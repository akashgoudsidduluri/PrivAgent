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
from typing import Annotated, Dict, List, Optional

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator, model_validator

from .text_safety import scan_reason_text, scan_text


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
    address = "address"


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
            "token", "secret", "card", "cardNumber", "card_number", "cvv",
            "pan", "accountNumber", "account_number", "raw", "input",
            "sensitiveValue", "sensitive_value", "pii",
        })
        FORBIDDEN_NORMALIZED = frozenset(k.lower().replace("_", "") for k in FORBIDDEN)
        for key in data.keys():
            norm = str(key).lower().replace("_", "")
            if norm in FORBIDDEN_NORMALIZED or key in FORBIDDEN:
                raise ValueError(
                    f"[PrivAgent Security] SafeDetectionExport contains forbidden PII key: '{key}'. "
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
    version: str = "0.7.0"
    service: str = "PrivAgent Agent Safety API"
    reasoner: str = "openrouter"           # active reasoner mode (never the key)
    reasoner_configured: bool = False      # whether an API key is present


# ── Milestone 5: Structured Browser Action Models ────────────────────────────

class BrowserActionType(str, Enum):
    click = "click"
    scroll = "scroll"
    type = "type"
    select = "select"
    navigate = "navigate"


class BrowserActionModel(StrictModel):
    """
    Strict Pydantic model for structured browser actions.
    extra='forbid' prevents arbitrary fields or code injection.

    Milestone 7 hardening (defense-in-depth):
      - Field applicability is enforced per action type (e.g. a 'click' with
        a 'text' field, or a 'scroll' with a 'url', is rejected).
      - scroll direction is restricted to up|down and amount is bounded.
      - navigate URLs must be http(s) — javascript:/data:/file: are rejected.
      - 'type' text is scanned for script-injection syntax.
      - Model-emitted free text (type.text, select.option, reason) is scanned
        for PII/credential-shaped content (text_safety.py) BEFORE it can
        execute in the browser or enter action history / the next LLM prompt.
      - Free-text fields are length-bounded; oversized values are REJECTED,
        never silently truncated.

    The extension-side M5 validator remains the authoritative gate; this model
    stops malformed actions one boundary earlier at the backend.
    """
    action: BrowserActionType
    target: Optional[str] = None
    direction: Optional[str] = None
    amount: Optional[int] = None
    text: Optional[Annotated[str, Field(max_length=500)]] = None
    option: Optional[Annotated[str, Field(max_length=200)]] = None
    url: Optional[str] = None
    reason: Optional[Annotated[str, Field(max_length=300)]] = None

    # Which optional fields are ALLOWED for each action type.
    _ALLOWED_FIELDS: Dict[BrowserActionType, frozenset] = {
        BrowserActionType.click: frozenset({"target"}),
        BrowserActionType.scroll: frozenset({"direction", "amount"}),
        BrowserActionType.type: frozenset({"target", "text"}),
        BrowserActionType.select: frozenset({"target", "option"}),
        BrowserActionType.navigate: frozenset({"url"}),
    }

    # Which optional fields are REQUIRED for each action type.
    _REQUIRED_FIELDS: Dict[BrowserActionType, frozenset] = {
        BrowserActionType.click: frozenset({"target"}),
        BrowserActionType.scroll: frozenset({"direction", "amount"}),
        BrowserActionType.type: frozenset({"target", "text"}),
        BrowserActionType.select: frozenset({"target", "option"}),
        BrowserActionType.navigate: frozenset({"url"}),
    }

    MIN_SCROLL_AMOUNT: int = 1
    MAX_SCROLL_AMOUNT: int = 5000

    @model_validator(mode="after")
    def validate_action_shape(self) -> "BrowserActionModel":
        allowed = self._ALLOWED_FIELDS[self.action]
        required = self._REQUIRED_FIELDS[self.action]

        provided = {
            "target": self.target,
            "direction": self.direction,
            "amount": self.amount,
            "text": self.text,
            "option": self.option,
            "url": self.url,
        }

        # 1. Reject fields that do not belong to this action type.
        for name, value in provided.items():
            if value is not None and name not in allowed:
                raise ValueError(
                    f"[PrivAgent Security] Field '{name}' is not allowed on a "
                    f"'{self.action.value}' action."
                )

        # 2. Require the fields this action type needs.
        for name in required:
            if provided[name] is None:
                raise ValueError(
                    f"[PrivAgent Security] Action '{self.action.value}' requires "
                    f"a non-empty '{name}' field."
                )

        # 3. Per-field constraints.
        if self.action is BrowserActionType.scroll:
            if self.direction not in ("up", "down"):
                raise ValueError(
                    "[PrivAgent Security] scroll direction must be 'up' or 'down'."
                )
            if self.amount is None or not (self.MIN_SCROLL_AMOUNT <= self.amount <= self.MAX_SCROLL_AMOUNT):
                raise ValueError(
                    f"[PrivAgent Security] scroll amount must be between "
                    f"{self.MIN_SCROLL_AMOUNT} and {self.MAX_SCROLL_AMOUNT}."
                )

        if self.action is BrowserActionType.navigate and self.url is not None:
            from urllib.parse import urlparse

            parsed = urlparse(self.url)
            if parsed.scheme not in ("http", "https"):
                raise ValueError(
                    "[PrivAgent Security] navigate URL must use http or https."
                )

        if self.action is BrowserActionType.type and self.text is not None:
            lowered = self.text.lower()
            if "<script" in lowered or "javascript:" in lowered:
                raise ValueError(
                    "[PrivAgent Security] type text contains prohibited script injection syntax."
                )

        if self.target is not None and not self.target.strip():
            raise ValueError("[PrivAgent Security] target must be a non-empty string.")

        # 4. Value-scan model-emitted free text (defense-in-depth, Phase 2).
        #    Structural metadata (target IDs, direction, amounts, URLs) is NOT
        #    scanned — only human-readable free-text fields.
        if self.text is not None:
            finding = scan_text(self.text)
            if finding:
                raise ValueError(
                    f"[PrivAgent Security] type text rejected by text-safety scan "
                    f"(rule={finding.rule}). Sensitive values must never transit "
                    "through agent actions."
                )
        if self.option is not None:
            finding = scan_text(self.option)
            if finding:
                raise ValueError(
                    f"[PrivAgent Security] select option rejected by text-safety scan "
                    f"(rule={finding.rule}). Sensitive values must never transit "
                    "through agent actions."
                )
        if self.reason is not None:
            finding = scan_reason_text(self.reason)
            if finding:
                raise ValueError(
                    f"[PrivAgent Security] action reason rejected by text-safety scan "
                    f"(rule={finding.rule}). Reasons must not contain sensitive values."
                )

        return self


class AgentActionRequest(StrictModel):
    """
    Incoming request to the Agent Reasoning API.
    Contains ONLY the task string, sanitized context, and safe action-history
    metadata (previous structured browser actions — never raw values).
    """
    task: str
    context: AgentContextPayload
    history: List[BrowserActionModel] = Field(default_factory=list)


class ReasoningTelemetry(StrictModel):
    """
    Safe reasoning telemetry — identifiers and durations only.
    Never contains prompts, model text, or API key material.
    """
    provider: str                      # "openrouter" | "mock"
    model: str                         # e.g. "google/gemma-4-31b-it:free"
    latency_ms: float
    attempts: int = 1
    error_kind: Optional[str] = None   # "timeout" | "auth" | "invalid_json" | ...


class AgentActionResponse(StrictModel):
    """
    Response containing the structured browser action and reasoning summary.
    """
    success: bool = True
    action: BrowserActionModel
    reason: str
    telemetry: Optional[ReasoningTelemetry] = None

