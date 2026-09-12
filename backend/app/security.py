"""
PrivAgent Backend Security Layer — Independent Recursive Validator.

This is a SECOND security boundary, entirely independent of the extension's
security boundary and the Pydantic model validation.

It performs a recursive key scan of the raw request payload dictionary BEFORE
any processing, so forbidden keys are caught even if Pydantic somehow allowed them
(e.g. via a library bug or model misconfiguration).

Security Principle: "Never trust the client."
The backend must NEVER assume "the extension already sanitized it."
"""
from __future__ import annotations

# ── Forbidden key set ─────────────────────────────────────────────────────────
# These keys must NEVER appear anywhere in an incoming payload — at any depth.
# Checked case-insensitively and with underscore-agnostic exact matching.
FORBIDDEN_KEYS: frozenset[str] = frozenset({
    "value",
    "text",
    "textContent",
    "innerText",
    "rawText",
    "rawOCR",
    "ocrText",
    "password",
    "words",
    "lines",
    "token",
    "secret",
    "card",
    "cardNumber",
    "card_number",
    "cvv",
    "pan",
    "accountNumber",
    "account_number",
    "raw",
    "input",
    "sensitiveValue",
    "pii",
})

FORBIDDEN_KEYS_NORMALIZED: frozenset[str] = frozenset(
    k.lower().replace("_", "") for k in FORBIDDEN_KEYS
)

# The ONLY accepted sanitized status string in the API.
REQUIRED_STATUS = "sanitized_only"


class PayloadSecurityError(ValueError):
    """Raised when a payload fails the independent backend security scan."""


def verify_payload_invariants(raw: dict) -> None:
    """
    Independently validate the raw (deserialized) payload dictionary.

    Performs:
      1. Recursive forbidden-key scan across all dicts and lists.
      2. Validates sanitized_status is the exact required sentinel.
      3. Basic structural sanity checks on detections.

    Raises:
        PayloadSecurityError: if any invariant is violated.
    """
    # 1. Recursive forbidden-key scan
    _scan_keys_recursive(raw, path="<root>")

    # 2. Validate sanitized_status
    status = raw.get("sanitized_status", None)
    if status is None:
        raise PayloadSecurityError(
            "[PrivAgent Backend Security] Payload missing required 'sanitized_status' field."
        )
    if status != REQUIRED_STATUS:
        raise PayloadSecurityError(
            f"[PrivAgent Backend Security] Invalid sanitized_status: '{status}'. "
            f"Expected exactly: '{REQUIRED_STATUS}'"
        )

    # 3. Structural checks on detections list
    detections = raw.get("detections", [])
    if not isinstance(detections, list):
        raise PayloadSecurityError(
            "[PrivAgent Backend Security] 'detections' must be a list."
        )
    for i, det in enumerate(detections):
        if not isinstance(det, dict):
            raise PayloadSecurityError(
                f"[PrivAgent Backend Security] Detection at index {i} is not an object."
            )
        # Validate confidence range
        confidence = det.get("confidence")
        if confidence is not None:
            try:
                conf_float = float(confidence)
            except (TypeError, ValueError):
                raise PayloadSecurityError(
                    f"[PrivAgent Backend Security] Detection[{i}].confidence is not numeric."
                )
            if not (0.0 <= conf_float <= 1.0):
                raise PayloadSecurityError(
                    f"[PrivAgent Backend Security] Detection[{i}].confidence={conf_float} out of [0,1]."
                )
        # Validate bbox
        bbox = det.get("bbox")
        if bbox is not None:
            if not isinstance(bbox, dict):
                raise PayloadSecurityError(
                    f"[PrivAgent Backend Security] Detection[{i}].bbox must be an object."
                )
            for dim in ("x", "y", "width", "height"):
                if dim not in bbox:
                    raise PayloadSecurityError(
                        f"[PrivAgent Backend Security] Detection[{i}].bbox missing '{dim}'."
                    )


def _scan_keys_recursive(obj: object, path: str) -> None:
    """
    Recursively walk obj and raise PayloadSecurityError if any key in
    FORBIDDEN_KEYS is found at any level of nesting.
    """
    if isinstance(obj, dict):
        for key, value in obj.items():
            norm_key = str(key).lower().replace("_", "")
            if norm_key in FORBIDDEN_KEYS_NORMALIZED or key in FORBIDDEN_KEYS:
                raise PayloadSecurityError(
                    f"[PrivAgent Backend Security] Forbidden key '{key}' found at path '{path}.{key}'. "
                    "Raw PII values must NEVER be transmitted to the backend."
                )
            _scan_keys_recursive(value, path=f"{path}.{key}")
    elif isinstance(obj, (list, tuple)):
        for i, item in enumerate(obj):
            _scan_keys_recursive(item, path=f"{path}[{i}]")
    # Scalars (str, int, float, bool, None) are safe — we only check keys
