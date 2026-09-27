# PrivAgent — Failure / Recovery Matrix

**Commit evaluated:** `593fe72`
**Date:** 2026-09-27

**Scope.** This documents failure modes that **already exist** in the implementation and **already have evidence**. It does not create, propose, or simulate new failure behaviour. Every row is traceable to source code and, where marked, to a real-browser or real-reasoner observation.

**Governing principle:** PrivAgent fails *closed*. The design answer to "the agent is unsure" is "do nothing and say why," not "guess." The rows below are all instances of that.

---

## Recovery strategies (the complete set)

From `recoveryEngine.ts`. Recovery is bounded and non-authoritative:

| Strategy | Meaning |
|---|---|
| `REPERCEIVE` | Discard stale perception, re-observe the live page |
| `RETRY_SAME_TARGET` | Re-propose the same logical action after fresh perception |
| `REGROUND_TARGET` | Re-run grounding against the fresh page for the failed target |
| `RESELECT_TARGET` | Pick a **different** control for the same intent (self-healing *proposes*; the loop re-validates) |
| `SCROLL_AND_REPERCEIVE` | Scroll to bring hidden content into view, then re-perceive |
| `REPLAN_SUBGOAL` | Ask the plan layer to reopen only the remaining work (Phase 9) |
| `ABORT` | Bounded recovery exhausted, or failure is unrecoverable |

`RecoveryEngine.decide` returns `RECOVERED | PROGRESSED | OPEN | EXHAUSTED | ABORTED`. `strategy === 'ABORT'` terminates the task.

> **Critical invariant:** every recovery strategy re-proposes an action. **None of them authorizes one.** Healed actions re-enter grounding and M5 (`agentLoop.ts:1001-1007`). Recovery cannot widen authority.

> **Documented design decision:** `MODAL_RECOVERY_NOTE` states that PrivAgent deliberately has **no dedicated modal-dismissal primitive**. Rather than invent an unverifiable capability, a modal is handled via `REPERCEIVE` so the next perception cycle can target the overlay's own close control through the normal pipeline. This is recorded as a conscious refusal to add an unverified shortcut.

---

## Failure matrix

