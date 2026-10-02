"""STEP 10.4 Part 8 diagnostic — capture the RAW model reason and score it locally.

Read-only. Calls the real provider in-process, prints the model's raw output
and the local `scan_reason_text` verdict for the reason it produced, so a
rejection can be attributed to an exact span instead of guessed at.

Rate limit: Groq free tier is ~3 req/min, so calls are spaced by the caller.
"""
from __future__ import annotations

import json
import sys
import time

sys.path.insert(0, "backend")

from app.text_safety import REASON_NAME_PATTERN, scan_reason_text  # noqa: E402


def build_prompt(task: str) -> str:
    """A faithful stand-in for the prompt main.py sends, so the model reasons
    about the same thing it would in production."""
    return f"""You are a browser automation reasoner. Reply with ONE JSON object only.

TASK: {task}

CURRENT PAGE OBSERVATION (this is what you are looking at, NOT user intent):
- url: http://localhost:4174/
- pageType: UNKNOWN (confidence 0.10)
- interactive elements:
  - btn-shop-now  (button)  "Shop Now"
  - btn-login-cta (button)  "Sign In"
  - brand-link   (link)    "ApexCart"

USER DECLARED DESTINATION (from the user's own request - NOT observed, NOT
proof of arrival, NOT yours to declare complete):
{{"provenance": "USER_DECLARED_DESTINATION", "role": ["LISTING"]}}

Respond with exactly:
{{"action": "...", "target": "...", "reason": "..."}}

The `reason` is a short human-readable sentence explaining the action. It must
never contain a person's name, an email address, a phone number or any account
value. Name the UI control you acted on, not a person.
"""


DETECTIONS = [
    {"id": "btn-login-cta", "type": "button", "confidence": 0.95,
     "bbox": {"x": 441, "y": 297, "width": 186, "height": 43}, "length": 15,
     "source": "dom_attribute", "selector": "#btn-login-cta", "is_partially_visible": False},
    {"id": "btn-shop-now", "type": "button", "confidence": 0.95,
     "bbox": {"x": 648, "y": 296, "width": 191, "height": 45}, "length": 14,
     "source": "dom_attribute", "selector": "#btn-shop-now", "is_partially_visible": False},
    {"id": "brand-link", "type": "link", "confidence": 0.95,
     "bbox": {"x": 32, "y": 16, "width": 125, "height": 28}, "length": 8,
     "source": "dom_attribute", "selector": "#brand-link", "is_partially_visible": False},
]

SEMANTIC = {
    "pageType": "UNKNOWN", "confidence": 0.1, "pageState": "populated",
    "pageGeneration": 3, "entities": [],
    "affordances": [
        {"id": "affordance-btn-shop-now", "type": "CLICK",
         "requiresConfirmation": False, "description": "Shop Now button"},
    ],
    "workflow": None, "promptInjectionDetected": False, "facts": [],
    "declaredDestination": {"provenance": "USER_DECLARED_DESTINATION", "role": ["LISTING"]},
}


def main() -> int:
    from app import config
    from app import reasoner as R
    from app.reasoner import GroqReasoner

    task = sys.argv[1] if len(sys.argv) > 1 else "open the store catalog"

    # Intercept the raw model content at the scan boundary so a rejection can
    # be attributed to an exact span. Nothing in app/ is modified; this is a
    # process-local monkeypatch inside a diagnostic script.
    captured: list[str] = []
    real_parse = R.parse_model_action

    def spy(content: str):
        captured.append(content)
        return real_parse(content)

    R.parse_model_action = spy

    provider = GroqReasoner()
    print(f"provider={type(provider).__name__} model={config.GROQ_MODEL}")

    n_calls = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    for i in range(1, n_calls + 1):
        if i > 1:
            time.sleep(70)
        captured.clear()
        try:
            provider.request_action(
                task=task,
                url="http://localhost:4174/",
                detections=DETECTIONS,
                history=[],
                viewport={"width": 1280, "height": 757, "scroll_x": 0, "scroll_y": 0},
                screenshot_dimensions={"width": 1280, "height": 757},
                page_type="landing",
                semantic_context=SEMANTIC,
            )
            outcome = "ACCEPTED by scan_reason_text"
        except Exception as e:
            outcome = f"{type(e).__name__}: {e}"
        raw = captured[-1] if captured else "(no content captured)"
        print(f"\n--- model output {i} ---  {outcome}")
        print(str(raw)[:700])
        try:
            obj = json.loads(str(raw))
        except Exception:
            # strip fences / chatter the same way reasoner.py does
            s, e = str(raw).find("{"), str(raw).rfind("}")
            obj = json.loads(str(raw)[s:e + 1]) if s != -1 and e > s else {}
        reason = obj.get("reason")
        finding = scan_reason_text(reason) if isinstance(reason, str) else None
        spans = [m.group(0) for m in REASON_NAME_PATTERN.finditer(reason or "")]
        print(f"  action  = {obj.get('action')}  target={obj.get('target')}")
        print(f"  reason  = {reason!r}")
        print(f"  spans   = {spans}")
        print(f"  verdict = {'BLOCK ' + finding.rule + ':' + finding.snippet if finding else 'ALLOW'}")
    R.parse_model_action = real_parse
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
