"""
PrivAgent Backend Tests — Agent Reasoning API (Milestones 5 → 7, M7 semantics)

Tests:
  - POST /api/v1/agent/action accepts sanitized context and returns a structured action.
  - Mock reasoner targets only elements that exist in the sanitized context.
  - No guessing: reasoning failure / unknown target / invalid model output fail safely.
  - Forbidden keys anywhere in the request body result in rejection.
  - Context with invalid sanitized_status is rejected.
  - Action-history metadata is accepted and validated.
  - Telemetry contains provider/model/latency but never key material or prompts.

The real-LLM path (OpenRouter) is exercised through mocks in test_reasoner.py;
no test in this suite performs a live network call.
"""
import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

VALID_CONTEXT = {
    "url": "https://bank.example.com/portal",
    "timestamp": 1720000000000,
    "viewport": {"width": 1280, "height": 800, "scroll_x": 0, "scroll_y": 0},
    "screenshot_dimensions": None,
    "detections": [
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
        }
    ],
    "total_elements_scanned": 40,
    "sensitive_elements_detected": 2,
    "sanitized_status": "sanitized_only",
    "ocr_metrics": None,
}


def _post_agent(body):
    return client.post("/api/v1/agent/action", json=body)


def test_agent_action_account_number_task():
    """Sanitized task returns a structured click action targeting the matching element."""
    req_body = {
        "task": "Find and click the account number field",
        "context": VALID_CONTEXT,
    }
    resp = _post_agent(req_body)
    assert resp.status_code == 200
    data = resp.json()
    assert data["success"] is True
    assert data["action"]["action"] == "click"
    assert data["action"]["target"] == "det_acc_1"
    # M7: telemetry is present and key-free
    assert data["telemetry"]["provider"] in ("mock", "openrouter")
    assert "latency_ms" in data["telemetry"]
    assert "OPENROUTER" not in resp.text and "sk-" not in resp.text


def test_agent_action_scroll_task():
    """Scroll task returns a structured scroll action with bounded amount."""
    req_body = {
        "task": "Scroll down to see more transactions",
        "context": VALID_CONTEXT,
    }
    resp = _post_agent(req_body)
    assert resp.status_code == 200
    data = resp.json()
    assert data["success"] is True
    assert data["action"]["action"] == "scroll"
    assert data["action"]["direction"] == "down"
    assert 1 <= data["action"]["amount"] <= 5000


def test_agent_action_with_safe_history_metadata():
    """Safe action history is accepted and does not change the response shape."""
    req_body = {
        "task": "Open the account details and find the recent transactions",
        "context": VALID_CONTEXT,
        "history": [
            {"action": "click", "target": "det_acc_1", "reason": "step 1"},
            {"action": "scroll", "direction": "down", "amount": 500},
        ],
    }
    resp = _post_agent(req_body)
    assert resp.status_code == 200
    data = resp.json()
    assert data["success"] is True
    assert data["action"]["action"] in ("click", "scroll")


def test_agent_action_rejects_unsafe_history_entry():
    """History entries that are not allowlisted browser actions are rejected."""
    req_body = {
        "task": "Find account",
        "context": VALID_CONTEXT,
        "history": [{"action": "eval", "code": "alert(1)"}],
    }
    resp = _post_agent(req_body)
    assert resp.status_code in (422, 400)


def test_agent_action_no_guessing_without_matching_element():
    """A task with no matching element in context fails safely instead of guessing."""
    empty_context = dict(VALID_CONTEXT)
    empty_context["detections"] = []
    req_body = {
        "task": "Find and click the account number field",
        "context": empty_context,
    }
    resp = _post_agent(req_body)
    # Fail closed: either 422 (validation) or 503 (reasoning unavailable).
    assert resp.status_code in (422, 503)
    body = resp.json()
    detail = body.get("detail")
    if isinstance(detail, dict):
        assert detail.get("success") is False
        assert "action" not in detail


