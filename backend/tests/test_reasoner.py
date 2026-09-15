"""
PrivAgent Backend Tests — Milestone 7 Reasoner Layer.

Covers the OpenRouter reasoner WITHOUT any live network calls:
  - Safe prompt construction (sanitized metadata only).
  - Structured output parsing (fences, chatter, empty, malformed).
  - Typed failure mapping: auth (401/403), rate limit (429), 4xx, 5xx,
    timeout, network error, model refusal / unexpected format.
  - API key handling: sent only via Authorization header; never logged,
    never echoed in errors, never present in ReasoningError messages.
  - Mock reasoner never guesses: raises ReasoningError when no element fits.

A local HTTP mock (httpx MockTransport via monkeypatching) inspects the
SERIALIZED outbound request body — this is the network-boundary test that
verifies no sensitive fields ever reach the LLM provider.
"""
from __future__ import annotations

import json

import httpx
import pytest

from app import reasoner as reasoner_mod
from app.reasoner import (
    REASONER_REGISTRY,
    MockReasoner,
    OpenRouterReasoner,
    ReasonerProvider,
    ReasoningError,
    build_reasoner,
    parse_model_action,
    resolve_reasoner_name,
)

API_KEY = "test-key-not-a-real-secret"


def make_reasoner(**kwargs) -> OpenRouterReasoner:
    defaults = dict(api_key=API_KEY, model="google/gemma-4-31b-it:free", timeout_seconds=5)
    defaults.update(kwargs)
    return OpenRouterReasoner(**defaults)


SAMPLE_DETECTIONS = [
    {
        "id": "det_acc_1",
        "type": "account_number",
        "confidence": 0.95,
        "bbox": {"x": 100.0, "y": 200.0, "width": 150.0, "height": 30.0},
        "length": 12,
        "source": "dom_input_type",
        "selector": "#account-input",
        "is_partially_visible": False,
    },
    {
        "id": "det_btn_2",
        "type": "person_name",
        "confidence": 0.88,
        "bbox": {"x": 100.0, "y": 300.0, "width": 120.0, "height": 25.0},
        "length": 8,
        "source": "dom_label",
        "selector": "#name-label",
        "is_partially_visible": False,
    },
]


def _completion(content: str) -> dict:
    return {"choices": [{"message": {"role": "assistant", "content": content}}]}


def _patch_post(monkeypatch, handler):
    """Patch httpx.post used by the reasoner with a local mock transport."""

    def fake_post(url, **kwargs):
        request = httpx.Request("POST", url, json=kwargs.get("json"), headers=kwargs.get("headers"))
        return handler(request)

    monkeypatch.setattr(reasoner_mod.httpx, "post", fake_post)


# ── Prompt construction: sanitized metadata only ─────────────────────────────

class TestPromptSafety:
    def test_user_prompt_contains_only_safe_metadata(self):
        from app.reasoner import _build_user_prompt

        prompt = _build_user_prompt(
            task="Find and click the account number field",
            url="https://bank.example.com/portal",
            viewport={"width": 1280, "height": 800, "scroll_x": 0, "scroll_y": 0},
            screenshot_dimensions=None,
            detections=SAMPLE_DETECTIONS,
            history=[{"action": "scroll", "direction": "down", "amount": 500}],
            steps_used=1,
            max_steps=10,
        )

        # Safe metadata present
        assert "det_acc_1" in prompt
        assert "account_number" in prompt
        # No raw PII values (they are not present on sanitized inputs by construction)
        assert "123456789012" not in prompt
        assert "rahul" not in prompt.lower()
        # History is safe metadata
        assert '"direction"' in prompt

    def test_system_prompt_establishes_injection_defenses(self):
        from app.reasoner import SYSTEM_PROMPT

        assert "UNTRUSTED" in SYSTEM_PROMPT
        assert "EXACTLY" in SYSTEM_PROMPT
        assert "Never invent" in SYSTEM_PROMPT
        assert "JavaScript" in SYSTEM_PROMPT


# ── Structured output parsing ─────────────────────────────────────────────────

