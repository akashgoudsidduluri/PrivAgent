"""
POST-17.10 Step 10 — the declared destination actually reaches the reasoner.

WHAT THIS FILE PROVES
─────────────────────
Step 9 MEASURED the provider egress payload and found it to be exactly
``{task, context, previousActions}``: the typed declaration, the active subgoal
and its description were all absent. A ``role = LISTING`` destination therefore
could not influence the route the model chose, and the model went to
``/search.html`` — the one internal page its own system prompt permitted.

Step 10 closes that gap by adding a TYPED field inside ``semantic_context``.
This file proves the four things that must be true of that field on the
BACKEND side, and pins the two things that must NOT be true:

  1. The frozen request schema accepts it unchanged (``semantic_context`` is a
     free ``Dict[str, Any]``; ``extra='forbid'`` applies only at the top level).
     This is what makes the provider-schema answer "NO CHANGE" an honest one.
  2. It is rendered into the user prompt as READ-ONLY, NON-AUTHORITATIVE data.
  3. A ``role`` never acquires a ``destinationUrl`` on the way through.
  4. It carries no key the outbound privacy firewall forbids, at any depth.

And it pins the fail-closed property: a payload whose ``provenance`` is not
``USER_DECLARED_DESTINATION`` is NOT rendered at all, so a model- or
page-derived lookalike can never arrive wearing this schema's clothes.
"""

import json

import pytest

from app.models import AgentContextPayload
from app.reasoner import SYSTEM_PROMPT, _build_user_prompt
from app.security import PayloadSecurityError, verify_payload_invariants

ORIGIN = "http://localhost:4174"

ROLE_ONLY = {
    "provenance": "USER_DECLARED_DESTINATION",
    "role": ["LISTING"],
    "entryUrl": f"{ORIGIN}/",
}


def _prompt(semantic_context, task=None):
    # Step 10.2 (G4): the default task is the trusted channel. Every URL a
    # declaration claims must be one the USER actually typed here; the reasoner
    # re-derives that set from this string alone.
    return _build_user_prompt(
        task=task if task is not None else ("open the store catalog at " + ORIGIN),
        url=f"{ORIGIN}/",
        viewport={"width": 1280, "height": 900},
        screenshot_dimensions=None,
        detections=[],
        history=[],
        steps_used=0,
        max_steps=5,
        page_type="LISTING",
        semantic_context=semantic_context,
    )


def _rendered_block(prompt: str) -> dict:
    """Extract the declared-destination object out of the rendered prompt.

    POST-17.10 Step 10.3 (G6): it is rendered in its own block headed
    ``USER DECLARED DESTINATION``, no longer inside the observed-state block.
    """
    marker = "USER DECLARED DESTINATION"
    if marker not in prompt:
        raise AssertionError("no declared-destination block was rendered")
    brace = prompt.index("{", prompt.index(marker))
    obj, _ = json.JSONDecoder().raw_decode(prompt[brace:])
    return obj


# ── 1. schema ──────────────────────────────────────────────────────────────


def test_frozen_request_schema_needs_no_change():
    """`semantic_context` is a free dict, so no provider schema change is required."""
    ctx = {
        "url": f"{ORIGIN}/",
        "timestamp": 1_700_000_000_000,
        "viewport": {"width": 1280, "height": 900, "scroll_x": 0, "scroll_y": 0},
        "screenshot_dimensions": None,
        "detections": [],
        "total_elements_scanned": 1,
        "sensitive_elements_detected": 0,
        "sanitized_status": "sanitized_only",
        "ocr_metrics": None,
        "semantic_context": {
            "pageType": "LISTING",
            "confidence": 0.99,
            "pageGeneration": 5,
            "declaredDestination": ROLE_ONLY,
        },
    }
    parsed = AgentContextPayload(**ctx)  # must not raise
    assert parsed.semantic_context["declaredDestination"]["role"] == ["LISTING"]


# ── 2. render ──────────────────────────────────────────────────────────────


def test_role_only_declaration_is_rendered():
    block = _rendered_block(_prompt({"declaredDestination": ROLE_ONLY}))
    assert block["provenance"] == "USER_DECLARED_DESTINATION"
    assert block["role"] == ["LISTING"]
    assert block["entryUrl"] == f"{ORIGIN}/"
    # The whole point: a bare role never acquires a URL.
    assert "destinationUrl" not in block


def test_no_url_field_is_present_when_the_user_named_none():
    prompt = _prompt({"declaredDestination": ROLE_ONLY})
    block = _rendered_block(prompt)
    assert set(block) == {"provenance", "role", "entryUrl"}


