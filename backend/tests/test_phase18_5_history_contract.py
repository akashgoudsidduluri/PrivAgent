"""
PHASE 18.5 / I-2 — REASONER HISTORY CONTRACT.

Regression coverage for the reported `422 extra_forbidden` on
`history[0].effect` / `history[0].scrollDelta`.

WHAT THIS ESTABLISHES
---------------------
The extension's `requestActionWithBoundedRetry` appends the OBSERVED effect and
the measured scroll delta to the last action before sending it as history. That
is correct and necessary: without it the model cannot tell "I scrolled and it
moved" from "I scrolled and nothing happened", which is exactly the
no-effect loop Phase 18.2 exists to break.

The 422 arose because the backend's `BrowserActionModel` did not declare those
fields while remaining `extra='forbid'` — strict validation meeting a
sender/receiver disagreement. `fcd94ea` added `effect` and `scroll_delta`
(with a `scrollDelta` alias) to the model, so the contract is now aligned.

This file pins that alignment so it cannot silently regress, and it does so
WITHOUT relaxing strictness: `extra='forbid'` stays, and an actually-unknown
field must still be rejected. These are the five history states the user named
— ACTION_NO_EFFECT, ACTION_CHANGED, ACTION_REJECTED, NAVIGATION_RESULT,
PROVIDER_FAILURE — plus the negative control.
"""
import json

import pytest


def _body(history):
    return {
        "task": "open store catalog",
        "context": {
            "url": "http://localhost:4174/",
            "timestamp": 1700000000000,
            "viewport": {"width": 1280, "height": 800},
            "detections": [],
            "total_elements_scanned": 10,
            "sensitive_elements_detected": 0,
            "sanitized_status": "sanitized_only",
        },
        "history": history,
    }


# ── The declared contract ─────────────────────────────────────────────────────

ACTION_NO_EFFECT = {
    "action": "scroll", "direction": "down", "amount": 500,
    "effect": "ACTION_NO_EFFECT", "scrollDelta": 0,
}
ACTION_CHANGED = {
    "action": "scroll", "direction": "down", "amount": 500,
    "effect": "SCROLL_CHANGED", "scrollDelta": 500,
}
ACTION_REJECTED = {
    "action": "click", "target": "element_details",
    "effect": "ACTION_REJECTED", "scrollDelta": 0,
}
NAVIGATION_RESULT = {
    "action": "navigate", "url": "https://example.com/",
    "effect": "URL_NAVIGATION_OBSERVED", "scrollDelta": 0,
}
PROVIDER_FAILURE = {
    "action": "scroll", "direction": "down", "amount": 500,
    "effect": "ACTION_REJECTED", "scrollDelta": 0,
}


@pytest.mark.parametrize("entry", [
    ACTION_NO_EFFECT,
    ACTION_CHANGED,
    ACTION_REJECTED,
    NAVIGATION_RESULT,
    PROVIDER_FAILURE,
], ids=[
    "ACTION_NO_EFFECT", "ACTION_CHANGED", "ACTION_REJECTED",
    "NAVIGATION_RESULT", "PROVIDER_FAILURE",
])
def test_history_state_is_accepted_by_the_strict_model(entry):
    """Every history state the extension produces must survive validation."""
    from app.models import BrowserActionModel

    parsed = BrowserActionModel.model_validate(entry)
    assert parsed.action == entry["action"]
    # The observed effect is preserved, not stripped on the way in.
    assert parsed.effect == entry["effect"]


def test_camel_case_alias_is_accepted_and_normalised():
    """The extension sends `scrollDelta`; the model must bind it, not reject it."""
    from app.models import BrowserActionModel

    parsed = BrowserActionModel.model_validate(ACTION_NO_EFFECT)
    assert parsed.scroll_delta == 0


def test_snake_case_form_is_equally_accepted():
    from app.models import BrowserActionModel

    parsed = BrowserActionModel.model_validate(
        {"action": "scroll", "direction": "down", "amount": 500, "scroll_delta": 7}
    )
    assert parsed.scroll_delta == 7


def test_strictness_is_preserved_for_a_genuinely_unknown_field():
    """NEGATIVE CONTROL.

    The fix aligned the two schemas; it did NOT open the model up. An
    undeclared field must still be rejected, or the 422 would be 'fixed' by
    deleting validation rather than by fixing the contract.
    """
    from app.models import BrowserActionModel
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        BrowserActionModel.model_validate(
            {"action": "scroll", "definitely_not_a_field": "x"}
        )


def test_extra_forbid_remains_set_on_the_model():
    """Belt and braces: the contract itself must still be strict."""
    from app.models import BrowserActionModel

    assert BrowserActionModel.model_config.get("extra") == "forbid"


def test_effect_is_length_bounded():
    """`effect` is a closed vocabulary, not free text the model may inflate."""
    from pydantic import ValidationError
    from app.models import BrowserActionModel

    with pytest.raises(ValidationError):
        BrowserActionModel.model_validate(
            {"action": "scroll", "effect": "E" * 500}
        )


def test_history_payload_round_trips_through_the_agent_request():
    """The full request envelope accepts the history the loop actually sends."""
    from app.models import AgentActionRequest

    req = AgentActionRequest.model_validate(_body([ACTION_NO_EFFECT, ACTION_CHANGED]))
    assert len(req.history) == 2
    assert req.history[0].effect == "ACTION_NO_EFFECT"
    assert req.history[1].effect == "SCROLL_CHANGED"
    # And it serialises back without losing the fields that caused the 422.
    dumped = json.loads(req.model_dump_json(by_alias=True))
    assert "effect" in dumped["history"][0]