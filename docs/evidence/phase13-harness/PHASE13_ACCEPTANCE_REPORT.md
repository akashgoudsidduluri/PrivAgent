# Phase 13 Evidence — Harness (Cycle Coordination & Runtime-State Observation)

All numbers come from commands actually executed in this repository.

| Item | Command | Result |
| --- | --- | --- |
| Phase 13 focused tests | `npx vitest run tests/phase13/` | **1 file / 47 tests passed** |
| Full regression suite | `npx vitest run` | **94 files / 1002 tests passed** (104.79 s) |
| TypeScript | `npx tsc -b --noEmit` | **0 new errors** (5 pre-existing, see §7) |
| Extension build | `npm run build:extension` | **exit 0** — `dist/contentScript.js` 108.41 kB |
| Real Chrome harness | `node scratch/verify_phase13_harness.mjs` | **9 / 9 checks PASS** |
| Real Chrome **production service-worker path** | `node scratch/verify_phase13_production_path.mjs` | **7 / 7 checks PASS** |

Regression baseline before this phase: **93 files / 955 tests**. Delta: **+1 file /
+47 tests**, all Phase 13. No pre-existing test was modified or removed.

---

## 1. What Phase 13 is, and what it is not

The Harness is **cycle coordination and runtime-state observation**. It is
explicitly **not** an arbiter of security.

It answers exactly one question at the top of every agent cycle:

> MAY THIS CYCLE RUN, IN THE ENVIRONMENT THE AGENT IS ACTUALLY IN?

Its entire verdict vocabulary is four words:

```
CONTINUE  ·  HALT_ENVIRONMENT  ·  BUDGET_EXHAUSTED  ·  TERMINAL
```

There is no `ALLOW`, no `DENY`, no `AUTHORIZE`, no `PERMIT` anywhere in its
surface. This is asserted structurally in test `4.4` and `8.7`, and again over
real Chrome in check 6.

### The central invariant

```
HARNESS = CONTINUE  →  M5 = REFUSED           →  NO DISPATCH
HARNESS = CONTINUE  →  CRITIC = BLOCK         →  NO DISPATCH
HARNESS = CONTINUE  →  CONTAINMENT = DENIED   →  NO DISPATCH
HARNESS = CONTINUE  →  GROUNDING = REFUSED    →  NO DISPATCH
HARNESS = CONTINUE  →  PRIVACY VALUE-TRANSIT  →  NO DISPATCH
```

`REASONING ≠ AUTHORITY` is unchanged. The reasoner still proposes; the local
pipeline still decides. A `CONTINUE` verdict means only *"the next cycle may run
the pipeline"*.

---

## 2. The boundary: what the Harness did NOT touch

The following modules are **unmodified and unreordered**:

`groundingEngine.ts` · `actionValidator.ts` · `securityCritic.ts` ·
`privacyPolicy.ts` · `riskEngine.ts` · `effectVerifier.ts` · `goalVerifier.ts` ·
`recoveryEngine.ts` · `containment.ts` · `selfHealing.ts` · `longHorizon.ts` ·
`serviceWorker.ts` · `contentScript.ts` · `targetResolver.ts` · the backend ·
the frontend · `manifest.json`

`resumeWithConfirmation()` is **unchanged**, as instructed. The service
worker's live dispatch-time containment check is **unchanged** — arming the
Harness added a line to the `AgentLoop` construction and touched nothing else in
that file.

Files changed by this phase:

| File | Change |
| --- | --- |
| `extension/src/agent/harness.ts` | **NEW** — the Harness module (pure, deterministic) |
| `extension/src/agent/agentLoop.ts` | `harness?: AgentHarness \| null` option, field, per-task reset, and **one insertion** immediately before perception |
| `extension/src/agent/agentState.ts` | `TaskState.harnessRun?: HarnessRunSummary` |
| `extension/src/background/serviceWorker.ts` | **arming only** — one import + `harness: new AgentHarness(),` in the existing `new AgentLoop({...})`. No other line touched. |
| `tests/phase13/harness.test.ts` | **NEW** — 47 focused tests |
| `scratch/verify_phase13_harness.mjs` | **NEW** — real-Chrome CDP verification of the seam |
| `scratch/verify_phase13_production_path.mjs` | **NEW** — real-Chrome CDP verification of the **shipped** service worker |
| `docs/evidence/phase13-harness/*` | **NEW** — this report, JSON evidence, screenshot |

No new permission, no new message type, no new browser API, no new dependency,
and **no security gate modified**. `manifest.json` is untouched.

---

## 2a. The Harness is armed in production

`serviceWorker.ts` constructs the production loop with `harness: new AgentHarness(),`.
This is the **entire** change — one import, one option, one comment. It adds no
authority: it only gives the existing `AgentLoop` its coordination layer.

Verified end to end through the **actual production path** — real dashboard page
→ real extension content script → real service worker loaded from `dist/` → real
target resolution and containment scope → real `AgentLoop` → real content-script
perception in a real target tab:

