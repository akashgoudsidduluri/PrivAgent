import pytest
from fastapi.testclient import TestClient
from app.main import app
from app import config

client = TestClient(app)

@pytest.fixture(autouse=True)
def mock_reasoner(monkeypatch):
    monkeypatch.setattr(config, "REASONER_MODE", "mock")
    monkeypatch.setattr(config, "REASONER_PROVIDER", "mock")
    monkeypatch.setattr(config, "MODEL_FAST", "fast-model")
    monkeypatch.setattr(config, "MODEL_STRONG", "strong-model")
    monkeypatch.setattr(config, "MODEL_VISION", "vision-model")
    monkeypatch.setattr(config, "MODEL_SAFETY", "safety-model")

def test_agent_action_with_role():
    payload = {
        "task": "scroll down",
        "context": {
            "url": "http://example.com",
            "timestamp": 1234567890,
            "viewport": {"width": 800, "height": 600},
            "detections": [],
            "total_elements_scanned": 0,
            "sensitive_elements_detected": 0,
            "sanitized_status": "sanitized_only"
        },
        "history": [],
        "model_role": "STRONG"
    }
    response = client.post("/api/v1/agent/action", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert data["telemetry"]["role"] == "STRONG"

def test_agent_action_with_invalid_role():
    payload = {
        "task": "scroll down",
        "context": {
            "url": "http://example.com",
            "timestamp": 1234567890,
            "viewport": {"width": 800, "height": 600},
            "detections": [],
            "total_elements_scanned": 0,
            "sensitive_elements_detected": 0,
            "sanitized_status": "sanitized_only"
        },
        "history": [],
        "model_role": "INVALID_ROLE"
    }
    response = client.post("/api/v1/agent/action", json=payload)
    assert response.status_code == 422 # Pydantic validation error or 400

def test_agent_review_endpoint():
    payload = {
        "action": {"action": "navigate", "url": "http://example.com"},
        "task": "scroll down",
        "context": {},
        "model_role": "SAFETY"
    }
    response = client.post("/api/v1/agent/review", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["safe"] is True
