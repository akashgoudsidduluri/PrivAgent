"""
PrivAgent Backend Tests — Agent Reasoning API (Milestone 5)

Tests:
  - POST /api/v1/agent/action accepts sanitized context and returns structured action.
  - Task matching 'account number' targets account_number element.
  - Task matching 'scroll' returns bounded scroll action.
  - Forbidden keys anywhere in the request body result in 422 rejection.
  - Context with invalid sanitized_status is rejected.
  - LLM cannot receive raw PII through the agent route.
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


def test_agent_action_account_number_task():
    """Valid task to find account number returns structured click action on det_acc_1."""
    req_body = {
        "task": "Find and click the account number field",
        "context": VALID_CONTEXT,
    }
    resp = client.post("/api/v1/agent/action", json=req_body)
    assert resp.status_code == 200
    data = resp.json()
    assert data["success"] is True
    assert data["action"]["action"] == "click"
    assert data["action"]["target"] == "det_acc_1"
    assert "account number" in data["action"]["reason"].lower()


def test_agent_action_scroll_task():
    """Scroll task returns structured scroll action with bounded amount."""
    req_body = {
        "task": "Scroll down to see more transactions",
        "context": VALID_CONTEXT,
    }
    resp = client.post("/api/v1/agent/action", json=req_body)
    assert resp.status_code == 200
    data = resp.json()
    assert data["success"] is True
    assert data["action"]["action"] == "scroll"
    assert data["action"]["direction"] == "down"
    assert 1 <= data["action"]["amount"] <= 5000


def test_agent_action_rejects_top_level_forbidden_key():
    """Forbidden sensitive keys at the top level of the request body are blocked."""
    req_body = {
        "task": "Find field",
        "context": VALID_CONTEXT,
        "password": "secret_password_value",
    }
    resp = client.post("/api/v1/agent/action", json=req_body)
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
    resp = client.post("/api/v1/agent/action", json=req_body)
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
    resp = client.post("/api/v1/agent/action", json=req_body)
    assert resp.status_code == 422
