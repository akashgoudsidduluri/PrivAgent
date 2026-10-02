# POST-17.10 Step 9 — Real Destination Arrival / Navigation Heuristic Audit

**Date:** 2026-10-01
**Type:** navigation audit + narrowly-scoped hardening + mutation-infrastructure safety.
**Steps 5–8 evidence in this directory is retained and not superseded.**

> **Read this first.** The audit found the real cause, and it is **not** a destination-verifier problem. It is
> that *the reasoner was never told the destination, and the deterministic action-selection layer was not wired
> at all*. One narrow fix was justified and is proven end to end in a real browser with **zero provider calls**.
> The canonical **role-only** prompt is still `NOT_PROVEN` end to end — it remains gated on the reasoner, and I
> did not fabricate a URL to make it pass.

---

## PHASE 1 — The data-flow trace, measured

Every step below is measured, not inferred. The evidence is
[`step9_navigation_audit.json`](./step9_navigation_audit.json), captured live from the service worker.

| | Question | Answer | How it was established |
|---|---|---|---|
| **A** | Destination declaration produced? | `DECLARED{ role: [LISTING], entryUrl: http://localhost:4174/ }` | Step 8, plus live capture |
| **B** | Destination subgoal created? | `sg1 NAVIGATE / DESTINATION_VERIFIED / READY` | Step 8, plus live capture |
| **C** | Subgoal selected? | **Yes** — `[AgentTrace] subgoal selected` | live console capture |
| **D** | Action generated? | `{action:'navigate', url:'http://localhost:4174/search.html'}` (implicit; the run reached that URL) | live run |
| **E** | Why that action? | The reasoner chose it | live network capture of the reasoner exchange |
| **F** | Which layer chose it? | **The reasoner.** No deterministic navigator was reachable at all | code audit + capture |
| **G** | Where was the destination lost? | **At the reasoner boundary** | captured egress payload |

### The decisive capture

The extension's egress payload to the backend is captured verbatim from the service worker:

```json
{ "task": "open the store catalog at http://localhost:4174",
  "context": { "url": "http://localhost:4174/", ... },
  "previousActions": [...] }
```

**The typed declaration (`role: LISTING`), the active subgoal, and its description are all absent.** The
provider receives only the raw task string, the sanitized page context, and action history.

### Three structural facts from the code audit

1. **`OneActionPlanner.proposeSubgoalAction` had ZERO production callers.** It exists only in one test. 100% of
   actions came from the reasoner.
2. **It returned `null` for any NAVIGATE subgoal by construction** — it only handles `SEARCH` + `targetEntity`.
   So a destination subgoal could only ever be "reached" by whatever URL the model guessed.
3. **The system prompt then forbids the model from fixing it.** `backend/app/reasoner.py` rule 6:
   *"navigate is STRICTLY for loading a full new external URL… NEVER use navigate to move around or view
   content within the current page."* On `http://localhost:4174/` the model therefore went to `/search.html` —
   a reachable internal page — and the correctly-strict verifier refused to complete.

---

## PHASE 2 — Root cause

**Primary: R1 — destination information lost**, compounded by **R2/R4 — the deterministic action-selection layer
is not wired**, and **R7 — the reasoner produced the wrong navigation as a consequence**.

It is **not** R3 (target resolution was correct: `http://localhost:4174/`), **not** R5 (execution worked), **not**
R6 (recovery did not override anything), **not** R8 (the fixture served `/results.html` correctly at `LISTING
@ 0.99` when asked).

### A separate, pre-existing failure mode found during the audit

A real run failed at the *first* provider call, before any navigation:

```
{"success": false, "reason": "Reasoning unavailable: Model-emitted reason rejected by
 text-safety scan (rule=person_name).", "error_kind": "invalid_action", "retryable": false}
```

This is the **documented prose-embedded-PII tradeoff** in `backend/app/text_safety.py` (a `reason` that does not
start with an action verb and contains a TitleCase token is over-blocked). It is a pre-existing P1, explicitly
out of scope here, and it is **reported separately, not fixed**.

---

## PHASE 3 — The one justified fix

```ts
OneActionPlanner.proposeDestinationNavigation(subgoal)
```

Fires **only** when the subgoal carries a DECLARED destination that includes an explicit `url`, and proposes it
verbatim. The loop consults it before the provider.

### Its limits are the point

| Limit | Why |
|---|---|
| **Role-only declaration ⇒ `null`** | A semantic destination has **no URL**. Producing one would be a fabrication and a fixture special-case. Reaching a LISTING page is a *discovery* problem. |
| **`entryUrl` is never used** | The entry site is where the browser *starts*; using it as a destination is exactly the conflation Steps 5–8 removed. |
| **No normalization, no query/fragment** | The verifier later compares origin+path exactly; proposing anything else would make arrival unverifiable. |
| **It proposes an action, never an arrival** | Completion remains `verifyDestination`'s exclusive decision on a fresh observation. |
| **It still passes every gate** | M5 → security critic → privacy → safety review → containment → effect verification, exactly like a model action. |

---

## PHASE 4 — Tests

