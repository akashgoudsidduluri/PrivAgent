"""G7 — does the live /api/v1/agent/action route emit Retry-After + rate_limit?

Loops real POSTs against the running backend until a rate limit is observed,
then prints the exact HTTP status, the Retry-After header and the structured
error_kind the extension would receive.
"""
import json

import httpx

URL = "http://127.0.0.1:8010/api/v1/agent/action"
PAYLOAD = {
    "task": "open the store catalog",
    "context": {
        "url": "http://localhost:4174/search.html",
        "timestamp": 1720000000000,
        "viewport": {"width": 1280, "height": 720, "scroll_x": 0, "scroll_y": 0},
        "screenshot_dimensions": None,
        "detections": [
            {
                "id": "elem_1",
                "type": "button",
                "confidence": 0.95,
                "bbox": {"x": 10, "y": 20, "width": 120, "height": 30},
                "length": 0,
                "source": "dom_label",
                "selector": "#catalog",
            }
        ],
        "total_elements_scanned": 3,
        "sensitive_elements_detected": 0,
        "sanitized_status": "sanitized_only",
        "ocr_metrics": None,
    },
    "history": [],
    "model_role": "FAST",
}

seen_rate_limit = False
for i in range(10):
    try:
        r = httpx.post(URL, json=PAYLOAD, timeout=60.0)
    except Exception as e:  # noqa: BLE001
        print(f"#{i+1} transport {type(e).__name__}")
        continue

    ra = r.headers.get("retry-after")
    try:
        detail = r.json().get("detail")
    except Exception:  # noqa: BLE001
        detail = None

    kind = detail.get("error_kind") if isinstance(detail, dict) else None
    retryable = detail.get("retryable") if isinstance(detail, dict) else None
    print(f"#{i+1} status={r.status_code} retry-after={ra!r} kind={kind!r} retryable={retryable!r}")

    if kind == "rate_limit":
        seen_rate_limit = True
        print("  -> ROUTE EMITTED rate_limit:", json.dumps(detail)[:220])
        break

print("RATE_LIMIT_OBSERVED:", seen_rate_limit)
