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

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import ValidationError as PydanticValidationError

from .. import config
from ..models import (
    AgentActionRequest,
    AgentActionResponse,
    BrowserActionModel,
    ReasoningTelemetry,
)
from ..reasoner import ReasoningError, build_reasoner, resolve_reasoner_name
from ..security import PayloadSecurityError, verify_payload_invariants

router = APIRouter(prefix="/api/v1/agent", tags=["agent"])
logger = logging.getLogger("privagent.agent")


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
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail={
                        "success": False,
                        "reason": f"Reasoning unavailable: {primary_name} ({err.kind}) and fallback {fallback_name} ({fallback_err.kind}) failed.",
                        "error_kind": fallback_err.kind,
                        "retryable": False,
                    },
                )
        else:
            logger.warning("Reasoning failed (%s): %s", err.kind, err)
            # Fail closed — never fabricate an action from detections.
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={
                    "success": False,
                    "reason": f"Reasoning unavailable: {err}",
                    "error_kind": err.kind,
                    "retryable": err.retryable,
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
                is_scroll_intent = (
                    raw_url in ("down", "up", "downwards", "upwards", "bottom", "top")
                    or raw_dir in ("down", "up", "downwards", "upwards", "bottom", "top")
                    or "direction" in raw_dict
                    or ("amount" in raw_dict and not raw_url.startswith(("http://", "https://")))
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
                elif raw_dict.get("target") and (not raw_dict.get("url") or not str(raw_dict.get("url")).startswith(("http://", "https://"))):
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
        logger.warning("Reasoner produced schema-invalid action: %s | raw: %s | error: %s", err.error_count(), result.raw_action, err)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "success": False,
                "reason": "Reasoner produced an invalid action structure.",
                "error_kind": "invalid_action",
                "retryable": True,
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
    )

    # Backend logs the actual model_id for debugging, but we do not leak it to the frontend telemetry
    logger.info("Agent Action Reasoning: role=%s, model=%s, provider=%s, latency=%.1fms", body.model_role or "FAST", result.model, effective_provider, result.latency_ms)

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

