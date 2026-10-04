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

Modes (chosen by the env var, never by model output):
  scroll_down       — always propose scroll/down
  oscillate         — alternate scroll/down, scroll/up
  malformed         — HTTP 200 with the exact observed live-model defect class
  bad_enum          — 200 whose action-specific enum value is not in the enum
  missing_field     — 200 missing a required action field
  wrong_type        — 200 with a field of the wrong type
  server_503        — upstream 503 with Retry-After (transient, bounded retry)
  click_fixture     — click a REAL affordance target read out of the posted
                      sanitized context (never a hard-coded id)
  navigate_fixture  — navigate to a route of the same fixture origin
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


def _first_target(payload: dict) -> str | None:
    """Pick a REAL actionable target out of the posted sanitized context.

    The stub never invents an element id: it reads what the extension actually
    said it could see, so a successful dispatch is evidence about the loop and
    not about a hard-coded fixture assumption.
    """
    context = (payload or {}).get("context") or {}
    semantic = context.get("semantic_context") or context.get("semanticContext") or {}
    preferred = ("CLICK", "SUBMIT_SEARCH", "FILL_FIELD", "SELECT_OPTION", "ENTER_QUERY")
    affordances = semantic.get("affordances") or []
    for wanted in preferred:
        for a in affordances:
            if a.get("type") == wanted and a.get("targetElementId"):
                return a["targetElementId"]
    for a in affordances:
        if a.get("targetElementId"):
            return a["targetElementId"]
    # Fall back to the sanitized detections the extension actually reported.
    interactive = ("button", "link", "search", "checkbox", "radio", "input", "select")
    for d in context.get("detections") or []:
        if d.get("id") and str(d.get("type", "")).lower() in interactive:
            return d["id"]
    return None


def _answer_from_context(payload: dict) -> str:
    """Compose an ANSWER strictly out of the sanitized facts the device sent.

    This is a CONTROLLED provider: it stands in for a model that chose to answer
    instead of acting. The answer text is assembled from the device's own
    sanitized observations so the ANSWER path can be exercised end to end. It is
    not evidence that a live model produces ANSWERs.
    """
    context = (payload or {}).get("context") or {}
    semantic = context.get("semantic_context") or context.get("semanticContext") or {}
    facts = semantic.get("facts") or []
    lines = []
    for f in facts[:5]:
        if isinstance(f, dict):
            key = f.get("key") or f.get("label") or f.get("type")
            value = f.get("value") or f.get("summary") or f.get("text") or ""
            if key or value:
                lines.append(f"{key}: {value}".strip(": ").strip())
    if not lines:
        lines.append("no structured facts were available in the sanitized observation")
    return "Based on the observed page state — " + "; ".join(lines)


def next_action(mode: str, n: int, payload: dict) -> dict:
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
    if mode == "bad_enum":
        return {"action": "scroll", "direction": "sideways", "amount": 500,
                "reason": "controlled: enum outside the contract"}
    if mode == "missing_field":
        return {"action": "scroll", "amount": 500,
                "reason": "controlled: direction missing"}
    if mode == "wrong_type":
        return {"action": "scroll", "direction": "down", "amount": "five hundred",
                "reason": "controlled: amount is not a number"}
    if mode == "click_fixture":
        target = _first_target(payload)
        if not target:
            return {"action": "scroll", "direction": "down", "amount": 400,
                    "reason": "controlled: no clickable affordance was offered"}
        return {"action": "click", "target": target,
                "reason": "controlled: click a real affordance from the sanitized context"}
    if mode == "navigate_fixture":
        return {"action": "navigate", "url": "http://127.0.0.1:4174/product.html",
                "reason": "controlled: navigate to a route of the same origin"}
    if mode == "navigate_wikipedia":
        return {"action": "navigate", "url": "https://en.wikipedia.org/wiki/Main_Page",
                "reason": "controlled: navigate to a goal-named host"}
    if mode == "act_then_answer":
        return {"action": "scroll", "direction": "down", "amount": 400,
                "reason": "controlled: gather evidence before answering"}
    raise SystemExit(f"unknown stub mode {mode}")


def terminal_proposal(mode: str, n: int, payload: dict):
    if mode == "answer":
        return {"kind": "ANSWER", "answer": _answer_from_context(payload)}
    if mode == "act_then_answer" and n >= 3:
        # A model that gathers evidence first and only then answers. The device
        # requires an ACTION from the planning step, so answering on the very
        # first cycle is correctly refused; this mode reproduces the real shape.
        return {"kind": "ANSWER", "answer": _answer_from_context(payload)}
    return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):  # keep the harness output readable
        return

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw or b"{}")
        except Exception:
            payload = {}
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
        if MODE == "server_503":
            # Transient upstream failure, declared retryable with a Retry-After.
            # A10 checks that this is retried WITHIN BOUNDS and then reported
            # truthfully — never that a 503 is retried into a green result.
            detail = json.dumps({"success": False,
                                 "reason": "controlled stub: upstream model overloaded",
                                 "error_kind": "upstream_unavailable",
                                 "retryable": True}).encode()
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Retry-After", "1")
            self.send_header("Content-Length", str(len(detail)))
            self.end_headers()
            self.wfile.write(detail)
            return
        proposal = terminal_proposal(MODE, SERVED["n"], payload)
        envelope = {
            "success": True,
            "reason": f"controlled stub mode={MODE} call={SERVED['n']}",
            "telemetry": {"provider": "controlled_stub", "role": "FAST",
                          "latency_ms": 1.0, "attempts": 1, "fallback_used": False},
        }
        if proposal is not None:
            envelope["proposal"] = proposal
        else:
            envelope["action"] = next_action(MODE, SERVED["n"], payload)
        body = json.dumps(envelope).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        global MODE
        # /mode?set=<mode> lets one long-lived stub serve a whole A10 sweep
        # without a restart per scenario. The mode is still chosen by the
        # harness, never by anything the page or the model says.
        if self.path.startswith("/mode"):
            from urllib.parse import urlparse, parse_qs
            q = parse_qs(urlparse(self.path).query)
            if "set" in q:
                MODE = q["set"][0]
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
