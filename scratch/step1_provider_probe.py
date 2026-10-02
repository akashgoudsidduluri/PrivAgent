"""
STEP-1 FAILURE PROBE — perception -> first reasoner call -> first proposed action.

Runs the REAL reasoner (groq, then openrouter fallback) through the REAL backend
parsing + normalization + BrowserActionModel validation, with a context that
mirrors the real-Chrome run against the localhost:4174 contact-form fixture.

Captures, per attempt:
  - the provider HTTP status actually returned
  - the RAW model text the provider returned
  - what parse_model_action() made of it
  - what the agent.py normalizer did to it
  - whether BrowserActionModel accepted it

This distinguishes:
  A) external provider failure (429/5xx/network) — nothing PrivAgent can fix
  B) provider returned genuinely malformed data, correctly rejected
  C) PrivAgent mangled a valid action into an invalid one  <-- the only bug class
     worth a code change

The fixture context contains no PII, so raw model text is safe to print here.
"""
import json
import sys

sys.path.insert(0, ".")

from app import config
from app.models import BrowserActionModel, SafeDetectionExport
from app.reasoner import ReasoningError, build_reasoner, resolve_reasoner_name

TASK = "open http://localhost:4174 and fill the contact form"
URL = "http://localhost:4174/"

# Mirrors the real fixture: heading, full-name input, email input, submit button.
DETECTIONS = [
    {
        "id": "det-heading-1",
        "type": "pii",
        "confidence": 0.9,
        "bbox": {"x": 40, "y": 40, "width": 320, "height": 32},
        "length": 0,
        "source": "dom",
        "selector": "#heading",
        "is_partially_visible": False,
        "label": "Contact Form",
    },
    {
        "id": "det-email-1",
        "type": "email",
        "confidence": 0.95,
        "bbox": {"x": 40, "y": 150, "width": 260, "height": 32},
        "length": 0,
        "source": "dom",
        "selector": "#email",
        "is_partially_visible": False,
        "label": "Email",
    },
    {
        "id": "btn-submit",
        "type": "pii",
        "confidence": 0.6,
        "bbox": {"x": 40, "y": 210, "width": 90, "height": 34},
        "length": 6,
        "source": "dom",
        "selector": "#submit",
        "is_partially_visible": False,
        "label": "Submit",
    },
]

VIEWPORT = {"width": 1280, "height": 800, "scroll_x": 0.0, "scroll_y": 0.0}
SCREENSHOT_DIMS = {"width": 1280, "height": 757}


def replay_normalizer(raw_dict: dict) -> dict:
    """Verbatim replay of backend/app/routes/agent.py step-2 normalization."""
    d = dict(raw_dict)
    act_type = str(d.get("action", "")).strip()
    raw_dir = str(d.get("direction", "")).strip().lower()
    raw_url = str(d.get("url", "")).strip().lower()

    if act_type == "navigate":
        has_valid_http_url = raw_url.startswith(("http://", "https://"))
        is_scroll_intent = (
            not has_valid_http_url
            and (
                raw_url in ("down", "up", "downwards", "upwards", "bottom", "top")
                or raw_dir in ("down", "up", "downwards", "upwards", "bottom", "top")
                or (d.get("direction") is not None
                    and str(d.get("direction")).strip().lower() in ("down", "up"))
                or (d.get("amount") is not None and not d.get("url"))
            )
        )
        if is_scroll_intent:
            d["action"] = "scroll"
            d["direction"] = "up" if ("up" in raw_dir or "up" in raw_url or "top" in raw_url) else "down"
            amount_val = d.get("amount")
            try:
                d["amount"] = int(amount_val) if amount_val is not None else 500
            except (ValueError, TypeError):
                d["amount"] = 500
            d.pop("url", None)
            d.pop("text", None)
            d.pop("target", None)
        elif d.get("target") and not has_valid_http_url:
            if d.get("text"):
                d["action"] = "type"
                d.pop("url", None)
            else:
                d["action"] = "click"
                d.pop("url", None)

    act_type = d.get("action")

    if act_type == "scroll":
        dirv = str(d.get("direction", "down")).strip().lower()
        d["direction"] = "up" if ("up" in dirv or "top" in dirv) else "down"
        amt = d.get("amount")
        try:
            d["amount"] = max(1, min(5000, int(amt))) if amt is not None else 500
        except (ValueError, TypeError):
            d["amount"] = 500
        for k in ["target", "text", "option", "url", "key"]:
            d.pop(k, None)
    elif act_type == "click":
        for k in ["direction", "amount", "text", "option", "url", "key"]:
            d.pop(k, None)
    elif act_type == "type":
        for k in ["direction", "amount", "option", "url", "key"]:
            d.pop(k, None)
    elif act_type == "select":
        for k in ["direction", "amount", "text", "url", "key"]:
            d.pop(k, None)
    elif act_type == "navigate":
        for k in ["target", "direction", "amount", "text", "option", "key"]:
            d.pop(k, None)
    elif act_type == "pressKey":
        raw_key = str(d.get("key", "")).strip()
        key_map = {
            "enter": "Enter", "return": "Enter", "tab": "Tab", "escape": "Escape",
            "esc": "Escape", "arrowdown": "ArrowDown", "down": "ArrowDown",
            "arrowup": "ArrowUp", "up": "ArrowUp", "arrowleft": "ArrowLeft",
            "left": "ArrowLeft", "arrowright": "ArrowRight", "right": "ArrowRight",
            "backspace": "Backspace", "delete": "Delete",
        }
        if raw_key.lower() in key_map:
            d["key"] = key_map[raw_key.lower()]
        for k in ["direction", "amount", "text", "option", "url"]:
            d.pop(k, None)
    return d


