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
from typing import Annotated, Any, ClassVar, Dict, List, Optional

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
    # Sensitive entity types (redacted on-device)
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
    # Interactive controls & elements (sanitized structural metadata)
    button = "button"
    link = "link"
    input = "input"
    search = "search"
    select = "select"
    form = "form"
    heading = "heading"
    element = "element"


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
    label: Optional[str] = ""

    @field_validator("label")
    @classmethod
    def validate_label_safety(cls, v: Optional[str]) -> Optional[str]:
        """Ensure label contains zero raw passwords, cards, or security tokens."""
        if v:
            scan_text(v)
        return v

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
    page_type: Optional[str] = "general"
    semantic_context: Optional[Dict[str, Any]] = None
    memory_hints: Optional[Dict[str, Any]] = None

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
    version: str = "0.8.0"
    service: str = "PrivAgent Agent Safety API"
    backend_status: str = "CONNECTED"      # CONNECTED | OFFLINE
    reasoner: str = "groq"                 # active primary reasoner mode (never the key)
    reasoner_status: str = "AVAILABLE"     # AVAILABLE | RATE_LIMITED | UNCONFIGURED | ERROR
    reasoner_configured: bool = False      # whether an API key is present
    model: Optional[str] = None
    fallback_reasoner: Optional[str] = None
    fallback_configured: bool = False
    privacy_firewall: str = "ACTIVE"       # ACTIVE | ERROR
    sensitive_data_sent: int = 0           # Invariant: 0


# ── Milestone 5: Structured Browser Action Models ────────────────────────────

class BrowserActionType(str, Enum):
    click = "click"
    scroll = "scroll"
    type = "type"
    select = "select"
    navigate = "navigate"
    pressKey = "pressKey"


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
    key: Optional[str] = None
    reason: Optional[Annotated[str, Field(max_length=300)]] = None
    effect: Optional[Annotated[str, Field(max_length=100)]] = None
    scroll_delta: Optional[int] = Field(default=None, validation_alias=AliasChoices("scroll_delta", "scrollDelta"))

    @field_validator("effect")
    @classmethod
    def validate_effect_safety(cls, v: Optional[str]) -> Optional[str]:
        if v:
            scan_text(v)
        return v

    # Which optional fields are ALLOWED for each action type.
    _ALLOWED_FIELDS: Dict[BrowserActionType, frozenset] = {
        BrowserActionType.click: frozenset({"target"}),
        BrowserActionType.scroll: frozenset({"direction", "amount"}),
        BrowserActionType.type: frozenset({"target", "text"}),
        BrowserActionType.select: frozenset({"target", "option"}),
        BrowserActionType.navigate: frozenset({"url"}),
        BrowserActionType.pressKey: frozenset({"key", "target"}),
    }

    # Which optional fields are REQUIRED for each action type.
    _REQUIRED_FIELDS: Dict[BrowserActionType, frozenset] = {
        BrowserActionType.click: frozenset({"target"}),
        BrowserActionType.scroll: frozenset({"direction", "amount"}),
        BrowserActionType.type: frozenset({"target", "text"}),
        BrowserActionType.select: frozenset({"target", "option"}),
        BrowserActionType.navigate: frozenset({"url"}),
        BrowserActionType.pressKey: frozenset({"key"}),
    }

    MIN_SCROLL_AMOUNT: ClassVar[int] = 1
    MAX_SCROLL_AMOUNT: ClassVar[int] = 5000

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
            "key": self.key,
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
        if self.action is BrowserActionType.pressKey:
            safe_keys = {
                "Enter", "Tab", "Escape", "ArrowDown", "ArrowUp",
                "ArrowLeft", "ArrowRight", "Backspace", "Delete"
            }
            if self.key not in safe_keys:
                # Case-tolerant matching for standard keys
                matched = next((k for k in safe_keys if k.lower() == (self.key or "").lower()), None)
                if matched:
                    self.key = matched
                else:
                    raise ValueError(
                        f"[PrivAgent Security] Key '{self.key}' is not in the safe key allowlist."
                    )

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


class ModelRole(str, Enum):
    FAST = "FAST"
    STRONG = "STRONG"
    VISION = "VISION"
    SAFETY = "SAFETY"

class AgentActionRequest(StrictModel):
    """
    Incoming request to the Agent Reasoning API.
    Contains ONLY the task string, sanitized context, and safe action-history
    metadata (previous structured browser actions — never raw values).
    """
    task: str
    context: AgentContextPayload
    history: List[BrowserActionModel] = Field(default_factory=list)
    model_role: Optional[ModelRole] = None


class ReasoningTelemetry(StrictModel):
    """
    Safe reasoning telemetry — identifiers and durations only.
    Never contains prompts, model text, or API key material.
    """
    provider: str                      # "groq" | "openrouter" | "mock"
    role: str                          # e.g. "STRONG", "FAST"
    latency_ms: float
    attempts: int = 1
    fallback_used: bool = False
    error_kind: Optional[str] = None   # "timeout" | "auth" | "invalid_json" | ...
    # PHASE 18.5 / I-3. Names of diagnostic fields the reasoner bounded to
    # their limit instead of rejecting the turn. NAMES ONLY — never content.
    clamped_fields: Optional[List[str]] = None


