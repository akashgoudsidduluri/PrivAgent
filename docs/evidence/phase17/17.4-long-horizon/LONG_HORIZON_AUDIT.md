# PHASE 17.4 — LONG-HORIZON RELIABILITY AUDIT

**HEAD at audit time:** `1bf0fcb` (Phase 17.3 OCR & Advanced Non-DOM Perception)
**Baseline:** 108 test files / 1355 tests passing · `tsc` **0 errors** · both builds green
**Method:** read-only source audit of every module named in the 17.4 brief, plus the
Phase 17.1 observation contract and the Phase 17.3 OCR observation contract.

**Headline finding:** most of the requested capability already exists and is sound.
The genuine defects are concentrated in **one place — the wiring between
`AgentLoop` and `LongHorizonTracker`** — where the production call site silently
disables two of the module's own controls. No security authority, no goal-verification
rule, and no budget-to-success path is implicated.

---

## 1. What already exists (do not rebuild)

Phase 9 (`longHorizon.ts`, 863 lines) already implements most of what 17.4 asks for.
This audit explicitly does **not** propose a new state machine.

| Requirement | Existing implementation | Status |
|---|---|---|
| Progress tracking | `assessProgress` — `NEW_PAGE` / `NEW_ENTITY` / `NEW_CANDIDATE` / `RELEVANT_STATE_CHANGED` | present, **partly defeated (D1, D3)** |
| Stagnation detection | `detectStall`, `maxConsecutiveNoProgress` | present, **defeated (D1)** |
| Action repetition control | `detectLoop` `REPEATED_STATE`, `fingerprintWindow` ring | present, **wrong input (D2)** |
| Recovery oscillation | `detectLoop` `ALTERNATING_LOOP` (A→B→A→B) + `RecoveryEngine` repeated-strategy escalation | present, sound |
| Recovery budgets | per-action / per-subgoal / total + `maxRepeatedStrategy` | present, sound |
| Hard bounds | `checkBounds` — action / replan / stall / subgoal | present, sound, **fails closed** |
| Subgoal lifecycle | `SUBGOAL_TRANSITIONS`; `COMPLETED` is terminal | present, sound |
| Replan | `replanRemaining` — reopens only outstanding work, preserves completed + discoveries | present, sound |

---

## 2. Actual defects

### D1 — HIGH — Stagnation detection cannot fire

**Where:** `extension/src/agent/agentLoop.ts:801-805` → `extension/src/agent/longHorizon.ts:255-262`

The only production call site:

```ts
const lhProgress = this.longHorizon.observe(lhObservation, undefined, {
  subgoalJustCompleted: this.state.lastActionResult?.success
    ? this.longHorizon.activeSubgoalId ?? undefined
    : undefined,
  ...
});
```

`lastActionResult.success` is **dispatch** state. Whenever an action is dispatched
successfully, `assessProgress` pushes a `SUBGOAL_COMPLETED` signal, and:

```ts
return { meaningful: signals.length > 0, ... }   // longHorizon.ts:262
```

so `meaningful === true`, so `consecutiveNoProgress = 0` (`longHorizon.ts:557`).
**`consecutiveNoProgress` and `totalNoProgress` never advance while actions keep
dispatching.** `detectStall` (`maxConsecutiveNoProgress: 3`) and the
`STALL_BUDGET_EXHAUSTED` bound (`maxStallActions: 5`) are therefore unreachable.

This directly contradicts the module's own contract, written 30 lines above the call
site (`longHorizon.ts:229-231`):

> *"Critically, a successful browser action is NOT by itself progress: an
> effect-verified click that leaves the page, the entities and the targeted state
> exactly where they were has moved the task nowhere."*

The call site makes a successfully dispatched action exactly that.

**Direction of failure:** fail-closed. Progress feeds only `replanRemaining` and
`FAILED`. It **cannot** produce a false SUCCESS. The cost is that requirements
"stagnation detection" and "action repetition control" are inert: a genuinely stuck
agent keeps burning its action budget until `ACTION_BUDGET_EXHAUSTED` instead of
detecting the stall and replanning.

