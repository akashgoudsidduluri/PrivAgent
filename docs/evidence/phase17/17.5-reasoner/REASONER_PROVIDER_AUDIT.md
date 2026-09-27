# PHASE 17.5 — REASONER & PROVIDER ROBUSTNESS AUDIT

**HEAD at audit time:** `095d7a4`
**Baseline:** 110 test files / 1406 tests · `tsc` 0 errors · both builds green
**Method:** read-only audit, completed **before** any code was changed.

**Architecture under audit:**

```
MODEL / PROVIDER  (untrusted)
      ↓
STRICT VALIDATION
      ↓
SAFE ACTION PROPOSAL
      ↓
AUTHORITATIVE PRIVAGENT GATES
      ↓
DISPATCH
      ↓
OBSERVED EFFECT
      ↓
GOAL VERIFICATION
```

**Headline:** the *authoritative* half of this chain is genuinely strong. M5 is
strict, the backend re-validates through Pydantic, goal success is verifier-only,
and the fallback path is **not** an escape hatch. The *provider boundary* is where
the real defects are: the production provider performs **no response validation at
all**, and nothing anywhere binds a response to the observation it was computed
from.

---

## 1. The 17 questions

### 1. Where are provider requests created?

`BackendAgentProvider.requestAction` (`backendAgentProvider.ts`) — the production
path, Extension → local FastAPI → Groq/OpenRouter, so the API key never reaches the
browser. Secondary: `OpenRouterProvider.requestAction` (dev/test only).

### 2. Where do provider responses enter the system?

`backendAgentProvider.ts`, at the return: **`return data.action`**, guarded only by
`if (!data.success || !data.action)`. `openRouterProvider.ts` via `parseLLMAction`.

### 3. Where does JSON/schema validation occur?

| Layer | Where | Verdict |
|---|---|---|
| Transport | `fetch` + AbortController | present |
| Parsing | `resp.json()` | present, **unbounded body** |
| Schema (backend) | `BrowserActionModel.model_validate` (`routes/agent.py:284`), `extra="forbid"` | **strong** |
| Grounding (backend) | target-ID check against received detections (`routes/agent.py:~299`) | **strong** |
| Schema (extension, production provider) | **none** | **DEFECT F1** |
| Schema (extension, OpenRouter provider) | action-type allowlist + oversized-string rejection, then `return parsed as BrowserAction` | **DEFECT F2** |
| M5 (extension) | `actionValidator.validateAction` | **strong** |

### 4. Where is malformed output rejected?

Backend: `parse_model_action` + `BrowserActionModel` → 502 `invalid_action`.
Extension: M5, per-type validators, unknown-field rejection, forbidden-field and
sensitive-key rejection, PII-bearing `reason` rejection.
**Gap:** the production provider returns the object unvalidated; rejection happens
only later, inside M5.

### 5. Where are provider exceptions converted into agent state?

`requestActionWithBoundedRetry` (`agentLoop.ts:2442`) rethrows; the call site
(`agentLoop.ts:~1015`) catches and sets `status = FAILED`, `goalStatus = FAILED`.
**Fail-closed and correct.**

### 6. Are HTTP status codes distinguished?

Partly. `auth` (401/403), `rate_limit` (429), `http_error` (else). **4xx generally,
409, and 5xx-vs-4xx are not separated**; 5xx is only special-cased when the body is
*not* structured.

### 7. Is timeout distinguishable from malformed response?

Yes — `ProviderErrorKind` carries `timeout` vs `invalid_json` / `empty_response` /
`unsupported_action` / `missing_action`.

### 8. Is 429 handled?

Yes, and conservatively: both providers force `retryable = false` for rate limits so
a free-tier pool cannot be multiplied by loop retries. **`Retry-After` is ignored.**

### 9. Is 5xx handled?

Yes: `retryable = true` **only** when the body is unstructured. A structured 503
carrying `error_kind` takes the body's `retryable` (fallback-exhausted sends
`false`). Correct but implicit.

### 10. Do fallback providers exist?

Yes, **server-side only**: `routes/agent.py` falls back
`REASONER_PROVIDER` → `REASONER_FALLBACK_PROVIDER`, and only for
`rate_limit | timeout | network | not_configured | http_server_error`. The extension
has no fallback chain.

### 11. Can fallback bypass validation?

**No.** Both primary and fallback results flow through the *same*
`BrowserActionModel.model_validate` and the *same* target-ID grounding, and the
response is returned to the extension which re-validates at M5. Fallback is not an
escape hatch. **Verified, not assumed.**

### 12. Can retries duplicate browser actions?

**No.** Dispatch happens only after the provider returns, so a provider-level retry
cannot re-dispatch a browser action. The two are already separated in effect,
though not in naming or telemetry.

### 13. Can stale provider responses be applied after page state changes?

