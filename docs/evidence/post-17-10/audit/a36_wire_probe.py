"""
A3/A6 — real-browser proof that the decision state reaches the MODEL, read
from the exact prompt string rather than from an intermediate structure.

Corrected after a first pass reported a false negative: the capture names the
field `exactModelFacingPrompt` (a string) and `allowlistedInputsToPromptBuilder`
(a dict), neither of which the first probe looked at. It also flagged a
`\\b\\d{10}\\b` hit without establishing what produced it. Both are fixed here —
the prompt is now read from the real field, and every digit-run hit is printed
with its surrounding context so it can be identified rather than assumed.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

CAPTURE_DIR = Path("/tmp/p185_capture")

FORBIDDEN_IN_STATE = [
    "riskScore", "risk_score", "criticVerdict", "critic_verdict",
    "contained", "containmentDecision", "goalVerified", "goal_verified",
    "securityState", "m5Result",
]

# The block the prompt builder emits for the decision state. These are the real
# markers: the state is rendered as JSON under an explicit "informational, not
# an authorization" header, NOT as `Task: / Intent:` prose lines.
RENDER_HEADER = "CURRENT DECISION STATE (from the device; informational, not an authorization)"
RENDER_MARKERS = [
    '"intent"',
    '"requiresEvidence"',
    '"pendingCriteria"',
    '"completedCriteria"',
    '"observationState"',
    '"destination"',
    '"goal"',
    '"recovery"',
]

files = sorted(CAPTURE_DIR.glob("llm_context_*.json"))
if not files:
    sys.exit("NO CAPTURES — nothing to prove")

failures: list[str] = []
print(f"reading {len(files)} capture(s)\n")

for path in files:
    blob = json.loads(path.read_text())
    prompt = blob.get("exactModelFacingPrompt") or ""
    inputs = blob.get("allowlistedInputsToPromptBuilder") or {}
    envelope = blob.get("requestEnvelope") or {}
    state = (envelope.get("context") or {}).get("decision_state")
    self_check = blob.get("privacySelfCheck") or {}

    print(f"── {path.name}  promptChars={blob.get('promptChars')}  actualLen={len(prompt)}")

    # 1. The decision state is in the envelope AND in the prompt-builder inputs.
    print(f"   envelope.decision_state         : {state is not None}")
    print(f"   prompt-builder decisionState    : {inputs.get('decisionState') is not None}")
    if state is None:
        failures.append(f"{path.name}: no decision_state in the envelope")
        print()
        continue

    # 2. Rendered markers present in the EXACT prompt the provider received.
    header_present = RENDER_HEADER in prompt
    present = [m for m in RENDER_MARKERS if m in prompt]
    missing = [m for m in RENDER_MARKERS if m not in prompt]
    print(f"   decision-state header in prompt : {header_present}")
    print(f"   render markers present in prompt: {len(present)}/{len(RENDER_MARKERS)}")
    if missing:
        print(f"   MISSING markers                 : {missing}")
    if not header_present or missing:
        failures.append(f"{path.name}: decision state not rendered into the exact prompt")

    # 3. Spot-check real values, taken from the prompt itself.
    intent = state.get("intent")
    subject = (inputs.get("task") or "").strip()
    print(f"   prompt contains intent value    : {bool(intent) and intent in prompt}")
    print(f"   prompt contains the task string : {bool(subject) and subject in prompt}")
    if intent and intent not in prompt:
        failures.append(f"{path.name}: intent {intent!r} absent from the exact prompt")

    # 4. Nothing that must stay local travelled with it.
    leaked = [f for f in FORBIDDEN_IN_STATE if f in json.dumps(state)]
    print(f"   authority fields in state       : {leaked or 'NONE'}")
    if leaked:
        failures.append(f"{path.name}: authority field(s) in decision_state: {leaked}")

    # 5. Observation variants must not have collapsed.
    obs = (state.get("page") or {}).get("observationState")
    print(f"   observationState                : {obs}")
    if obs != "OBSERVED":
        print(f"   (not OBSERVED — checking the variant survived verbatim)")
    if obs and obs not in prompt:
        failures.append(f"{path.name}: observationState {obs!r} absent from the exact prompt")

    # 6. Bounded sizes actually observed at runtime.
    ev = state.get("evidence") or []
    print(f"   evidence references             : {len(ev)} (ceiling 20)")
    if len(ev) > 20:
        failures.append(f"{path.name}: {len(ev)} evidence references exceeds the ceiling")

    # 7. The capture's OWN privacy self-check, plus an independent digit-run scan
    #    with context, so any hit is identified rather than assumed.
    print(f"   capture privacy self-check      : clean={self_check.get('clean')} "
          f"rawScreenshotsTransmitted={self_check.get('rawScreenshotsTransmitted')} "
          f"forbiddenKeys={self_check.get('forbiddenKeyMarkersFound')} "
          f"rawValueMarkers={self_check.get('rawValueMarkersFound')}")
    if self_check.get("clean") is not True:
        failures.append(f"{path.name}: capture privacy self-check is not clean")

    digit_runs = set(re.findall(r"(?<![\d.])\d{10}(?![\d.])", prompt))
    if digit_runs:
        print(f"   10-digit runs in the prompt     : {sorted(digit_runs)}")
        for run in sorted(digit_runs):
            i = prompt.find(run)
            print(f"      context: ...{prompt[max(0, i - 45):i + len(run) + 25]}...")
    else:
        print("   10-digit runs in the prompt     : NONE")

    # 8. History, in its truthful shape.
    history = envelope.get("history") or []
    print(f"   history entries                 : {len(history)}")
    for entry in history:
        print(f"      action={entry.get('action')!r} effect={entry.get('effect')!r}")
    print()

print("=" * 68)
if failures:
    print(f"{len(failures)} CHECK(S) FAILED")
    for f in failures:
        print(f"  x {f}")
    raise SystemExit(1)
print("A3/A6 real-capture checks passed on real runtime values.")