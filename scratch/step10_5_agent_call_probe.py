"""STEP 10.5 Part 9 — reproduce the EXACT agent-sized provider call and print
the precise provider error.

Read-only diagnostic. Uses the production reasoner with the same sanitized
context shape the agent loop sends, so the failure the loop reports as
"groq (rate_limit)" can be attributed to a real provider response.
"""
from __future__ import annotations

import json
import sys
import time

import httpx

sys.path.insert(0, "backend")

from app import config  # noqa: E402
from app.reasoner import GroqReasoner, ReasoningError  # noqa: E402

DETECTIONS = [
    {"id": "btn-shop-now", "type": "button", "confidence": 0.95,
     "bbox": {"x": 648, "y": 296, "width": 191, "height": 45}, "length": 14,
     "source": "dom_attribute", "selector": "#btn-shop-now",
     "is_partially_visible": False},
]
SEMANTIC = {
    "pageType": "UNKNOWN", "confidence": 0.1, "pageState": "form_incomplete",
    "pageGeneration": 6, "entities": [],
    "affordances": [
        {"id": "affordance-enter_query-1", "type": "ENTER_QUERY",
         "targetElementId": "input-search-query", "requiresConfirmation": False,
         "description": "Input search keyword query into query bar"},
        {"id": "affordance-submit_search-1", "type": "SUBMIT_SEARCH",
         "targetElementId": "btn-search-submit", "requiresConfirmation": False,
         "description": "Submit the search form"},
    ],
    "workflow": None, "promptInjectionDetected": False, "facts": [],
    "declaredDestination": {"provenance": "USER_DECLARED_DESTINATION",
                            "role": ["LISTING"]},
}


def main() -> int:
    provider = GroqReasoner()
    print(f"model = {config.MODEL_STRONG}")
    print("8 consecutive agent-sized calls, 2s apart:\n")
    for i in range(1, 9):
        t0 = time.time()
        try:
            r = provider.request_action(
                task="open the store catalog",
                url="http://localhost:4174/search.html",
                detections=DETECTIONS,
                history=[{"action": "click", "target": "btn-shop-now",
                          "reason": "Clicking Shop Now"}],
                viewport={"width": 1280, "height": 757, "scroll_x": 0, "scroll_y": 0},
                screenshot_dimensions={"width": 1280, "height": 757},
                page_type="landing",
                semantic_context=SEMANTIC,
            )
            fields = {f: getattr(r, f, None) for f in ("model", "latency_ms", "provider")}
            print(f"  call {i}: OK in {time.time()-t0:.1f}s  {fields}")
        except ReasoningError as e:
            print(f"  call {i}: ReasoningError in {time.time()-t0:.1f}s "
                  f"kind={e.kind!r}")
            print(f"      {e}")
        except Exception as e:  # noqa: BLE001
            print(f"  call {i}: {type(e).__name__} in {time.time()-t0:.1f}s: {e}")
        time.sleep(2)

    print("\nraw provider probe of the same shape:")
    body = {
        "model": config.MODEL_STRONG,
        "messages": [{"role": "user", "content": "Reply with the word ok"}],
        "max_tokens": 300,
        "temperature": 0.2,
    }
    r = httpx.post(
        config.GROQ_BASE_URL.rstrip("/"),
        headers={"Authorization": f"Bearer {config.GROQ_API_KEY}",
                 "Content-Type": "application/json"},
        json=body, timeout=45.0,
    )
    print(f"  raw status={r.status_code}")
    print(f"  ratelimit={ {k: v for k, v in r.headers.items() if k.lower().startswith('x-ratelimit')} }")
    if r.status_code != 200:
        print(f"  body={r.text[:400]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
