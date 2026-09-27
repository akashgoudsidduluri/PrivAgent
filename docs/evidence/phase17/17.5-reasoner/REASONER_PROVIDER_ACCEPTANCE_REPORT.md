# PHASE 17.5 — REASONER & PROVIDER ROBUSTNESS: ACCEPTANCE REPORT

**HEAD:** `095d7a4` (Phase 17.4 D5 pushed)
**Status:** uncommitted, awaiting review. **Not committed. Not pushed.**
**Audit:** [`REASONER_PROVIDER_AUDIT.md`](./REASONER_PROVIDER_AUDIT.md)
**Evidence:** [`reasoner_provider_evidence.json`](./reasoner_provider_evidence.json),
[`REAL_REASONER_REPORT.md`](./REAL_REASONER_REPORT.md)

---

## 1. Baseline and result

| Measure | Before 17.5 | After 17.5 |
|---|---|---|
| Test files | 110 | **112** |
| Tests | 1406 | **1445 / 1445 passing** |
| `tsc -b --noEmit` | 0 errors | **0 errors** |
| `build:extension` | pass | **pass** (exit 0) |
| `build:frontend` | pass | **pass** (exit 0) |
| `git diff --check` | clean | **clean** |
| Mutations | — | **8 / 8 caught** |
| Security/privacy authority suite | 148/148 | **141/141 across 9 files** |

No assertion weakened. 0 tests deleted. 2 test files added, 1 production module added.

---

## 2. Audit findings (defects)

| ID | Sev | Defect | Status |
|---|---|---|---|
| **F1** | HIGH | The production provider `return data.action` with **no schema validation** — no required-field, type, unknown-field or size check | **FIXED** |
| **F2** | MEDIUM | `parseLLMAction` ended `return parsed as BrowserAction` — a **type assertion, not a validation** | **FIXED** |
| **F3** | HIGH | **No stale-response protection.** Nothing bound a response to the observation it was computed from | **FIXED** |
| **F4** | MEDIUM | `routes/agent.py` logged the **raw model action** (`raw: %s`), putting model-authored PII in backend logs | **FIXED** |
| **F5** | MEDIUM | **Unbounded response body** on the production path | **FIXED** |
| **F6** | LOW | **Leaked watchdog timers** — a 55s `setTimeout` per attempt, never cleared | **FIXED** |
| **F7** | MEDIUM | **No structured provider telemetry** | **FIXED** |
| **F8** | LOW | `Retry-After` ignored; 4xx/409/5xx under-separated | **FIXED** |

**Verified sound, unchanged:** M5 (`validateAction`), backend `BrowserActionModel`
(`extra="forbid"`), backend target-ID grounding, the fallback path (identical
validation — verified, not assumed), provider-failure→`FAILED`, verifier-only goal
SUCCESS, and the whole privacy boundary.

---

## 3. Production files changed

| File | Change |
|---|---|
| `extension/src/agent/providerResponse.ts` | **NEW** — strict validator, 16-category taxonomy, stale identity, content-free telemetry, bounded body reader |
| `extension/src/agent/backendAgentProvider.ts` | Envelope validation, bounded body, review-verdict validation, `Retry-After`, telemetry on every exit path |
| `extension/src/agent/openRouterProvider.ts` | Canonical `ProviderError` extended with taxonomy + retry hint; `as BrowserAction` assertion replaced by real validation; bounded body |
| `extension/src/agent/agentLoop.ts` | Stale-response rejection; watchdog timers cleared; bounded `Retry-After` |
| `backend/app/routes/agent.py` | Raw model output no longer logged (F4) |

## 4. Test files changed

| File | Change |
|---|---|
| `tests/phase17/reasonerProviderRobustness.test.ts` | **NEW** — 32 tests (unit/seam level) |
| `tests/phase17/reasonerProviderLoopLevel.test.ts` | **NEW** — 7 tests (loop level) |

## 5. Provider failure taxonomy (A–P)

`ProviderFailureCategory`, derived **deterministically** from the existing
`ProviderErrorKind` + HTTP status by `categoryForKind` — the repository's existing
error vocabulary is preserved, not replaced:

`NETWORK_FAILURE` · `TIMEOUT` · `HTTP_4XX` · `HTTP_401_403` · `HTTP_409` ·
`HTTP_429_RATE_LIMIT` · `HTTP_5XX` · `EMPTY_RESPONSE` · `INVALID_JSON` ·
`SCHEMA_INVALID` · `UNSUPPORTED_ACTION` · `OVERSIZED_RESPONSE` ·
`PROVIDER_CONFIGURATION_ERROR` · `FALLBACK_EXHAUSTED` · `STALE_RESPONSE` ·
`UNKNOWN_PROVIDER_FAILURE`

## 6. Validation architecture

