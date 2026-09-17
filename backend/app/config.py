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
#   "groq"       — real reasoning via Groq (production default)
#   "openrouter" — real Gemma reasoning via OpenRouter
#   "mock"       — deterministic offline reasoner (tests / CI only)
#
# REASONER_PROVIDER is primary; PRIVAGENT_REASONER is supported for backwards compatibility.
REASONER_PROVIDER = os.environ.get(
    "REASONER_PROVIDER", os.environ.get("PRIVAGENT_REASONER", "groq")
).strip().lower()
if not REASONER_PROVIDER:
    REASONER_PROVIDER = "groq"

# REASONER_MODE is the authoritative active mode string (compatible with test monkeypatching)
REASONER_MODE = REASONER_PROVIDER

# Optional transient provider fallback (e.g. "openrouter")
REASONER_FALLBACK_PROVIDER = os.environ.get("REASONER_FALLBACK_PROVIDER", "").strip().lower()



# ── Groq settings ─────────────────────────────────────────────────────────────
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "").strip()
GROQ_BASE_URL = os.environ.get(
    "GROQ_BASE_URL", "https://api.groq.com/openai/v1/chat/completions"
).strip()
GROQ_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-20b").strip()
GROQ_TIMEOUT_SECONDS = float(os.environ.get("GROQ_TIMEOUT_SECONDS", "30"))


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


def has_api_key(provider: str | None = None) -> bool:
    """Whether an API key is configured for the requested (or active) provider."""
    target = (provider or REASONER_PROVIDER).lower()
    if target == "groq":
        return bool(GROQ_API_KEY)
    if target == "openrouter":
        return bool(OPENROUTER_API_KEY)
    if target == "mock":
        return True
    return False

