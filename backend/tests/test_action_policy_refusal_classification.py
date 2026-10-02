"""
PrivAgent — Phase 17.10 D1: action-policy refusal vs. malformed-payload classification.

Pydantic raises ONE exception type out of `BrowserActionModel.model_validate` for two
very different situations:

  1. A genuinely MALFORMED payload from the model (unknown action enum,
     `extra_forbidden`, wrong JSON type). Retrying is reasonable — the model may
     produce something different next time.

  2. A WELL-FORMED action that PrivAgent's own `validate_action_shape` POLICY refused
     (PII-shaped `type.text`, a field that does not belong to the action type, a
     missing required field, a key outside the allowlist, a non-http navigate URL).

Case 2 was reported to the extension as "Reasoner produced an invalid action
structure." with `retryable: True`. That is wrong twice over: the structure was
fine, and the refusal is deterministic, so retrying it can never succeed.

Live evidence (real Groq, model openai/gpt-oss-20b, 3/3 runs identical):
    HTTP 200, 1004ms
    raw: {"action":"type","target":"det-email-1","text":"test@example.com", ...}
    -> refused by the email rule in text_safety.py

These tests pin the CORRECTED behaviour and, critically, pin that the refusal
itself is unchanged: nothing may reach the extension, and no action may ever
be executed.
"""
from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from app import reasoner as reasoner_mod
from app.main import app

client = TestClient(app)

API_KEY = "test-key-not-a-real-secret"

SAMPLE_CONTEXT = {
    "url": "http://localhost:4174/",
    "timestamp": 1720000000000,
    "viewport": {"width": 1280, "height": 800, "scroll_x": 0, "scroll_y": 0},
    "screenshot_dimensions": None,
    "detections": [
        {
            "id": "det-email-1",
            "type": "email",
            "confidence": 0.95,
            "bbox": {"x": 40.0, "y": 150.0, "width": 260.0, "height": 32.0},
            "length": 0,
            "source": "dom_input_type",
            "selector": "#email",
            "is_partially_visible": False,
        },
    ],
    "total_elements_scanned": 16,
    "sensitive_elements_detected": 1,
    "sanitized_status": "sanitized_only",
    "ocr_metrics": None,
}


def _completion(content: str) -> httpx.Response:
    return httpx.Response(
        200, json={"choices": [{"message": {"role": "assistant", "content": content}}]}
    )


def _patch_openrouter(monkeypatch, completions):
    queue = list(completions)
    captured = {"calls": 0}

    def fake_post(url, **kwargs):
        captured["calls"] += 1
        response = queue.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(reasoner_mod.httpx, "post", fake_post)
    return captured


@pytest.fixture()
def openrouter_mode(monkeypatch):
    monkeypatch.setattr("app.config.REASONER_MODE", "openrouter")
    monkeypatch.setattr("app.config.OPENROUTER_API_KEY", API_KEY)
    yield


def _body(task="fill the contact form"):
    return {"task": task, "context": SAMPLE_CONTEXT}


class TestPolicyRefusalClassification:
    """A well-formed action refused by policy is NOT a malformed payload."""

    def test_pii_shaped_type_text_is_a_policy_refusal(self, monkeypatch, openrouter_mode):
        _patch_openrouter(
            monkeypatch,
            [_completion('{"action":"type","target":"det-email-1","text":"test@example.com"}')],
        )
        resp = client.post("/api/v1/agent/action", json=_body())

        assert resp.status_code == 502  # unchanged transport contract
        detail = resp.json()["detail"]
        assert detail["success"] is False
        assert detail["error_kind"] == "invalid_action"  # unchanged

        # The reason must no longer claim the structure was invalid.
        assert "invalid action structure" not in detail["reason"]
        assert "policy refused" in detail["reason"]

        # Deterministic refusal: retrying it can never help.
        assert detail["retryable"] is False

    def test_script_injection_type_text_is_a_policy_refusal(self, monkeypatch, openrouter_mode):
        _patch_openrouter(
            monkeypatch,
            [_completion('{"action":"type","target":"det-email-1","text":"<script>alert(1)</script>"}')],
        )
        resp = client.post("/api/v1/agent/action", json=_body())

        assert resp.status_code == 502
        detail = resp.json()["detail"]
        assert detail["retryable"] is False
        assert "invalid action structure" not in detail["reason"]

    def test_key_outside_the_allowlist_is_a_policy_refusal(self, monkeypatch, openrouter_mode):
        # The normalizer does not touch an unmapped key, so `F5` reaches the model
        # and is refused by the pressKey allowlist — a policy rule, not a schema fault.
        _patch_openrouter(monkeypatch, [_completion('{"action":"pressKey","key":"F5"}')])
        resp = client.post("/api/v1/agent/action", json=_body())

        assert resp.status_code == 502
        detail = resp.json()["detail"]
        assert detail["retryable"] is False
        assert "invalid action structure" not in detail["reason"]

    def test_non_http_navigate_scheme_is_a_policy_refusal(self, monkeypatch, openrouter_mode):
        # The normalizer keeps `url` for navigate; the scheme allowlist refuses it.
        _patch_openrouter(
            monkeypatch, [_completion('{"action":"navigate","url":"javascript:alert(1)"}')]
        )
        resp = client.post("/api/v1/agent/action", json=_body())

        assert resp.status_code == 502
        detail = resp.json()["detail"]
        assert detail["retryable"] is False
        assert "invalid action structure" not in detail["reason"]

    def test_unknown_action_enum_is_a_genuine_structure_error(self, monkeypatch, openrouter_mode):
        _patch_openrouter(
            monkeypatch, [_completion('{"action":"teleport","target":"det-email-1"}')]
        )
        resp = client.post("/api/v1/agent/action", json=_body())

        assert resp.status_code == 502
        detail = resp.json()["detail"]
        # A malformed payload keeps the original message and stays retryable.
        assert detail["reason"] == "Reasoner produced an invalid action structure."
        assert detail["retryable"] is True


class TestRefusalIsUnchangedAndFailClosed:
    """The fix corrects REPORTING only. It must not weaken any refusal."""

    def test_policy_refused_action_never_reaches_the_extension(self, monkeypatch, openrouter_mode):
        _patch_openrouter(
            monkeypatch,
            [_completion('{"action":"type","target":"det-email-1","text":"test@example.com"}')],
        )
        resp = client.post("/api/v1/agent/action", json=_body())

        body = resp.json()
        assert resp.status_code != 200
        assert "action" not in body
        assert body["detail"]["success"] is False

    def test_no_retries_are_attempted_for_a_deterministic_policy_refusal(
        self, monkeypatch, openrouter_mode
    ):
        # Only ONE completion is queued. If the route retried, this would raise
        # IndexError from the empty queue and the test would fail.
        captured = _patch_openrouter(
            monkeypatch,
            [_completion('{"action":"type","target":"det-email-1","text":"test@example.com"}')],
        )
        resp = client.post("/api/v1/agent/action", json=_body())

        assert resp.status_code == 502
        assert captured["calls"] == 1

    def test_a_safe_action_is_still_accepted_end_to_end(self, monkeypatch, openrouter_mode):
        _patch_openrouter(
            monkeypatch,
            [_completion('{"action":"click","target":"det-email-1","reason":"focus the email field"}')],
        )
        resp = client.post("/api/v1/agent/action", json=_body())

        assert resp.status_code == 200
        body = resp.json()
        assert body["success"] is True
        assert body["action"]["action"] == "click"
        assert body["action"]["target"] == "det-email-1"