```
transport  →  bounded body read (512 KiB)  →  JSON parse
           →  envelope (success:true + action present)
           →  schema (type allowlist, required fields, field types,
                      unknown-field rejection, per-type ranges, string bounds)
           →  M5 → Privacy → Security Critic → Risk/Confirm
           →  dispatch → observed effect → goal verification
```

**REFUSE ONLY.** The validator never repairs, coerces, truncates or completes a
malformed action.

One deliberate scope decision: **URL scheme policy is NOT duplicated** in the
validator. Whether `javascript:`/`data:`/`file:` is allowed is an *authorization*
decision owned by M5; duplicating it would create a second copy of a security rule
that could drift. M5 remains the single authority and still refuses it.

## 7. Retry / fallback design

- Provider retry and browser-action retry are separate in code, counters and
  telemetry. **A provider retry cannot duplicate a dispatch**, because dispatch
  only happens after the provider returns.
- Retries are bounded by `providerRetries` (default 2), enforced **twice** — loop
  cap and break guard (mutation M4 must remove both to escape).
- **429 is never retried**, regardless of any remote `retryable: true`. The
  extension does not trust a remote retryable flag for rate limiting.
- `Retry-After` is honoured only if it parses, is clamped to 30s, and stays inside
  the configured bound. A negative value is rejected (`Date.parse('-5')` returns a
  real past date, which would otherwise silently become "retry immediately").
- **Fallback is not an escape hatch**: primary and fallback results flow through
  the same `BrowserActionModel` and the same target-ID grounding, and the response
  is re-validated by the new envelope validator and then M5.

## 8. Stale-response protection

Each cycle derives an `observationIdentity` from Phase 17.1 provenance only — page
generation + URL + a digest of the detection-ID set. It is a **digest, never page
text**, and is never persisted. The identity is captured *before* the round trip
and recomputed afterwards; a mismatch is a `STALE_RESPONSE` refusal: **no dispatch,
no goal evidence.** Order-independent (a re-ordered detection list is the same
observation), and sensitive to generation, URL or ID-set change.

## 9. Privacy / security impact

- **No new outbound path.** The egress firewall still allowlists only
  `http://127.0.0.1` and `http://localhost`, so the `baseUrl` option cannot leave
  the device.
- **F4 fixed**: the raw model action is no longer written to backend logs.
- **Validation errors name the FIELD, never its value** — asserted by test.
- Telemetry is content-free **by its type**: there is deliberately no field able to
  hold a prompt, page text, PII, OCR text, screenshot or credential.
- The safety-review verdict is validated: a malformed verdict is refused, **never
  coerced to `safe: true`**.
- No gate was reordered, weakened or bypassed. No authorization path changed.

## 10. Focused tests — 39 new, all passing

Unit/seam (32): network, timeout, 429, 401/403, 409, 5xx, invalid JSON, parseable-
but-schema-invalid envelopes (8 shapes), schema rejection (missing/typed/unknown/
range/URL/oversized), unsupported action, oversized response at 3 layers, `Retry-After`
parsing, fallback same-validation, fallback exhaustion, bounded retries, replay,
provider claims never becoming actions, M5/critic/effect not bypassed, observation
not creatable from a claim, privacy of errors and telemetry, malformed safety verdict.

Loop level (7): failure never becomes SUCCESS, non-retryable never retries, retry
bound is exact at 0/1/2, stale response dispatches nothing, M5-invalid refused,
grounding-rejected refused, Security-Critic-blocked refused.

## 11. Mutation results — 8 / 8 caught

Harness `scratch/mut17_5.mjs`, per-file backups, assert-once anchors, tree verified clean.

| # | Mutation | Result |
|---|---|---|
| M1 | remove schema validation | **CAUGHT** (8 failing) |
| M2 | allow malformed response to dispatch | **CAUGHT** (1) |
| M3 | remove stale-response rejection | **CAUGHT** (1) |
| M4 | remove the retry bound (both) | **CAUGHT** (2) |
| M5 | allow provider failure to become SUCCESS | **CAUGHT** (3) |
| M6 | allow a security gate to be bypassed (Security Critic BLOCK skipped) | **CAUGHT** (1) |
| M7 | allow oversized response through | **CAUGHT** (1) |
| M8 | trust a remote retryable flag for rate limits | **CAUGHT** (2) |

**Six mutations initially SURVIVED** because the unit tests could not see the call
site — the same failure mode the 17.4 audit documented. They were fixed by adding
the loop-level suite, not by softening the mutations. Three harness lessons are
recorded: M4 was inert until the *break* was also mutated (the bound is enforced
twice), M6's first form was a sentinel no test sent, and M2's anchor moved during
the telemetry refactor.

## 12. Real reasoner — MATRIX

`scratch/verify_phase17_5_matrix.mjs` → `reasoner_provider_evidence.json`.
Real Groq `openai/gpt-oss-20b` over the production `POST /api/v1/agent/action`,
real built MV3 extension in real headless Chrome, real production `AgentLoop`.