---

### D2 — MEDIUM — The fingerprint's action component is dead code

**Where:** `longHorizon.ts:217-226` (definition) vs `agentLoop.ts:801` (call)

`fingerprintObservation` is documented as *"a bounded, deterministic fingerprint of
same page state + same action"* and takes an `action` parameter. The only production
call passes `undefined` as the second argument, so `actionPart` is permanently the
literal `'observe'`.

Two consequences:

1. The advertised "same action repeated" detection does not exist. Only "same state
   repeated" is detected.
2. `A → FAIL → A → FAIL` (requirement B) is detected for the wrong reason: it is
   detected because the *observation* repeated, not because the *action* repeated.
   A different action that also changed nothing is treated identically, and an
   identical action that legitimately changed nothing is indistinguishable from a
   genuinely stuck one.

**Direction of failure:** fail-closed (false loop → replan → bounded), but it makes
the control's stated semantics untrue — the "duplicated or contradictory state
machine" pattern (Axiom R) between a module's contract and its wiring.

---

### D3 — MEDIUM — A progress signal is permanently dead behind an `as any` cast

**Where:** `agentLoop.ts:799`

```ts
targetValueLength: (context as any).typed_value_length ?? 0,
```

`AgentContextPayload` (`extension/src/privacy/types.ts:241-262`) has **no**
`typed_value_length` field. The cast suppresses the type error and the expression
evaluates to `0` on every cycle, forever.

Consequently `assessProgress`'s check
`previous.targetValueLength !== current.targetValueLength` can never fire, so
`RELEVANT_STATE_CHANGED` is unreachable from a typed value. The `as any` is hiding a
contract mismatch between the loop and the perception payload rather than surfacing
it.

**Direction of failure:** fail-closed (progress is under-reported, never over-reported).

---

### D4 — MEDIUM — The long-horizon layer consumes no observation provenance

**Where:** `longHorizon.ts:174-188` (`observeFromContext`)

```ts
return {
  url: context.url,                                            // no freshness
  pageGeneration: context.semantic_context?.pageGeneration ?? 0,  // no document identity
  entityIds, candidateIds,
  scrollY: extra.scrollY ?? 0,                                 // absence decodes as 0
  targetValueLength: extra.targetValueLength ?? 0,             // absence decodes as 0
};
```

17.1 established per-field `ObservationState` (`effectVerifier.ts:46-58`) and 17.3
established freshness, tab binding and document identity
(`ocr/ocrObservationContract.ts` — `isOCRObservationFresh`,
`isSameDocumentIdentity`, `MAX_OCR_OBSERVATION_AGE_MS`). The goal verifier (17.3,
`goalVerifier.ts:751`) and the effect verifier both consume those gates. **The
long-horizon reliability layer consumes none of them.**

So loop and stall detection fingerprint observations that were never proven fresh or
bound to a document. A repeated *stale* perception reads exactly like a repeated
*current* one.

**Direction of failure:** fail-closed. This can cause a false loop on stale input, or
mask a real one. It cannot fabricate progress, because stale repetition produces
*identical* fingerprints, which is the non-progress direction.

---

### D5 — MEDIUM — Long-horizon state does not survive a service-worker restart

**Where:** `agentLoop.ts:300` (`private readonly longHorizon = new LongHorizonTracker(...)`),
`agentLoop.ts:460` (`initialize` inside `runTask`)

All long-horizon state — fingerprints, action/recovery counters, completed subgoals,
discoveries — lives in a per-`AgentLoop`-instance field and is rebuilt on every
`runTask`. Manifest V3 service workers are terminated when idle. A genuinely long
task that outlives a worker restart resumes with **empty** loop accounting, which
means `ACTION_BUDGET_EXHAUSTED`, `REPEATED_STATE_EXHAUSTED` and
`STALL_BUDGET_EXHAUSTED` all reset to zero part-way through, and previously completed
subgoals are forgotten.

