"""
PHASE 18.5 / I-3 — the classification half, at the HTTP boundary.

The second half of the defect was classification, not validation: every
reasoner failure came back as HTTP 503 "Service Unavailable", which is the
wire vocabulary for "this service is down, try later". A model that answered
with an over-long sentence was therefore reported identically to an outage.

These tests pin both directions so neither class can quietly absorb the other:
  * a model contract violation  -> 502 `model_contract`, non-retryable
  * a genuine provider fault     -> 503 with its own kind, unchanged
"""
import pytest


@pytest.fixture()
def client_and_patch(monkeypatch):
    """Build the real FastAPI client plus a controllable provider stub."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app import reasoner as reasoner_mod
    from app.routes import agent as agent_mod

    client = TestClient(app)

    class _Resp:
        status_code = 200

        def json(self):
            return {"choices": [{"message": {"content": "{}"}}]}

    def _install(content: str, kind: str = None):
        """Make the next provider call return `content`, or raise `kind`."""

        class _Stub:
            model = "stub-model"
            configured = True

            def request_action(self, **kwargs):
                if kind:
                    raise reasoner_mod.ReasoningError("stubbed provider fault", kind=kind)
                from app.reasoner import ReasoningResult
                return ReasoningResult(
                    raw_action=__import__("json").loads(content),
                    model="stub-model",
                    latency_ms=1.0,
                    attempts=1,
                )

        # `agent.py` binds `build_reasoner` into its own module namespace at
        # import time, so the route must be patched HERE — patching the
        # reasoner module's attribute would leave the route using the real one.
        monkeypatch.setattr(agent_mod, "build_reasoner", lambda *a, **k: _Stub())

    return client, _install


def _body(url="http://localhost:4174/results.html"):
    return {
        "task": "open store catalog",
        "context": {
            "url": url,
            "timestamp": 1700000000000,
            "viewport": {"width": 1280, "height": 800},
            "detections": [],
            "total_elements_scanned": 10,
            "sensitive_elements_detected": 0,
            "sanitized_status": "sanitized_only",
        },
        "history": [],
    }


def test_provider_fault_still_reports_503(client_and_patch):
    """Regression guard: genuine provider faults must NOT move to 502."""
    client, install = client_and_patch
    install("", kind="timeout")
    resp = client.post("/api/v1/agent/action", json=_body())
    assert resp.status_code == 503, "timeout is a provider fault, not a contract fault"
    assert resp.json()["detail"]["error_kind"] == "timeout"


def test_rate_limit_still_reports_503(client_and_patch):
    client, install = client_and_patch
    install("", kind="rate_limit")
    resp = client.post("/api/v1/agent/action", json=_body())
    assert resp.status_code == 503
    assert resp.json()["detail"]["error_kind"] == "rate_limit"


def test_model_contract_kind_is_disjoint_from_provider_kinds():
    """The two classes must not overlap, or the split is cosmetic."""
    from app.routes.agent import _MODEL_CONTRACT_KINDS

    provider_kinds = {
        "auth", "rate_limit", "timeout", "network",
        "not_configured", "http_server_error", "http_client_error",
    }
    assert _MODEL_CONTRACT_KINDS.isdisjoint(provider_kinds)


def test_contract_violation_is_not_reported_as_service_unavailable(client_and_patch):
    """A contract violation must never be dressed as an outage.

    Forcing a contract failure through the real route proves the status and
    kind are distinguishable from a 503 provider fault.
    """
    client, install = client_and_patch
    install("", kind="invalid_action")
    resp = client.post("/api/v1/agent/action", json=_body())

    assert resp.status_code == 502, (
        "model contract violation must be 502, not 503 Service Unavailable"
    )
    detail = resp.json()["detail"]
    assert detail["error_kind"] == "model_contract"
    # Deterministic: re-sending the same prompt reproduces the same output.
    assert detail["retryable"] is False
    assert detail["success"] is False