"""
PrivAgent Agent Safety API — Context Routes.

POST   /api/v1/context         — Receive sanitized context from extension
GET    /api/v1/context/latest  — Serve latest sanitized context to agent
DELETE /api/v1/context         — Clear stored context
"""
from __future__ import annotations

import time
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, status

from ..models import (
    AgentContextPayload,
    ContextAcceptedResponse,
    ContextResponse,
)
from ..security import PayloadSecurityError, verify_payload_invariants

router = APIRouter(prefix="/api/v1/context", tags=["context"])

# In-memory store — single latest context.
# M4 is a local IPC bridge; no persistence is needed or desired.
_latest_context: Optional[ContextResponse] = None


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=ContextAcceptedResponse,
    summary="Receive sanitized context from PrivAgent extension",
)
async def receive_context(
    payload: AgentContextPayload,
    request: Request,
) -> ContextAcceptedResponse:
    """
    Accept a sanitized AgentContextPayload.

    Security pipeline (two independent layers):
      Layer 1 — Pydantic validation (extra='forbid', field validators, enum checks)
      Layer 2 — Independent recursive forbidden-key scan + status validation

    If either layer fails, the payload is rejected and NOT stored.
    """
    global _latest_context

    # Layer 2: independent recursive security scan
    # (Pydantic is Layer 1 and already ran on the `payload` parameter above)
    try:
        raw = payload.model_dump()
        verify_payload_invariants(raw)
    except PayloadSecurityError as exc:
        # Do NOT echo the payload or raw content in the error response
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        )

    received_at = int(time.time() * 1000)
    _latest_context = ContextResponse(received_at=received_at, payload=payload)

    return ContextAcceptedResponse(
        success=True,
        message="Sanitized context accepted. Zero PII invariant verified.",
        received_at=received_at,
        detection_count=len(payload.detections),
    )


@router.get(
    "/latest",
    response_model=ContextResponse,
    summary="Retrieve latest sanitized context for agent consumption",
)
async def get_latest_context() -> ContextResponse:
    """
    Return the most recently accepted sanitized context.
    404 if no context has been received yet.
    """
    if _latest_context is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No sanitized context available. Run a PrivAgent capture first.",
        )
    return _latest_context


@router.delete(
    "",
    status_code=status.HTTP_200_OK,
    summary="Clear stored context",
)
async def clear_context() -> dict:
    global _latest_context
    _latest_context = None
    return {"status": "cleared", "message": "Stored context cleared from memory."}