| # | Failure mode | Detection point | Fail-safe behaviour | Recovery attempted? | Task terminates? | Can any authority be bypassed? | Evidence |
|---|---|---|---|---|---|---|---|
| 1 | **Reasoner unavailable** (HTTP 401/5xx/timeout) | `BackendAgentProvider` / backend | Terminal `FAILED` with an explicit provider reason; **0 speculative dispatches** | No | Yes | **No** — no action is produced, so nothing can be dispatched | `providerFailure.test.ts` (21); `phase14/reasonerFailurePath.test.ts`; real: `REAL_REASONER_E2E_REPORT.md` |
| 2 | **Reasoner rate limit (429)** | Backend `reasoner.py` | Fails closed. Live: Groq `rate_limit` + fallback `unexpected_format` → HTTP 503 → terminal `FAILED` / `REASONER_FAILED` | No | Yes | **No** | `real_reasoner_e2e_evidence.json`; `providerFailure.test.ts`; `providerRetryBound.test.ts` |
| 3 | **Malformed reasoner output** | Action normalization | Rejected before it can become a valid action; recorded as a normalization failure | No | Yes | **No** — an unparseable action never reaches a gate | `m7Pipeline.test.ts`, `agentProvider.test.ts`; live: fallback `unexpected_format` |
| 4 | **Reasoner stalls (no progress)** | Harness / watchdog | Loop detected the stall and terminated rather than hanging. `reasoningEnteredAtMs 4966` → `terminalAtMs 45005` on a 40,000 ms slow reasoner | No | Yes | **No** | `reasoner_failure_path_evidence.json`. This is the behaviour commit `e41b8b9` fixed: a slow reasoner was previously misreported as a *perception* stall. |
| 5 | **Grounding failure** (target not in current page) | `groundProposedTarget`, `agentLoop.ts:919` | Action rejected. M5 re-run on any healed variant | Yes — `REGROUND_TARGET`, `RESELECT_TARGET` | Eventually, via `ABORT` if unrecoverable | **No** — healed actions re-enter grounding and M5 | `candidateVerification.test.ts`, `m5EndToEnd.test.ts`, `staleTargetSafety.test.ts` |
| 6 | **M5 rejection** (invalid schema, out-of-bounds, forbidden type, PII in reason text) | `validateAction`, `agentLoop.ts:991` | Action blocked, reason recorded | Yes — healed variant re-validated | Yes, when the block is terminal | **No** | Live: the Google search-button click was blocked because the reason text contained "cats" → read as possible `person_name`. **Correct fail-closed. Scanner not weakened.** |
| 7 | **Security Critic block** | `reviewProposedAction`, `agentLoop.ts:1112` | Action blocked | Yes | Yes | **No** | `phase8SecurityCritic.test.ts` (19) |
| 8 | **Privacy Policy denial** (capability not permitted for `agent_llm`) | `canPerformAction(..., 'agent_llm')`, `agentLoop.ts:1179` | Action blocked | No | Yes | **No** — the role argument is hard-coded at the call site and cannot be supplied by the model | `privacyPolicy.test.ts` |
| 9 | **Semantic / confidence gate requires confirmation** | `verifySemanticAction` / `evaluateExecutionConfidence`, `agentLoop.ts:1252-1254` | Execution pauses for explicit user authorization | N/A — awaits user | Only if declined | **No** | `semanticVerifier.test.ts`, `riskEngine.test.ts` |
| 10 | **Containment violation** (out-of-scope navigation) | `evaluateContainment`, `agentLoop.ts:1467`; `verifyNavigationContainment` on navigation | Navigation refused | No | Yes | **No** | `containment.test.ts` (43) |
| 11 | **Local port provisioning / hijack refused** | `extractProvisioningDestination` + resolver, `targetResolver.ts:110-152`, `:480-528` | `DESTINATION_REQUIRED`; the tab must already be open | No | Yes | **No** | **Real-browser proof**: the first controlled-run attempt failed exactly this way. |
| 12 | **Stale target** (prior page generation) | Page-generation counter + `validateTargetOrigin` | Action rejected as stale | Yes — `REPERCEIVE`, `REGROUND_TARGET` | Eventually | **No** | `staleTargetSafety.test.ts`, `targetResolutionAndLifecycle.test.ts` |
| 13 | **Action dispatched but no effect** | `verifyActionEffect` on observed snapshots, `agentLoop.ts:1765` | `ACTION_NO_EFFECT`. Dispatch success is explicitly **not** treated as success | Yes — `REPERCEIVE`, `RESELECT_TARGET`, `SCROLL_AND_REPERCEIVE` | Yes, on budget exhaustion | **No** | **Real Chrome, 9/9**: requested 600 px scroll at a boundary, **observed delta 0** → `ACTION_NO_EFFECT`, with `dispatchSucceeded: true, effectVerified: false`. Re-run and confirmed this pass. |
| 14 | **Effect unverifiable** (post-snapshot cannot be read) | `observeEffectSnapshot('post')` in the loop | **Fails closed** as `ACTION_NO_EFFECT` / `EFFECT_UNVERIFIABLE` within the existing retry budget. A PRE snapshot may fall back; a POST may not. | Within budget only | Yes | **No** — unverifiable is treated as failure, never as success | `effectVerificationObserved.test.ts` (17) |
| 15 | **Effect observed but goal not met** | `verifyTaskGoal` | Loop continues to the next planning round | Yes — `REPLAN_SUBGOAL` | On step-budget exhaustion | **No** | Live: after action 1 (`VALUE_STATE_CHANGED`) the goal was correctly still `IN_PROGRESS`. Typed-but-unsubmitted is never success. |
| 16 | **Google anti-bot interstitial** | External site behaviour, not PrivAgent | The agent observed a real navigation to `https://www.google.com/sorry/index?...` and the goal was correctly **not** satisfied | Yes | Yes, `FAILED` | **No** | `real_reasoner_e2e_evidence.json`. A known product boundary; no bypass is attempted. |
| 17 | **Harness budget exhausted** | `evaluateHarnessCycle` | `BUDGET_EXHAUSTED`; `MAX_STEPS_EXHAUSTED`, `RETRY_BUDGET_EXHAUSTED`, `RECOVERY_BUDGET_EXHAUSTED`, `STOP_REQUESTED`, `TASK_NOT_IN_PROGRESS` | No — this *is* the budget | Yes | **No** | `harness.test.ts` (47); `docs/evidence/phase13-harness/` |
| 18 | **Harness environment halt** | `evaluateHarnessCycle` | `HALT_ENVIRONMENT` — "the environment the agent is in is no longer the one the task resolved to." Reuses Phase 12 `ContainmentCode` values verbatim rather than a parallel taxonomy | No | Yes | **No** | `harness.test.ts`; `docs/evidence/phase13-harness/phase13_production_path_evidence.json` |
| 19 | **Loop detected / subgoal stalled** | Long-horizon layer → `LOOP_DETECTED`, `SUBGOAL_STALLED` | Detected; `REPLAN_SUBGOAL` or `ABORT` | Yes | Eventually | **No** | `phase9LongHorizon.test.ts` (33) |
| 20 | **Modal blocking** | Perception sees an open modal | `MODAL_RECOVERY_NOTE`: no dedicated dismissal primitive; recovered via `REPERCEIVE` so the normal pipeline can target the close control | Yes (`REPERCEIVE`) | Eventually | **No** | `phase10RecoveryEngine.test.ts`; modal counting is in the observed snapshot (`countOpenModals`) |
| 21 | **Privacy detection / fusion failure — unmappable finding** | `fusion.ts::buildFinding` | Escalated, not dropped: `unmappable: true`, `exportable: false`, `fail_closed:unmappable` in the evidence trail | N/A | N/A | **No** — escalation is strictly more conservative | `phase15/privacyFusionContextual.test.ts` (59) |
| 22 | **Unknown / unregistered privacy category** | `privacyDecision.ts::policyForCategory` | `FAIL_CLOSED` — not exported, region redacted locally; `policy.unknown_category` recorded | N/A | N/A | **No** | `privacyDecision.test.ts` (16) |
| 23 | **Raw value found in outbound payload** | `scanForRawSensitiveValues` / `assertNoRawSensitiveValues` | `PrivacyBoundaryError`; export terminated | N/A | N/A | **No** | `rawValueScanner.test.ts` (17); backend `verify_payload_invariants` repeats the check on arrival |
| 24 | **Dashboard output would leak** | `sendToDashboard` → `screenAgentOutput` | Fails closed; `projectAgentOutput` is narrowing with no write path back | N/A | N/A | **No** | `agentOutput.test.ts` (47), `extensionAdapter.test.ts` (16) |

