# STEP 10.1 — G1 closure: the ACTION_NO_EFFECT causality invariant

Surgical closure of the single audit gap **G1**. No production code was changed.
No other gap was touched. No Phase 18, no Step 11, no commit, no push.

---

## 1. Why M13 survived the Step 10 audit

`agentLoop.runTask` has exactly two places that write the action verdict:

| line | branch | written value |
| --- | --- | --- |
| `agentLoop.ts:2108` | `ACTION_NO_EFFECT` **and** `destinationVerifier = MATCH` | `{ success: false, error: 'ACTION_NO_EFFECT (destination already satisfied per verifier)' }` |
| `agentLoop.ts:2121` | `ACTION_NO_EFFECT` **and** the destination is not satisfied (or there is no destination subgoal) | `{ success: false, error: effectResult.details \|\| 'ACTION_NO_EFFECT' }` ← **M13's line** |
| `agentLoop.ts:2341` | real observed effect | `{ success: true }` |

W20/W21/W22 pin line 2108 (`lastActionResult.success === false` on the MATCH branch).
**Nothing pinned line 2121.** W23 (MISMATCH), W24 (UNKNOWN) and W25b (STALE) all execute
it, and all three assert the trace line, the subgoal state and the failure record — but
none ever looked at `lastActionResult`. M13 therefore passed all 2088 tests.

A second, static consequence found while auditing that line: `agentLoop.ts:2917`

```ts
private isTaskGoalSatisfied(task, state, context): boolean {
  if (state.lastActionResult && !state.lastActionResult.success) {
    return false;          // a failed action can never yield task SUCCESS
  }
  const res = verifyTaskGoal(task, state, context);
  ...
}
```

so `success: false` on the no-effect path is load-bearing for **GoalVerifier authority**,
not just bookkeeping. With M13's `success: true`, that short-circuit no longer fires and
`verifyTaskGoal` gets to run on a step the effect verifier just declared a failure.

---

## 2. The invariant the new tests pin

> `ACTION_NO_EFFECT` is never action success, and destination satisfaction is never action
> success. The two are orthogonal signals that share one `success` field.

Every assertion is cross-checked against a signal written on a *different* branch, so
"the object happens to say false" cannot pass on its own:

| signal | written only by | branch |
| --- | --- | --- |
| `completedSteps` | `agentLoop.ts:2345` | the **success** branch |
| `failureHistory` entry `category: 'ACTION_NO_EFFECT'` | `agentLoop.ts:2125-2130` | the **no-effect fall-through** |
| `destSubgoalState === 'COMPLETED'` | `completeSubgoal`, `agentLoop.ts:2103` | the **MATCH** branch |
| `lastActionResult.error` literal | one per branch | distinguishes which branch wrote it |

---

## 3. Tests added

`tests/destinationPropagationAndAlreadySatisfied.test.ts`, new
`describe('D · W31/W32 — causality: ACTION_NO_EFFECT is never action success')`.
47 → **52** tests; the file adds **5**.

* **W31 × 3** — one per non-MATCH verdict the verifier can return (`MISMATCH`, `UNKNOWN`,
  `STALE`). Each drives the real `AgentLoop` with `maxSteps: 1` so the recorded action
  result is unambiguously the one fall-through that wrote it, then asserts the eight-step
  chain: no-effect warned, `ACTION_NO_EFFECT` in the failure history, `completedSteps`
  empty, the verifier's own non-MATCH reason present in the trace,
  **`lastActionResult.success === false`**, the error is *not* the already-satisfied
  wording, destination not completed, `goalStatus !== 'SUCCESS'`.
* **W32** — the MATCH control. Destination `COMPLETED`, `failureHistory` empty,
  `completedSteps` empty, and `lastActionResult.error` matching
  `/ACTION_NO_EFFECT \(destination already satisfied per verifier\)/`. Same
  `success: false`, different destination state and different writer — that pair is what
  makes the two signals non-implying.
* **W32b** — a structural backstop across all four verdicts, asserting
  `completedSteps` stays empty and `success` stays false in every one, so the invariant
  survives a future re-typing or rename of `lastActionResult`.

---

## 4. Mutation result

M13 run against the new tests (`scratch/step10_mutation_matrix.mjs M13`):

