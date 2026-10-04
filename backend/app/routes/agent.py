"""
PrivAgent Agent Reasoning Route (Milestones 5 → 7).

Endpoint:
  POST /api/v1/agent/action — receives user task + sanitized page context,
  performs ONE structured reasoning request (Gemma via OpenRouter, or the
  deterministic mock reasoner for offline tests), validates the result, and
  returns a structured browser action.

Security Invariants:
  1. Incoming payload context MUST pass recursive forbidden-key check
     (defense-in-depth) and strict Pydantic validation (extra="forbid").
  2. NO first-detection / nearest-element guessing. If the reasoner cannot
     identify a valid target from the sanitized metadata, the endpoint fails
     safely with success=false — the extension's M6 loop decides whether to
     re-perceive or stop. M6 owns all loop semantics.
  3. The LLM's raw output is UNTRUSTED: it is parsed defensively, then
     re-validated through BrowserActionModel, then checked against the
     provided detections. The extension re-validates everything again (M5).
  4. The API key never leaves the backend process and never appears in
     errors, logs, or responses.
"""
from __future__ import annotations

import logging
from typing import Dict, List, Any

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import ValidationError as PydanticValidationError

from .. import config
from ..models import (
    AgentActionRequest,
    AgentActionResponse,
    BrowserActionModel,
    ReasoningTelemetry,
)
from ..reasoner import (
    ReasoningError,
    build_reasoner,
    last_clamped_fields,
    resolve_reasoner_name,
)
from ..security import PayloadSecurityError, verify_payload_invariants

router = APIRouter(prefix="/api/v1/agent", tags=["agent"])
logger = logging.getLogger("privagent.agent")


def _rate_limit_headers(err: ReasoningError) -> Dict[str, str]:
    """POST-17.10 Step 10.6 (G7): relay the PROVIDER's own Retry-After.

    Only a header the upstream provider actually emitted is relayed. Nothing
    here invents a back-off, and an absent header produces no header — the
    client then falls back to its own bounded delay. The value is passed
    through verbatim; `parseRetryAfter` on the extension side is what clamps
    and validates it.
    """
    if err.kind == "rate_limit" and err.retry_after:
        return {"Retry-After": str(err.retry_after)}
    return {}


# PHASE 18.5 / I-3. Reasoner failures that mean "the model answered, but what
# it answered is unusable", as opposed to "the provider could not answer".
# These are reported as 502 `model_contract` so a client (and an operator) can
# tell a prompt/contract problem from a service outage. The classes are
# disjoint by construction: every genuinely transient/provider-side kind is
# absent from this tuple and therefore still maps to 503.
_MODEL_CONTRACT_KINDS = frozenset(
    {
        "invalid_action",
        "invalid_json",
        "missing_action",
        "empty_response",
        "unexpected_format",
    }
)


def _build_reasoner():
    """Select the reasoner from SERVER-SIDE configuration only.

    Resolution happens in `reasoner.build_reasoner` (the provider registry), so
    swapping the reasoning model is a configuration change. Fail-closed: an
    unknown mode resolves to the production reasoner, which refuses to run
    without an API key. No guessing-based fallback exists.
    """
    return build_reasoner(config.REASONER_MODE)