**Direction of failure:** this *weakens* a bound (extends the run) rather than
creating a false success. Classified as a defect because the brief explicitly asks
for correct behaviour across long runs.**Originally deferred from 17.4, then remediated.** This audit first recorded D5
as a known limitation, reasoning that persistence needs a storage decision, a
restore contract, and an answer to "what does a resumed task's budget mean".
Review required the fix, so D5 was remediated as a separate, later change set
after `89817c6`.

**See [`LONG_HORIZON_AUDIT_D5.md`](./LONG_HORIZON_AUDIT_D5.md)** for the full
design audit, the storage decision (including the added `storage` manifest
permission), task identity, lifecycle semantics, fail-closed restore and the
privacy argument. The body of this audit is left exactly as written, so the
original reasoning stands on the record.

---

### D6 — LOW — Confirmed action re-dispatched without re-validating against the page

**Where:** `agentLoop.ts:2242-2270` (`resumeWithConfirmation`)

After the confirmation gate, the action is dispatched straight to `executeAction`
with no fresh perception and no re-check that the target is still valid in the
current page generation. If the page changed while the loop was paused awaiting user
confirmation, a stale target is dispatched.

Partially mitigated: effect verification would report `ACTION_NO_EFFECT` afterwards.
But the stale dispatch still occurs, and a consequential action is involved.

**Not proposed for 17.4.** Adding a re-validation here means re-entering the gate
chain for a user-authorized action — a change to the authorization semantics, which
this phase must not touch.

---

### D7 — LOW / unverified — `SUBGOAL_BUDGET_EXHAUSTED` accounting

`checkBounds` compares `subgoalCount` (i.e. `this.subgoals.size`) against
`maxSubgoals`, and `registerSubgoal` only ever inserts. Replanning reuses existing
subgoal ids, so the counter should not inflate artificially — but this was **not
verified end-to-end** and is recorded as an open question rather than a defect.

---

## 3. Existing protections (verified — must not be weakened)

| Protection | Evidence |
|---|---|
| Terminal state cannot restart the main loop | `while (this.state.status === 'IN_PROGRESS')` — `agentLoop.ts:504` |
| Terminal state cannot be resumed | `resumeWithConfirmation` throws unless status is exactly `NEEDS_USER_CONFIRMATION` — `agentLoop.ts:2243` |
| `maxSteps` fails closed | `agentLoop.ts:514-519` → `FAILED` |
| Hard long-horizon bounds fail closed | `agentLoop.ts:844-858` → `FAILED` |
| **Budget exhaustion is never SUCCESS** | `checkBounds` returns only `{exhausted:true, reason}`; the caller sets `FAILED`. **Requirement 6 satisfied today.** |
| Perception unavailable fails closed | `agentLoop.ts:602-609` → `FAILED` |
| Completed subgoals are terminal | `SUBGOAL_TRANSITIONS['COMPLETED'] = []` — `longHorizon.ts:106` |
| Replan preserves completed work | `replanRemaining` — `longHorizon.ts:640-651` |
| Recovery oscillation is bounded | `RecoveryEngine` per-action / per-subgoal / total budgets + `maxRepeatedStrategy` — `recoveryEngine.ts:222-353` |
| Alternating A→B→A→B loop detected | `longHorizon.ts:303-312` |
| Fingerprint memory is bounded | `fingerprintWindow: 8` ring — `longHorizon.ts:562-565` |
| Long-horizon state is value-free | `scanForRawSensitiveValues` on every discovery label — `longHorizon.ts:610-614` |
| Goal success only from observed verification | `verifyTaskGoal` has one caller; 17.2A invariants intact at `1bf0fcb` |
| Goal verification is not an authorization path | `isTaskGoalSatisfied` only sets `goalStatus` |
| 17.1 fail-closed effect verification | per-field `ObservationState`, `effectVerifier.ts:46-58` |
| 17.3 OCR freshness / document identity / tab binding | `ocrObservationContract.ts`; consumed at `goalVerifier.ts:751` |
| Gate ordering unchanged | 17.4 introduces no gate and reorders none |

