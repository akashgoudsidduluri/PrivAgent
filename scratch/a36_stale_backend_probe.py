"""A3/A6 — is the `decision_state` payload contract still sound?

ORIGIN
This probe was written to answer one question about a real run: why did
POST /api/v1/agent/action return

    [{"type": "extra_forbidden",
      "loc": ["body", "context", "decision_state"], ...}]

when the extension was sending a field it had every right to send?

Answer: the uvicorn serving port 8010 had been running for ~3.9 hours WITHOUT
--reload, started before the A3 change landed, so its in-memory
`AgentContextPayload` predated the field. `extra='forbid'` then rejected it.
It was a stale process, not a contract defect and not a weakened schema. See
docs/evidence/post-17-10/audit/a36_422_root_cause.json.

WHY IT STILL EXISTS
That field has since landed, so the original question is settled. What is NOT
settled is whether the contract it belonged to is still intact — `extra='forbid'`
is the property that made the 422 a safe failure in the first place, and it is
exactly the kind of guarantee that erodes silently during ordinary refactoring.

So the probe keeps the parts that remain meaningful and drops the part that has
become historical:

  KEPT   the observed 422 prefix, as the record of what actually happened;
  KEPT   a payload carrying `decision_state` still validates;
  KEPT   a genuinely unknown field is still rejected — the strictness check.

  DROPPED the "HEAD does not have the field" assertion. It was a hypothesis
  guard for the original investigation. HEAD does have the field now, because
  A3/A6 landed, so the assertion fired forever and turned the probe into a
  permanent false alarm. A check that is always red teaches a reader to ignore
  red.

Run:  cd backend && ./.venv/bin/python ../scratch/a36_stale_backend_probe.py
"""
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.models import AgentContextPayload  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
AUDIT = ROOT / "docs/evidence/post-17-10/audit/a36_422_root_cause.json"

# ── 1. The historical record, asserted so it cannot be quietly rewritten ─────
audit = json.loads(AUDIT.read_text())
prior = audit["observation"]["priorNetwork"][0]
assert prior["status"] == 422, prior["status"]
detail = prior["detailPrefix"]
assert detail.startswith(
    '[{"type":"extra_forbidden","loc":["body","context","decision_state"]'
), detail[:120]
print("recorded rejection :", detail[:118])

# The exact shape the extension sends at runtime.
sent_state = {
    "task": "open wikipedia and find information about charminar",
    "intent": "MIXED_TASK",
    "requiresEvidence": True,
    "activeSubgoal": 'Enter search query "wikipedia information about" into search',
    "pendingCriteria": [],
    "completedCriteria": [],
    "page": {"url": "https://en.wikipedia.org/wiki/Charminar", "pageType": "ARTICLE"},
    "lastAction": {"kind": "navigate", "status": "succeeded"},
    "destination": None,
    "goal": None,
    "evidenceCount": 0,
    "recovery": None,
}


def base_payload(**extra):
    return {
        "url": "https://en.wikipedia.org/wiki/Charminar",
        "timestamp": 1760000000000,
        "viewport": {"width": 1280, "height": 800, "scroll_x": 0.0, "scroll_y": 0.0},
        "detections": [],
        "total_elements_scanned": 0,
        "sensitive_elements_detected": 0,
        "sanitized_status": "sanitized_only",
        **extra,
    }


# ── 2. The declared field is declared ───────────────────────────────────────
accepted = AgentContextPayload.model_validate(base_payload(decision_state=sent_state))
print("accepts decision_state:", isinstance(accepted.decision_state, dict))
print("round-tripped keys    :", sorted((accepted.decision_state or {}).keys()))

# ── 3. AND, the property that made the 422 safe: extra='forbid' is intact ────
try:
    AgentContextPayload.model_validate(base_payload(totally_unknown_field={"x": 1}))
except Exception as exc:  # noqa: BLE001
    print("unknown field rejected: True")
    print("  ->", str(exc).splitlines()[1].strip() if len(str(exc).splitlines()) > 1 else exc)
else:
    print("unknown field rejected: False  <-- CONTRACT WEAKENED")
    raise SystemExit(1)

# ── 4. The declared field is still optional, so an older extension still works ─
without = AgentContextPayload.model_validate(base_payload())
print("payload without decision_state still valid:", without.decision_state is None)

print("\nAll decision_state contract checks passed.")