| # | Check | Result |
| --- | --- | --- |
| 1 | `harnessArmedInProduction` | PASS — `harnessRun.cycles = 1`, `continueCount = 1`, `halts = 0` |
| 2 | `harnessConsultedByRealLoop` | PASS — `[AgentTrace] harness cycle` observed in the **real service worker's** console |
| 3 | `harnessStateReachedRealDashboard` | PASS — `harnessRun` arrived in the real dashboard's `TASK_PROGRESS` payload (4 progress messages) |
| 4 | `containmentStillEstablished` | PASS — `[AgentTrace] containment scope established` in the production worker |
| 5 | `perceptionStillRan` | PASS — real perception completed |
| 6 | `harnessStateCarriesNoUrl` | PASS — the record contains no URL |
| 7 | `environmentHeldThroughout` | PASS — the live target page never left the contained origin |

**Honest scope of that run:** the reasoner backend is intentionally not running
in this environment, so the task ends `FAILED` at the reasoning step and **no
action was ever proposed**. The per-action gates (M5, Security Critic, Privacy,
Risk/Confirmation, Containment-at-dispatch, Recovery) therefore had nothing to
evaluate and did not fire in this particular run — the reasoner failure is
upstream of them, and no gate was skipped by the Harness. Those gates are
verified by the 47 focused tests and by the 9-check seam harness in §6. The two
things this run uniquely proves are: the shipped service worker **does** arm the
Harness, and the Harness **does** run and report in the real product path.

---

## 3. Where the Harness sits

```
while (state.status === 'IN_PROGRESS') {
  ├─ isStopped check                       (existing, authoritative)
  ├─ max-steps check                       (existing, authoritative)
  │
  ├─ ★ HARNESS.runCycle()  ──────────────── THE SINGLE INSERTION
  │     environment  → CONTINUE ? HALT_ENVIRONMENT
  │     budget       → CONTINUE ? BUDGET_EXHAUSTED
  │     terminal     → CONTINUE ? TERMINAL
  │
  ├─ 2. perceivePage()
  ├─ GATE 1  groundProposedTarget()
  ├─ GATE 2  validateAction()              (M5)
  ├─ GATE 2.5 reviewProposedAction()       (Security Critic)
  ├─ GATE 3  canPerformAction()            (Privacy Firewall)
  ├─ GATE 4  assessActionRisk / semantic / confidence
  ├─ GATE 5  confirmation
  ├─ 5.5 evaluateContainment()             (Phase 12 — unchanged)
  ├─ 6. executeAction()
  ├─ 7. verifyActionEffect()               (Effect Verification)
  └─ 8. RecoveryEngine.decide()            → Goal Verification
}
```

The insertion sits **after** the existing stop and max-steps checks and
**immediately before** perception. Placing it there is deliberate: it is the
only position from which the loop can be stopped *before* it perceives, and it
leaves the two most regression-sensitive existing checks (stop, max-steps)
untouched and authoritative.

---

## 4. Containment ownership stays with Phase 12

The Harness **consumes** the Phase 12 scope. It never creates, widens, narrows
or reinterprets one. Boundary semantics come from Phase 12's own primitives —
`isContainableScheme`, `hostWithinScope`, `containmentSummary` — and its halt
codes **reuse the `ContainmentCode` values verbatim** rather than inventing a
parallel taxonomy (test `2.10`):

```
HALT_ENVIRONMENT → SCOPE_DRIFT_DETECTED    (Phase 12's code)
HALT_ENVIRONMENT → TAB_SCOPE_VIOLATION     (Phase 12's code)
HALT_ENVIRONMENT → UNSUPPORTED_SCHEME_DENIED (Phase 12's code)
HALT_ENVIRONMENT → MALFORMED_INPUT         (Phase 12's code)
```

The two environmental controls are complementary and both deliberately exist:

| Layer | Question | When |
| --- | --- | --- |
| **Harness** (13) | "should this perception cycle run?" | before perception |
| **Service worker** (12) | "is this real dispatch still inside the boundary?" | at dispatch |

Test `7.8` pins this layering: when both are armed, containment's
dispatch-boundary denial is the one that fires, and the harness is the earlier
backstop for the case where containment never gets to run.

---

## 5. Budgets are observed, never re-invented

The Harness **holds no bounds of its own**. Every bound arrives per call from
the loop, and the comparison operators mirror the loop's own checks exactly, so
the two can never drift into competing limit sets:

| Bound | Loop's own check | Harness check | Same operator |
| --- | --- | --- | --- |
| steps | `agentLoop.ts:475` `currentStep >= maxSteps` | `MAX_STEPS_EXHAUSTED` | `>=` |
| retries | `agentLoop.ts` `retryCount > maxRetries` | `RETRY_BUDGET_EXHAUSTED` | `>` |
| recovery | `RecoveryEngine.decide()` `totalRecoveries > maxTotalRecoveries` | `RECOVERY_BUDGET_EXHAUSTED` | `>` |