class TestParseModelAction:
    def test_plain_json(self):
        parsed = parse_model_action('{"action":"click","target":"det_acc_1","reason":"r"}')
        assert parsed["action"] == "click"
        assert parsed["target"] == "det_acc_1"

    def test_markdown_fenced_json(self):
        parsed = parse_model_action('```json\n{"action":"scroll","direction":"down","amount":500}\n```')
        assert parsed["action"] == "scroll"

    def test_json_with_surrounding_chatter(self):
        parsed = parse_model_action('Here is the action: {"action":"click","target":"x"} — done.')
        assert parsed["action"] == "click"

    def test_empty_response_raises(self):
        with pytest.raises(ReasoningError) as exc:
            parse_model_action("")
        assert exc.value.kind == "empty_response"

    def test_malformed_json_raises(self):
        with pytest.raises(ReasoningError) as exc:
            parse_model_action("not json at all")
        assert exc.value.kind == "invalid_json"

    def test_missing_action_raises(self):
        with pytest.raises(ReasoningError) as exc:
            parse_model_action('{"target":"x"}')
        assert exc.value.kind == "missing_action"

    def test_non_object_raises(self):
        with pytest.raises(ReasoningError):
            parse_model_action('["action"]')


# ── Network-boundary tests: inspect the SERIALIZED outbound request ──────────

FORBIDDEN_KEYS = {
    "value", "text", "textContent", "innerText", "rawText", "rawOCR", "ocrText",
    "password", "words", "lines", "token", "secret", "card", "cardNumber",
    "cvv", "pan", "accountNumber", "raw", "sensitiveValue", "pii",
}


