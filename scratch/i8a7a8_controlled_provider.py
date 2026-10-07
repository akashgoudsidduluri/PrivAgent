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
    interrupt_demo    — A12: the "slowly" task is answered late, so its provider
                       response lands after the next task superseded it
  malformed         — HTTP 200 with the exact observed live-model defect class
  bad_enum          — 200 whose action-specific enum value is not in the enum
  missing_field     — 200 missing a required action field
  wrong_type        — 200 with a field of the wrong type
  server_503        — upstream 503 with Retry-After (transient, bounded retry)
  click_fixture     — click a REAL affordance target read out of the posted
                      sanitized context (never a hard-coded id)
  navigate_fixture  — navigate to a route of the same fixture origin
  fill_sanitized    — type into the SANITIZED detection id of the account field
  unknown_target    — type into an id that matches no offered detection at all
  bogus_target      — type into the affordance's raw DOM id (never offered by
                      the device) so grounding must reject it
  confirm_submit    — click the device-reported SUBMIT_LOGIN affordance with a
                      submission intent, so the HIGH-risk confirmation gate
                      (GATE 5) is exercised from the sanitized context alone
  commit_demo       — A14: always propose the SAME consequential control, so a
                      second dispatch would be a second commit
  freshness_demo    — A16: propose the consequential control, but hold the FIRST
                      answer open long enough for the same fixture page that A14
                      uses to move to a new document before the plan comes back
