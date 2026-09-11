"""
Pydantic v2 models for the PrivAgent Agent Safety API.

Security Contract:
  - AgentContextPayload MUST contain ONLY sanitized metadata.
  - No raw PII values (text, value, password, textContent, innerText, rawText) allowed.
  - extra='forbid' on ALL models — unknown fields are REJECTED, not silently dropped.
    This prevents a security bug where an unexpected sensitive field could be silently ignored.
  - Validated at ingestion time by the Pydantic models AND the independent security validator.
"""
from __future__ import annotations

from enum import Enum
from typing import Annotated, List, Optional

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator, model_validator


# ── Shared strict base ────────────────────────────────────────────────────────

class StrictModel(BaseModel):
    """
    Base model with extra='forbid'. Unknown fields are REJECTED.
    This is critical: silently dropping an unknown sensitive field could hide a bug.
    """
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


# ── Enums ─────────────────────────────────────────────────────────────────────

class DetectionSource(str, Enum):
    dom_input_type = "dom_input_type"
    dom_autocomplete = "dom_autocomplete"
    dom_attribute = "dom_attribute"
    dom_label = "dom_label"
    text_pattern = "text_pattern"
    ocr = "ocr"


class SensitiveEntityType(str, Enum):
    password = "password"
    email = "email"
    phone = "phone"
    credit_card = "credit_card"
    account_number = "account_number"
    person_name = "person_name"
    pan = "pan"
    otp = "otp"
    cvv = "cvv"


# ── Sub-models ────────────────────────────────────────────────────────────────

class BoundingBox(StrictModel):
    """Screen-space bounding box in pixels. No raw PII — only geometry."""
    x: float
    y: float
    width: float
    height: float


class SafeDetectionExport(StrictModel):
    """
    Allowlisted sanitized detection — contains ONLY safe metadata fields.
    The backend explicitly forbids extra keys so raw PII can never slip through.
    """
    id: str
    type: SensitiveEntityType
    confidence: Annotated[float, Field(ge=0.0, le=1.0)]
    bbox: BoundingBox
    length: Annotated[int, Field(ge=0)]    # character count only — not the value
    source: DetectionSource
    selector: str = ""
    is_partially_visible: bool = False

    @model_validator(mode="before")
    @classmethod
    def reject_forbidden_keys(cls, data: object) -> object:
        """Explicit guard against raw PII keys sneaking into a detection object."""
        if not isinstance(data, dict):
            return data
        FORBIDDEN = frozenset({
            "value", "text", "textContent", "innerText",
            "rawText", "rawOCR", "ocrText", "password", "words", "lines",
        })
        found = FORBIDDEN & set(data.keys())
        if found:
            raise ValueError(
                f"[PrivAgent Security] SafeDetectionExport contains forbidden PII key(s): {found}. "
                "Raw sensitive values must never be included in the agent payload."
            )
        return data


class ViewportInfo(StrictModel):
    width: int
    height: int
    scroll_x: float = 0.0
    scroll_y: float = 0.0


class ScreenshotDimensions(StrictModel):
    width: int
    height: int


class OCRMetrics(StrictModel):
    regions_scanned: int
    sensitive_detected: int
    latency_ms: float


# ── Main payload ──────────────────────────────────────────────────────────────

# The ONLY accepted sanitized status string in the API.
_REQUIRED_STATUS = "sanitized_only"


class AgentContextPayload(StrictModel):
    """
    The formal, typed, security-validated context payload produced by the
    PrivAgent extension and consumed by the agent / LLM gateway.

    Security invariants:
      - extra='forbid': unknown fields cause a 422 rejection.
      - sanitized_status must EXACTLY equal the required sentinel string 'sanitized_only'.
      - detections are individually validated for forbidden keys.
      - The backend security.py runs an additional independent recursive scan.
    """
    url: str
    timestamp: Annotated[int, Field(gt=0)]
    viewport: ViewportInfo
    screenshot_dimensions: Optional[ScreenshotDimensions] = None
    detections: List[SafeDetectionExport]
    total_elements_scanned: Annotated[int, Field(ge=0)]
    sensitive_elements_detected: Annotated[int, Field(ge=0)]
    sanitized_status: str = Field(
        validation_alias=AliasChoices("sanitized_status", "sanitizedStatus"),
    )
    ocr_metrics: Optional[OCRMetrics] = None

    @field_validator("sanitized_status")
    @classmethod
    def validate_status(cls, v: str) -> str:
        if v != _REQUIRED_STATUS:
            raise ValueError(
                f"[PrivAgent Security] Payload rejected: sanitized_status must be exactly "
                f"'{_REQUIRED_STATUS}'. Got: '{v}'"
            )
        return v


# ── API response models ───────────────────────────────────────────────────────

class ContextAcceptedResponse(StrictModel):
    success: bool = True
    message: str
    received_at: int
    detection_count: int


class ContextResponse(StrictModel):
    received_at: int
    payload: AgentContextPayload


class HealthResponse(BaseModel):  # not strict — allow future additions
    status: str = "ok"
    version: str = "0.4.0"
    service: str = "PrivAgent Agent Safety API"
