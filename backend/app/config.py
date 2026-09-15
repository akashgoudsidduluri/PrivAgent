"""
PrivAgent Backend Configuration (Milestone 7).

Server-side settings for the reasoning gateway. The OpenRouter API key is read
ONLY from the environment (or a local .env file during development) and must
NEVER be embedded in the extension, committed to git, logged, or echoed in any
API response.

Security Invariants:
  1. The API key exists exclusively inside the local backend process.
  2. It is never returned by any endpoint and never written to logs.
  3. The backend fails closed (unsupported reasoner mode) rather than falling
     back to guessing-based deterministic reasoning.
"""
from __future__ import annotations

import os

try:  # python-dotenv is optional; the env var can also be set directly.
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # pragma: no cover - dotenv is a soft dependency
    pass


# ── Reasoner mode ─────────────────────────────────────────────────────────────
# Selects the SERVER-SIDE reasoning provider by name. The authoritative list of
# valid names is `reasoner.REASONER_REGISTRY`:
#   "openrouter" — real Gemma reasoning via OpenRouter (production/demo mode)
#   "mock"       — deterministic offline reasoner (tests / CI only, never guessing)
#                   plus any future provider registered there.
# Adding a provider is a registry entry + this env var — no change to the agent
# route, the request/response models, the security validator, or the extension.
# An unregistered name FAILS CLOSED to the production provider (see
# reasoner.build_reasoner) rather than to any deterministic fallback.
REASONER_MODE = os.environ.get("PRIVAGENT_REASONER", "openrouter").strip().lower()
if not REASONER_MODE:
    REASONER_MODE = "openrouter"


# ── OpenRouter settings ───────────────────────────────────────────────────────
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "").strip()
OPENROUTER_BASE_URL = os.environ.get(
    "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1/chat/completions"
).strip()
OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "google/gemma-4-31b-it:free").strip()

# LLM request budget (seconds). Kept generous: free-tier models can be slow.
OPENROUTER_TIMEOUT_SECONDS = float(os.environ.get("OPENROUTER_TIMEOUT_SECONDS", "45"))

# One provider call per M6 reasoning step (M6 owns all loop/bounds semantics).
MAX_LLM_ATTEMPTS = int(os.environ.get("PRIVAGENT_MAX_LLM_ATTEMPTS", "1"))


def has_api_key() -> bool:
    """Whether an OpenRouter API key is configured (value never exposed)."""
    return bool(OPENROUTER_API_KEY)