def test_agent_action_rejects_top_level_forbidden_key():
    """Forbidden sensitive keys at the top level of the request body are blocked."""
    req_body = {
        "task": "Find field",
        "context": VALID_CONTEXT,
        "password": "secret_password_value",
    }
    resp = _post_agent(req_body)
    assert resp.status_code == 422
    assert "forbidden" in resp.text.lower() or "extra" in resp.text.lower()


def test_agent_action_rejects_value_in_context():
    """Forbidden raw text value in context detection triggers security rejection."""
    bad_context = dict(VALID_CONTEXT)
    bad_context["detections"] = [
        {
            "id": "det_1",
            "type": "account_number",
            "confidence": 0.95,
            "bbox": {"x": 10.0, "y": 20.0, "width": 100.0, "height": 30.0},
            "length": 12,
            "source": "dom_input_type",
            "selector": "#acc",
            "is_partially_visible": False,
            "value": "123456789012",  # FORBIDDEN RAW PII
        }
    ]
    req_body = {
        "task": "Find account",
        "context": bad_context,
    }
    resp = _post_agent(req_body)
    assert resp.status_code == 422
    assert "forbidden" in resp.text.lower() or "value" in resp.text.lower()


def test_agent_action_rejects_invalid_sanitized_status():
    """Context with missing or incorrect sanitized_status is rejected."""
    bad_context = dict(VALID_CONTEXT)
    bad_context["sanitized_status"] = "raw_unverified"
    req_body = {
        "task": "Find account",
        "context": bad_context,
    }
    resp = _post_agent(req_body)
    assert resp.status_code == 422


def test_agent_action_normalizes_navigate_down_to_scroll(monkeypatch):
    """When LLM emits navigate with url='down' to view more results, normalize to scroll."""
    from app.reasoner import MockReasoner, ReasoningResult
    
    def fake_request(*args, **kwargs):
        return ReasoningResult(
            raw_action={"action": "navigate", "url": "down", "reason": "Navigate down the homepage."},
            model="mock",
            latency_ms=10.0,
            attempts=1,
        )

    monkeypatch.setattr(MockReasoner, "request_action", fake_request)
    req_body = {
        "task": "open Google and search for cats",
        "context": VALID_CONTEXT,
    }
    resp = _post_agent(req_body)
    assert resp.status_code == 200
    data = resp.json()
    assert data["success"] is True
    assert data["action"]["action"] == "scroll"
    assert data["action"]["direction"] == "down"
    assert data["action"]["amount"] == 500


def test_agent_action_normalizes_navigate_direction_to_scroll(monkeypatch):
    """When LLM emits navigate with direction='down', amount=500, normalize to scroll."""
    from app.reasoner import MockReasoner, ReasoningResult

    def fake_request(*args, **kwargs):
        return ReasoningResult(
            raw_action={"action": "navigate", "direction": "down", "amount": 500, "reason": "Navigate down"},
            model="mock",
            latency_ms=10.0,
            attempts=1,
        )

    monkeypatch.setattr(MockReasoner, "request_action", fake_request)
    req_body = {
        "task": "open Google and search for cats",
        "context": VALID_CONTEXT,
    }
    resp = _post_agent(req_body)
    assert resp.status_code == 200
    data = resp.json()
    assert data["success"] is True
    assert data["action"]["action"] == "scroll"
    assert data["action"]["direction"] == "down"
    assert data["action"]["amount"] == 500


def test_agent_action_supports_press_key(monkeypatch):
    """When LLM emits pressKey with key='enter', normalize and validate."""
    from app.reasoner import MockReasoner, ReasoningResult

    def fake_request(*args, **kwargs):
        return ReasoningResult(
            raw_action={"action": "pressKey", "key": "enter", "target": "det_acc_1", "reason": "Press enter"},
            model="mock",
            latency_ms=10.0,
            attempts=1,
        )

    monkeypatch.setattr(MockReasoner, "request_action", fake_request)
    req_body = {
        "task": "Submit the search",
        "context": VALID_CONTEXT,
    }
    resp = _post_agent(req_body)
    assert resp.status_code == 200
    data = resp.json()
    assert data["success"] is True
    assert data["action"]["action"] == "pressKey"
    assert data["action"]["key"] == "Enter"