---

## 4. Intended limitations (not defects)

- No cross-task or cross-session memory by design; `initialize()` clears everything.
  (D5 remediation adds persistence *within* a single active run only; it does
  not add cross-task memory.)
- `UNVERIFIABLE` is still absent from `GoalVerificationResult` (17.2 documented gap).
- Local reliability controls are deliberately deterministic and model-free; that is
  a design invariant, not a gap.
- Provider round-trip latency dominates wall-clock; local cycle cost is not the
  bottleneck and is not optimised here.

---

## 5. Proposed changes (minimal, evidence-driven)

Only what the audit proves is necessary. **No new state machine; no new bounds system;
no change to any security authority; no change to any goal-verification rule.**

| # | Change | Fixes | Size |
|---|---|---|---|
| **P1** | Stop injecting dispatch-derived `subgoalJustCompleted` at the loop call site. A subgoal completion must be recognised from **observed** state, not from `lastActionResult.success`. | D1 | 1 call site |
| **P2** | Pass the attempted action into `observe()` so the fingerprint matches its documented "state + action" contract. | D2 | 1 call site |
| **P3** | Delete the phantom `(context as any).typed_value_length` cast; read a field that genuinely exists, or drop the signal explicitly and say so. | D3 | 1 call site |
| **P4** | Gate the long-horizon observation on real provenance by **reusing** the 17.1/17.3 primitives — no new contract invented. | D4 | small adapter |
| **P5** | Document D5 (SW restart) as a known limitation. No code change. | D5 | docs only |

Explicitly **not** proposed: `resumeWithConfirmation` re-validation (D6, authorization semantics), any new goal
type, any change to bounds defaults, any change to the gate chain.

> **Superseded for D5 only.** P5's "no code change" is no longer the position:
> service-worker state persistence was built in a later change set on the same
> branch and is specified in [`LONG_HORIZON_AUDIT_D5.md`](./LONG_HORIZON_AUDIT_D5.md).
> Everything else in this table stands unchanged.

---

## 6. Axiom-by-axiom result

| Axiom | Result |
|---|---|
| A State drift | D1, D4 |
| B Stale observations | D4 |
| C Repeated actions | D2 |
| D Repeated failed actions | D2 (detected for the wrong reason) |
| E Recovery oscillation | protected — `RecoveryEngine` + `ALTERNATING_LOOP` |
| F Recovery loops | protected — bounded budgets, `RECOVERY_EXHAUSTED` |
| G Planner/goal divergence | protected by 17.2A; D1 is progress-level only |
| H Page/document transitions | D4, D6 |
| I Target-tab drift | protected — `ensureTargetTabReady` revalidates each cycle in the service worker |
| J Observation unavailable | protected — `agentLoop.ts:602-609` |
| K Perception failure | protected — same path |
| L Bounded runs | protected — `maxSteps` + `checkBounds` |
| M Step/retry/recovery budgets | protected |
| N Terminal-state handling | protected — `while (IN_PROGRESS)`, guarded resume |
| O Reset/restart | `initialize()` is total and idempotent — protected |
| P Long-horizon persistence | **D5 — remediated after `89817c6`**; see `LONG_HORIZON_AUDIT_D5.md`. No cross-task memory is introduced. |
| Q Accidental success from bookkeeping | **no defect found** — see below |
| R Duplicated/contradictory state machines | **D2** — module contract vs. production wiring |

**Q (accidental success from internal bookkeeping) — checked explicitly and clean.**
`subgoalJustCompleted` is the only dispatch-derived value reaching the long-horizon
layer, and it feeds *progress*, never a verdict. `checkBounds` can only return
`exhausted`. `replanRemaining` cannot mark a subgoal `COMPLETED`. Goal `SUCCESS` is
writable at exactly two sites (`agentLoop.ts:887`, `:2205`), both gated by
`isTaskGoalSatisfied` → `verifyTaskGoal`. No 17.2A fabrication path was found to
have returned.