Because the operators are identical, **the harness can never terminate a run
the loop would have continued**. Test `3.4` proves the bounds are re-supplied on
every call; test `3.5` proves the counters are the loop's, mirrored.

---

## 6. Real-browser evidence (9 / 9)

`node scratch/verify_phase13_harness.mjs` drives the **real** `AgentLoop`, with a
**real** `AgentHarness` wired in, against the **real** PrivAgent content script
in a **real** Chrome tab over CDP.

| # | Check | Result |
| --- | --- | --- |
| 1 | `harnessRunEstablished` | PASS — cycles=3, runId `harness-run-…`, scope `contained:localhost` |
| 2 | `allowedCycleReallyDispatched` | PASS — `dispatched=["click",…]`, page marker changed, `window.__clicks=1` |
| 3 | `harnessStateIsValueFree` | PASS — `assertNoSensitiveDataInState` clean, 0 raw-value findings, no host in the record |
| 4 | `environmentDriftHaltsCycle` | PASS — `HALT_ENVIRONMENT` / `SCOPE_DRIFT_DETECTED` |
| 5 | `wrongTabHaltsCycle` | PASS — `HALT_ENVIRONMENT` / `TAB_SCOPE_VIOLATION` |
| 6 | `boundsObservedFromLoop` | PASS — `MAX_STEPS_EXHAUSTED` / `RETRY_BUDGET_EXHAUSTED` / `RECOVERY_BUDGET_EXHAUSTED` |
| 7 | `noAuthorizationVocabulary` | PASS — no `allow` / `deny` / `authorize` anywhere in the verdict surface |
| 8 | `continueIsNotPermission` | PASS — harness `CONTINUE`, real Critic `BLOCK/SUSPICIOUS_NAVIGATION`, nothing dispatched |
| 9 | `environmentHeldThroughout` | PASS — the live page never left the contained environment |

The verification harness **never dispatches an action of its own, never decides
a gate, and never authorizes anything**. It proposes through the real pipeline
and reads back what the real stack did.

---

## 7. Limitations and known caveats — read before judging this phase

1. **The first cycle makes no environmental claim.** At cycle 1 the loop has
   not yet perceived, so `state.currentUrl` is empty and the harness correctly
   records `liveUrlKnown: false`, `withinScope: null` and continues. This is the
   fail-safe direction — it never halts spuriously — and the service worker's own
   start guard (`CONTAINMENT_UNINITIALIZED`) is what ensures the task begins in
   the resolved environment. Pinned deliberately by test `7.4`.

2. **With containment at 5.5 in place, the harness's environment halt is
   largely a backstop.** When the loop's known URL drifts, the Phase 12
   dispatch-boundary denial normally fires in the *same* cycle, so the harness
   rarely gets to be the one that refuses. It is genuinely reachable when the
   drift is discovered by perception but the cycle is refused before the next
   reasoning round (test `7.2`). The two layers are not redundant: the harness
   stops the agent *perceiving and reasoning about* an unauthorized page, which
   containment never does.

3. **The harness observes `state.currentUrl`, not a live tab read.** Getting a
   genuinely live URL would require either a new `AgentLoopCallbacks` hook or a
   service-worker change. Both were out of scope, so the harness uses the loop's
   own last-known URL and the **service worker keeps the authoritative live
   check at dispatch**, as instructed.

4. **5 pre-existing `tsc` errors** in `extension/src/background/targetResolver.ts`
   (lines 285, 287 ×2, 290, 488) introduced by commit `d1fbf5c`. Verified
   pre-existing on a clean tree. Phase 13 adds **0 new** type errors and does not
   modify that file. "Typecheck PASS" here means *0 new errors*, exactly as in
   Phase 12.

5. **Backend pytest was not run** (`No module named pytest` in this environment)
   and no backend code was changed by this phase.

6. **Headless Chromium** was used (`--headless=new`), matching the Phase 9–12
   harnesses.

7. **The seam real-Chrome run ended `FAILED`.** That is correct behaviour, not a
   defect: the deterministic provider re-proposes the same click, and the
   Phase 11 duplicate-click guard (`DUPLICATE_CLICK_SUPPRESSED`) refuses the
   repeats until the retry bound is spent. The first click really executed and
   really changed the page, which is what check 2 asserts.

---

## 8. Verdict

**PASS.**

Phase 13 adds a Harness that coordinates cycles and observes runtime state, and
nothing else. It introduces no authority, no gate, no second loop, no second
recovery path, no new permission, no new message type, no new browser surface,
and no new dependency. It leaves every existing security module unmodified and
unreordered, leaves `resumeWithConfirmation()` unchanged, and leaves the service
worker's live dispatch-time containment check unchanged.

The Harness is **armed in production** (§2a, verified through the real shipped
service worker) and remains **non-authoritative**: arming it gives the existing
`AgentLoop` a coordination layer, while Grounding, M5, the Security Critic, the
Privacy Firewall, Risk/Confirmation, Phase 12 Containment, Effect Verification,
Goal Verification and the Recovery Engine all stay authoritative and unreordered.

Implementation is complete.
