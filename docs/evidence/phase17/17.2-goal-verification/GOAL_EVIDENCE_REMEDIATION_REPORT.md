# PHASE 17.2A — GOAL EVIDENCE FABRICATION REMEDIATION REPORT

**Scope:** remove every path by which goal verification could establish `SUCCESS`
from action history, action counts, `executionSuccess` / dispatch success,
requested action parameters (`action.url`, `action.text`, `action.target`), or
model claims.

**Status:** implementation complete, **not committed, not pushed**, awaiting review.

**Baseline:** `4fb476f` (Phase 17.1 approved and pushed). All 17.2A work is
uncommitted on `main`.

**Two invariants, stated once and enforced everywhere below:**

```
ACTION REQUEST   != OBSERVED RESULT
DISPATCH SUCCESS != GOAL SUCCESS
```

---

## 0. Executive summary

| | |
|---|---|
| Fabrication paths removed | **9** (7 in `goalVerifier.ts`, 1 in `agentLoop.ts`, 1 in `planStateMachine.ts`) |
| Production files changed | **4** |
| Test files changed | **5** |
| Test files added | **1** (`tests/phase17/goalEvidenceFabrication.test.ts`, 21 tests) |
| Lines added / removed (tracked) | **+292 / −102** |
| New files (untracked) | 3 — 473 + 238 + 139 lines |
| Full regression | **1339 / 1339 passing, 107 files** (baseline 1318 / 106) |
| `tsc -b --noEmit` | **5 errors, all pre-existing** in `targetResolver.ts`; **0 new** |
| `build:extension` / `build:frontend` | both **pass** |
| Mutation checks | **4 / 4 caught** (M1, M2, M3 required; M4 added for a newly-found site) |
| Real-Chrome proof | **3 / 3 cases pass** |
| Remaining fabrication paths | **0** |
| Security authorities modified | **0** |

Phase 17.2 proper is **not** started, per instruction.

---

## 1. Audit findings

The committed 17.2 audit
(`docs/evidence/phase17/17.2-goal-verification/GOAL_VERIFICATION_AUDIT.md`)
classified every input goal verification consumes. That classification held up
and is reproduced here unchanged, because it is the contract this remediation
enforces:

