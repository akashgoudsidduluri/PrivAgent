# PHASE 17.5 — REAL-REASONER VALIDATION: RESULT

**HEAD at start:** `095d7a4` (Phase 17.4 D5 remediation, pushed)
**Machine evidence:** [`real_reasoner_evidence.json`](./real_reasoner_evidence.json)
**Harness:** `scratch/verify_phase17_5_real_reasoner.mjs`

---

## 1. The 17.4 `NOT_PROVEN`, resolved

Phase 17.4 recorded the real reasoner as `NOT_PROVEN`: **0 model cycles**, HTTP 422,
and a stated cause — "`BackendAgentProvider` hardcodes `127.0.0.1:8010`; the harness
backend was first started on 8061, and on a retry at 8010 that port was already held
by a foreign process."

**The port was not held by a foreign process.** It was held by *our own* backend,
already running from `backend/.venv`. Two independent harness bugs stacked:

| # | Bug | Kind | Fix |
|---|---|---|---|
| 1 | `BackendAgentProvider` hardcoded `8010` with no way to point it elsewhere, so the harness's own backend on `8061` was never contacted | **product** — provider robustness | `baseUrl` option added, default **unchanged** |
| 2 | Hand-built context emitted detection types `text_input` / `text`, which are not in the backend's `DetectionType` enum → 422 | **harness** | emit the real enum values |
| 3 | Task phrasing left the route ambiguous, so the real model answered it with three `scroll` actions against an already-bottomed page | **harness** | task recorded verbatim; the earlier run is preserved, not hidden |

Bug 1 is a genuine product defect and is the only production change in this phase.

---

## 2. Production change — `BackendAgentProvider.baseUrl`

The endpoint is now derived from a `baseUrl` option that **defaults to
`http://127.0.0.1:8010`**. Production behaviour is byte-identical when unset.

**The override cannot escape the local boundary.** `validateEgressPayload` still
allowlists only `http://127.0.0.1` and `http://localhost`, so a remote base is
`BLOCK`ed fail-closed at the single outbound enforcement point. The API key and the
sanitized context cannot be sent off-device by this option. `egressFirewall.ts`,
`privacy/`, `security/` and `content/` are untouched.

---

## 3. What the REAL model actually did

`groq` / `openai/gpt-oss-20b` over the production `POST /api/v1/agent/action`, in a
real built MV3 extension in real headless Chrome, driving the real production
`AgentLoop`. **The proposer was never scripted.**

| Run | Cycles | Model proposed | Outcome |
|---|---|---|---|
| 1 (ambiguous task) | 3 | `scroll` ×3 | `ACTION_NO_EFFECT` — scroll at boundary. Effect verification and the recovery limit correctly refused to let it retry forever. |
| 2 (retry) | 2 | — | Real **rate limit**: `groq (rate_limit)` and `openrouter (rate_limit)` both 503. Loop **failed closed, 0 speculative actions.** |
| 3 (final) | 3 | `navigate http://localhost:4260/pricing` ×3 — **the correct action** | Blocked by the Security Critic. |

**Reasoner latency measured across real calls: p50 662 ms, min 502 ms, max 752 ms.**

This upgrades the 17.4 claim from `NOT_PROVEN` (0 model cycles) to
**PROVEN_REAL — the real reasoner is invoked and drives the loop.** The rate-limit
run is separately valuable: the loop failed closed against a *real* provider 503 with
zero speculative browser actions.

---

## 4. Open finding — Security Critic `GOAL_MISMATCH` over-block (NOT FIXED HERE)

The model proposed the exactly-correct action — navigate to the pricing page named
in the task — and `securityCritic.ts` blocked it:

```
Security Critic BLOCKED (GOAL_MISMATCH): Proposed action is unrelated to the
current goal or subgoal.
```

Cause, in `detectGoalMismatch` (`securityCritic.ts:461-472`): the goal
*"**Go to** the pricing page … and **report** the price shown there"* satisfies
`goalIsRead` (via `report`/`show`) with no state-changing term the critic
recognises, so `goalIsReadOnly` is true, and the `case 'navigate'` branch returns
`true` — a mismatch. `NAVIGATE_TERMS` does not appear to cover "go to".

**This is a security authority.** The brief for this work forbids modifying
Grounding, M5, the Security Critic, Risk/Confirmation, Effect Verification,
Containment and the privacy boundary. So it is **reported, not changed.**

**Direction of failure is fail-closed**: it blocks a *safe* action. It cannot
produce a false success and is not a security hole. It is a liveness/usability
defect — the agent cannot navigate when the user's phrasing reads as
"read-only". Anyone who owns the security authority should decide the fix; it
should not be made by loosening a gate.

**Consequence for the claim:** the real reasoner is proven, but a *completed*
real-reasoner task is **NOT_PROVEN** — blocked by this over-block, not by the
reasoner.

---

## 5. Status

| Claim | Status |
|---|---|
| Real reasoner is reached and invoked (was 0 cycles in 17.4) | **PROVEN_REAL** |
| Model output drives the loop; nothing is scripted | **PROVEN_REAL** |
| Provider base URL bug fixed, default unchanged, still local-only | **PROVEN_TEST** |
| Real provider rate limit → fail closed, 0 speculative actions | **PROVEN_REAL** |
| Real-reasoner task reaches a verifier-decided SUCCESS | **NOT_PROVEN** — blocked by the Security Critic over-block (§4) |
| Open-web real-reasoner long-horizon behaviour | **NOT_PROVEN** — controlled local fixture only |
| `UNVERIFIABLE` goal state | still absent from `GoalVerificationResult` (17.2 gap) |
| `targetValueLength` progress signal | still unavailable (17.4) |

No gate, gate ordering, or goal-verification rule was changed. `tsc` 0 errors and
the full suite (110 files / 1406 tests) are green.
