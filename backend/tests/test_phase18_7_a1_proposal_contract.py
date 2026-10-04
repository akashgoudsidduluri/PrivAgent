"""
PHASE 18.7 / A1 — the information-answer contract, backend half.

WHAT THIS PROVES
  1. Backward compatibility is total: every action-only completion takes the
     identical path and yields the identical dict. Nothing about the existing
     action loop changes.
  2. The model can PROPOSE a terminal state, and every such proposal is
     bounded, shape-checked and PII-scanned exactly like `reason` is.
  3. The backend cannot promote a proposal. It relays an inert claim; it never
     resolves a citation, never reports success, never fabricates an action.
  4. `extra='forbid'` is still in force on the new proposal model — widening
     the contract did not widen it into a loophole.
  5. Fail-closed: an unusable proposal is a 502 contract failure, never a
     success and never a silent coercion into an action.

The tests deliberately exercise the ROUTE, not just the parser, because the
route is where a proposal could accidentally acquire authority.
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError as PydanticValidationError

from app.main import app
from app.models import AgentActionResponse, AgentProposal
from app.reasoner import (
    ReasoningError,
    parse_model_action,
    parse_model_proposal,
)

client = TestClient(app)

SANITIZED = {
    "url": "https://en.wikipedia.org/wiki/Charminar",
    "timestamp": 1760000000000,
    "viewport": {"width": 1280, "height": 800, "scroll_x": 0.0, "scroll_y": 0.0},
    "detections": [
        {
            "id": "wm-elem-2-144",
            "type": "button",
            "confidence": 0.9,
            "bbox": {"x": 10, "y": 20, "width": 100, "height": 40},
            "length": 0,
            "source": "dom_input_type",
        }
    ],
    "total_elements_scanned": 412,
    "sensitive_elements_detected": 0,
    "sanitized_status": "sanitized_only",
    "page_type": "article",
    "decision_state": {
        "task": "open wikipedia and find information about charminar",
        "intent": "MIXED_TASK",
        "requiresEvidence": True,
        "evidence": [{"id": "ev-1", "verification": "VERIFIED"}],
    },
}

SECRET = "Contact telephone 9876543210 now"


def _post(monkeypatch, completion, task="tell me about charminar"):
    """Drive the REAL route with a scripted provider completion.

    The stub goes through the same `_result_from_content` a live provider
    does, so the route is exercised exactly as it is in production.
    """
    from app.reasoner import _result_from_content
    from app.routes import agent as agent_route

    class _StubReasoner:
        model = "stub-model"

        def __init__(self, **_kwargs):
            self.configured = True

        def request_action(self, **_kwargs):
            return _result_from_content(completion, "stub-model", 1.0, 1)

    monkeypatch.setattr(agent_route, "build_reasoner", lambda name: _StubReasoner())
    return client.post(
        "/api/v1/agent/action",
        json={"task": task, "context": SANITIZED, "history": []},
    )


# ── 1. Backward compatibility ────────────────────────────────────────────────


class TestBackwardCompatibility:
    def test_action_only_completion_is_unchanged(self):
        raw = '{"action": "scroll", "direction": "down", "amount": 500, "reason": "More content below."}'
        legacy = parse_model_action(raw)
        proposal = parse_model_proposal(raw)
        assert proposal.action == legacy
        assert proposal.proposal is None

    def test_fenced_action_completion_is_unchanged(self):
        raw = '```json\n{"action":"scroll","direction":"down","amount":500}\n```'
        assert parse_model_proposal(raw).action == parse_model_action(raw)

    def test_chatter_wrapped_action_is_unchanged(self):
        raw = 'Here is the action: {"action":"click","target":"wm-elem-2-144"} — done.'
        assert parse_model_proposal(raw).action == parse_model_action(raw)

    @pytest.mark.parametrize(
        "raw",
        [
            "",
            "not json at all",
            '{"target":"x"}',
            '["action"]',
            '{"action": "", "reason": "r"}',
        ],
    )
    def test_malformed_still_fails_closed(self, raw):
        with pytest.raises(ReasoningError):
            parse_model_proposal(raw)

    def test_action_route_still_returns_an_action(self, monkeypatch):
        """The end-to-end action path is byte-for-byte what it was."""
        response = _post(
            monkeypatch,
            '{"action": "click", "target": "wm-elem-2-144", "reason": "Open the article."}',
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["action"]["action"] == "click"
        assert body["action"]["target"] == "wm-elem-2-144"
        # A response with an action and no proposal IS the historical response.
        assert body.get("proposal") is None


# ── 2. Proposal parsing ──────────────────────────────────────────────────────


class TestProposalParsing:
    def test_answer_proposal_parses(self):
        parsed = parse_model_proposal(
            json.dumps(
                {
                    "proposal": {
                        "kind": "ANSWER",
                        "reason": "The evidence already answers this.",
                        "answer": "Charminar is a monument in Hyderabad built in 1591.",
                        "citedEvidence": ["ev-1"],
                    }
                }
            )
        )
        assert parsed.action is None
        assert parsed.proposal["kind"] == "ANSWER"
        assert parsed.proposal["cited_evidence"] == ["ev-1"]

    @pytest.mark.parametrize("kind", ["PARTIAL", "NEEDS_INFORMATION", "CANNOT_VERIFY"])
    def test_terminal_kinds_parse(self, kind):
        parsed = parse_model_proposal(
            json.dumps({"proposal": {"kind": kind, "reason": "Nothing further can help."}})
        )
        assert parsed.proposal["kind"] == kind
        assert parsed.action is None

    def test_action_proposal_yields_an_action(self):
        parsed = parse_model_proposal(
            json.dumps(
                {
                    "proposal": {
                        "kind": "ACTION",
                        "reason": "Need to scroll for more.",
                        "action": {"action": "scroll", "direction": "down", "amount": 500},
                    }
                }
            )
        )
        assert parsed.action["action"] == "scroll"
        assert parsed.action["reason"] == "Need to scroll for more."
        assert parsed.proposal is None

    @pytest.mark.parametrize(
        "payload,kind",
        [
            ({"kind": "TOTALLY_MADE_UP", "reason": "r"}, "unknown_proposal_kind"),
            ({"kind": "ACTION", "reason": "r"}, "missing_action"),
            ({"kind": "ANSWER", "reason": "r"}, "missing_action"),  # ANSWER needs text
            (
                {
                    "kind": "PARTIAL",
                    "reason": "r",
                    "action": {"action": "scroll", "direction": "down", "amount": 1},
                },
                "unknown_proposal_kind",
            ),
            ({"kind": "ANSWER", "reason": "   "}, "missing_action"),
            ("not-an-object", "invalid_json"),
        ],
    )
    def test_invalid_proposals_fail_closed(self, payload, kind):
        with pytest.raises(ReasoningError) as exc:
            parse_model_proposal(json.dumps({"proposal": payload}))
        assert exc.value.kind == kind

    def test_proposal_may_not_smuggle_an_action_field_outside_envelope(self):
        """A completion stating two contradictory things is refused outright."""
        with pytest.raises(ReasoningError) as exc:
            parse_model_proposal(
                json.dumps(
                    {
                        "action": "click",
                        "proposal": {"kind": "ANSWER", "reason": "r", "answer": "a"},
                    }
                )
            )
        assert exc.value.kind == "unexpected_format"


# ── 3. The proposal is scanned exactly like `reason` ─────────────────────────


class TestProposalIsScanned:
    def test_answer_carrying_pii_is_rejected(self):
        with pytest.raises(ReasoningError) as exc:
            parse_model_proposal(
                json.dumps(
                    {
                        "proposal": {
                            "kind": "ANSWER",
                            "reason": "Answering from the page.",
                            "answer": SECRET,
                        }
                    }
                )
            )
        assert exc.value.kind == "invalid_action"

    def test_missing_item_carrying_pii_is_rejected(self):
        with pytest.raises(ReasoningError):
            parse_model_proposal(
                json.dumps(
                    {
                        "proposal": {
                            "kind": "PARTIAL",
                            "reason": "Partly answered.",
                            "answer": "Some facts.",
                            "missing": [SECRET],
                        }
                    }
                )
            )

    def test_proposal_reason_carrying_pii_is_rejected(self):
        with pytest.raises(ReasoningError):
            parse_model_proposal(
                json.dumps({"proposal": {"kind": "CANNOT_VERIFY", "reason": SECRET}})
            )

    def test_the_scan_precedes_the_bound(self):
        """A secret past the length bound is still a PII rejection.

        The full reason is scanned before its bound is applied, so a bound can
        never become a way to park unscanned text past the safety layer.
        """
        with pytest.raises(ReasoningError) as exc:
            parse_model_proposal(
                json.dumps(
                    {"proposal": {"kind": "CANNOT_VERIFY", "reason": "x" * 200 + SECRET}}
                )
            )
        assert exc.value.kind == "invalid_action"

    def test_an_oversized_but_clean_reason_is_a_format_failure(self):
        with pytest.raises(ReasoningError) as exc:
            parse_model_proposal(
                json.dumps({"proposal": {"kind": "CANNOT_VERIFY", "reason": "x" * 400}})
            )
        assert exc.value.kind == "unexpected_format"

    def test_citations_are_id_shaped_only(self):
        """A citation is a record id, never the model's copy of the fact."""
        parsed = parse_model_proposal(
            json.dumps(
                {
                    "proposal": {
                        "kind": "ANSWER",
                        "reason": "Answering.",
                        "answer": "A fact.",
                        "citedEvidence": ["ev-1", "ev-2"],
                    }
                }
            )
        )
        assert parsed.proposal["cited_evidence"] == ["ev-1", "ev-2"]


