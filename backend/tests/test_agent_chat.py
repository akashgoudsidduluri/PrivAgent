"""
FINAL ACCEPTANCE AUDIT — the conversational endpoint.

These tests pin the SECURITY SHAPE of `POST /api/v1/agent/chat`, not the wording
of any model's answer:

  * the request model has nowhere to put page data, and an attempt to attach it
    is refused (422) rather than silently widened;
  * the answer path is exercised with the deterministic mock reasoner, so this
    suite needs no network and no credentials;
  * an answer that carries a raw sensitive VALUE is withheld, and one that merely
    contains a capitalised technical phrase is NOT withheld (the observed
    false positive that withheld an ordinary answer about TCP vs UDP);
  * when reasoning is unavailable the route fails with a typed 503 — never an
    empty answer and never a fabricated one.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app import config
from app.reasoner import CHAT_VALUE_RULES, CHAT_WITHHELD, _screen_chat_answer, chat_answer


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture()
def mock_reasoner(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config, "REASONER_MODE", "mock")


def test_chat_returns_a_plain_answer(client: TestClient, mock_reasoner: None) -> None:
    resp = client.post("/api/v1/agent/chat", json={"task": "Hi"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["success"] is True
    assert data["answer"].strip()
    # No action, no proposal, no context: this route cannot dispatch anything.
    assert "action" not in data
    assert "proposal" not in data
    assert "context" not in data


def test_chat_request_has_nowhere_to_put_page_context(client: TestClient, mock_reasoner: None) -> None:
    """The shape is the control: attaching a page payload is a hard 422."""
    resp = client.post(
        "/api/v1/agent/chat",
        json={
            "task": "Hi",
            "context": {"url": "https://example.com", "detections": [{"id": "x"}]},
        },
    )
    assert resp.status_code == 422


def test_chat_rejects_an_empty_message(client: TestClient, mock_reasoner: None) -> None:
    assert client.post("/api/v1/agent/chat", json={"task": ""}).status_code == 422
    assert client.post("/api/v1/agent/chat", json={"task": "   "}).status_code == 422


def test_chat_fails_typed_when_reasoning_is_unavailable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.reasoner import ReasoningError

    def _boom(_task: str):
        raise ReasoningError("no provider", retryable=False, kind="unconfigured")

    monkeypatch.setattr("app.routes.agent.chat_answer", _boom)
    resp = client.post("/api/v1/agent/chat", json={"task": "Hi"})
    assert resp.status_code == 503
    # The failure detail is fixed copy; no internal kind, key or stack crosses.
    assert "unconfigured" not in resp.text.lower()


def test_answer_screen_withholds_a_raw_value() -> None:
    withheld = _screen_chat_answer("Sure — the card number is 4111 1111 1111 1111.")
    assert withheld == CHAT_WITHHELD
    assert "4111" not in withheld


def test_answer_screen_does_not_withhold_ordinary_technical_prose() -> None:
    # REAL observed false positive: "Transmission Control" was reported as
    # `person_name`, which withheld the whole answer to "Explain TCP vs UDP".
    prose = (
        "TCP (Transmission Control Protocol) is connection-oriented and guarantees "
        "delivery; UDP is connectionless and does not."
    )
    assert _screen_chat_answer(prose) == prose


def test_answer_screen_value_classes_match_the_extension_egress_screen() -> None:
    # The backend screen and the extension's authoritative user-facing screen must
    # agree about what a raw value is. `person_name` is deliberately absent from
    # both for this path.
    assert "person_name" not in CHAT_VALUE_RULES
    assert {"credit_card", "account_number", "phone"} <= CHAT_VALUE_RULES


def test_mock_chat_answer_is_plainly_a_mock(mock_reasoner: None) -> None:
    answer, model = chat_answer("What is machine learning?")
    assert model == "mock"
    assert "Mock answer" in answer
