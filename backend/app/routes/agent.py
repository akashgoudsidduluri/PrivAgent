"""
PrivAgent Agent Reasoning Route (Milestone 5)

Endpoint:
  POST /api/v1/agent/action — Receives user task + sanitized page context, returns structured browser action.

Security Invariants:
  1. Incoming payload context MUST pass recursive forbidden-key check (defense-in-depth).
  2. Input context is strictly validated via Pydantic AgentContextPayload.
  3. Action returned is strictly allowlisted BrowserActionModel.
  4. Never exposes or handles raw PII values.
"""
from __future__ import annotations

import logging
from typing import Any, Dict

from fastapi import APIRouter, HTTPException, Request, status

from ..models import (
    AgentActionRequest,
    AgentActionResponse,
    BrowserActionModel,
    BrowserActionType,
)
from ..security import PayloadSecurityError, verify_payload_invariants

router = APIRouter(prefix="/api/v1/agent", tags=["agent"])
logger = logging.getLogger("privagent.agent")


@router.post(
    "/action",
    response_model=AgentActionResponse,
    status_code=status.HTTP_200_OK,
    summary="Agent Reasoning — Produce structured browser action from sanitized context",
)
async def generate_action(
    request: Request,
    body: AgentActionRequest,
) -> AgentActionResponse:
    """
    Agent Reasoning endpoint.
    Takes a user task and sanitized M4 context, and determines the next structured browser action.
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

    # 2. Deterministic reasoning based on task & sanitized detections
    task_lower = body.task.lower()
    context = body.context

    # Case 1: Account number task
    if "account number" in task_lower or "account_number" in task_lower:
        target_det = next((d for d in context.detections if d.type == "account_number"), None)
        if target_det:
            action = BrowserActionModel(
                action=BrowserActionType.click,
                target=target_det.id,
                reason="Identified account number field from sanitized context metadata",
            )
            return AgentActionResponse(
                success=True,
                action=action,
                reason=f"Generated click action targeting {target_det.id}",
            )
        if context.detections:
            first_det = context.detections[0]
            action = BrowserActionModel(
                action=BrowserActionType.click,
                target=first_det.id,
                reason="Targeting first detection in context",
            )
            return AgentActionResponse(
                success=True,
                action=action,
                reason=f"Fallback click targeting {first_det.id}",
            )

    # Case 2: Scroll task
    if "scroll" in task_lower:
        action = BrowserActionModel(
            action=BrowserActionType.scroll,
            direction="down",
            amount=500,
            reason="User requested scroll to inspect lower section",
        )
        return AgentActionResponse(
            success=True,
            action=action,
            reason="Generated scroll down action",
        )

    # Case 3: Details task
    if "details" in task_lower or "account details" in task_lower:
        target_det = next(
            (d for d in context.detections if d.type in ("account_number", "person_name")),
            context.detections[0] if context.detections else None,
        )
        if target_det:
            action = BrowserActionModel(
                action=BrowserActionType.click,
                target=target_det.id,
                reason="Targeting element associated with account details",
            )
            return AgentActionResponse(
                success=True,
                action=action,
                reason=f"Generated click targeting {target_det.id}",
            )

    # Default: click first element if available, else scroll
    if context.detections:
        action = BrowserActionModel(
            action=BrowserActionType.click,
            target=context.detections[0].id,
            reason=f"Interacting with detected element {context.detections[0].id}",
        )
        return AgentActionResponse(
            success=True,
            action=action,
            reason=f"Default action: click {context.detections[0].id}",
        )

    action = BrowserActionModel(
        action=BrowserActionType.scroll,
        direction="down",
        amount=400,
        reason="No detections in viewport; scrolling",
    )
    return AgentActionResponse(
        success=True,
        action=action,
        reason="Default action: scroll down",
    )
