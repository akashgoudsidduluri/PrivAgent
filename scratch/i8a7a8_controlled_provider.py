#!/usr/bin/env python3
"""
CONTROLLED PROVIDER STUB for the I-8 / A7 / A8 real-Chrome checkpoint.

Serves the SAME wire contract as the real FastAPI gateway
(`POST /api/v1/agent/action`) on 127.0.0.1:8010, but returns a SCRIPTED
sequence of well-formed actions instead of calling a model.

WHY THIS EXISTS
---------------
The live model (`gpt-oss-20b`) is the thing I-8 and A8 are about, and it was
observed doing exactly the A8 defect — but it is also rate-limited and
unavailable at the moment, so it cannot be driven through a scripted DOWN x3
or DOWN/UP/DOWN/UP sequence on demand.

This stub is therefore used ONLY to make the browser-side behaviour
observable. It is honest about that: every artifact it produces is labelled
CONTROLLED_PROVIDER, and the live-model proofs are labelled separately.

Modes (chosen by the file name / env, never by model output):
  scroll_down   — always propose scroll/down
  oscillate     — alternate scroll/down, scroll/up
  malformed     — HTTP 200 with the exact observed defect class
"""

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODE = os.environ.get("STUB_MODE", "scroll_down")
PORT = int(os.environ.get("STUB_PORT", "8010"))
SERVED = {"n": 0}

CONTEXT = {
    "task": "scroll",
    "context": {
        "url": "http://127.0.0.1:4174/index.html",
        "timestamp": 0,
        "viewport": {"width": 1280, "height": 800, "scroll_x": 0, "scroll_y": 0},
        "screenshot_dimensions": {"width": 1280, "height": 800},
        "sanitized_status": "sanitized_only",
        "total_elements_scanned": 1,
        "sensitive_elements_detected": 0,
        "ocr_metrics": None,
        "detections": [],
    },
    "history": [],
    "model_role": "FAST",
}


def next_action(mode: str, n: int) -> dict:
    if mode == "scroll_down":
        return {"action": "scroll", "direction": "down", "amount": 500,
                "reason": "controlled: scroll down"}
    if mode == "oscillate":
        direction = "down" if n % 2 == 0 else "up"
        return {"action": "scroll", "direction": direction, "amount": 500,
                "reason": "controlled: oscillate"}
    if mode == "malformed":
        # EXACTLY the defect class observed from the real model in the A8 run.
        # Every unused field is present and inapplicable. Pre-A8 the route
        # deleted them and dispatched a scroll.
        return {"action": "scroll", "amount": 500, "direction": "down",
                "option": "", "reason": "controlled: malformed", "target": "",
                "text": "", "url": ""}
    raise SystemExit(f"unknown stub mode {mode}")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):  # keep the harness output readable
        return

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        if not self.path.endswith("/agent/action"):
            if self.path.endswith("/agent/review"):
                # The loop's SAFETY review is a separate endpoint on the same
                # gateway. It is not what this checkpoint is measuring, so the
                # stub answers it exactly as a clean review would: a verdict is
                # still produced, and the loop still runs the gate.
                body = json.dumps({"safe": True, "reason": "controlled stub: no objection"}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_response(404)
            self.end_headers()
            return
        SERVED["n"] += 1
        body = json.dumps({
            "success": True,
            "action": next_action(MODE, SERVED["n"]),
            "reason": f"controlled stub mode={MODE} call={SERVED['n']}",
            "telemetry": {"provider": "controlled_stub", "role": "FAST",
                          "latency_ms": 1.0, "attempts": 1, "fallback_used": False},
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        body = json.dumps({"success": True, "stub_mode": MODE,
                           "calls_served": SERVED["n"]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print(f"controlled provider stub mode={MODE} port={PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
