"""
PrivAgent — M7 Phase 5: Full Reasoning Pipeline Integration Test (offline).

Connects the important seams WITHOUT any real network access:

  fabricated OpenRouter response
    → backend reasoner (parse_model_action, field limits, reason scan)
    → backend agent route (security scan, history validation)
    → strict BrowserActionModel (per-action shape + value scanning)
    → target grounding against the sanitized context
    → extension-side validation/policy (mirrored by the M7 TS suite)

The OpenRouter HTTP boundary is simulated with httpx monkeypatching so the
SERIALIZED outbound request can be inspected. Malicious/fabricated model
outputs must fail closed at the correct layer.
"""
from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app import reasoner as reasoner_mod
from app.main import app

client = TestClient(app)

API_KEY = "test-key-not-a-real-secret"

SAMPLE_CONTEXT = {
    "url": "https://bank.example.com/portal",
    "timestamp": 1720000000000,
    "viewport": {"width": 1280, "height": 800, "scroll_x": 0, "scroll_y": 0},
    "screenshot_dimensions": None,
    "detections": [
        {
            "id": "element_details",
            "type": "person_name",
            "confidence": 0.92,
            "bbox": {"x": 100.0, "y": 200.0, "width": 150.0, "height": 30.0},
            "length": 8,
            "source": "dom_label",
            "selector": "#btn-details",
            "is_partially_visible": False,
        },
        {
            "id": "element_transactions",
            "type": "account_number",
            "confidence": 0.95,
            "bbox": {"x": 100.0, "y": 320.0, "width": 180.0, "height": 30.0},
            "length": 12,
            "source": "dom_label",
            "selector": "#btn-transactions",
            "is_partially_visible": False,
        },
    ],
    "total_elements_scanned": 40,
    "sensitive_elements_detected": 2,
    "sanitized_status": "sanitized_only",
    "ocr_metrics": None,
}


def _patch_openrouter(monkeypatch, completions):
    """Patch httpx.post to return a queue of fabricated completion responses."""
    queue = list(completions)
    captured = {}

    def fake_post(url, **kwargs):
        captured["url"] = url
        raw = kwargs.get("json")
        captured["body"] = json.loads(raw) if isinstance(raw, str) else raw
        captured["headers"] = {
            k.lower(): v for k, v in dict(kwargs.get("headers", {})).items()
        }
        response = queue.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(reasoner_mod.httpx, "post", fake_post)
    return captured


def _completion(content: str) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": content}}]})


def _agent_body(task: str, history=None):
    body = {"task": task, "context": SAMPLE_CONTEXT}
    if history is not None:
        body["history"] = history
    return body


@pytest.fixture()
def openrouter_mode(monkeypatch):
    """Force openrouter mode with a fake key for this module; restore after."""
    monkeypatch.setattr("app.config.REASONER_MODE", "openrouter")
    monkeypatch.setattr("app.config.OPENROUTER_API_KEY", API_KEY)
    yield


class TestFullPipelineHappyPath:
    def test_fabricated_llm_response_flows_to_validated_action(self, monkeypatch, openrouter_mode):
        completions = [
            '{"action":"click","target":"element_details","reason":"Open the account details section."}',
            '{"action":"scroll","direction":"down","amount":500,"reason":"Transactions section not visible yet."}',
            '{"action":"click","target":"element_transactions","reason":"Open the transactions list."}',
        ]
        captured = _patch_openrouter(monkeypatch, [_completion(c) for c in completions])

        # Step 1 → click details
        r1 = client.post("/api/v1/agent/action", json=_agent_body(
            "Open the account details and find the recent transactions"))
        assert r1.status_code == 200
        assert r1.json()["action"]["target"] == "element_details"

        # Step 2 → scroll
        r2 = client.post("/api/v1/agent/action", json=_agent_body(
            "Open the account details and find the recent transactions",
            history=[{"action": "click", "target": "element_details",
                      "reason": "Open the account details section."}]))
        assert r2.status_code == 200
        assert r2.json()["action"]["action"] == "scroll"

        # Step 3 → click transactions
        r3 = client.post("/api/v1/agent/action", json=_agent_body(
            "Open the account details and find the recent transactions",
            history=[
                {"action": "click", "target": "element_details",
                 "reason": "Open the account details section."},
                {"action": "scroll", "direction": "down", "amount": 500,
                 "reason": "Transactions section not visible yet."},
            ]))
        assert r3.status_code == 200
        assert r3.json()["action"]["target"] == "element_transactions"

        # Outbound request inspection: only sanitized metadata left the backend.
        assert captured["url"].endswith("/chat/completions")
        body_str = json.dumps(captured["body"])
        assert "element_details" in body_str and "element_transactions" in body_str
        for pii in ("123456789012", "4111111111111111", "rahul", "DemoPassword123", "ABCDE1234F"):
            assert pii not in body_str
        assert captured["headers"]["authorization"] == f"Bearer {API_KEY}"

    def test_outbound_prompt_contains_history_metadata_not_values(self, monkeypatch, openrouter_mode):
        captured = _patch_openrouter(
            monkeypatch, [_completion('{"action":"click","target":"element_transactions"}')])

        resp = client.post("/api/v1/agent/action", json=_agent_body(
            "Find the transactions",
            history=[{"action": "click", "target": "element_details", "reason": "Opened details."}],
        ))
        assert resp.status_code == 200
        user_content = captured["body"]["messages"][1]["content"]
        assert "element_details" in user_content
        assert '"action"' in user_content  # safe action metadata present


