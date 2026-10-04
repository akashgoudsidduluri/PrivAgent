"""
PHASE 18.5 / I-3 — MODEL CONTRACT vs PROVIDER OUTAGE.

Regression coverage for the observed failure where a model-emitted `reason`
over the 300-character limit was rejected as HTTP 503 "Service Unavailable",
losing an entire turn that had already produced a structurally valid action.

THE CONTRACT DECISION UNDER TEST
--------------------------------
`reason` is DIAGNOSTIC prose. It never selects, grounds, authorizes or
executes anything. It is therefore BOUNDED, not GATING: exceeding its limit
clamps the field and the action survives to be judged by every real authority
(grounding, M5, Security Critic, containment, effect verification).

DECISION fields (`text`, `option`, `target`, `url`, `direction`) decide what
the agent DOES and are still hard-rejected. Those bounds are asserted here so
the clamp cannot be used to quietly relax them.

Model contract failures are reported as 502 `model_contract`; genuine provider
faults stay 503. Asserted both ways so neither class can absorb the other.
"""
import pytest


# ── Unit: the field-limit contract itself ─────────────────────────────────────

def test_oversized_decision_field_is_still_rejected():
    """DECISION fields must NOT be clamped. Over-length `text` is unsafe."""
    from app.reasoner import MAX_TEXT_CHARS, parse_model_action
    import json

    payload = json.dumps({
        "action": "type",
        "target": "search_box",
        "text": "x" * (MAX_TEXT_CHARS + 50),
    })
    with pytest.raises(Exception) as exc:
        parse_model_action(payload)
    assert "exceeds" in str(exc.value)


def test_oversized_decision_target_is_still_rejected():
    """A too-long target is ungroundable, not merely verbose."""
    from app.reasoner import MAX_PROMPT_FIELD_CHARS, parse_model_action
    import json
    from app.reasoner import ReasoningError

    payload = json.dumps({
        "action": "click",
        "target": "t" * (MAX_PROMPT_FIELD_CHARS + 20),
    })
    with pytest.raises(ReasoningError):
        parse_model_action(payload)


def test_oversized_reason_is_clamped_and_action_survives():
    """DIAGNOSTIC `reason` is bounded, not gating."""
    from app.reasoner import MAX_REASON_CHARS, parse_model_action, last_clamped_fields
    import json

    payload = json.dumps({
        "action": "scroll",
        "direction": "down",
        "amount": 500,
        "reason": "y" * 4000,
    })
    parsed = parse_model_action(payload)

    # The action survived intact...
    assert parsed["action"] == "scroll"
    assert parsed["direction"] == "down"
    assert parsed["amount"] == 500
    # ...and the bound is unchanged and actually applied.
    assert len(parsed["reason"]) == MAX_REASON_CHARS
    assert "reason" in last_clamped_fields


def test_short_reason_is_not_marked_as_clamped():
    from app.reasoner import parse_model_action, last_clamped_fields
    import json

    parse_model_action(json.dumps({"action": "scroll", "reason": "short and fine"}))
    assert "reason" not in last_clamped_fields


def test_clamp_does_not_weaken_the_pii_scan_on_reason():
    """The bound must never become a way past the text-safety layer.

    The scan runs on the FULL unclamped reason, so sensitive text sitting
    beyond the 300-char bound is still rejected rather than trimmed away.
    """
    from app.reasoner import parse_model_action, ReasoningError
    import json

    padded = "a" * 400 + " account 4111111111111111 "
    payload = json.dumps({"action": "scroll", "reason": padded})
    with pytest.raises(ReasoningError) as exc:
        parse_model_action(payload)
    # A safety rejection, not a silent clamp.
    assert "text-safety" in str(exc.value) or "reason rejected" in str(exc.value)


def test_clamp_records_names_not_content():
    """Telemetry must carry field NAMES only, never the model's prose."""
    from app.reasoner import parse_model_action, last_clamped_fields
    import json

    secret = "z" * 500
    parse_model_action(json.dumps({"action": "scroll", "reason": secret}))
    assert last_clamped_fields == ["reason"]
    # None of the clamped content may appear in the record.
    assert not any("z" * 10 in item for item in last_clamped_fields)