def _walk_keys(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k
            yield from _walk_keys(v)
    elif isinstance(obj, list):
        for item in obj:
            yield from _walk_keys(item)


class TestOutboundRequestSafety:
    def test_outbound_payload_contains_only_sanitized_metadata(self, monkeypatch):
        captured = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["headers"] = dict(request.headers)
            captured["body"] = json.loads(request.content.decode("utf-8"))
            return httpx.Response(200, json=_completion('{"action":"click","target":"det_acc_1"}'))

        _patch_post(monkeypatch, handler)
        r = make_reasoner()
        result = r.request_action(
            task="Find and click the account number field",
            url="https://bank.example.com/portal",
            detections=SAMPLE_DETECTIONS,
            history=[{"action": "click", "target": "det_acc_1", "reason": "step 1"}],
            viewport={"width": 1280, "height": 800, "scroll_x": 0, "scroll_y": 0},
        )

        assert result.raw_action["action"] == "click"
        body = captured["body"]
        serialized = json.dumps(body)

        # 1. No forbidden sensitive keys anywhere in the outbound request.
        for key in _walk_keys(body):
            norm = key.lower().replace("_", "")
            assert norm not in {k.lower().replace("_", "") for k in FORBIDDEN_KEYS}, key

        # 2. No raw PII / base64 / screenshot content in the serialized request.
        for pii in ("123456789012", "4111111111111111", "DemoPassword123", "rahul", "base64,"):
            assert pii not in serialized

        # 3. The model target is grounded in provided metadata.
        assert "det_acc_1" in serialized

        # 4. Authorization header carries the key; body does not.
        assert captured["headers"].get("authorization") == f"Bearer {API_KEY}"
        assert API_KEY not in serialized

    def test_api_key_never_in_error_messages(self, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(401, json={"error": {"message": "invalid credentials"}})

        _patch_post(monkeypatch, handler)
        r = make_reasoner()
        with pytest.raises(ReasoningError) as exc:
            r.request_action(task="t", url="u", detections=SAMPLE_DETECTIONS)
        assert API_KEY not in str(exc.value)
        assert exc.value.kind == "auth"

    def test_not_configured_raises_without_network(self, monkeypatch):
        called = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            called["n"] += 1
            return httpx.Response(200, json=_completion('{"action":"click"}'))

        _patch_post(monkeypatch, handler)
        r = make_reasoner(api_key="")
        with pytest.raises(ReasoningError) as exc:
            r.request_action(task="t", url="u", detections=SAMPLE_DETECTIONS)
        assert exc.value.kind == "not_configured"
        assert called["n"] == 0


# ── HTTP failure mapping ──────────────────────────────────────────────────────

class TestHTTPFailureMapping:
    @pytest.mark.parametrize("status_code,expected_kind", [
        (401, "auth"),
        (403, "auth"),
        (429, "rate_limit"),
        (400, "http_client_error"),
        (404, "http_client_error"),
        (500, "http_server_error"),
        (502, "http_server_error"),
        (503, "http_server_error"),
    ])
    def test_http_errors_map_to_typed_failures(self, monkeypatch, status_code, expected_kind):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(status_code, json={"error": {"message": "boom"}})

        _patch_post(monkeypatch, handler)
        r = make_reasoner()
        with pytest.raises(ReasoningError) as exc:
            r.request_action(task="t", url="u", detections=SAMPLE_DETECTIONS)
        assert exc.value.kind == expected_kind

    def test_timeout_is_retryable(self, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("timed out")

        _patch_post(monkeypatch, handler)
        r = make_reasoner()
        with pytest.raises(ReasoningError) as exc:
            r.request_action(task="t", url="u", detections=SAMPLE_DETECTIONS)
        assert exc.value.kind == "timeout"
        assert exc.value.retryable is True

    def test_network_error_is_retryable(self, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        _patch_post(monkeypatch, handler)
        r = make_reasoner()
        with pytest.raises(ReasoningError) as exc:
            r.request_action(task="t", url="u", detections=SAMPLE_DETECTIONS)
        assert exc.value.kind == "network"
        assert exc.value.retryable is True

    def test_malformed_model_json_fails_safely(self, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=_completion("I cannot comply with that request."))

        _patch_post(monkeypatch, handler)
        r = make_reasoner()
        with pytest.raises(ReasoningError) as exc:
            r.request_action(task="t", url="u", detections=SAMPLE_DETECTIONS)
        assert exc.value.kind in ("invalid_json", "empty_response")

    def test_unexpected_response_format_fails_safely(self, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"unexpected": "shape"})

        _patch_post(monkeypatch, handler)
        r = make_reasoner()
        with pytest.raises(ReasoningError) as exc:
            r.request_action(task="t", url="u", detections=SAMPLE_DETECTIONS)
        assert exc.value.kind == "unexpected_format"


# ── Mock reasoner: never guesses ──────────────────────────────────────────────

class TestMockReasoner:
    def test_matching_element_is_targeted(self):
        r = MockReasoner()
        result = r.request_action(
            task="Find and click the account number field",
            url="u",
            detections=SAMPLE_DETECTIONS,
        )
        assert result.raw_action["target"] == "det_acc_1"

    def test_unknown_task_raises_instead_of_guessing(self):
        r = MockReasoner()
        with pytest.raises(ReasoningError) as exc:
            r.request_action(task="Completely unknown task", url="u", detections=SAMPLE_DETECTIONS)
        assert exc.value.kind == "no_target"

    def test_empty_detections_raise_for_click_tasks(self):
        r = MockReasoner()
        with pytest.raises(ReasoningError):
            r.request_action(task="Find and click the account number field", url="u", detections=[])

    def test_scroll_task_is_bounded(self):
        r = MockReasoner()
        result = r.request_action(task="Scroll down", url="u", detections=[])
        assert 1 <= result.raw_action["amount"] <= 5000

    def test_fail_with_maps_to_reasoning_error(self):
        r = MockReasoner(fail_with="simulated provider outage")
        with pytest.raises(ReasoningError) as exc:
            r.request_action(task="t", url="u", detections=SAMPLE_DETECTIONS)
        assert exc.value.kind == "mock_failure"


# ── Rate limits are never retried (M7 hotfix) ─────────────────────────────────

class TestRateLimitZeroRetry:
    """HTTP 429 must cost exactly ONE provider request, even when the bounded
    attempt budget for transient failures is configured higher."""

    def test_429_is_non_retryable_and_makes_exactly_one_request(self, monkeypatch):
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(429, json={"error": {"message": "rate limit exceeded"}})

        _patch_post(monkeypatch, handler)
        # A generous attempt budget that must NOT be consumed by a rate limit.
        monkeypatch.setattr(reasoner_mod.config, "MAX_LLM_ATTEMPTS", 3)

        r = make_reasoner()
        with pytest.raises(ReasoningError) as exc:
            r.request_action(task="t", url="u", detections=SAMPLE_DETECTIONS)

        assert exc.value.kind == "rate_limit"
        assert exc.value.retryable is False
        assert calls["n"] == 1

    def test_429_fails_closed_without_inventing_an_action(self, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(429, json={"error": {"message": "rate limit exceeded"}})

        _patch_post(monkeypatch, handler)
        r = make_reasoner()
        with pytest.raises(ReasoningError) as exc:
            r.request_action(task="t", url="u", detections=SAMPLE_DETECTIONS)
        # A ReasoningError carries NO action payload, so the route has nothing
        # to fall back to — it can only fail closed with a typed 503.
        assert exc.value.kind == "rate_limit"
        assert not hasattr(exc.value, "raw_action")

    def test_transient_5xx_still_uses_the_bounded_retry_policy(self, monkeypatch):
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(503, json={"error": {"message": "temporarily unavailable"}})

        _patch_post(monkeypatch, handler)
        monkeypatch.setattr(reasoner_mod.config, "MAX_LLM_ATTEMPTS", 3)

        r = make_reasoner()
        with pytest.raises(ReasoningError) as exc:
            r.request_action(task="t", url="u", detections=SAMPLE_DETECTIONS)

        assert exc.value.kind == "http_server_error"
        assert exc.value.retryable is True
        assert calls["n"] == 3  # unchanged bounded retry behavior for 5xx

    def test_auth_failures_do_not_retry(self, monkeypatch):
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(401, json={"error": {"message": "invalid credentials"}})

        _patch_post(monkeypatch, handler)
        monkeypatch.setattr(reasoner_mod.config, "MAX_LLM_ATTEMPTS", 3)

        r = make_reasoner()
        with pytest.raises(ReasoningError):
            r.request_action(task="t", url="u", detections=SAMPLE_DETECTIONS)
        assert calls["n"] == 1


# ── Reasoner registry: configuration-driven provider selection ────────────────

class TestReasonerRegistry:
    """The agent route resolves its provider from the registry, so swapping the
    reasoning model is configuration, not an architecture change."""

    def test_registry_declares_production_and_offline_providers(self):
        assert "openrouter" in REASONER_REGISTRY   # production: Gemma via OpenRouter
        assert "mock" in REASONER_REGISTRY         # offline tests / CI

    def test_build_reasoner_selects_by_name(self):
        assert isinstance(build_reasoner("openrouter"), OpenRouterReasoner)
        assert isinstance(build_reasoner("mock"), MockReasoner)

    def test_unknown_name_fails_closed_to_the_production_provider(self):
        assert resolve_reasoner_name("not-a-provider") == "openrouter"
        # Fail-closed means: the production provider (which refuses to run
        # without a key) — never a deterministic/guessing fallback.
        assert isinstance(build_reasoner("not-a-provider"), OpenRouterReasoner)
        assert resolve_reasoner_name("") == "openrouter"

    def test_resolved_name_reports_what_will_actually_run(self):
        assert resolve_reasoner_name(" MOCK ") == "mock"
        assert resolve_reasoner_name("openrouter") == "openrouter"

    def test_every_registered_provider_satisfies_the_contract(self):
        for name in REASONER_REGISTRY:
            provider = build_reasoner(name)
            assert isinstance(provider, ReasonerProvider), name
            assert isinstance(provider.configured, bool), name
            assert callable(provider.request_action), name

    def test_each_build_returns_a_fresh_instance(self):
        assert build_reasoner("mock") is not build_reasoner("mock")

    def test_mock_and_production_providers_share_one_call_signature(self):
        """A provider swap cannot change the route's call site."""
        kwargs = dict(
            task="Find and click the account number field",
            url="https://bank.example.com/portal",
            detections=SAMPLE_DETECTIONS,
            history=[],
            viewport={"width": 1280, "height": 800, "scroll_x": 0, "scroll_y": 0},
            screenshot_dimensions=None,
            steps_used=0,
            max_steps=10,
        )
        result = build_reasoner("mock").request_action(**kwargs)
        assert result.raw_action["action"] in ("click", "scroll")
        assert result.attempts >= 1