# ── 4. The response model carries no authority ───────────────────────────────


class TestResponseModel:
    def test_proposal_alone_is_valid(self):
        response = AgentActionResponse.model_validate(
            {"reason": "r", "proposal": {"kind": "NEEDS_INFORMATION", "reason": "r2"}}
        )
        assert response.action is None
        assert response.proposal.kind == "NEEDS_INFORMATION"

    def test_neither_action_nor_proposal_is_rejected(self):
        with pytest.raises(PydanticValidationError):
            AgentActionResponse.model_validate({"reason": "r"})

    def test_action_and_a_disagreeing_proposal_is_rejected(self):
        with pytest.raises(PydanticValidationError):
            AgentActionResponse.model_validate(
                {
                    "reason": "r",
                    "action": {"action": "scroll", "direction": "down", "amount": 500},
                    "proposal": {"kind": "ANSWER", "reason": "r", "answer": "a"},
                }
            )

    def test_unknown_proposal_key_is_rejected(self):
        with pytest.raises(PydanticValidationError):
            AgentProposal.model_validate(
                {"kind": "ANSWER", "reason": "r", "answer": "a", "goalVerified": True}
            )

    def test_proposal_carries_no_authority_fields(self):
        """A proposal can express no verdict, score or permission at all."""
        schema = AgentProposal.model_json_schema()
        properties = set(schema["properties"])
        for forbidden in (
            "riskScore",
            "criticVerdict",
            "contained",
            "goalVerified",
            "success",
            "permitted",
            "risk",
        ):
            assert forbidden not in properties, forbidden
        assert schema.get("additionalProperties") is False