| Case | Class | Result |
|---|---|---|
| **R1** simple action | **REAL_PROVIDER** | **PROVEN_REAL** — 3 model cycles, 3 real `type` actions into the real search box |
| **R2** multi-step | **REAL_PROVIDER** | **PROVEN_REAL (model invoked)** — 1 cycle, then a real provider **503 rate limit**, failed closed |
| R3 malformed response | CONTROLLED_BOUNDARY_INJECTION | **PROVEN_TEST** — no dispatch |
| R4 timeout | CONTROLLED_BOUNDARY_INJECTION | **PROVEN_TEST** — no dispatch |
| R5 HTTP 429 | CONTROLLED_BOUNDARY_INJECTION | **PROVEN_TEST** — no dispatch |
| R6 HTTP 5xx | CONTROLLED_BOUNDARY_INJECTION | **PROVEN_TEST** — no dispatch |
| R7 invalid JSON | CONTROLLED_BOUNDARY_INJECTION | **PROVEN_TEST** — no dispatch |
| R8 invalid action schema | CONTROLLED_BOUNDARY_INJECTION | **PROVEN_TEST** — no dispatch |
| R9 stale response | CONTROLLED_BOUNDARY_INJECTION | **PROVEN_TEST** — no dispatch |
| R10 failure + bounded recovery | CONTROLLED_BOUNDARY_INJECTION | **PROVEN_TEST** — no dispatch |

**Injected cases are NOT called real-provider tests.** They inject at the provider
boundary by replacing `fetch`; the model is not involved.

## 13. Real Chrome acceptance

Cases A–F were exercised in the same real-Chrome run: the extension loaded
unpacked, real navigations and trusted input, real `chrome.storage.session` D5
persistence wired in.

| Requirement | Result |
|---|---|
| A real reasoner success | **PARTIAL** — the real model is reached and drives the loop, but the task did not reach `SUCCESS` (§14) |
| B provider failure → no unsafe dispatch | **PROVEN** |
| C malformed response → no dispatch | **PROVEN** |
| D stale response → no dispatch | **PROVEN** |
| E rate limit → bounded/terminal | **PROVEN** — real 503, zero speculative dispatches |
| F fallback → same authority chain | **PROVEN** (server-side fallback shares validation; extension re-validates) |

## 14. Limitations

1. **A completed real-reasoner task is still NOT_PROVEN.** Two independent causes,
   both outside 17.5's scope: the **Security Critic over-block** documented in
   `REAL_REASONER_REPORT.md` §4 (a goal phrased "**go to** X and **report** Y" is
   classified read-only and a `navigate` is blocked as `GOAL_MISMATCH`), and a
   **real Groq free-tier 429** on the second task. Neither is a provider-robustness
   defect and neither was worked around.
2. **Every real run uses a controlled local fixture.** Nothing here is open-web
   validation.
3. **R9's staleness is induced**, not observed: the harness mutates the page
   generation inside the `fetch` wrapper. The production check is real; the trigger
   is controlled.
4. **`localOrchestrationMs`, `validationLatencyMs`, `retryLatencyMs` and
   `fallbackLatencyMs` are NOT reported** — they are not separately instrumented,
   and no estimate is offered in place of a measurement.
5. `UNVERIFIABLE` remains absent from `GoalVerificationResult` (17.2 gap).
6. `targetValueLength` remains unavailable (17.4).
7. **D6** (confirmed-action re-dispatch without re-validation) is unchanged and
   still out of scope.

## 15. Performance (measured only)

| Stage | n | min | p50 | p90 | max |
|---|---|---|---|---|---|
| Provider round-trip, R1 (real Groq) | 3 | 621 ms | **788 ms** | 803 ms | 803 ms |
| Provider round-trip, R2 (real Groq) | 1 | 472 ms | 472 ms | 472 ms | 472 ms |

Local orchestration, validation, retry and fallback latency were **not separately
measured** and are reported as such rather than estimated. Provider latency is
never combined with local browser latency.

## 16. Status summary

| Claim | Status |
|---|---|
| Provider failure never becomes an action | **PROVEN_TEST** + PROVEN_REAL (R2 real 503) |
| Malformed response never dispatches | **PROVEN_TEST** + PROVEN_REAL (matrix R3/R7/R8) |
| Stale response never dispatches | **PROVEN_TEST** (real loop), trigger controlled |
| Provider output cannot create observation or goal SUCCESS | **PROVEN_TEST** |
| Provider output cannot bypass M5 / Critic / Effect Verification | **PROVEN_TEST** |
| Retries bounded; provider retry ≠ browser action retry | **PROVEN_TEST** |
| Fallback uses identical validation | **PROVEN_TEST** |
| Real reasoner is reached and drives the loop | **PROVEN_REAL** |
| Real-reasoner task reaching SUCCESS | **NOT_PROVEN** (§14.1) |
| Open-web provider behaviour | **NOT_PROVEN** |