`tests/destinationNavigationIntent.test.ts` — **34/34**, covering W1–W18.

The most important tests are the **negatives**: W2c/W15 prove a role-only destination yields **no** deterministic
navigation, and W10a–W10e prove it stays `null` even when the subgoal carries a `targetEntity`, a model-proposed
`suggestedAction.url`, or `executionSuccess`.

---

## PHASE 5 — Mutation testing

`scratch/mutation_destination_navigation_intent.mjs` — **12/12 killed, 0 survived, 0 invalid.**

| | Mutant | Killed by |
|---|---|---|
| M1 | drop the destination from the proposal input | 6 failed |
| M2 | replace the declared destination with the current URL | 4 failed |
| M3 | fabricate a URL from `targetEntity` | 1 failed |
| M4 | derive the destination from the observed page type | 48 failed |
| M5 | derive the destination from a model-proposed action | 1 failed |
| M6 | treat `targetEntity` as the declaration | 2 failed |
| M7 | complete on UNKNOWN | 17 failed |
| M8 | complete on MISMATCH | 14 failed |
| M9 | complete from `executionSuccess` alone | 3 failed |
| M10 | complete from affordance existence | 35 failed |
| M11 | complete from a stale observation | 5 failed |
| M12 | let recovery overwrite the declaration | 4 failed |

**M3 and M5 survived the first run.** Both were **test gaps, not equivalent mutants**: their predicates require
a declaration that is DECLARED but carries **no `url`** (a role-only destination) *combined with*
`targetEntity` / `suggestedAction`. No test constructed that combination, so neither could fire. Tests
**W10a–W10e** now do, and both die.

### All suites

| Suite | Result |
|---|---|
| `mutation_destination_navigation_intent.mjs` (new) | **12/12** |
| `mutation_classification_destination_gap.mjs` | 14/14 |
| `mutation_destination_producer_wiring.mjs` | 14/14 |
| `mutation_destination_entry_url.mjs` | 11/11 |
| `mutation_destination_verifier.mjs` | 12/12 |
| `mutation_destination_normalizer.mjs` | 14/15 (1 genuinely equivalent survivor, unchanged since Step 4) |
| **Total** | **77/78** |

---

## PHASE 8 — MUTATION RUNNER SAFETY

**Step 8's brief said "DO NOT ASSUME THAT IS ENOUGH." It was right to.** Proving it exposed two real defects
that the earlier signal handlers would never have caught.

### Defect 1 — the signal handlers were dead code

`mutation_runner_safety_test.mjs` TEST B initially **FAILED**: a SIGTERM delivered mid-suite was never acted
on. Root cause: the runner used **`spawnSync`**, which **blocks the event loop**, so a signal is queued and
never dispatched until the synchronous child has already exited. The runner then had to be SIGKILLed 30s later,
by which time production source carried a live mutant.

**Fixed:** the runner now uses async `spawn` + `await`. TEST B passes (exit code 130, source clean).

### Defect 2 — the durable backup did not survive a kill

SIGKILL cannot be trapped by *any* process. An earlier version deleted the backup inside every `restoreAll()`,
so it existed only during the milliseconds a single mutant was applied. TEST C caught exactly this: residue
**and** no backup. **Fixed:** the backup now persists for the whole run and is removed once, on graceful
completion. `scratch/mutation_restore.mjs` recovers residue on demand, and any runner auto-recovers on start.

### The safety results

| Test | Result |
|---|---|
| **A** — normal run leaves source clean | PASS |
| **B** — SIGTERM mid-mutation auto-restores | PASS (`exit=130`, byte-identical) |
| **C** — SIGKILL (untrappable): durable backup survives | PASS |
| **C** — `mutation_restore.mjs` recovers byte-identical source | PASS (residue confirmed present before restore) |
| **D** — sequential runs leave no residue | PASS |
| **E** — a subsequent run auto-recovers prior residue | PASS |
| **FINAL** — production source byte-identical to clean baseline | PASS |

**8 passed, 0 failed.**

### Honest residual limitation

For SIGKILL/SIGABRT, "restore automatically" is **impossible** — no handler can run. What is proven is that the
residue is **durable-recoverable** by a separate process and self-healing on the next run. During this work the
harness was itself killed by the 180s command timeout **while restoring**, twice, leaving live mutants in
production source. Both were detected by the focused suites, repaired, and every number in this report is from
after the repair. A purpose-built fast runner (`mutation_safety_probe.mjs`) now exists so the safety harness
finishes inside the command timeout — the first two attempts did not, which is why an over-long safety test is
treated here as a safety test that never reports.

---

## PHASE 6/7 — Real Chrome

Production extension, rebuilt and loaded unpacked; real configured reasoner; no scripted proposer.

### The case the fix addresses — explicit destination URL

**Task:** `open http://localhost:4174/results.html and buy the first product listed`
**Category:** `ECOMMERCE_SEARCH` · **Declaration:** `DECLARED{ url: /results.html }`
**Target tab `1045789804` provisioned by production `targetResolver`**