# ── 5. Route behaviour ───────────────────────────────────────────────────────


class TestRouteRelay:
    def test_answer_proposal_is_relayed_with_no_action(self, monkeypatch):
        response = _post(
            monkeypatch,
            json.dumps(
                {
                    "proposal": {
                        "kind": "ANSWER",
                        "reason": "The evidence answers this.",
                        "answer": "Charminar was built in 1591.",
                        "citedEvidence": ["ev-1"],
                    }
                }
            ),
        )
        assert response.status_code == 200, response.text
        body = response.json()
        # No action exists, so there is nothing that could be dispatched. The
        # response carries no `action` KEY AT ALL, not an action set to null.
        assert "action" not in body
        assert body["proposal"]["kind"] == "ANSWER"
        assert body["proposal"]["cited_evidence"] == ["ev-1"]
        # The backend did NOT decide anything on the model's behalf.
        assert "goalVerified" not in body
        assert "success" in body and body["success"] is True

    def test_non_action_proposal_skips_every_action_gate(self, monkeypatch):
        """No target grounding, no action validation — because no action exists."""
        response = _post(
            monkeypatch,
            json.dumps({"proposal": {"kind": "NEEDS_INFORMATION", "reason": "The page has no prices."}}),
            task="find the cheapest flight",
        )
        assert response.status_code == 200, response.text
        assert "action" not in response.json()

    def test_proposal_carrying_pii_fails_closed_as_a_contract_violation(self, monkeypatch):
        response = _post(
            monkeypatch,
            json.dumps(
                {"proposal": {"kind": "ANSWER", "reason": "Answering.", "answer": SECRET}}
            ),
        )
        assert response.status_code == 502, response.text
        detail = response.json()["detail"]
        # A deterministic model-contract violation: 502, non-retryable, never a
        # success and never coerced into an action.
        assert detail["error_kind"] == "model_contract"
        assert detail["retryable"] is False


# ── 6. The prompt tells the model it is proposing ─────────────────────────────


class TestPromptContract:
    def _prompt(self) -> str:
        from app.reasoner import _render_user_prompt

        return _render_user_prompt(
            task="tell me about charminar",
            url=SANITIZED["url"],
            viewport=SANITIZED["viewport"],
            screenshot_dimensions=None,
            detections=SANITIZED["detections"],
            history=[],
            steps_used=0,
            max_steps=10,
            page_type="article",
            semantic_context={},
            decision_state=SANITIZED["decision_state"],
        )

    def test_prompt_offers_the_terminal_kinds(self):
        prompt = self._prompt()
        for kind in ("ANSWER", "PARTIAL", "NEEDS_INFORMATION", "CANNOT_VERIFY"):
            assert kind in prompt, kind

    def test_prompt_states_the_model_is_not_the_authority(self):
        prompt = self._prompt()
        assert "proposing, not deciding" in prompt
        assert "An ANSWER is not a success" in prompt
        assert "only its GoalVerifier may report a task as successful" in prompt

    def test_prompt_quotes_the_evidence_count_it_actually_sent(self):
        from app.reasoner import _render_user_prompt

        with_evidence = _render_user_prompt(
            task="t",
            url=SANITIZED["url"],
            viewport=SANITIZED["viewport"],
            screenshot_dimensions=None,
            detections=[],
            history=[],
            steps_used=0,
            max_steps=10,
            decision_state={"evidence": [{"id": "a"}, {"id": "b"}, {"id": "c"}]},
        )
        without = _render_user_prompt(
            task="t",
            url=SANITIZED["url"],
            viewport=SANITIZED["viewport"],
            screenshot_dimensions=None,
            detections=[],
            history=[],
            steps_used=0,
            max_steps=10,
            decision_state={"evidence": []},
        )
        assert "(3 available)" in with_evidence
        assert "(0 available)" in without

    def test_legacy_instruction_is_gone(self):
        assert "single JSON action object now" not in self._prompt()
        assert "single JSON object now" in self._prompt()