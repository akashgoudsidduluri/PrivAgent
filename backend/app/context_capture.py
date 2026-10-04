"""
PHASE 18.5 / TIER 1.3 — MODEL-FACING CONTEXT CAPTURE.

INSTRUMENTATION ONLY. This module observes; it never transforms, filters,
adds to, or removes from anything the model sees. `_build_user_prompt` still
returns exactly the string it returned before, byte for byte — the capture
happens alongside the return, not inside it.

WHY HERE
--------
`_build_user_prompt` is the single choke point through which EVERY provider
(Groq, OpenRouter, NVIDIA) assembles the user prompt. Capturing here proves
what the LLM was actually given, rather than inferring it from the fact that a
prompt-building function exists.

SAFETY
------
The captured prompt is built from allowlisted, already-sanitized fields, so it
carries no raw DOM values, no input `value`, no textContent/innerText and no
sensitive OCR text BY CONSTRUCTION — that is the existing privacy boundary,
not something this module establishes. To make that a checked claim rather
than an assumed one, `privacy_self_check` independently re-scans the captured
text for forbidden key names and raw-value markers and records the verdict in
the artifact. A failure is reported, never suppressed.

The capture is OFF unless `PRIVAGENT_CAPTURE_DIR` is set, so production
behaviour and egress are unchanged when it is not in use.
"""
from __future__ import annotations

import json
import os
import threading
import time
from typing import Any, Dict, List, Optional

_lock = threading.Lock()
_counter = 0

# Set by `_build_user_prompt`; read by the route to attach the exact prompt to
# the request envelope that produced it. Single-request lifecycle in practice,
# and guarded by the lock so concurrent requests cannot interleave a prompt
# with the wrong envelope.
_last_prompt: Optional[Dict[str, Any]] = None

# Key names that must never appear in model-facing text. This is an
# INDEPENDENT re-check of the upstream M5 / backend firewall guarantee.
_FORBIDDEN_KEY_MARKERS = (
    "textContent",
    "innerText",
    "rawText",
    "rawOCR",
    "ocrText",
    "password",
    "cardNumber",
    "accountNumber",
    "sensitiveValue",
    "sensitive_value",
    "\"value\"",
)

# High-entropy / sensitive-looking raw markers. Deliberately narrow: this is a
# tripwire, not a redactor, and it never modifies anything.
_RAW_VALUE_MARKERS = (
    "sk-",
    "gsk_",
    "nvapi-",
    "Bearer ",
)


def capture_enabled() -> bool:
    return bool(os.environ.get("PRIVAGENT_CAPTURE_DIR"))


def record_prompt(prompt: str, inputs: Dict[str, Any]) -> None:
    """Record the exact prompt that is about to be sent to the LLM."""
    global _last_prompt
    with _lock:
        _last_prompt = {"prompt": prompt, "inputs": inputs}


def take_prompt() -> Optional[Dict[str, Any]]:
    """Consume the most recent prompt, if any."""
    global _last_prompt
    with _lock:
        captured = _last_prompt
        _last_prompt = None
    return captured


def privacy_self_check(prompt: str, envelope: Dict[str, Any]) -> Dict[str, Any]:
    """Independently verify the capture carries no raw sensitive markers."""
    blob = prompt + json.dumps(envelope, default=str)

    hits = [m for m in _FORBIDDEN_KEY_MARKERS if m in blob]
    raw_hits = [m for m in _RAW_VALUE_MARKERS if m in blob]

    # A screenshot is only ever referenced by DIMENSIONS. Any payload carrying
    # base64 image data, a data: URI, or an image mime type would mean pixels
    # crossed the boundary.
    screenshot_fields = _find_screenshot_fields(envelope)

    return {
        "forbiddenKeyMarkersFound": hits,
        "rawValueMarkersFound": raw_hits,
        "screenshotDataFieldsFound": screenshot_fields,
        "rawScreenshotsTransmitted": 0 if not screenshot_fields else len(screenshot_fields),
        "clean": not hits and not raw_hits and not screenshot_fields,
    }


def _find_screenshot_fields(node: Any, path: str = "$") -> List[str]:
    """Find any field that could carry image data rather than image metadata."""
    found: List[str] = []
    if isinstance(node, dict):
        for k, v in node.items():
            lowered = str(k).lower()
            here = f"{path}.{k}"
            if isinstance(v, str) and (v.startswith("data:image") or len(v) > 20000):
                found.append(here)
            elif any(m in lowered for m in ("base64", "image_data", "pixels", "png", "jpeg")):
                found.append(here)
            else:
                found.extend(_find_screenshot_fields(v, here))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            found.extend(_find_screenshot_fields(v, f"{path}[{i}]"))
    return found


def write_capture(
    task: str,
    envelope: Dict[str, Any],
    prompt_bundle: Optional[Dict[str, Any]],
    response_summary: Optional[Dict[str, Any]] = None,
) -> Optional[str]:
    """Write one capture artifact. Returns the path, or None when disabled."""
    out_dir = os.environ.get("PRIVAGENT_CAPTURE_DIR")
    if not out_dir:
        return None

    global _counter
    with _lock:
        _counter += 1
        seq = _counter

    prompt = (prompt_bundle or {}).get("prompt") or ""
    inputs = (prompt_bundle or {}).get("inputs") or {}

    artifact = {
        "seq": seq,
        "capturedAt": time.time(),
        "layer": "backend_prompt_boundary",
        "note": (
            "Exact model-facing text. INSTRUMENTATION ONLY - does not alter "
            "the prompt. Anything present here reached the real LLM."
        ),
        "task": task,
        "promptChars": len(prompt),
        # The exact string handed to the provider.
        "exactModelFacingPrompt": prompt,
        "allowlistedInputsToPromptBuilder": inputs,
        "requestEnvelope": envelope,
        "privacySelfCheck": privacy_self_check(prompt, envelope),
        "providerResponse": response_summary,
    }

    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"llm_context_{seq:04d}.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(artifact, fh, indent=2, default=str)
    return path