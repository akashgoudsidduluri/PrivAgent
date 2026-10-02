"""G7 — does Groq actually return a Retry-After HEADER (not just body text)?"""
import sys

sys.path.insert(0, "/home/daytona/codebase/backend")

from app.reasoner import GroqReasoner, ReasoningError  # noqa: E402

r = GroqReasoner()
D = [{"id": "elem_1", "type": "button", "confidence": 0.9, "bbox": [0, 0, 10, 10]}]

for i in range(6):
    try:
        out = r.request_action(
            task="open the store catalog",
            url="http://localhost:4174/search.html",
            detections=D,
            history=[],
            viewport={"width": 1280, "height": 720},
            page_type="SEARCH",
            semantic_context={"pageType": "SEARCH", "affordances": []},
        )
        print(f"call#{i+1} OK {out.raw_action.get('action')}", flush=True)
    except ReasoningError as e:
        print(f"call#{i+1} kind={e.kind} retryable={e.retryable} retry_after={e.retry_after!r}", flush=True)
