"""
Is the Groq rate limit EXTERNAL, or is PrivAgent self-inflicting it?

The real-browser loop made 4 provider calls in quick succession and step 4 came
back `groq (rate_limit)`. A direct single-call probe is healthy. This measures
whether the LOOP'S OWN CALL PATTERN (burst cadence + prompt size) is what trips
the limit, which would be a local integration issue rather than an external one.

Reports prompt size (tokens estimate), per-call latency, and the exact call
index at which Groq starts refusing. Nothing here changes production code.
"""
import json
import sys
import time

sys.path.insert(0, ".")

from app import config
from app.reasoner import ReasoningError, build_reasoner

# Mirrors the real shopping fixture perception the loop actually sent:
# the world model had 6 privacy findings and ~10-11 visual regions.
DETECTIONS = [
    {
        "id": f"finding-{i}",
        "type": "email" if i % 3 == 0 else ("phone" if i % 3 == 1 else "account_number"),
        "confidence": 0.9,
        "bbox": {"x": 40.0 + i * 12, "y": 60.0 + i * 9, "width": 180.0, "height": 28.0},
        "length": 12,
        "source": "dom_input_type",
        "selector": f"#field-{i}",
        "is_partially_visible": False,
        "label": f"Field {i}",
    }
    for i in range(6)
]

TASK = __import__("os").environ.get("ST_TASK", "open the store catalog at http://localhost:4174/ and open the first product listed")

VIEWPORT = {"width": 1280, "height": 800, "scroll_x": 0.0, "scroll_y": 0.0}
DIMS = {"width": 1280, "height": 757}

BURST = int(sys.argv[1]) if len(sys.argv) > 1 else 6
GAP_MS = int(sys.argv[2]) if len(sys.argv) > 2 else 0


def prompt_tokens(reasoner, task, url, detections):
    try:
        p = reasoner.build_prompt(
            task=task,
            url=url,
            detections=detections,
            history=[],
            viewport=VIEWPORT,
            screenshot_dimensions=DIMS,
            page_type="general",
            semantic_context=None,
        )
        return len(p), int(len(p) / 4)
    except Exception as err:
        return -1, -1


reasoner = build_reasoner("groq")
chars, approx_tokens = prompt_tokens(reasoner, TASK, __import__("os").environ.get("ST_URL","http://localhost:4174/search.html"), DETECTIONS)
print(f"prompt size        : {chars} chars (~{approx_tokens} tokens, 4 chars/token estimate)")
print(f"burst plan         : {BURST} calls, {GAP_MS}ms gap")
print("-" * 78)

results = []
for i in range(1, BURST + 1):
    t0 = time.perf_counter()
    try:
        r = reasoner.request_action(
            task=TASK,
            url=__import__("os").environ.get("ST_URL","http://localhost:4174/search.html"),
            detections=DETECTIONS,
            history=[],
            viewport=VIEWPORT,
            screenshot_dimensions=DIMS,
            page_type="general",
            semantic_context=None,
        )
        ms = (time.perf_counter() - t0) * 1000
        print(f"  call {i}: OK    {ms:7.1f}ms  action={r.raw_action.get('action')!r} target={r.raw_action.get('target')!r}")
        results.append(("ok", i))
    except ReasoningError as err:
        ms = (time.perf_counter() - t0) * 1000
        print(f"  call {i}: FAIL  {ms:7.1f}ms  kind={err.kind!r}")
        print(f"          {str(err)[:150]}")
        results.append((err.kind, i))
    if GAP_MS:
        time.sleep(GAP_MS / 1000.0)

print("-" * 78)
first_fail = next((i for k, i in results if k != "ok"), None)
print(f"calls made         : {len(results)}")
print(f"first failure call : {first_fail}")
print(f"verdict            : " + (
    "EXTERNAL — every call in the burst was accepted" if first_fail is None
    else f"SELF-INFLICTED — Groq refused from call {first_fail} of {BURST} in this burst"
))