def attempt(name: str):
    reasoner = build_reasoner(name)
    print("=" * 72)
    print(f"PROVIDER ATTEMPT: {name}  (class={type(reasoner).__name__})")
    print("=" * 72)
    try:
        result = reasoner.request_action(
            task=TASK,
            url=URL,
            detections=DETECTIONS,
            history=[],
            viewport=VIEWPORT,
            screenshot_dimensions=SCREENSHOT_DIMS,
            page_type="general",
            semantic_context=None,
        )
    except ReasoningError as err:
        print(f"  OUTCOME            : ReasoningError kind={err.kind!r} retryable={err.retryable}")
        print(f"  MESSAGE            : {err}")
        print("  CLASSIFICATION     : provider-side failure BEFORE any action existed")
        return {"provider": name, "ok": False, "kind": err.kind, "retryable": err.retryable}

    print(f"  HTTP/PROVIDER OK   : model={result.model} latency_ms={result.latency_ms:.1f} attempts={result.attempts}")
    print(f"  RAW MODEL ACTION   : {json.dumps(result.raw_action)}")
    print(f"  NORMALIZED         : ", end="")
    try:
        norm = replay_normalizer(dict(result.raw_action))
        print(json.dumps(norm))
    except Exception as err:
        print(f"<normalizer raised {type(err).__name__}: {err}>")
        return {"provider": name, "ok": False, "kind": "normalizer_error", "raw": result.raw_action}

    try:
        validated = BrowserActionModel.model_validate(norm)
    except Exception as err:
        print(f"  BrowserActionModel : REJECTED -> {err}")
        print("  CLASSIFICATION     : provider returned a shape the strict model refuses")
        return {"provider": name, "ok": False, "kind": "invalid_action", "raw": result.raw_action, "norm": norm}

    print(f"  BrowserActionModel : ACCEPTED -> {validated.model_dump(exclude_none=True)}")

    # Step 3: target-ID grounding against the supplied detections.
    provided = {d["id"] for d in DETECTIONS}
    if validated.target is not None and validated.target not in provided:
        print("  TARGET GROUNDING   : REJECTED (target not in sanitized context) -> HTTP 422 unknown_target")
        return {"provider": name, "ok": False, "kind": "unknown_target", "raw": result.raw_action}

    print("  TARGET GROUNDING   : PASS")
    print("  OUTCOME            : a valid action would be returned to the extension (HTTP 200)")
    return {"provider": name, "ok": True, "action": validated.model_dump(exclude_none=True), "raw": result.raw_action}


primary = resolve_reasoner_name(config.REASONER_MODE)
fallback = (config.REASONER_FALLBACK_PROVIDER or "").strip().lower()
print(f"configured: primary={primary} fallback={fallback or 'none'} keyConfigured={config.has_api_key('groq')}")
print()

results = [attempt(primary)]
if fallback and fallback in ("groq", "nvidia", "openrouter", "mock") and fallback != primary:
    print()
    results.append(attempt(fallback))

print()
print("=" * 72)
print("SUMMARY")
for r in results:
    print(f"  {r['provider']:12s} ok={r['ok']} kind={r.get('kind')}")
print("=" * 72)