**Yes — this is the most serious finding (F3).** Nothing binds a response to the
observation it was computed from. The round trip is 500 ms–55 s; the page can
change underneath it. Partial mitigation exists (M5 re-validates targets against the
*current* context; the backend grounds against the context it *received*), but
there is **no positive identity check**, and `navigate` URLs and `scroll` amounts
derived from stale geometry are not re-checked at all.

### 14. Can provider output contain raw sensitive values?

It can *contain* them; it is not *permitted* to. Three scan points exist (backend
`parse_model_action`, `BrowserActionModel`, extension M5) plus the egress firewall.
**But `routes/agent.py:286` logs `raw: %s` — the raw model action — at WARNING.**
Model-authored PII therefore reaches the backend log (F4).

### 15. Can provider output create fake goal completion?

**No.** Goal `SUCCESS` is writable only where `isTaskGoalSatisfied` →
`verifyTaskGoal` sets it, from observed state. Provider output cannot reach it.

### 16. Can provider output influence authorization?

**No.** It proposes; Grounding → M5 → Security Critic → Risk/Confirmation →
Effect Verification decide. None read provider claims as evidence.

### 17. Do provider failures interact correctly with Recovery and Harness?

Correctly. A provider failure terminates the task `FAILED` and never enters the
Recovery path, which is right — recovery is for *browser* failures, and routing a
transport failure into recovery would mislabel it. Provider failures do not consume
the browser recovery budget, and vice versa.

**Infinite retry?** No. `providerRetries` defaults to 2 and the loop breaks on the
first non-retryable kind.

---

## 2. Defects found

| ID | Sev | Defect | Location |
|---|---|---|---|
| **F1** | **HIGH** | Production provider returns `data.action` with **no schema validation**. No required-field, no type, no unknown-field, no size check. It trusts the backend's envelope completely. | `backendAgentProvider.ts` |
| **F2** | MEDIUM | `parseLLMAction` ends `return parsed as BrowserAction` — a **type assertion, not a validation**. Per-type required fields are never checked. | `openRouterProvider.ts` |
| **F3** | **HIGH** | **No stale-response protection.** Nothing binds a response to the observation identity it was computed from. | `agentLoop.ts` / both providers |
| **F4** | MEDIUM | **Raw model output logged** (`raw: %s`) — model-authored PII reaches backend logs. | `routes/agent.py:286` |
| **F5** | MEDIUM | **Unbounded response body.** `resp.json()` with no size cap on the production path; `MAX_RESPONSE_CONTENT_CHARS` exists only on the OpenRouter path. | `backendAgentProvider.ts` |
| **F6** | LOW | **Leaked timers.** `requestActionWithBoundedRetry` creates a 55 s `setTimeout` per attempt and never clears it. | `agentLoop.ts:2448` |
| **F7** | MEDIUM | **No structured provider telemetry.** No requestId, cycle, attempt, failure category, HTTP status, retry decision or fallback flag. | both providers |
| **F8** | LOW | `Retry-After` ignored; 4xx/409/5xx not separated beyond auth/429/other. | both providers |

---

## 3. What is already sound and must not be weakened

- **M5 `validateAction`** — forbidden fields, sensitive keys, unmodifiable-security-policy
  action types, per-type allowed keys, per-type field validators, PII in `reason`.
- **Backend `BrowserActionModel`** (`extra="forbid"`) after deterministic normalization.
- **Backend target-ID grounding** — a hallucinated ID fails safely.
- **Fallback uses identical validation** — verified, not assumed (§1.11).
- **Provider failure → `FAILED`**, never `SUCCESS`.
- **Goal SUCCESS is verifier-only**, from observed state.
- **Privacy boundary intact** — `assertSanitizedContextSafe`, `buildModelFacingContext`,
  `validateEgressPayload`, and the `baseUrl` override is still constrained to
  `127.0.0.1` / `localhost` by the egress firewall.

---

## 4. Design decisions

1. **A single strict validator, shared by both providers.** One
   `validateProviderAction` module. Validation at the provider boundary is
   *additional* to M5, never a replacement — M5 remains the authority and keeps
   running on every proposal.
2. **Refuse, never repair, at the provider boundary.** The backend already
   normalizes deterministically; the extension will not. A malformed response
   produces **no dispatch**.
3. **A 16-category failure taxonomy** mapped from the existing
   `ProviderErrorKind` + HTTP status, so no new stringly-typed handling is
   introduced and existing vocabulary is preserved.
4. **Stale-response rejection by observation identity.** Each cycle derives an
   identity from Phase 17.1 provenance (page generation + URL + detection-id
   digest). After the provider returns, the identity is recomputed; a mismatch
   **fails closed**. No raw page data is persisted — the identity is a digest.
5. **Bounded, deterministic retries.** Provider retry stays separate from browser
   action retry, in code, in counters and in telemetry. `Retry-After` is honoured
   only if present, numeric and within a hard cap.
6. **Telemetry carries no content** — identifiers, categories, counts, statuses
   only. Never prompts, page text, PII or keys.