class TestFullPipelineFailures:
    def test_hallucinated_target_fails_closed(self, monkeypatch, openrouter_mode):
        _patch_openrouter(
            monkeypatch, [_completion('{"action":"click","target":"element_xyz_invented"}')])

        resp = client.post("/api/v1/agent/action", json=_agent_body("Find anything"))
        assert resp.status_code == 422
        detail = resp.json()["detail"]
        assert detail["error_kind"] == "unknown_target"
        assert detail["retryable"] is True

    def test_stale_target_from_previous_page_fails_closed(self, monkeypatch, openrouter_mode):
        _patch_openrouter(
            monkeypatch, [_completion('{"action":"click","target":"element_old_page_button"}')])

        resp = client.post("/api/v1/agent/action", json=_agent_body("Find anything"))
        assert resp.status_code == 422

    def test_pii_in_model_reason_rejected_at_reasoner_layer(self, monkeypatch, openrouter_mode):
        _patch_openrouter(
            monkeypatch,
            [_completion('{"action":"click","target":"element_details","reason":"Account holder Rahul Sharma."}')],
        )
        resp = client.post("/api/v1/agent/action", json=_agent_body("Find account details"))
        # Fails closed: reasoner-layer scan raises ReasoningError → 503.
        assert resp.status_code == 503
        detail = resp.json()["detail"]
        assert detail["error_kind"] == "invalid_action"
        assert detail["success"] is False

    def test_oversized_model_reason_rejected(self, monkeypatch, openrouter_mode):
        huge_reason = "x" * 400
        _patch_openrouter(
            monkeypatch,
            [_completion(f'{{"action":"click","target":"element_details","reason":"{huge_reason}"}}')],
        )
        resp = client.post("/api/v1/agent/action", json=_agent_body("Find account details"))
        # Oversized model fields are rejected (reasoner-layer limit) → 503.
        assert resp.status_code == 503
        assert resp.json()["detail"]["error_kind"] == "invalid_action"

    def test_model_script_output_rejected_by_action_model(self, monkeypatch, openrouter_mode):
        _patch_openrouter(
            monkeypatch,
            [_completion('{"action":"type","target":"element_details","text":"<script>alert(1)</script>"}')],
        )
        resp = client.post("/api/v1/agent/action", json=_agent_body("Fill the form"))
        assert resp.status_code == 502

    def test_model_malformed_json_fails_closed_503(self, monkeypatch, openrouter_mode):
        _patch_openrouter(monkeypatch, [_completion("I cannot comply with that request.")])
        resp = client.post("/api/v1/agent/action", json=_agent_body("Find anything"))
        assert resp.status_code == 503
        detail = resp.json()["detail"]
        assert detail["success"] is False
        assert detail["error_kind"] in ("invalid_json", "empty_response")

    def test_openrouter_5xx_fails_closed_503(self, monkeypatch, openrouter_mode):
        _patch_openrouter(monkeypatch, [httpx.Response(500, json={"error": {"message": "server oops"}})])
        resp = client.post("/api/v1/agent/action", json=_agent_body("Find anything"))
        assert resp.status_code == 503
        assert resp.json()["detail"]["error_kind"] == "http_server_error"

    def test_openrouter_429_maps_to_retryable_503(self, monkeypatch, openrouter_mode):
        _patch_openrouter(monkeypatch, [httpx.Response(429, json={"error": {"message": "slow down"}})])
        resp = client.post("/api/v1/agent/action", json=_agent_body("Find anything"))
        assert resp.status_code == 503
        detail = resp.json()["detail"]
        assert detail["error_kind"] == "rate_limit"
        assert detail["retryable"] is True

    def test_openrouter_auth_failure_fails_closed(self, monkeypatch, openrouter_mode):
        _patch_openrouter(monkeypatch, [httpx.Response(401, json={"error": {"message": "bad key"}})])
        resp = client.post("/api/v1/agent/action", json=_agent_body("Find anything"))
        assert resp.status_code == 503
        detail = resp.json()["detail"]
        assert detail["error_kind"] == "auth"
        assert detail["retryable"] is False
        # The API key must never appear in any error surfaced to the extension.
        assert API_KEY not in resp.text

    def test_no_first_detection_guessing_on_unknown_task(self, monkeypatch, openrouter_mode):
        """Model returns an empty/garbage output for an unknown task — no fallback."""
        _patch_openrouter(monkeypatch, [_completion("")])
        resp = client.post("/api/v1/agent/action", json=_agent_body("Do something unknown"))
        assert resp.status_code == 503


class TestFullPipelineHistoryGuard:
    def test_pii_in_history_reason_is_dropped(self, monkeypatch, openrouter_mode):
        """A history entry whose reason carries PII must never reach the LLM prompt."""
        captured = _patch_openrouter(
            monkeypatch, [_completion('{"action":"click","target":"element_details"}')])

        resp = client.post("/api/v1/agent/action", json=_agent_body(
            "Find the transactions",
            history=[{
                "action": "click", "target": "element_details",
                "reason": "holder Priya Nair record",
            }],
        ))
        # The reason is scanned by BrowserActionModel → 422 (request rejected)
        # rather than silently forwarded.
        assert resp.status_code in (200, 422)
        if resp.status_code == 200:
            user_content = captured["body"]["messages"][1]["content"]
            assert "Priya" not in user_content