```
subgoal selected
destination navigation proposed deterministically        ← Step 9 fix, real browser
action validated by M5
security critic → privacy policy → safety review
containment decision → executeAction
ACTION_EXECUTED + ACTION_NO_EFFECT
recovery decision → M6 failed → terminal
```

**`providerCalls: 0`.** The reasoner was **never consulted** — the deterministic navigator produced the action.

**Agent-directed real observation:**

| | |
|---|---|
| Observed URL | `http://localhost:4174/results.html` |
| pageType | **`LISTING`** |
| confidence | **`0.99`** |
| pageGeneration | `3` |
| agentDirected | **`true`** |

Production decision on that real observation: **satisfied**.

**But the subgoal did not complete**, and this must not be glossed over: Effect Verification reported
`ACTION_NO_EFFECT`, because the tab was **already at `/results.html`** — the target resolver provisioned it
there, and the deterministic action navigated to the same URL, so nothing changed. The run went to recovery and
terminated, and the completion line and an in-browser verifier verdict were **never reached**.

### The canonical role-only prompt — unchanged and still not proven

**Task:** `open the store catalog at http://localhost:4174` · **Category:** `GENERIC_INTERACTION`
`providerConsulted: true`, `deterministicNavigation: false` — correctly, because there is no URL to propose.
The run failed at the first provider call on the documented `person_name` text-safety rejection.
**Destination verifier: `NOT_REACHED`.**

### Phase 7 failure controls, on real observations

| Control | Result |
|---|---|
| Agent reached `/search.html` (UNKNOWN 0.10), declared destination URL | **MISMATCH** |
| Agent reached UNKNOWN page, declared **role** LISTING | **UNKNOWN** (not MATCH) |
| Agent reached wrong page type | **not completed** |
| Correct page type, **stale** generation | **UNKNOWN** |
| Correct URL, **stale** generation | **UNKNOWN** |
| Explicit wrong destination URL `/` vs real `/results.html` | **MISMATCH** |
| Correct destination, fresh observation | **MATCH** |

---

## Evidence classification

### PROVEN_REAL
- The reasoner never receives the destination declaration — captured verbatim from the service worker.
- The deterministic navigator fired in a real browser with **zero provider calls**, and the real agent-directed
  observation of that run is the declared destination at **`LISTING @ 0.99`**.
- The full gate chain (M5 → security critic → privacy → safety review → containment → effect verification) ran
  unchanged on the deterministic proposal.
- Real perception: `/results.html` → `LISTING @ 0.99`; `/` and `/search.html` → `UNKNOWN @ 0.10`.
- The backend rejected a model-emitted `reason` under `person_name` — the documented prose-PII tradeoff.

### PROVEN_TEST
- 307/307 focused destination + planning; 158/158 security/privacy; **130 files / 2041 tests** full regression;
  `tsc`, both builds, `git diff --check` PASS.
- Mutation **77/78**, 1 genuinely equivalent survivor, 0 invalid.
- Mutation-runner safety **8/8**, including SIGTERM and untrappable SIGKILL.

### CONTROLLED_FIXTURE_PROVEN
- The Phase 7 controls computed in Node over real observations. Real data, deterministic harness.

### NOT_PROVEN
- **The canonical role-only prompt arriving at the catalog end to end.** It is gated on the reasoner, which is
  not told the destination, and which separately fails the `person_name` prose gate.
- **An in-browser destination subgoal `COMPLETED`** — Effect Verification reported `ACTION_NO_EFFECT` because the
  tab already held the destination URL.
- **An in-browser verifier verdict** (`MATCH`) on either prompt.
- **Authoritative Goal Verification succeeding** — runs ended in `M6 failed → terminal progress emitted`.

### KNOWN_LIMITATION
- The service worker exposes no planner read-out; the production subgoal record comes from `[AgentTrace]`
  console output whose structured arguments render as `"Object"`.
- A **role-only** destination has no URL. Deterministic navigation cannot help, and fabricating one is
  forbidden. Fixing it requires giving the reasoner the destination — a backend prompt/schema change, which this
  step is explicitly gated from doing.
- The **`person_name` prose-PII rejection** remains open and is a separate pre-18 work item. It remains visible
  here, as instructed.
- SIGKILL/SIGABRT cannot auto-restore; that residue is durable-recoverable, not impossible.

---

## Production changes

`oneActionPlanner.ts` (new `proposeDestinationNavigation`), `agentLoop.ts` (consult it before the provider —
**32 insertions**, the only change to a file that has been untouched since `b677654` in every prior step).
`taskDecomposer.ts`, `hierarchicalTypes.ts`, `goalProgressTracker.ts`, `destinationNormalizer.ts`,
`destinationVerifier.ts` have **no Step 9 semantic change**.

**Security authorities unchanged versus `b677654`:** `containment`, `groundingEngine`, `privacyPolicy`,
`recoveryEngine`, `riskEngine`, `securityCritic`, `privacyDecision`, `goalVerifier`, `targetResolver`, backend.
No provider egress added. `goalVerifier`, `targetResolver` and the backend still carry pre-existing uncommitted
work from earlier tasks.

Nothing was committed or pushed.