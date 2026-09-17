"""
PrivAgent Agent Safety API — FastAPI Application Entry Point.

Security Boundaries:
  1. CORS locked to local extension + localhost origins ONLY.
  2. Incoming payloads are Pydantic-validated (model-level forbidden key rejection).
  3. Independent recursive JSON security scan in the route handler (defense in depth).
  4. Zero external network calls — this is a local IPC bridge only.

Run:
  python backend/run.py
  OR: uvicorn backend.app.main:app --host 127.0.0.1 --port 8010
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import config
from .models import HealthResponse
from .reasoner import resolve_reasoner_name
from .routes.context import router as context_router
from .routes.agent import router as agent_router

app = FastAPI(
    title="PrivAgent Agent Safety API",
    description=(
        "Local IPC gateway between the PrivAgent Chrome extension and external browser agents. "
        "Receives ONLY sanitized, zero-PII context payloads. "
        "M7: performs ONE structured Gemma (OpenRouter) reasoning request per "
        "agent step, server-side, with the API key never leaving this process."
    ),
    version="0.7.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

# ── CORS — local only ─────────────────────────────────────────────────────────
# Allow the Chrome extension popup and local development servers.
# chrome-extension://* covers the extension origin.
# http://127.0.0.1:* and http://localhost:* cover local agents/UIs.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"(chrome-extension://[a-z]+|https?://(127\.0\.0\.1|localhost)(:\d+)?)",
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Accept"],
    max_age=600,
)

# ── Routes ───────────────────────────────────────────────────────────────────
app.include_router(context_router)
app.include_router(agent_router)



@app.get("/api/v1/health", response_model=HealthResponse, tags=["health"])
async def health() -> HealthResponse:
    """Liveness check — used by the extension popup and dashboard.

    Separates backend connectivity (CONNECTED) from reasoner availability (AVAILABLE /
    UNCONFIGURED / RATE_LIMITED). The API key itself is never exposed.
    """
    primary = resolve_reasoner_name(getattr(config, "REASONER_MODE", config.REASONER_PROVIDER))
    is_configured = config.has_api_key(primary)
    reasoner_status = "AVAILABLE" if is_configured else "UNCONFIGURED"


    fallback = (
        resolve_reasoner_name(config.REASONER_FALLBACK_PROVIDER)
        if config.REASONER_FALLBACK_PROVIDER
        else None
    )
    fallback_configured = config.has_api_key(fallback) if fallback else False

    model_name = (
        config.GROQ_MODEL
        if primary == "groq"
        else (config.OPENROUTER_MODEL if primary == "openrouter" else "mock-deterministic")
    )

    return HealthResponse(
        backend_status="CONNECTED",
        reasoner=primary,
        reasoner_status=reasoner_status,
        reasoner_configured=is_configured,
        model=model_name,
        fallback_reasoner=fallback,
        fallback_configured=fallback_configured,
        privacy_firewall="ACTIVE",
        sensitive_data_sent=0,
    )



@app.get("/", include_in_schema=False)
async def root():
    return {
        "service": "PrivAgent Agent Safety API",
        "version": "0.4.0",
        "docs": "/docs",
        "health": "/api/v1/health",
        "context": "/api/v1/context/latest",
    }