```
KILLED (2.9s, restore=true) 4 failing
  × W31. a no-effect action the page answers MISMATCH stays unsuccessful and completes nothing
  × W31. a no-effect action the page answers UNKNOWN  stays unsuccessful and completes nothing
  × W31. a no-effect action the page answers STALE   stays unsuccessful and completes nothing
  × W32b. no code path turns ACTION_NO_EFFECT into a completedSteps entry
```

The failures are **exclusively** the new causal-invariant tests. `W32` correctly does
**not** fail: it reads the already-satisfied branch at line 2108, which M13 does not
touch — exactly the discrimination the step required.

Full matrix re-run, 21 entries: **20 KILLED · 1 EQUIVALENT (M9b) · 0 SURVIVED ·
0 INVALID.** Every previously-killed mutation is still killed. Several kill counts rose
because the new tests independently reinforce them (M9a 8→11, M10 4→5, M11 4→6,
M12 2→3, M15 52) — additive, nothing weakened. M9b remains EQUIVALENT at 52/52.

**Residue:** all six mutated files byte-identical to their pre-run backups
(`cmp -s` on every one), `scratch/.mutation_backup/` removed, `git diff --check` clean,
tracked-source diff unchanged at 19 files / 892 insertions.

---

## 5. Real Chrome regression

Production `dist/`, real headless Chrome, real Groq-backed backend. `lastActionResult`
is read out of the `AgentTaskState` the extension itself publishes to the dashboard
(`chrome.tabs.sendMessage(tabId, {type:'PRIVAGENT_DASHBOARD_PROGRESS', payload})`),
captured by wrapping that one function in the worker and forwarding its arguments
unchanged. No verifier was invoked, no state was written, nothing was injected into the
loop.

| | A already-at-destination | B wrong destination | C UNKNOWN |
| --- | --- | --- | --- |
| start / final URL | `/results.html` | `/login.html` → `/search.html` | `/search.html` |
| pageType / confidence | `LISTING` / 0.99 | `LOGIN` 0.99 → `UNKNOWN` 0.10 | `UNKNOWN` / 0.10 |
| freshness | fresh re-perception, generation 5 | generation 3 → 5 | generation 8 |
| effect | `ACTION_NO_EFFECT` (scroll, 0px) | **real** `URL_NAVIGATION_OBSERVED` | `ACTION_NO_EFFECT` ×3 |
| verifier | **MATCH** — `"Observed page identity LISTING at confidence 0.99 is one of the declared roles [LISTING]."` | **MISMATCH** — `"destination not confirmed (MISMATCH): Observed page identity LOGIN at confidence 0.99 is not one of the declared roles [LISTING]."` | **UNKNOWN** (no MATCH line emitted) |
| subgoal `sg1` | **COMPLETED** | `IN_PROGRESS` | `FAILED` |
| `lastActionResult.success` | **`false`** | **`true`** — the only true in the set, and it is a *real* effect | **`false`** |
| `lastActionResult.error` | `ACTION_NO_EFFECT (destination already satisfied per verifier)` | — | `Scroll down produced zero viewport movement (scrollDelta: 0px)…` |
| `completedSteps` | `[]` | `["click: Click element btn-signin"]` | `[]` |
| `failureHistory` | `[]` | `[]` | `["ACTION_NO_EFFECT","ACTION_NO_EFFECT","ACTION_NO_EFFECT","RECOVERY_EXHAUSTED"]` |
| `goalStatus` | `FAILED` | `FAILED` | `FAILED` |

`success: true` appears exactly once across the three runs and is accompanied by a
non-empty `completedSteps` and an empty failure history — the same pairing W31 asserts is
*absent* on the no-effect path. That is what makes A and C meaningful rather than the
loop simply always reporting failure.

B also carries the MISMATCH evidence: the destination subgoal stayed `IN_PROGRESS` while
the run ended `FAILED`, and the pre-existing Step 10 audit capture
`case_D_run3.json` shows the same MISMATCH on a no-effect step. The exact
"no-effect **and** MISMATCH **and** recorded `success:false`" triple is directly observed
in C, where the verdict is UNKNOWN rather than MISMATCH.

---

## 6. Files

* changed: `tests/destinationPropagationAndAlreadySatisfied.test.ts` (test-only, +~120 lines)
* harnesses: `scratch/step10_egress_capture.mjs`, `scratch/step10_mutation_matrix.mjs`
* evidence: `docs/evidence/post-17-10/audit/step10_1_*.json`, `mutation_matrix.json`,
  `mutation_matrix_pre_step10_1.json`
* **no production file changed**