| Signal | Class | Disposition |
|---|---|---|
| `context.url`, `state.currentUrl`, `state.steps[].url` | **AUTHORITATIVE OBSERVATION** | kept |
| `context.detections`, `viewport`, `observedScrollY`, `pageType` (semantic) | **AUTHORITATIVE OBSERVATION** | kept |
| `state.taskConstraints` (the user's own words) | **AUTHORITATIVE** | kept |
| `state.previousActions` (7 read sites) | **FABRICATED** | **removed** |
| `state.steps[].executionSuccess` (3 read sites) | **FABRICATED** | **removed** |
| `state.steps[].navigationDestination` (= `action.url`) | **FABRICATED** | **removed** |
| `state.visitedElementIds` (populated from `action.target`) | **FABRICATED** | **removed** |
| model `reason` / claims | **FABRICATED** | never read (verified) |
| zero / fallback viewport defaults | **FABRICATED** | now fails closed |

### The single-call-point finding

`verifyTaskGoal` has exactly **one** production caller —
`AgentLoop.isTaskGoalSatisfied` (`agentLoop.ts:2393`) — and that method is a
**verifier only**: it reads, sets `state.goalStatus`, and returns a boolean. It
does not authorize, does not gate, and does not bypass M5, the Security Critic,
Grounding, Risk, Effect Verification or Containment. This was verified, not
assumed, and it is the reason a nine-site remediation is a complete one for the
verifier module.

The audit's own blind spot, found during implementation, is recorded in §2.9.

---

## 2. Every removed fabrication path

Nine sites. Each entry states what fabricated the success and what authoritative
observation replaced it.

### 2.1 Banking / transaction history — the named case (`goalVerifier.ts`)

**Before** (`goalVerifier.ts:636-641` at HEAD):

```ts
if (state.previousActions.length >= 3 && hasClicked && hasScrolled) {
  return {
    satisfied: true,
    status: 'SUCCESS',
    reason: 'Navigated to and verified recent account transaction history.'
  };
}
```

Three dispatched actions were reported as verification of transaction history,
and the reason string described evidence that did not exist.

**After:** a detection naming a ledger/statement surface in the **current
perception** (`transaction` / `ledger` / `statement` across
`id + selector + label + type`). Otherwise fail closed.

### 2.2 Account number / `account_number` — removed conjuncts

`executionSuccess && hasClicked` and `state.visitedElementIds.includes(...)` were
both deleted. `visitedElementIds` is populated from `action.target` — it records
what the agent **asked** to click.

**After:** unconditional `satisfied: false`. See §9.1 for why no authoritative
observation exists for this goal today.

### 2.3 Account details — pure click counter

Any dispatched click returned `'Account details view opened.'`

**After:** the **observed** URL must contain `detail` or `transaction`.
`state.pageType === 'banking'` is deliberately **not** accepted — that classifies
the *site*, not the *view*; being anywhere on a banking portal must not claim a
particular pane is displayed.

### 2.4 Google search — dispatch fallback

A dispatched `type` + `click`/`navigate` was treated as a search.

**After:** the observed `q=` in the live results URL is the only evidence.

### 2.5 Login — attempt vs. outcome

`hasTyped` / `hasClickedSubmit` deleted.

**After:** the **observed** URL transition away from `/login`. Removing the
conjuncts is also strictly *less* brittle: a login whose actions were not
recorded still verifies on its observed outcome.

### 2.6 Shopping product detail — `previousActions` click conjunct

Deleted. Required now: observed detail URL **and** `qualifying.length > 0`, where
qualifying candidates are rebuilt from `context.detections`, never from history.

### 2.7 Research / long-horizon — `executionSuccess` + `navigationDestination`

Both were admitted into the "pages actually reached" set. A navigation that was
dispatched, returned without error, and **never committed** could certify a
research goal from a page the browser was never on.

**After:** `step.url` alone.

### 2.8 `agentLoop.ts` — requested URL written back as the observed URL

```ts
advancePageGeneration(this.state, action.url);   // before
advancePageGeneration(this.state);               // after
```

`advancePageGeneration(state, newUrl)` assigns `state.currentUrl = newUrl`, and
goal verification reads `context.url || state.currentUrl`. A requested
destination was therefore being stored in the field that holds the **observed**
tab URL. `onNavigationComplete` settling proves the injection/load handshake
completed — transport state, not the tab's location. The observed URL is now
picked up from the next real perception cycle.

### 2.9 `planStateMachine.ts` / `agentLoop.ts` — the site the audit did not reach

**Found during implementation, not in the original audit.**

`SubgoalGraph.completeSubgoal()` is called on `execResult.success`, and the loop
then OR'd the resulting `allDone` in as an **alternative** to goal verification:

```ts
const allDone = this.subgoalGraph?.isAllCompleted() ?? false;
if (allDone || this.isTaskGoalSatisfied(task, this.state, context)) {
  this.planStateMachine.registerGoalVerification(true, true);
  this.state.planningEngineState = this.planStateMachine.getState();
}
```

"Every planned subgoal was dispatched" was sufficient to drive the plan state
machine to `COMPLETED` with the reason **`'Goal verified and satisfied'`** — a
goal claim no observation ever made, published as `state.planningEngineState`.
The state machine emitted that same reason for both causes, so the dispatch
cause announced a verification.

**After:** only the goal verifier may assert goal satisfaction. Subgoal dispatch
completion is still recorded, as planning progress (`allSubgoalsDone`), never as
`goalSatisfied`; and the state machine names the two causes separately.

### 2.10 What was NOT touched

`securityCritic.ts`, `injectionFirewall.ts`, `containment.ts`,
`rawValueScanner.ts`, `harness.ts`, the risk engine, M5 validation,
`agentBridge.ts`'s outbound allowlist, `effectVerifier.ts`, and
`docs/evidence/phase16*/`. **Zero changes** to any security authority.

---

## 3. Before / after evidence flow

### Before

```
previousActions / step.executionSuccess / step.navigationDestination /
visitedElementIds / model reason / pageType=='banking'
        │
        │  (all four treated alike)
        ▼
  verifyTaskGoal ──► satisfied: true, status: 'SUCCESS'
        │
        │  reason string ASSERTS evidence that was never observed
        ▼
  isTaskGoalSatisfied ──► goalStatus = 'SUCCESS' ──► loop terminates
```

### After

```
AUTHORITATIVE (observed)                NON-AUTHORITATIVE (kept, non-evidentiary)
─────────────────────────────────────   ──────────────────────────────────────────
context.url / state.currentUrl          previousActions   → reasoner history only
state.steps[].url                       step.executionSuccess → diagnostics only
context.detections                      navigationDestination → never read
context.viewport                        visitedElementIds → never read
observedScrollY                         model reason      → never read
state.taskConstraints (user's words)
        │
        ▼
  verifyTaskGoal ──► satisfied: false, status: 'IN_PROGRESS'  (fail closed)
```

`previousActions` remains in `AgentTaskState` as **telemetry / planning
context** — it is snapshotted (`:392`), reset (`:411`), and passed to the
reasoner as action history (`:1132`, `:2357`). It is never evidence that a goal
state exists.

---

## 4. Tests proving action history is not evidence

`tests/phase17/goalEvidenceFabrication.test.ts`, describe **A** and **B**:

- **A.1** an arbitrarily long click history (20 dispatched actions) satisfies
  none of `open the account details`, `find the account number field`,
  `show my recent transactions`.
- **A.2** a typed value is not observed content.
- **B.1** the **exact** pre-17.2A condition — `previousActions: [click, click, scroll]`,
  `pageType: 'banking'` — now returns `satisfied: false`, `IN_PROGRESS`.
- **B.2** the *positive control*: the same goal succeeds from an **observed**
  ledger detection, and **also succeeds with no action history at all**. That
  second assertion is the proof that the history was never the evidence.
- **B.3** an account-details goal needs the observed details surface, not a click.
- **B.4** a banking **portal** page alone does not prove a details **view**.

## 5. Tests proving requested parameters are not evidence

Describe **C** and **E**:

- **C.1** `action.url` cannot establish navigation success for a genuine
  multi-page research goal.
- **C.2** a REQUESTED url is not an OBSERVED page even when dispatch succeeded.
- **C.3** *(positive control, same task, same fixture)* three **observed** item
  URLs **do** verify — the only difference between C.1/C.2 and C.3 is whether the
  urls are observed or merely requested.
- **E.1** `advancePageGeneration` never overwrites the observed URL with a request.
- **E.2** an unsatisfied navigation goal is unaffected by a settled handshake.
- **E.3** *loop-level*: a **redirected** navigation. The reasoner requests
  `/results?q=cats`, the navigation is dispatched and the load handshake settles,
  but the site lands the tab on `/consent-notice`. The request really was made
  (`executeAction` and `onNavigationComplete` both asserted called) and it bought
  nothing: `currentUrl !== REQUESTED`, status and goalStatus both not `SUCCESS`.
- **E.4** *loop-level*: an **UNAVAILABLE** url cannot be backfilled from a
  requested destination. When the browser reports no URL for a cycle,
  `AgentLoop` keeps the previous `state.currentUrl` and goal verification falls
  back to it — so a requested destination written into that field becomes the
  *last observation of the page*. This is the case that actually catches M2.

> **Test-design note.** The first draft of C.1–C.3 used a task string the
> verifier never recognises as a research goal, so it returned
> `satisfied: false` for an uninteresting reason and proved nothing. Both
> vacuous cases were rewritten onto a task shape the verifier genuinely claims,
> and a positive control was added to the same describe. Every "must fail" case
> in this file now has a paired "does succeed from observation" case.

## 6. Tests proving dispatch success is not goal success

Describe **C/D** and the second-location describe:

- **D.1** every step dispatched without error (`executionSuccess: true` × 3) and
  the goal is still unmet.
- **D.2** the plan state machine: a subgoal DAG completed by dispatch does **not**
  set `goalSatisfied`, and the transition reason no longer matches
  `/goal verified and satisfied/i`.
- **D.3** *(positive control)* an observed, verified goal is still reported
  satisfied, state `COMPLETED`.

Plus the real-Chrome case 2 in §8, where the navigation genuinely failed
(`chrome-error://chromewebdata/`) and the requested URL was supplied anyway.

---

## 7. Mutation results

Harness: `scratch/mut17_2a.mjs`. Every anchor must match **exactly once** or the
script aborts before touching a file; `restore` puts every file back
byte-for-byte.

```
node scratch/mut17_2a.mjs apply  M1|M2|M3|M4
node scratch/mut17_2a.mjs restore M1|M2|M3|M4
```

| # | Fabrication reintroduced | Site | Result |
|---|---|---|---|
| **M1** | `previousActions.length >= 3 && hasClicked && hasScrolled` → SUCCESS (the original banking fabrication) | `goalVerifier.ts` | **CAUGHT — 4 tests fail** |
| **M2** | `advancePageGeneration(this.state, action.url)` | `agentLoop.ts` | **CAUGHT — 1 test fails** |
| **M3** | `state.steps.every(s => s.executionSuccess)` → SUCCESS | `goalVerifier.ts` | **CAUGHT — 4 tests fail** |
| **M4** | `allDone \|\| goalVerified` + the merged `'Goal verified and satisfied'` reason (both sites, as it originally existed) | `agentLoop.ts` + `planStateMachine.ts` | **CAUGHT — 1 test fails** |

M1 failures:
- `17.2A-B > the exact fabricated triple that used to verify now fails closed`
- `17.2A-F/G > a model "reason" string asserting completion changes nothing`
- `17.2A-H/I > an empty perception with a full action history is not success`
- `agentLoop.test.ts > 1 & 3. executes a multi-step task to SUCCESS …`

M2 failure — and it is the *right* failure, not string matching:
```
AssertionError: expected 'http://localhost:4173/results?q=cats'
                not to be 'http://localhost:4173/results?q=cats'
```

M3 failures: three in `17.2A-C/D` plus
`phase9LongHorizon.test.ts > 19. a long research goal is satisfied only once
every requested item is OBSERVED` — a **pre-existing** test that already pins
this invariant.

M4 failure:
```
AssertionError: expected 'Goal verified and satisfied'
                not to match /goal verified and satisfied/i
```

**Coverage caveat, stated plainly.** M2 and M3 are caught by behavioural
assertions — an observed URL and an observed `q=`. M1 and M4 are caught by both
behavioural assertions and one reason-string assertion. The single M4 assertion
is a string match on the transition reason; the behavioural guarantee behind it
is `context.goalSatisfied === false`. The loop-level `allDone ||` disjunct on
its own has **no externally observable effect** today (both disjuncts end in
`COMPLETED`), so it is covered by the state-machine half of the M4 mutation
rather than by a loop-level assertion. That is a real limit of the coverage and
is recorded here rather than papered over.

---

## 8. Real-Chrome result

Harness: `scratch/verify_phase17_2a_goal_evidence.mjs`.
Evidence: `docs/evidence/phase17/17.2-goal-verification/real_chrome_evidence.json`.

**Substrate — stated up front so the result is not over-read:**

- **REAL:** headless Chrome via CDP, the built MV3 extension
  (`Extensions.loadUnpacked` on `dist/`, id `ihbbhmifbgfcibhjhcafakdkcppkccaf`),
  the service worker, the content script, and the page state read back out of the
  live tab.
-**NOT REAL — the decision.** The production `verifyTaskGoal` cannot be invoked
inside the service worker: it is bundled and not exported there. The decision is
made by importing the **identical production module**
  (`extension/src/agent/goalVerifier.ts`, the file the bundle is built from) in
  Node and feeding it observations captured from Chrome in the same run.

This is a **hybrid**, and is reported as one: the observation half is real-browser
proved; the decision half is proved against those real observations. It is not a
claim that the goal verdict was produced inside Chrome.

| Case | Real browser did | Verdict |
|---|---|---|
| **1** action request alone | tab genuinely at `http://localhost:4220/`, 25 DOM nodes, **no** transaction marker | `satisfied: false`, `IN_PROGRESS` — with a full `previousActions`, three `executionSuccess: true` steps, `visitedElementIds`, and a model reason claiming the details view is open |
| **2** failed navigation | requested `http://localhost:9/results?q=cats`; origin refused the connection; tab landed on **`chrome-error://chromewebdata/`** | `satisfied: false`, `IN_PROGRESS` — the requested `?q=cats` was supplied as both `action.url` and `navigationDestination` |
| **3** observed success | tab genuinely at `http://localhost:4220/results?q=cats`, result marker present | **`satisfied: true`**, `SUCCESS` — *"Search goal verified against observed results URL: query 'cats' present at 'localhost'."* |

**3 / 3 pass.**

**Limitation recorded, not worked around.** The verifier cannot express the
required distinction *cleanly* in case 2, and this is a contract limitation, not
an implementation one. `GoalVerificationResult` has no `UNVERIFIABLE` state
(§9.1), so "the navigation failed" and "we have not looked yet" both surface as
`satisfied: false, IN_PROGRESS`. The remediation asserts the strongest fail-closed
behaviour the existing contract supports; it does not invent a way to say
"unverifiable" that the type does not carry. See §10.

---

## 9. Remaining provenance gaps

**None of these were silently fixed.** They are prerequisites for 17.2 proper.

### 9.1 `GoalVerificationResult` has only `satisfied: boolean`

No `UNVERIFIABLE`. The three-state contract required for
`VERIFIED_SUCCESS` / `VERIFIED_FAILURE` / `UNVERIFIABLE` does not exist, and
redesigning it is explicitly out of scope for 17.2A. Every regression test here
therefore asserts the strongest available fail-closed behaviour —
`satisfied === false` with `status === 'IN_PROGRESS'` — which means "not yet",
**not** "definitely not met". A goal that can never be satisfied (see 9.2) and a
goal that is merely unmet are currently indistinguishable.

### 9.2 `AgentDetection` has no focus/opened signal

Consequence: the "find and click the account number field" goal has **no**
authoritative observation available, so it now fails closed unconditionally
(§2.2). That is correct under the invariant, and it is a real capability
regression, deliberately accepted: inventing a focus flag here would fabricate
exactly the evidence this remediation exists to remove. 17.2 proper needs a
DOM/text goal type that can read whether the field is actually open.

### 9.3 `context.url` has no `observedAt` and no document identity

The verifier cannot tell a URL observed just now from one carried over from a
previous page generation, and cannot bind a verdict to a document. This is what
makes §5/E.4 (unavailable URL falling back to `state.currentUrl`) a real
residual risk rather than a hypothetical.

### 9.4 `MultimodalPerceptionInput.tabId` is optional

Visual observations cannot be bound to a specific tab, so they cannot be
attributed to a page generation.

### 9.5 `screenshotCapture.ts` records no source tab

**Screenshot source tab provenance is currently insufficient.** A captured
image carries no tab identity and no page generation, so a screenshot cannot be
proven to depict the page whose goal is being verified. Per instruction, no
attempt was made to make current visual evidence *stronger* merely because the
field is missing. The broader fix belongs to 17.2.

### 9.6 Transaction success proves a surface, not rows

The banking branch proves a ledger/statement surface is **observed**. The
sanitized context carries no row content, so "rows are loaded" is not proven.
This is strictly stronger than the removed fabrication and strictly weaker than
the goal's actual intent — the text/content goal type in 17.2 proper closes it.

### 9.7 `evaluateExecutionConfidence` consumes `executionSuccess` counts

`agentLoop.ts:1266` computes `previousSuccessCount` from
`state.steps[].executionSuccess` and feeds `evaluateExecutionConfidence`. This
is **not** a goal-verification path and cannot establish SUCCESS — it can only
influence a BLOCK-or-proceed confidence directive downstream of the risk engine.
It is recorded here because it is the one remaining production consumer of
`executionSuccess` outside telemetry, and because a future confidence-scoring
review should know it exists.

### 9.8 `isTaskGoalSatisfied` uses a dispatch result as a **veto**

`agentLoop.ts:2390` returns `false` early when
`state.lastActionResult && !state.lastActionResult.success`. This is
dispatch-derived, but it can only **withhold** success, never create it. It is
conservative and was deliberately left in place.

---

## 10. Explicit prerequisites for Phase 17.2 proper

Ordered by what unblocks the most.

1. **Three-state `GoalVerificationResult`.** `VERIFIED_SUCCESS` /
   `VERIFIED_FAILURE` / `UNVERIFIABLE`, so "unmet" and "unverifiable" stop
   being the same value. Unblocks §9.1, §9.2 and the real-Chrome limitation in §8.
2. **Observation identity on the goal context.** `observedAt` + page generation
   + document identity on `context.url`, so a verdict is bound to a specific
   observed document. Unblocks §9.3, and the residual fallback risk in §9.8/E.4.
3. **A DOM/text goal type.** Replaces the now-permanently-failing
   account-number goal (§9.2) and upgrades transaction success from
   "surface observed" to "content observed" (§9.6).
4. **Focus/opened signal on `AgentDetection`** (or an equivalent DOM state
   read), so "the field is open" becomes observable rather than inferred.
5. **Screenshot source-tab provenance.** Required `tabId` on
   `MultimodalPerceptionInput` (§9.4) and a recorded source tab +
   page generation in `screenshotCapture.ts` (§9.5). Until then visual evidence
   stays out of goal verification.
6. **A content/focus-aware `agentBridge` observation adapter** for goal
   verification, reading the same live target tab that effect verification
   already reads. Not implemented here, to avoid duplicating Phase 17.1's work.

---

## 11. Validation, exact counts

| Check | Command | Result |
|---|---|---|
| Focused goal-verification | `npx vitest run tests/phase17/goalEvidenceFabrication.test.ts` | **21 / 21**, 1 file |
| Affected Phase 16 tests | `tests/phase16-remediation` | pass |
| Full regression, chunk 1 | 54 files | **692 / 692** |
| Full regression, chunk 2 | 53 files | **647 / 647** |
| **Full regression total** | 107 files | **1339 / 1339** |
| Baseline for comparison | — | 1318 / 1318, 106 files |
| TypeScript | `npx tsc -b --noEmit` | **5 errors**, all pre-existing in `extension/src/background/targetResolver.ts` (lines 285, 287×2, 290, 488). **0 new** |
| Extension build | `npm run build:extension` | **exit 0** |
| Frontend build | `npm run build:frontend` | **exit 0** |
| Mutation tests | `scratch/mut17_2a.mjs` | **4 / 4 caught** |
| Real-Chrome validation | `scratch/verify_phase17_2a_goal_evidence.mjs` | **3 / 3 pass** |

The full suite is run in two bounded chunks because a single `npx vitest run`
exceeds the command timeout in this environment. Chunk boundary is mechanical
(`ls tests/*.test.ts tests/*/*.test.ts | sort | split -l 54`); the two chunks
together are the whole suite.

### Files changed

**Production — 4 files, +136 / −48**

| File | +/− |
|---|---|
| `extension/src/agent/goalVerifier.ts` | +84 / −42 |
| `extension/src/agent/agentLoop.ts` | +31 / −2 |
| `extension/src/agent/agentState.ts` | +10 / −1 |
| `extension/src/hierarchicalPlanning/planStateMachine.ts` | +11 / −3 |

`agentState.ts` is documentation only: the `navigationDestination` JSDoc now
marks it an INTENT and states it is never goal evidence.

**Tests changed — 5 files, +156 / −54**

| File | +/− | Change |
|---|---|---|
| `tests/phase16-remediation/scrollGoalVerification.test.ts` | +18 / −4 | the test literally titled *"still click-based"* was **inverted**: it now asserts `satisfied === false` for a click and `true` for an observed `/transactions` URL |
| `tests/agentLoop.test.ts` | +44 / −13 | fixture's transaction-ledger detection gated behind `step >= 4`; `perceivePage` count 3 → 4. The agent still takes exactly 3 actions. No assertion relaxed — the goal is still proven from an observed surface, just one genuinely absent until the work is done |
| `tests/m7Pipeline.test.ts` | +56 / −33 | `contextAfterDetailsOpened(bool)` helper; the transactions control appears only after the details click |
| `tests/providerRetryBound.test.ts` | +22 / −2 | one test switched to `runTask('search for cats')` with a progress-gated observed URL |
| `tests/providerRegistry.test.ts` | +16 / −2 | `TASK` switched to `'search for cats'` with a progress-gated observed URL |

**Tests added — 1 file, 21 tests, 473 lines:** `tests/phase17/goalEvidenceFabrication.test.ts`

**New files — 3, 850 lines:** the test file above, `scratch/mut17_2a.mjs` (139),
`scratch/verify_phase17_2a_goal_evidence.mjs` (238).

### Tests invalidated because they relied on fabricated evidence

**5 test files changed; 0 tests deleted; 0 assertions removed without replacement.**

Every changed test is documented inline at the point of change with the reason.
In every case the *invariant under test* changed — a test was asserting that
dispatch proves a goal, which is the defect being removed — and in every case an
unrelated assertion in the same test was preserved. `tests/agentLoop.test.ts`
is the clearest example: the fix makes the fixture's ledger detection genuinely
absent until step 4 rather than weakening the expectation.

### Security invariants

Goal verification remains a **verifier only**. This remediation touched no
authorization path. `verifyTaskGoal` still has one caller,
`isTaskGoalSatisfied`, which only sets `state.goalStatus`; it does not
authorize, and does not bypass M5, the Security Critic, Grounding, Risk, Effect
Verification or Containment. No security authority file was modified. The
key invariant — `isTaskGoalSatisfied` (`agentLoop.ts:2389`) sets `goalStatus`
only — is preserved.

---

## 12. STOP condition

Re-searched after implementation, across all of `extension/src`:

| Signal | Can it independently establish SUCCESS? |
|---|---|
| `previousActions` | **NO** — 6 production occurrences remain: 2 writes, 1 reset, 1 snapshot, 2 passes to the reasoner as action history. Zero reads by any goal/success path. |
| requested action parameters (`action.url` → `navigationDestination`) | **NO** — 2 production occurrences remain, both **writes**. Zero reads outside comments. |
| `executionSuccess` / dispatch success | **NO** — remaining reads are failure diagnostics (`:337`), the confidence heuristic (§9.7, BLOCK-only), and writes. The subgoal-DAG path (§2.9) is removed. |
| `visitedElementIds` | **NO** — zero reads in `goalVerifier.ts`; remaining text is a comment naming what was removed. |
| model claims (`reason` strings) | **NO** — never read. |

**ZERO remaining fabrication paths.** `verifyTaskGoal` has exactly one caller and
it is a verifier.

Phase 17.2 proper is **not** started. Nothing is committed. Nothing is pushed.

**Awaiting review.**
