"""
PrivAgent Backend — pytest test suite for the Agent Safety API.

All sensitive values used here are synthetic/fake for testing purposes.
Tests verify that the backend enforces its independent security boundary
and correctly accepts, rejects, and stores sanitized context payloads.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routes.context import router  # to reset state between tests

client = TestClient(app)


# ── Fixture: valid minimal sanitized payload ──────────────────────────────────

def _valid_payload(**overrides) -> dict:
    """Return a fully valid sanitized AgentContextPayload dict."""
    base = {
        "url": "http://localhost:8002/",
        "timestamp": 1700000000000,
        "viewport": {"width": 1280, "height": 720, "scroll_x": 0.0, "scroll_y": 0.0},
        "screenshot_dimensions": {"width": 1280, "height": 720},
        "detections": [
            {
                "id": "det-001",
                "type": "email",
                "confidence": 0.98,
                "bbox": {"x": 100.0, "y": 200.0, "width": 220.0, "height": 30.0},
                "length": 25,
                "source": "ocr",
                "selector": "",
                "is_partially_visible": False,
            }
        ],
        "total_elements_scanned": 40,
        "sensitive_elements_detected": 1,
        "sanitized_status": "sanitized_only",
        "ocr_metrics": {
            "regions_scanned": 10,
            "sensitive_detected": 1,
            "latency_ms": 320.5,
        },
    }
    base.update(overrides)
    return base


@pytest.fixture(autouse=True)
def reset_context():
    """Clear stored context before each test for isolation."""
    client.delete("/api/v1/context")
    yield
    client.delete("/api/v1/context")


# ── Health check ──────────────────────────────────────────────────────────────

def test_health_ok():
    """GET /api/v1/health returns 200 with expected fields."""
    resp = client.get("/api/v1/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert "service" in data
    assert "version" in data


# ── Context not yet available ─────────────────────────────────────────────────

def test_get_latest_before_post_returns_404():
    """GET /api/v1/context/latest before any POST returns 404."""
    resp = client.get("/api/v1/context/latest")
    assert resp.status_code == 404


# ── Valid payload acceptance ──────────────────────────────────────────────────

def test_post_valid_payload_accepted():
    """POST with a fully sanitized payload returns 201 success."""
    resp = client.post("/api/v1/context", json=_valid_payload())
    assert resp.status_code == 201
    data = resp.json()
    assert data["success"] is True
    assert "message" in data
    assert data["detection_count"] == 1


def test_post_then_get_latest_returns_payload():
    """POST then GET /latest returns the stored sanitized context."""
    payload = _valid_payload()
    post_resp = client.post("/api/v1/context", json=payload)
    assert post_resp.status_code == 201

    get_resp = client.get("/api/v1/context/latest")
    assert get_resp.status_code == 200
    data = get_resp.json()
    assert "payload" in data
    assert data["payload"]["url"] == "http://localhost:8002/"
    assert data["payload"]["sanitized_status"] == "sanitized_only"
    assert len(data["payload"]["detections"]) == 1
    assert "received_at" in data


# ── Forbidden key rejection — top level ──────────────────────────────────────

def test_post_with_top_level_value_key_rejected():
    """Payload containing top-level 'value' key must be rejected."""
    bad = _valid_payload()
    bad["value"] = "FAKE_SECRET_1234"
    resp = client.post("/api/v1/context", json=bad)
    assert resp.status_code in (400, 422)


def test_post_with_top_level_text_key_rejected():
    """Payload containing top-level 'text' key must be rejected."""
    bad = _valid_payload()
    bad["text"] = "FAKE_SECRET_TEXT"
    resp = client.post("/api/v1/context", json=bad)
    assert resp.status_code in (400, 422)


def test_post_with_top_level_rawtext_key_rejected():
    """Payload containing 'rawText' key must be rejected."""
    bad = _valid_payload()
    bad["rawText"] = "FAKE_SECRET_RAW"
    resp = client.post("/api/v1/context", json=bad)
    assert resp.status_code in (400, 422)


def test_post_with_password_key_rejected():
    """Payload containing 'password' key at top level must be rejected."""
    bad = _valid_payload()
    bad["password"] = "SuperSecret123!"
    resp = client.post("/api/v1/context", json=bad)
    assert resp.status_code in (400, 422)


# ── Forbidden key rejection — nested in detection ────────────────────────────

def test_post_with_value_in_detection_rejected():
    """Detection containing 'value' key must be rejected (nested forbidden key)."""
    bad = _valid_payload()
    bad["detections"][0]["value"] = "4111111111111111"  # fake card number
    resp = client.post("/api/v1/context", json=bad)
    assert resp.status_code in (400, 422)


def test_post_with_text_in_detection_rejected():
    """Detection containing 'text' key must be rejected."""
    bad = _valid_payload()
    bad["detections"][0]["text"] = "rahul.sharma@example.com"  # fake email
    resp = client.post("/api/v1/context", json=bad)
    assert resp.status_code in (400, 422)


def test_post_with_deeply_nested_forbidden_key_rejected():
    """
    Deeply nested forbidden key must be rejected.
    e.g. detections[0].metadata.value = "FAKE_SECRET"
    """
    bad = _valid_payload()
    # Add a nested metadata object with a forbidden key
    bad["detections"][0]["metadata"] = {"value": "FAKE_SECRET_NESTED"}
    resp = client.post("/api/v1/context", json=bad)
    assert resp.status_code in (400, 422)


def test_post_with_nested_rawtext_in_list_rejected():
    """Forbidden key inside a list element nested in detections must be rejected."""
    bad = _valid_payload()
    bad["detections"][0]["tags"] = [{"rawText": "secret"}]
    resp = client.post("/api/v1/context", json=bad)
    assert resp.status_code in (400, 422)


# ── Rejected payloads must NOT be stored ────────────────────────────────────

def test_rejected_payload_not_stored_as_latest():
    """After a rejected POST, GET /latest must still return 404 (not store bad data)."""
    bad = _valid_payload()
    bad["value"] = "LEAKED_SECRET"
    resp = client.post("/api/v1/context", json=bad)
    assert resp.status_code in (400, 422)

    # Context must still be empty
    get_resp = client.get("/api/v1/context/latest")
    assert get_resp.status_code == 404


# ── Sanitized status validation ───────────────────────────────────────────────

def test_post_with_wrong_sanitized_status_rejected():
    """Incorrect sanitized_status must be rejected."""
    bad = _valid_payload(sanitized_status="Not Sanitized")
    resp = client.post("/api/v1/context", json=bad)
    assert resp.status_code in (400, 422)


def test_post_with_missing_sanitized_status_rejected():
    """Missing sanitized_status must be rejected."""
    bad = _valid_payload()
    del bad["sanitized_status"]
    resp = client.post("/api/v1/context", json=bad)
    assert resp.status_code in (400, 422)


def test_post_with_empty_sanitized_status_rejected():
    """Empty string sanitized_status must be rejected."""
    bad = _valid_payload(sanitized_status="")
    resp = client.post("/api/v1/context", json=bad)
    assert resp.status_code in (400, 422)


def test_post_with_human_readable_ui_status_rejected():
    """Human-readable UI status string must NOT be accepted in the API payload."""
    bad = _valid_payload(sanitized_status="Sanitized Context — Local Privacy Check Passed")
    resp = client.post("/api/v1/context", json=bad)
    assert resp.status_code in (400, 422)


def test_post_with_camel_case_sanitized_status_accepted():
    """CamelCase 'sanitizedStatus: sanitized_only' must be accepted."""
    payload = _valid_payload()
    del payload["sanitized_status"]
    payload["sanitizedStatus"] = "sanitized_only"
    resp = client.post("/api/v1/context", json=payload)
    assert resp.status_code == 201


# ── Unknown unexpected fields — extra='forbid' ───────────────────────────────

def test_post_with_unknown_top_level_field_rejected():
    """Unknown top-level field must be rejected (extra='forbid')."""
    bad = _valid_payload()
    bad["unknownField"] = "should_not_be_here"
    resp = client.post("/api/v1/context", json=bad)
    assert resp.status_code == 422  # Pydantic validation error


def test_post_with_unknown_detection_field_rejected():
    """Unknown field in a detection object must be rejected (extra='forbid')."""
    bad = _valid_payload()
    bad["detections"][0]["extraField"] = "unexpected"
    resp = client.post("/api/v1/context", json=bad)
    assert resp.status_code == 422


# ── Malformed payload rejection ───────────────────────────────────────────────

def test_post_with_invalid_confidence_rejected():
    """Confidence > 1.0 must be rejected."""
    bad = _valid_payload()
    bad["detections"][0]["confidence"] = 1.5  # invalid
    resp = client.post("/api/v1/context", json=bad)
    assert resp.status_code == 422


def test_post_with_negative_confidence_rejected():
    """Confidence < 0.0 must be rejected."""
    bad = _valid_payload()
    bad["detections"][0]["confidence"] = -0.1
    resp = client.post("/api/v1/context", json=bad)
    assert resp.status_code == 422


def test_post_with_invalid_bbox_rejected():
    """Detection with missing bbox fields must be rejected."""
    bad = _valid_payload()
    bad["detections"][0]["bbox"] = {"x": 100}  # missing y, width, height
    resp = client.post("/api/v1/context", json=bad)
    assert resp.status_code == 422


def test_post_with_negative_timestamp_rejected():
    """Timestamp <= 0 must be rejected."""
    bad = _valid_payload(timestamp=0)
    resp = client.post("/api/v1/context", json=bad)
    assert resp.status_code == 422


def test_post_with_invalid_source_type_rejected():
    """Unknown detection source enum value must be rejected."""
    bad = _valid_payload()
    bad["detections"][0]["source"] = "unknown_source"
    resp = client.post("/api/v1/context", json=bad)
    assert resp.status_code == 422


# ── Clear context ─────────────────────────────────────────────────────────────

def test_clear_context():
    """DELETE /api/v1/context clears stored payload; subsequent GET returns 404."""
    # First store something
    client.post("/api/v1/context", json=_valid_payload())
    assert client.get("/api/v1/context/latest").status_code == 200

    # Clear it
    resp = client.delete("/api/v1/context")
    assert resp.status_code == 200

    # Now should be gone
    assert client.get("/api/v1/context/latest").status_code == 404


# ── Multiple POSTs replace previous ──────────────────────────────────────────

def test_second_post_replaces_first():
    """Second valid POST overwrites the first stored context."""
    payload1 = _valid_payload(url="http://localhost:8000/")
    payload2 = _valid_payload(url="http://localhost:8002/")

    client.post("/api/v1/context", json=payload1)
    client.post("/api/v1/context", json=payload2)

    resp = client.get("/api/v1/context/latest")
    assert resp.status_code == 200
    assert resp.json()["payload"]["url"] == "http://localhost:8002/"


# ── Empty detections are valid ────────────────────────────────────────────────

def test_post_with_empty_detections_accepted():
    """Payload with zero detections (clean page) must be accepted."""
    payload = _valid_payload()
    payload["detections"] = []
    payload["sensitive_elements_detected"] = 0
    resp = client.post("/api/v1/context", json=payload)
    assert resp.status_code == 201