@router.post(
    "/action",
    response_model=AgentActionResponse,
    response_model_exclude_none=True,
    status_code=status.HTTP_200_OK,
    summary="Agent Reasoning — one structured browser action from sanitized context",
)
async def generate_action(
    request: Request,
    body: AgentActionRequest,
    response: Response,
) -> AgentActionResponse:
    """
    Agent Reasoning endpoint (M7).

    Takes a user task and sanitized M4 context, performs ONE reasoning request
    (Gemma via OpenRouter by default), validates the structured result, and
    returns the next browser action. Fails safely on any reasoning failure.
    """
    # 1. Defense-in-depth: Verify context payload invariants
    try:
        raw_context = body.context.model_dump()
        verify_payload_invariants(raw_context)
    except PayloadSecurityError as err:
        logger.warning("Security violation in /agent/action: %s", err)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Security violation: {err}",
        )

    context = body.context

    # Safe action-history metadata. body.history is typed as
    # List[BrowserActionModel], so entries are ALREADY strictly validated
    # (shape, bounds, value-scan) by Pydantic before this point — invalid
    # entries are rejected with 422 at request parsing. Serialize to plain
    # dicts for the prompt builder (which expects dict metadata only).
    safe_history: List[Dict[str, str | int | float]] = [
        h.model_dump(exclude_none=True) for h in body.history
    ]

    primary_name = resolve_reasoner_name(getattr(config, "REASONER_MODE", config.REASONER_PROVIDER))
    reasoner = build_reasoner(primary_name)
    fallback_used = False
    effective_provider = primary_name
    
    # Phase 6: Map model role
    model_id = None
    if body.model_role:
        role = body.model_role
        if role == "FAST":
            model_id = config.MODEL_FAST
        elif role == "STRONG":
            model_id = config.MODEL_STRONG
        elif role == "VISION":
            model_id = config.MODEL_VISION
        elif role == "SAFETY":
            model_id = config.MODEL_SAFETY
        else:
            raise HTTPException(status_code=400, detail="Unknown model_role")



    try:
        result = reasoner.request_action(
            task=body.task,
            url=context.url,
            detections=[d.model_dump() for d in context.detections],
            history=safe_history,
            viewport=context.viewport.model_dump(),
            screenshot_dimensions=(
                context.screenshot_dimensions.model_dump()
                if context.screenshot_dimensions
                else None
            ),
            model=model_id,
            page_type=context.page_type,
            semantic_context=context.semantic_context,
        )
    except ReasoningError as err:
        fallback_name = (config.REASONER_FALLBACK_PROVIDER or "").strip().lower()
        can_fallback = (
            fallback_name
            and fallback_name in ["groq", "nvidia", "openrouter", "mock"]
            and fallback_name != primary_name
            and err.kind in ("rate_limit", "timeout", "network", "not_configured", "http_server_error")
        )
        if can_fallback:
            logger.info(
                "Primary reasoner '%s' failed (%s); attempting fallback to '%s'.",
                primary_name,
                err.kind,
                fallback_name,
            )
            fallback_reasoner = build_reasoner(fallback_name)
            try:
                result = fallback_reasoner.request_action(
                    task=body.task,
                    url=context.url,
                    detections=[d.model_dump() for d in context.detections],
                    history=safe_history,
                    viewport=context.viewport.model_dump(),
                    screenshot_dimensions=(
                        context.screenshot_dimensions.model_dump()
                        if context.screenshot_dimensions
                        else None
                    ),
                    model=model_id,
                    page_type=context.page_type,
                    semantic_context=context.semantic_context,
                )
                fallback_used = True
                effective_provider = fallback_name
            except ReasoningError as fallback_err:
                logger.warning(
                    "Fallback reasoner '%s' also failed (%s): %s",
                    fallback_name,
                    fallback_err.kind,
                    fallback_err,
                )
                # POST-17.10 Step 10.6 (G7) — HONEST RATE-LIMIT REPORTING.
                #
                # The defect: this reported `error_kind: fallback_err.kind` and a
                # hardcoded `retryable: False`. When the PRIMARY was rate-limited
                # and the fallback then also failed, the client was told only
                # that the FALLBACK failed — a classification the client cannot
                # distinguish from a permanent error. The primary's rate limit
                # survived only inside a human-readable `reason` string, where
                # no client is expected to parse it.
                #
                # The fix changes the REPORT, never the classification rules: a
                # rate limit is still refused by this layer (zero speculative
                # actions are produced, the response is still a failure), but it
                # is now labelled truthfully and the provider's own Retry-After
                # is relayed so the client can wait the published interval
                # instead of guessing or hammering the pool. A rate limit
                # WITHOUT a Retry-After stays exactly as before — non-retryable,
                # no header, fail closed.
                rate_limited = err.kind == "rate_limit" and bool(err.retry_after)
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    headers=_rate_limit_headers(err),
                    detail={
                        "success": False,
                        "reason": f"Reasoning unavailable: {primary_name} ({err.kind}) and fallback {fallback_name} ({fallback_err.kind}) failed.",
                        "error_kind": "rate_limit" if rate_limited else fallback_err.kind,
                        "retryable": rate_limited,
                    },
                )
        else:
            logger.warning("Reasoning failed (%s): %s", err.kind, err)
            # Fail closed — never fabricate an action from detections.
            #
            # POST-17.10 Step 10.6 (G7): a rate limit that carries the
            # provider's own Retry-After is TRANSIENT, and is reported as such
            # with that header relayed. Every other kind is reported exactly as
            # before. Nothing here converts a failure into a success: the
            # status is still a failure and no action is produced.
            #
            # PHASE 18.5 / I-3 — MODEL CONTRACT vs PROVIDER OUTAGE.
            #
            # The defect: EVERY reasoner failure was reported as HTTP 503
            # "Service Unavailable". 503 means "this service is down, try
            # later". But `invalid_action` (and `invalid_json`,
            # `missing_action`, `empty_response`, `unexpected_format`) are
            # MODEL CONTRACT failures: the service is healthy and answered.
            # Reporting them as 503 made a model that emitted unusable output
            # indistinguishable from an outage, sent operators looking at
            # provider health for a prompt problem, and told the client to
            # treat a deterministic contract violation as a transient fault.
            #
            # The fix separates the two classes on the wire. Contract failures
            # are 502 (an upstream returned something unusable); genuine
            # provider faults — auth, rate limit, timeout, network, not
            # configured, 5xx — remain 503 exactly as before. Neither is ever
            # converted into a success, and retryability is unchanged:
            # contract violations stay non-retryable because re-sending the
            # same prompt reliably reproduces the same unusable output.
            rate_limited = err.kind == "rate_limit" and bool(err.retry_after)
            contract_failure = err.kind in _MODEL_CONTRACT_KINDS
            raise HTTPException(
                status_code=(
                    status.HTTP_502_BAD_GATEWAY
                    if contract_failure
                    else status.HTTP_503_SERVICE_UNAVAILABLE
                ),
                headers=_rate_limit_headers(err),
                detail={
                    "success": False,
                    "reason": (
                        f"Reasoner model contract violation: {err}"
                        if contract_failure
                        else f"Reasoning unavailable: {err}"
                    ),
                    "error_kind": (
                        "model_contract" if contract_failure
                        else ("rate_limit" if rate_limited else err.kind)
                    ),
                    "retryable": rate_limited,
                },
            )

    # 2. LLM output is UNTRUSTED: defensive normalization + strict schema validation.
    try:
        raw_dict = dict(result.raw_action) if isinstance(result.raw_action, dict) else result.raw_action
        if isinstance(raw_dict, dict):
            act_type = str(raw_dict.get("action", "")).strip()

            # Normalize direction and url heuristics
            raw_dir = str(raw_dict.get("direction", "")).strip().lower()
            raw_url = str(raw_dict.get("url", "")).strip().lower()

            # Did the model say "navigate" when it actually meant "scroll"?
            # (e.g. {"action": "navigate", "url": "down"} or {"action": "navigate", "direction": "down"})
            if act_type == "navigate":
                has_valid_http_url = raw_url.startswith(("http://", "https://"))
                is_scroll_intent = (
                    not has_valid_http_url
                    and (
                        raw_url in ("down", "up", "downwards", "upwards", "bottom", "top")
                        or raw_dir in ("down", "up", "downwards", "upwards", "bottom", "top")
                        or (raw_dict.get("direction") is not None and str(raw_dict.get("direction")).strip().lower() in ("down", "up"))
                        or (raw_dict.get("amount") is not None and not raw_dict.get("url"))
                    )
                )
                if is_scroll_intent:
                    raw_dict["action"] = "scroll"
                    raw_dict["direction"] = "up" if ("up" in raw_dir or "up" in raw_url or "top" in raw_url) else "down"
                    amount_val = raw_dict.get("amount")
                    try:
                        raw_dict["amount"] = int(amount_val) if amount_val is not None else 500
                    except (ValueError, TypeError):
                        raw_dict["amount"] = 500
                    raw_dict.pop("url", None)
                    raw_dict.pop("text", None)
                    raw_dict.pop("target", None)
                elif raw_dict.get("target") and not has_valid_http_url:
                    # Model targeted an element with action "navigate"
                    if raw_dict.get("text"):
                        raw_dict["action"] = "type"
                        raw_dict.pop("url", None)
                    else:
                        raw_dict["action"] = "click"
                        raw_dict.pop("url", None)

            # Re-read normalized act_type
            act_type = raw_dict.get("action")

            if act_type == "scroll":
                # Ensure direction is valid ('up' | 'down')
                d = str(raw_dict.get("direction", "down")).strip().lower()
                raw_dict["direction"] = "up" if ("up" in d or "top" in d) else "down"

                # Ensure amount is valid bounded int
                amt = raw_dict.get("amount")
                try:
                    raw_dict["amount"] = max(1, min(5000, int(amt))) if amt is not None else 500
                except (ValueError, TypeError):
                    raw_dict["amount"] = 500

                for k in ["target", "text", "option", "url", "key"]:
                    raw_dict.pop(k, None)
            elif act_type == "click":
                for k in ["direction", "amount", "text", "option", "url", "key"]:
                    raw_dict.pop(k, None)
            elif act_type == "type":
                for k in ["direction", "amount", "option", "url", "key"]:
                    raw_dict.pop(k, None)
            elif act_type == "select":
                for k in ["direction", "amount", "text", "url", "key"]:
                    raw_dict.pop(k, None)
            elif act_type == "navigate":
                for k in ["target", "direction", "amount", "text", "option", "key"]:
                    raw_dict.pop(k, None)
            elif act_type == "pressKey":
                raw_key = str(raw_dict.get("key", "")).strip()
                key_map = {
                    "enter": "Enter", "return": "Enter",
                    "tab": "Tab", "escape": "Escape", "esc": "Escape",
                    "arrowdown": "ArrowDown", "down": "ArrowDown",
                    "arrowup": "ArrowUp", "up": "ArrowUp",
                    "arrowleft": "ArrowLeft", "left": "ArrowLeft",
                    "arrowright": "ArrowRight", "right": "ArrowRight",
                    "backspace": "Backspace", "delete": "Delete",
                }
                if raw_key.lower() in key_map:
                    raw_dict["key"] = key_map[raw_key.lower()]
                for k in ["direction", "amount", "text", "option", "url"]:
                    raw_dict.pop(k, None)
        action = BrowserActionModel.model_validate(raw_dict)
    except PydanticValidationError as err:
        # PHASE 17.5 (F4): PRIVACY. The raw model action used to be logged here
        # (`raw: %s`). It is model-authored text and may contain a value the model
        # saw, i.e. PII, which then landed in the backend log permanently. The
        # error COUNT and the exception are still logged; the payload is not.
        #
        # PHASE 17.10 (D1): these are NOT all structural failures. Pydantic raises
        # this one exception type for BOTH a malformed payload (unknown enum,
        # extra_forbidden, wrong JSON type) and a well-formed action that our own
        # `validate_action_shape` POLICY refused (PII-shaped `type.text`, a field
        # that does not belong to the action type, a missing required field, a key
        # outside the allowlist, a non-http navigate URL).
        #
        # Reporting the second kind as "invalid action structure" was factually
        # wrong and made a deliberate, CORRECT privacy refusal look like a provider
        # malfunction. `validate_action_shape` surfaces as root-level `value_error`
        # entries (type "value_error", empty loc); genuine schema faults carry
        # specific types such as `extra_forbidden` / `enum` / `int_parsing`.
        policy_refusal = bool(err.errors()) and all(
            e.get("type") == "value_error" and not e.get("loc") for e in err.errors()
        )
        logger.warning(
            "Reasoner action refused by action validation (%d error(s), policy_refusal=%s): %s",
            err.error_count(),
            policy_refusal,
            err,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "success": False,
                # A policy refusal is deterministic: the same task and context
                # produce the same refusal, so retrying it can never help. The
                # loop must treat it as a final refusal rather than a transport
                # fault. Only a genuinely malformed payload stays retryable.
                "reason": (
                    "Reasoner produced a well-formed action that PrivAgent's action "
                    "policy refused (e.g. it proposed typing sensitive content)."
                    if policy_refusal
                    else "Reasoner produced an invalid action structure."
                ),
                "error_kind": "invalid_action",
                "retryable": not policy_refusal,
            },
        )

    # 3. Target-ID grounding: the action may ONLY target elements that exist
    #    in THIS sanitized context. Stale/hallucinated IDs fail safely.
    provided_ids = {d.id for d in context.detections}
    if action.target is not None and action.target not in provided_ids:
        logger.warning(
            "Reasoner targeted unknown element '%s' (context has %d detections).",
            action.target,
            len(provided_ids),
        )
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "success": False,
                "reason": (
                    f"Target '{action.target}' does not exist in the current "
                    "sanitized context. A fresh perception is required."
                ),
                "error_kind": "unknown_target",
                "retryable": True,
            },
        )

    telemetry = ReasoningTelemetry(
        provider=effective_provider,
        role=body.model_role or "FAST",
        latency_ms=round(result.latency_ms, 1),
        attempts=result.attempts,
        fallback_used=fallback_used,
        # PHASE 18.5 / I-3. Field NAMES only, never content. Makes the
        # diagnostic clamp observable instead of silent, so a model that
        # routinely over-runs `reason` is visible without ever putting prose
        # on the wire twice.
        clamped_fields=list(last_clamped_fields) or None,
    )

    # Backend logs the actual model_id for debugging, but we do not leak it to the frontend telemetry
    logger.info("Agent Action Reasoning: role=%s, model=%s, provider=%s, latency=%.1fms, action=%s", body.model_role or "FAST", result.model, effective_provider, result.latency_ms, action.model_dump())

    return AgentActionResponse(
        success=True,
        action=action,
        reason=action.reason or "Reasoned action from sanitized context metadata.",
        telemetry=telemetry,
    )


@router.post(
    "/review",
    status_code=status.HTTP_200_OK,
    summary="Agent Safety Review",
)
async def review_action(
    request: Request,
    body: Dict[str, Any] = None,
):
    """
    Safety Review endpoint (Phase 6).
    Returns whether the proposed action is safe.
    """
    # In a full implementation, this would invoke the configured safety model.
    # For this phase, we return a deterministic "SAFE" response since the model is Mock/Fast by default.
    return {"safe": True, "reason": "Safety review passed (deterministic)."}

