"""STEP 10.5 Part 9 — measure the REAL provider rate limit from response headers.

Read-only diagnostic. Issues real requests to the configured Groq endpoint and
prints the x-ratelimit-* headers, so the provider-capacity blocker can be
classified with hard numbers rather than inferred from 503 bodies.
"""
from __future__ import annotations

import json
import sys
import time

import httpx

sys.path.insert(0, "backend")

from app import config  # noqa: E402

# config.GROQ_BASE_URL is already the full chat/completions endpoint.
URL = config.GROQ_BASE_URL.rstrip("/")
HEADERS = {
    "Authorization": f"Bearer {config.GROQ_API_KEY}",
    "Content-Type": "application/json",
}
BODY = {
    "model": config.MODEL_STRONG,
    "messages": [{"role": "user", "content": "Reply with the single word: ok"}],
    "max_tokens": 5,
}


def one() -> tuple[int, dict, str]:
    try:
        r = httpx.post(URL, headers=HEADERS, json=BODY, timeout=45.0)
        rl = {
            k: v for k, v in r.headers.items()
            if k.lower().startswith("x-ratelimit") or k.lower() in ("retry-after",)
        }
        return r.status_code, rl, r.text[:200]
    except Exception as e:  # noqa: BLE001
        return 0, {}, f"{type(e).__name__}: {e}"


def main() -> int:
    print(f"endpoint = {URL}")
    print(f"model    = {config.MODEL_STRONG}")
    print()
    print("burst of 6 calls, 2s apart:")
    for i in range(1, 7):
        t0 = time.time()
        status, rl, snippet = one()
        print(f"  call {i}: status={status} in {time.time()-t0:.1f}s  {rl or '(no ratelimit headers)'}")
        if status != 200:
            print(f"      body: {snippet[:160]}")
        time.sleep(2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
