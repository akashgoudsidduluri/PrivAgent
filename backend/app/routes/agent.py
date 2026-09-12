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
from typing import Dict, List

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import ValidationError as PydanticValidationError

from .. import config
from ..models import (
    AgentActionRequest,
    AgentActionResponse,
    BrowserActionModel,
    ReasoningTelemetry,
)
from ..reasoner import MockReasoner, OpenRouterReasoner, ReasoningError
from ..security import PayloadSecurityError, verify_payload_invariants

router = APIRouter(prefix="/api/v1/agent", tags=["agent"])
logger = logging.getLogger("privagent.agent")


def _build_reasoner():
    """Select the reasoner based on server-side configuration.

    Fail-closed: unsupported modes resolve to the OpenRouter reasoner, which
    itself refuses to run without an API key. No guessing-based fallback exists.
    """
    if config.REASONER_MODE == "mock":
        return MockReasoner()
    return OpenRouterReasoner()


@router.post(
    "/action",
    response_model=AgentActionResponse,
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

    reasoner = _build_reasoner()

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
        )
    except ReasoningError as err:
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

    # 2. LLM output is UNTRUSTED: strict schema validation + re-validation.
    try:
        action = BrowserActionModel.model_validate(result.raw_action)
    except PydanticValidationError as err:
        logger.warning("Reasoner produced schema-invalid action: %s", err.error_count())
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
        provider=("mock" if config.REASONER_MODE == "mock" else "openrouter"),
        model=result.model,
        latency_ms=round(result.latency_ms, 1),
        attempts=result.attempts,
    )

    return AgentActionResponse(
        success=True,
        action=action,
        reason=action.reason or "Reasoned action from sanitized context metadata.",
        telemetry=telemetry,
    )