class ProposalKind(str, Enum):
    """
    PHASE 18.7 / A1 — what the model PROPOSES to do next.

    The model is a PROPOSER. It never decides an outcome. `ANSWER`,
    `NEEDS_INFORMATION`, `PARTIAL` and `CANNOT_VERIFY` are claims the device
    must independently check against the evidence ledger before anything is
    reported to the user. Only the GoalVerifier may mark a task SUCCESS, and
    an ANSWER proposal is not a SUCCESS.
    """
    ACTION = "ACTION"
    ANSWER = "ANSWER"
    NEEDS_INFORMATION = "NEEDS_INFORMATION"
    PARTIAL = "PARTIAL"
    CANNOT_VERIFY = "CANNOT_VERIFY"


# Bounds for proposal text. These are PROPOSAL limits, not new egress limits:
# the existing MAX_* action bounds are unchanged, and every value here is
# still scanned by the text-safety layer before it can leave the backend.
MAX_PROPOSAL_REASON_CHARS = 300
MAX_PROPOSAL_ANSWER_CHARS = 1500
MAX_PROPOSAL_QUESTION_CHARS = 300
MAX_PROPOSAL_CITATIONS = 12
MAX_PROPOSAL_ITEM_CHARS = 200


class AgentProposal(StrictModel):
    """
    PHASE 18.7 / A1 — a structured proposal from the reasoner.

    INERT BY CONSTRUCTION. Carrying no authority means, concretely:
      - it carries no risk score, no Security Critic verdict, no containment
        decision and no verifier internals;
      - `citedEvidence` holds ledger RECORD IDS only, so a claim cannot cite
        its own text — the device resolves the id against the ledger it holds;
      - `answer` is model prose and is therefore UNTRUSTED: it is scanned by
        the text-safety layer and re-checked against the ledger on device.

    It is additive: `extra='forbid'` stays in force, so an unknown key is a
    422 rather than a silently accepted field.
    """
    kind: ProposalKind
    reason: Annotated[str, Field(min_length=1, max_length=MAX_PROPOSAL_REASON_CHARS)]
    question: Optional[Annotated[str, Field(max_length=MAX_PROPOSAL_QUESTION_CHARS)]] = None
    answer: Optional[Annotated[str, Field(max_length=MAX_PROPOSAL_ANSWER_CHARS)]] = None
    cited_evidence: List[Annotated[str, Field(min_length=1, max_length=120)]] = Field(
        default_factory=list, max_length=MAX_PROPOSAL_CITATIONS
    )
    missing: List[Annotated[str, Field(min_length=1, max_length=MAX_PROPOSAL_ITEM_CHARS)]] = Field(
        default_factory=list, max_length=MAX_PROPOSAL_CITATIONS
    )
    # Present and required ONLY when kind == ACTION. The route guarantees it.
    action: Optional[BrowserActionModel] = None

    @model_validator(mode="after")
    def _kind_shape(self) -> "AgentProposal":
        if self.kind == ProposalKind.ACTION and self.action is None:
            raise ValueError("[PrivAgent Security] An ACTION proposal must carry an action.")
        if self.kind == ProposalKind.ANSWER and not (self.answer or "").strip():
            raise ValueError("[PrivAgent Security] An ANSWER proposal must carry answer text.")
        if self.kind in (ProposalKind.NEEDS_INFORMATION, ProposalKind.CANNOT_VERIFY) and self.action is not None:
            raise ValueError(
                "[PrivAgent Security] A non-ACTION proposal must not carry an action."
            )
        return self


class AgentActionResponse(StrictModel):
    """
    Response containing the structured browser action and reasoning summary.

    PHASE 18.7 / A1: `action` is now Optional and a sibling `proposal` was
    added. This is WIDENING, not weakening — the response must still carry at
    least one of the two, exactly one `action` can be executed, and every
    action-only path is byte-for-byte unchanged because a response that has an
    action and no proposal is exactly what it was before.
    """
    success: bool = True
    action: Optional[BrowserActionModel] = None
    reason: str
    proposal: Optional[AgentProposal] = None
    telemetry: Optional[ReasoningTelemetry] = None

    @model_validator(mode="after")
    def _at_least_one(self) -> "AgentActionResponse":
        if self.action is None and self.proposal is None:
            raise ValueError(
                "[PrivAgent Security] Response must carry an action or a proposal."
            )
        if self.action is not None and self.proposal is not None:
            if self.proposal.kind != ProposalKind.ACTION or self.proposal.action is not self.action:
                raise ValueError(
                    "[PrivAgent Security] An ACTION proposal must be the same object as the response action."
                )
        return self


AgentContextPayload.model_rebuild()
AgentActionRequest.model_rebuild()
AgentProposal.model_rebuild()
AgentActionResponse.model_rebuild()