def test_explicit_url_declaration_is_rendered_verbatim():
    block = _rendered_block(
        _prompt(
            {
                "declaredDestination": {
                    "provenance": "USER_DECLARED_DESTINATION",
                    "destinationUrl": f"{ORIGIN}/results.html",
                }
            },
            # Step 10.2 (G4): the user must have TYPED this URL. Before G4 the
            # backend rendered a destination URL that appeared nowhere in the
            # request — that was the trust-boundary defect.
            task=f"open {ORIGIN}/results.html",
        )
    )
    assert block["destinationUrl"] == f"{ORIGIN}/results.html"
    assert "role" not in block


def test_an_explicit_url_the_user_never_typed_is_not_rendered():
    """G4: the backend may not accept a URL on the strength of its provenance."""
    prompt = _prompt(
        {
            "declaredDestination": {
                "provenance": "USER_DECLARED_DESTINATION",
                "destinationUrl": f"{ORIGIN}/results.html",
            }
        },
        task="open the store catalog",  # no URL at all
    )
    assert "declaredDestination" not in prompt


# ── 3. fail-closed ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "forged",
    [
        {"role": ["LISTING"]},                                    # no provenance
        {"provenance": "MODEL_PROPOSED", "role": ["LISTING"]},   # wrong provenance
        {"provenance": "PAGE_OBSERVED", "role": ["LISTING"]},    # observation-derived
        "not-a-dict",
        None,
    ],
)
def test_a_forged_or_provenanceless_declaration_is_not_rendered(forged):
    """Only a genuine USER_DECLARED_DESTINATION reaches the model."""
    prompt = _prompt({"declaredDestination": forged})
    assert "USER DECLARED DESTINATION" not in prompt


# ── 4. system prompt ───────────────────────────────────────────────────────


def test_system_prompt_states_the_constraint():
    assert "USER_DECLARED_DESTINATION" not in SYSTEM_PROMPT  # provenance is data, not prose
    assert "declaredDestination" in SYSTEM_PROMPT
    # The three prohibitions that make this read-only, non-authoritative data.
    assert "MUST NOT invent a URL from a role" in SYSTEM_PROMPT
    assert 'never treat "entryUrl" as the' in SYSTEM_PROMPT
    assert "never declare the task or the destination complete" in SYSTEM_PROMPT
    # And it must remain subordinate to the existing page-role authority.
    assert "local destination verifier decides satisfaction" in SYSTEM_PROMPT


# ── 5. privacy firewall ────────────────────────────────────────────────────


def _context(semantic_context):
    """The exact shape `routes/agent.py` hands to the firewall."""
    return {
        "url": f"{ORIGIN}/",
        "timestamp": 1_700_000_000_000,
        "viewport": {"width": 1280, "height": 900, "scroll_x": 0, "scroll_y": 0},
        "screenshot_dimensions": None,
        "detections": [],
        "total_elements_scanned": 1,
        "sensitive_elements_detected": 0,
        "sanitized_status": "sanitized_only",
        "ocr_metrics": None,
        "semantic_context": semantic_context,
    }


def test_constraint_keys_survive_the_outbound_firewall():
    """No forbidden key may appear at any nesting depth of the egress context."""
    verify_payload_invariants(_context({"declaredDestination": ROLE_ONLY}))  # must not raise


def test_a_constraint_with_a_forbidden_key_is_blocked():
    """The shape is not merely allowed — a prose/value field in it is still refused."""
    poisoned = dict(ROLE_ONLY)
    poisoned["text"] = "open the store catalog"
    with pytest.raises(PayloadSecurityError):
        verify_payload_invariants(_context({"declaredDestination": poisoned}))


def test_the_constraint_still_survives_the_firewall_when_copied_into_the_prompt():
    """Exactly what the egress firewall already asserts, stated once, honestly.

    STEP 10.3 (G8). This test used to be named
    ``test_the_rendered_prompt_passes_the_firewall`` while rendering no prompt
    at all: it called ``verify_payload_invariants(_context({...ROLE_ONLY}))`` —
    the byte-identical call already made by
    ``test_constraint_keys_survive_the_outbound_firewall`` directly above it.

    The honest fix is to remove the duplicate, not to invent a prompt-rendering
    claim to justify the name. A test that renders a prompt and feeds THAT to
    the firewall would prove nothing new: ``verify_payload_invariants``
    validates the REQUEST payload by design, and the rendered prompt is prompt
    TEXT, not a payload — passing it through would be asserting something the
    firewall does not and should not do.

    So the genuine end-to-end property (the declaration survives the outbound
    firewall) is asserted ONCE, by the test above this one, and the rendering
    property it used to claim is asserted by ``test_role_only_declaration_is_
    rendered`` and its explicit-URL sibling. Both now read the dedicated
    ``USER DECLARED DESTINATION`` block.
    """
    # Rendered: the declaration the model is actually shown.
    prompt = _prompt({"declaredDestination": ROLE_ONLY})
    assert _rendered_block(prompt) == ROLE_ONLY
    # And the payload the firewall guards is unchanged.
    verify_payload_invariants(_context({"declaredDestination": ROLE_ONLY}))