"""

import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODE = os.environ.get("STUB_MODE", "scroll_down")
# PHASE 18.8 / A12. How long the FIRST reasoning call of a scenario is held open,
# so the browser test can start a SECOND task while the first is provably still
# waiting for an answer — the exact window in which a stale response could
# dispatch.
SLOW_FIRST_SECONDS = float(os.environ.get("STUB_SLOW_FIRST_SECONDS", "12"))
# PHASE 18.8 / A16. How long the FIRST reasoning call of the freshness scenario is
# held open, so the fixture page can really navigate to a new document while the
# step the agent is preparing still belongs to the old one.
FRESHNESS_HOLD_SECONDS = float(os.environ.get("STUB_FRESHNESS_HOLD_SECONDS", "14"))
PORT = int(os.environ.get("STUB_PORT", "8010"))
SERVED = {"n": 0}
# Per-task call counter, so a mode can treat one task differently from another.
CALLS_BY_TASK: dict[str, int] = {}

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


def _commit_target(payload: dict) -> str | None:
    """Pick the CONSEQUENTIAL control out of what the device actually offered.

    PHASE 18.8 / A14. Only ids the extension itself reported are considered: a
    controlled provider must not invent a target, or a successful dispatch would
    be evidence about the fixture rather than about the loop.
    """
    context = (payload or {}).get("context") or {}
    semantic = context.get("semantic_context") or context.get("semanticContext") or {}
    #
    # A CLICKABLE control only. The send control is what this scenario is about;
    # answering with a text field would exercise a different (and much older)
    # risk path, and would say nothing about the commit contract.
    #
    clickable = ("button", "link")
    for word in ("send", "enquiry", "enquiry", "question"):
        for d in context.get("detections") or []:
            if str(d.get("type", "")).lower() not in clickable:
                continue
            blob = f"{d.get('label', '')} {d.get('id', '')} {d.get('text', '')}".lower()
            if word in blob and d.get("id"):
                return d["id"]
        for a in semantic.get("affordances") or []:
            if a.get("type") != "CLICK":
                continue
            blob = f"{a.get('description', '')} {a.get('type', '')}".lower()
            if word in blob and a.get("targetElementId"):
                return a["targetElementId"]
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


def _task_text(payload: dict) -> str:
    for key in ("task", "prompt", "instruction", "user_task"):
        value = (payload or {}).get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def _wants_open(payload: dict) -> bool:
    """Does THIS turn ask to open/navigate somewhere? Local text check only."""
    text = _task_text(payload).lower()
    return any(k in text for k in ("open", "go to", "goto", "visit", "navigate", "launch"))


def _resolved_anchor(payload: dict) -> tuple[str | None, str | None]:
    """The anchor the LOCAL resolver produced, as the reasoner sees it.

    PHASE 18.8 / A13 + A15. The anchor is `[RESOLVED REFERENCE] title | id: N |
    on: host`. A controlled provider may act on it exactly as a real reasoner
    would; it may never invent one, which is why this parses the anchor instead
    of picking a product itself.
    """
    text = _task_text(payload)
    if "[RESOLVED REFERENCE]" not in text:
        return None, None
    anchor = text.split("[RESOLVED REFERENCE]", 1)[1].strip().splitlines()[0]
    title = anchor.split("|")[0].strip() or None
    product_id = None
    for part in anchor.split("|")[1:]:
        if part.strip().startswith("id:"):
            product_id = part.split(":", 1)[1].strip()
    return title, product_id


def _page_url(payload: dict) -> str:
    context = (payload or {}).get("context") or {}
    url = context.get("url")
    return url if isinstance(url, str) else ""


def next_action(mode: str, n: int, payload: dict) -> dict:
    if mode == "scroll_down":
        return {"action": "scroll", "direction": "down", "amount": 500,
                "reason": "controlled: scroll down"}
    if mode == "interrupt_demo":
        # Every call scrolls, so task A keeps running and can be interrupted
        # mid-flight. The LATE response is produced in the POST handler below.
        return {"action": "scroll", "direction": "down", "amount": 200,
                "reason": "controlled: keep working through the page"}
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
    if mode == "type_password":
        # GATE 5 confirmation test: propose typing into the REAL password field
        # the device reported (never an invented id). Risk: type + password
        # category => HIGH => requiresUserConfirmation => the loop must ask.
        #
        # The typed text is deliberately BENIGN and low-entropy. An earlier
        # revision sent a credential-shaped token (upper+lower+digit, >=8 chars),
        # which M5's credential-token heuristic (actionValidator.ts,
        # CREDENTIAL_TOKEN_PATTERN) correctly refused as a PII-smuggling channel
        # BEFORE the risk gate could ever be reached. That refusal is the intended
        # privacy-first behaviour, not the confirmation gate — so the scenario that
        # exercises GATE 5 must not carry a credential-shaped payload.
        context = (payload or {}).get("context") or {}
        for d in context.get("detections") or []:
            if str(d.get("type", "")).lower() == "password" and d.get("id"):
                return {
                    "action": "type",
                    "target": d["id"],
                    "text": "demo",
                    "reason": "controlled: fill the credential field the task asked for",
                }
        semantic = context.get("semantic_context") or context.get("semanticContext") or {}
        for a in semantic.get("affordances") or []:
            if a.get("type") == "FILL_FIELD" and a.get("targetElementId"):
                return {
                    "action": "type",
                    "target": a["targetElementId"],
                    "text": "demo",
                    "reason": "controlled: fill the requested field",
                }
        return {"action": "scroll", "direction": "down", "amount": 300,
                "reason": "controlled: no credential field was offered"}
    if mode == "fill_sanitized":
        # PHASE 1 — the SANITIZED identity is the actionable one.
        #
        # Types into the detection id the device actually offered for the
        # account-identifier field (never the raw DOM id an affordance may name).
        # If the privacy-safe identity cannot be grounded, then the legitimate
        # interaction really is broken; if it can, the interaction works and only
        # the affordance's raw id is unusable.
        context = (payload or {}).get("context") or {}
        for d in context.get("detections") or []:
            sel = str(d.get("selector") or "")
            if d.get("id") and "input-username" in sel:
                return {"action": "type", "target": d["id"], "text": "operator",
                        "reason": "controlled: fill the account identifier field"}
        return {"action": "scroll", "direction": "down", "amount": 200,
                "reason": "controlled: no offered detection for the account field"}
    if mode == "unknown_target":
        # PHASE 1 — the negative control. This id matches NO detection on any
        # signal (id, selector, label), so grounding must refuse it and nothing
        # may be dispatched. It proves the fix did not widen the target space.
        return {"action": "type", "target": "no-such-field-anywhere", "text": "operator",
                "reason": "controlled: fill a field the device never offered"}
    if mode == "bogus_target":
        # PHASE 1 — grounding must STILL reject a target the device never
        # offered. This is the raw DOM id that the FILL_FIELD affordance named
        # while the detections called the same field `privagent-det-N`: exactly
        # the id a model following that affordance would have used.
        context = (payload or {}).get("context") or {}
        offered = {d.get("id") for d in context.get("detections") or []}
        candidate = None
        sem = context.get("semantic_context") or context.get("semanticContext") or {}
        for a in sem.get("affordances") or []:
            tid = a.get("targetElementId")
            if tid and tid not in offered:
                candidate = tid
                break
        return {"action": "type", "target": candidate or "input-username",
                "text": "shopper",
                "reason": "controlled: fill the field this affordance named"}
    if mode == "confirm_submit":
        # GATE 5 confirmation test that is reachable from the SANITIZED context.
        #
        # A credential FILL is not reachable this way — the password field is
        # excluded from the remote context and exposed only as an
        # ENTER_PASSWORD_LOCAL affordance explicitly marked "never forwarded to
        # remote reasoner" — so the gate is exercised with a still-consequential,
        # still-reachable action: submitting the sign-in form. A click whose
        # declared intent is a form submission scores HIGH in the deterministic
        # risk engine, which is exactly what the confirmation gate guards. The
        # target is the device-reported SUBMIT_LOGIN affordance id, never an
        # invented one.
        context = (payload or {}).get("context") or {}
        semantic = context.get("semantic_context") or context.get("semanticContext") or {}
        for a in semantic.get("affordances") or []:
            if a.get("type") == "SUBMIT_LOGIN" and a.get("targetElementId"):
                return {"action": "click", "target": a["targetElementId"],
                        "reason": "controlled: submit the sign-in form the user asked for"}
        target = _first_target(payload)
        if target:
            return {"action": "click", "target": target,
                    "reason": "controlled: submit the form the user asked for"}
        return {"action": "scroll", "direction": "down", "amount": 300,
                "reason": "controlled: no submit control was offered"}
    if mode == "click_fixture":
        target = _first_target(payload)
        if not target:
            return {"action": "scroll", "direction": "down", "amount": 400,
                    "reason": "controlled: no clickable affordance was offered"}
        return {"action": "click", "target": target,
                "reason": "controlled: click a real affordance from the sanitized context"}
    if mode == "commit_demo":
        # Every call proposes the SAME consequential control. If the agent
        # re-dispatches it, that is a second send; if A14 holds, the first one
        # blocks the class and the run stops.
        target = _commit_target(payload)
        if not target:
            return {"action": "scroll", "direction": "down", "amount": 300,
                    "reason": "controlled: no consequential control was offered"}
        return {"action": "click", "target": target,
                "reason": "controlled: send the enquiry the user asked for"}
    if mode == "freshness_demo":
        # PHASE 18.8 / A16. The SAME consequential control A14 uses, proposed the
        # same honest way: only an id the device itself reported is considered.
        # The difference is on the wire, not here — the POST handler holds this
        # first answer long enough for the page under it to move.
        target = _commit_target(payload)
        if not target:
            return {"action": "scroll", "direction": "down", "amount": 300,
                    "reason": "controlled: no consequential control was offered"}
        return {"action": "click", "target": target,
                "reason": "controlled: send the enquiry the user asked for"}
    if mode == "navigate_fixture":
        return {"action": "navigate", "url": "http://127.0.0.1:4174/product.html",
                "reason": "controlled: navigate to a route of the same origin"}
    if mode == "navigate_wikipedia":
        return {"action": "navigate", "url": "https://en.wikipedia.org/wiki/Main_Page",
                "reason": "controlled: navigate to a goal-named host"}
    if mode == "act_then_answer":
        return {"action": "scroll", "direction": "down", "amount": 400,
                "reason": "controlled: gather evidence before answering"}
    if mode == "slow_then_normal":
        return {"action": "scroll", "direction": "down", "amount": 300,
                "reason": "controlled: observe the page the user asked about"}
    if mode == "multiturn":
        _, product_id = _resolved_anchor(payload)
        url = _page_url(payload)
        if product_id and _wants_open(payload) and "product.html" not in url:
            # The anchor is the ONLY source of which product to open, and the
            # user must actually have ASKED to open something: "tell me about
            # the third one" is a reporting request, not a navigation.
            return {"action": "navigate",
                    "url": f"http://localhost:4174/product.html?id={product_id}",
                    "reason": "controlled: open the entity the local resolver selected"}
        if not product_id and "product" in _task_text(payload).lower() and "results.html" not in url:
            # A fresh turn that asks for the catalog goes back to the catalog, so
            # the next turn can be asked about several items again.
            return {"action": "navigate", "url": "http://localhost:4174/results.html",
                    "reason": "controlled: return to the catalog listing"}
        return {"action": "scroll", "direction": "down", "amount": 300,
                "reason": "controlled: observe the page the user referred to"}
    raise SystemExit(f"unknown stub mode {mode}")


def _verified_evidence_ids(payload: dict) -> list:
    """Evidence ids the DEVICE reports as VERIFIED and CURRENT.

    These come from the sanitized `decision_state` the loop attaches to this very
    request — the same ids a real model is shown, and the same ones
    `verifyTerminalProposal` resolves against the local ledger. Citing them here
    is honest: a controlled provider must not invent an id the device never sent.
    """
    context = (payload or {}).get("context") or {}
    ds = context.get("decision_state") or context.get("decisionState") or {}
    ids = []
    for ref in ds.get("evidence") or []:
        if not isinstance(ref, dict):
            continue
        if ref.get("verificationStatus") == "VERIFIED" and ref.get("freshness") == "CURRENT":
            ids.append(ref.get("id"))
    return [i for i in ids if isinstance(i, str)][:12]


def terminal_proposal(mode: str, n: int, payload: dict):
    if mode == "answer":
        return {
            "kind": "ANSWER",
            "reason": "controlled: answering from the verified evidence on this page",
            "answer": _answer_from_context(payload),
            "cited_evidence": _verified_evidence_ids(payload),
        }
    if mode == "interrupt_demo":
        # The interrupting task terminates promptly from verified evidence; the
        # "slowly" task never proposes a terminal state.
        if "slowly" not in _task_text(payload).lower():
            return {
                "kind": "ANSWER",
                "reason": "controlled: reporting the products this device verified",
                "answer": _answer_from_context(payload),
                "cited_evidence": _verified_evidence_ids(payload),
            }
        return None
    if mode == "multiturn":
        _, product_id = _resolved_anchor(payload)
        url = _page_url(payload)
        text = _task_text(payload).lower()
        wants_details = any(k in text for k in ("detail", "tell me about", "what is", "price"))
        if "results.html" in url and not _wants_open(payload):
            # The catalog turn is a LISTING request: the page already shows the
            # products, so the honest terminal move is to report what the device
            # verified on it. No anchor is claimed here — the next turn's ordinal
            # is resolved locally, by the device.
            return {
                "kind": "ANSWER",
                "reason": "controlled: listing the products this device verified on the catalog page",
                "answer": _answer_from_context(payload),
                "cited_evidence": _verified_evidence_ids(payload),
            }
        if product_id and "product.html" in url:
            # Answer about the SAME entity the resolver selected, citing only
            # evidence the DEVICE reports as verified.
            return {
                "kind": "ANSWER",
                "reason": "controlled: answering about the selected entity from verified evidence",
                "answer": _answer_from_context(payload),
                "cited_evidence": _verified_evidence_ids(payload),
            }
        return None
    if mode == "fill_sanitized" and n >= 2:
        # Bounded scenario: after the authorized fill went out, a controlled
        # provider reports instead of proposing the same sensitive fill forever
        # (which would park the run in a second confirmation state and measure
        # nothing). Answer text comes from the device's own sanitized facts.
        return {
            "kind": "ANSWER",
            "reason": "controlled: reporting that the requested field was filled",
            "answer": _answer_from_context(payload),
            "cited_evidence": _verified_evidence_ids(payload),
        }
    if mode == "type_password" and n >= 2:
        # The credential fill has been DISPATCHED (the run only asks for a second
        # plan after the first action went out) or the first cycle was refused.
        # Answering here is what makes the scenario bounded: a controlled
        # provider that kept proposing the same sensitive fill forever would
        # leave the run parked in a confirmation state, which measures nothing.
        # The answer is composed from the device's own sanitized facts and cites
        # only evidence the DEVICE reports as verified and current.
        return {
            "kind": "ANSWER",
            "reason": "controlled: reporting that the requested field was filled",
            "answer": _answer_from_context(payload),
            "cited_evidence": _verified_evidence_ids(payload),
        }
    if mode == "act_then_answer" and n >= 3:
        # A model that gathers evidence first and only then answers. The device
        # requires an ACTION from the planning step, so answering on the very
        # first cycle is correctly refused; this mode reproduces the real shape.
        return {
            "kind": "ANSWER",
            "reason": "controlled: answering from the verified evidence on this page",
            "answer": _answer_from_context(payload),
            "cited_evidence": _verified_evidence_ids(payload),
        }
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
        if self.path.endswith("/agent/chat"):
            #
            # FINAL ACCEPTANCE AUDIT — the conversational endpoint.
            #
            # A controlled stub so the normal-chat ROUTING can be proven in real
            # Chrome without depending on a live model. It answers with an
            # unmistakably controlled string: no artifact that contains this text
            # can be mistaken for live-provider evidence.
            #
            # NOTE what it is given: the user's text only. There is no page
            # context on this route, so the stub has nothing else to echo even if
            # it wanted to.
            task_text = _task_text(payload) or "(empty)"
            body = json.dumps({
                "success": True,
                "answer": f"CONTROLLED_STUB_ANSWER: {task_text[:120]}",
                "model": "controlled_stub",
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
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
        if os.environ.get("STUB_DUMP_TARGETS"):
            # Debug aid: what did the DEVICE say it could see? Sanitized ids and
            # screened labels only; this never prints a raw value.
            ctx = payload.get("context") or {}
            sem = ctx.get("semantic_context") or ctx.get("semanticContext") or {}
            detections = ctx.get("detections") or []
            affordances = sem.get("affordances") or []
            offered = {d.get("id") for d in detections}
            #
            # DECOY CHECK — measured on the real wire payload, not from source.
            # An affordance whose targetElementId is not among the offered
            # detection ids names a target the prompt itself forbids, so a model
            # that follows it cannot be grounded. The codebase states this
            # invariant (contextMinimizer.filterAffordancesToOfferedIds); this
            # line reports whether it actually HOLDS on the wire.
            decoys = [a.get("targetElementId") for a in affordances
                      if a.get("targetElementId") and a.get("targetElementId") not in offered]
            print("DECOY_AFFORDANCES", json.dumps({
                "task": _task_text(payload)[:60],
                "offered_detection_ids": sorted(i for i in offered if i),
                "affordance_targets": [a.get("targetElementId") for a in affordances],
                "decoy_targets": sorted(set(decoys)),
                "decoy_count": len(decoys),
            }), flush=True)
            print("TARGETS", json.dumps({
                "task": _task_text(payload)[:80],
                "detections": [{k: d.get(k) for k in ("id", "type", "selector", "label")}
                               for d in detections][:8],
                "affordances": [{k: a.get(k) for k in ("type", "targetElementId", "description")}
                                for a in affordances][:8],
            }), flush=True)
        if MODE == "freshness_demo" and SERVED["n"] == 1:
            # PHASE 18.8 / A16. The FIRST call of the scenario is held open while
            # the fixture page performs a real navigation. The plan that comes
            # back therefore belongs to a document that no longer exists, which
            # is exactly the condition the pre-action freshness gate must catch
            # BEFORE anything is dispatched. A controlled hold, never a claim
            # about a live model.
            time.sleep(FRESHNESS_HOLD_SECONDS)
        if MODE == "slow_then_normal" and SERVED["n"] == 1:
            # PHASE 18.8 / A12. The FIRST reasoning call of a scenario is held
            # open long enough for the browser test to start a SECOND task while
            # this one is provably still waiting for an answer — the exact window
            # in which a stale response could dispatch. The counter resets when
            # the mode is set, so "first call" is per scenario, not per process.
            time.sleep(SLOW_FIRST_SECONDS)
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
        # PHASE 18.8 / A12 — a genuinely LATE provider response. The FIRST call
        # of the long task answers promptly (so the run really dispatches an
        # action before the interrupt); every later call is held back until
        # after the dashboard has started the second task, which is exactly the
        # race the cancellation contract must survive.
        _task_key = _task_text(payload).strip()[:60]
        CALLS_BY_TASK[_task_key] = CALLS_BY_TASK.get(_task_key, 0) + 1
        if (MODE == "interrupt_demo" and "slowly" in _task_key.lower()
                and CALLS_BY_TASK[_task_key] >= 2):
            time.sleep(4.0)
        proposal = terminal_proposal(MODE, SERVED["n"], payload)
        envelope = {
            "success": True,
            "reason": f"controlled stub mode={MODE} call={SERVED['n']}",
            "telemetry": {"provider": "controlled_stub", "role": "FAST",
                          "latency_ms": 1.0, "attempts": 1, "fallback_used": False},
        }
        chosen: dict = {}
        if proposal is not None:
            envelope["proposal"] = proposal
            chosen = {"kind": proposal.get("kind")}
        else:
            action = next_action(MODE, SERVED["n"], payload)
            envelope["action"] = action
            # Compact, sanitized echo of what this call proposed. No typed text,
            # no page content — only the action shape the extension itself will
            # re-validate. It makes the wire sequence readable from the stub log.
            chosen = {k: action.get(k) for k in ("action", "target", "direction",
                                                 "amount", "url") if action.get(k) is not None}
        print("PROPOSAL", json.dumps({
            "mode": MODE,
            "call": SERVED["n"],
            "task": _task_text(payload)[:60],
            "chosen": chosen,
        }), flush=True)
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
                SERVED["n"] = 0
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