---

## Cross-cutting answers

**Can any authority be bypassed by any failure path?**
No. Every row above either produces no action, or produces an action that re-enters the full gate chain. The only gate that runs after dispatch is effect verification, and its entire output space is "the effect happened" or "it did not / is unverifiable" — it has no code path that permits an action.

**Is there any path where a failure is silently swallowed into success?**
No. Specifically closed off in this codebase:
- a successful dispatch is not success (`ACTION_NO_EFFECT` exists precisely for this);
- an unverifiable effect is failure, not success;
- a typed-but-unsubmitted value is not goal success;
- a hardcoded result cannot be injected, because goal verification reads observed browser state and the harnesses never assert the verdict itself.

**Which failure modes have actually been observed with a real reasoner?**
Rows 1, 2, 3, 4, 6, 11, 13, 15, 16 — that is, provider unavailability and rate limiting, malformed fallback output, reasoner stall, an M5 block, a local-port refusal, a no-effect verdict, a correctly-deferred goal, and an anti-bot interstitial.

**Which are test-only?**
Rows 5, 7, 8, 9, 10, 12, 17, 18, 19, 20, 21, 22, 23, 24. All are implemented and covered by automated tests; they were simply not required by the live runs.

---

## The single most important row

**Row 13.** It is the row that makes the rest of the system trustworthy. Before this was fixed, post-action state was synthesized *from the requested action* — `newUrl = action.url`, `newScrollY += delta` — meaning effect verification **could not fail** for any successfully dispatched action. The controlled success run is only meaningful because the same seam was independently proven to return `ACTION_NO_EFFECT` under a real browser. A success demonstration and its own falsifier were established together, which is the only defensible way to demonstrate one.
