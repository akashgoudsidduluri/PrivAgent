"""G7 Phase 2A — measure real prompt size and sustained call capacity.

Builds a realistic sanitized context (declared destination + affordances +
elements, shaped like the real fixture page), measures the exact prompt the
reasoner would send, then makes N sequential REAL Groq calls recording the
timestamp and outcome of each. No mocks.
"""
import json
import sys
import time

sys.path.insert(0, "/home/daytona/codebase/backend")

from app import config  # noqa: E402
from app.reasoner import GroqReasoner, _build_user_prompt  # noqa: E402

TASK = "open the store catalog"

# Realistic page-2 context: the search page, with the ENTER_QUERY affordance
# that Step 10.5 proved the model can actually use.
AFFORDANCES = [
    {"id": "affordance-search-input-1", "kind": "ENTER_QUERY", "label": "product search"},
    {"id": "affordance-search-submit-1", "kind": "SUBMIT_QUERY", "label": "search"},
    {"id": "affordance-scroll-1", "kind": "SCROLL", "label": "more results"},
]
ELEMENTS = [
    {"id": "elem_1", "type": "input", "confidence": 0.95,
     "bbox": [10, 20, 300, 40], "length": 0, "source": "dom", "selector": "#q"},
    {"id": "elem_2", "type": "button", "confidence": 0.93,
     "bbox": [310, 20, 380, 40], "length": 0, "source": "dom", "selector": "#submit"},
    {"id": "elem_3", "type": "link", "confidence": 0.88,
     "bbox": [10, 60, 120, 80], "length": 0, "source": "dom", "selector": "nav"},
]
SEMANTIC = {
    "pageType": "SEARCH",
    "pageState": "READY",
    "affordances": AFFORDANCES,
    "declaredDestination": {
        "provenance": "USER_DECLARED_DESTINATION",
        "role": ["LISTING"],
    },
}

prompt = _build_user_prompt(
    task=TASK,
    url="http://localhost:4174/search.html",
    viewport={"width": 1280, "height": 720},
    screenshot_dimensions=None,
    detections=ELEMENTS,
    history=[],
    steps_used=1,
    max_steps=10,
    page_type="SEARCH",
    semantic_context=SEMANTIC,
)
approx_tokens = (len(prompt) + len("system prompt") ) // 4
print(f"PROMPT_CHARS={len(prompt)}")
print(f"APPROX_PROMPT_TOKENS={approx_tokens}")

reasoner = GroqReasoner()
N = int(sys.argv[1]) if len(sys.argv) > 1 else 6
DELAY = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0

print(f"--- {N} real Groq calls, delay={DELAY}s ---")
t0 = time.time()
for i in range(N):
    started = time.time()
    try:
        out = reasoner.request_action(
            task=TASK,
            url="http://localhost:4174/search.html",
            detections=ELEMENTS,
            history=[],
            viewport={"width": 1280, "height": 720},
            steps_used=1,
            max_steps=10,
            page_type="SEARCH",
            semantic_context=SEMANTIC,
        )
        a = out.raw_action
        print(
            f"call#{i+1} t+{started - t0:6.1f}s OK  action={a.get('action')} "
            f"target={a.get('target')} text={a.get('text')!r} lat={out.latency_ms:.0f}ms",
            flush=True,
        )
    except Exception as err:  # noqa: BLE001
        print(
            f"call#{i+1} t+{started - t0:6.1f}s ERR kind={getattr(err, 'kind', '?')} "
            f"retryable={getattr(err, 'retryable', None)} msg={str(err)[:120]}",
            flush=True,
        )
    if DELAY:
        time.sleep(DELAY)

print(f"TOTAL_ELAPSED={time.time() - t0:.1f}s")
