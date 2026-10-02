"""G7 Phase 2A — real provider availability probe.

One genuine minimal call per configured provider. No mocks. Records only
status codes and typed error kinds — never key material.
"""
import json
import sys
import time

sys.path.insert(0, "/home/daytona/codebase/backend")

from app import config  # noqa: E402
from app.reasoner import build_reasoner, resolve_reasoner_name  # noqa: E402

DETECTIONS = [
    {"id": "elem_1", "type": "button", "confidence": 0.9, "bbox": [0, 0, 10, 10]},
]

results = {}

for name in ("groq", "openrouter", "nvidia"):
    resolved = resolve_reasoner_name(name)
    configured = config.has_api_key(resolved)
    entry = {"resolved": resolved, "configured": configured}
    if configured:
        reasoner = build_reasoner(resolved)
        started = time.perf_counter()
        try:
            out = reasoner.request_action(
                task="open the store catalog",
                url="http://localhost:4174/",
                detections=DETECTIONS,
                history=[],
                viewport={"width": 1280, "height": 720},
                steps_used=0,
                max_steps=10,
            )
            entry["result"] = "OK"
            entry["raw_action"] = out.raw_action
        except Exception as err:  # noqa: BLE001 — probe reports every kind
            entry["result"] = "ERROR"
            entry["kind"] = getattr(err, "kind", type(err).__name__)
            entry["retryable"] = getattr(err, "retryable", None)
            entry["message"] = str(err)[:300]
        entry["latency_ms"] = round((time.perf_counter() - started) * 1000, 1)
    results[name] = entry
    print(name, json.dumps(entry), flush=True)

print("\nACTIVE PROVIDER:", config.REASONER_MODE)
print("FALLBACK:", repr(config.REASONER_FALLBACK_PROVIDER))
print("MAX_LLM_ATTEMPTS:", config.MAX_LLM_ATTEMPTS)
