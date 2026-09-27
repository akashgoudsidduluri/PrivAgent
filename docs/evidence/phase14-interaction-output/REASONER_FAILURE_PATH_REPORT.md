# REASONER FAILURE PATH — Forensic Investigation Report

Scope: the real-Chrome `REASONER_FAILED` + `WATCHDOG_TIMEOUT` misdiagnosis observed in the
Phase 14 production build.

**Do not read this report as a Phase 16 plan. It is a bounded defect investigation with a
minimal fix, deterministic tests and a real-Chrome acceptance run.**

Machine-readable evidence: [`reasoner_failure_path_evidence.json`](./reasoner_failure_path_evidence.json)
(produced by `scratch/verify_reasoner_failure_path.mjs`, 8/8 assertions PASS).

---

## 1. ROOT CAUSE

The terminal state was **always correct** (`FAILED` / `TERMINAL` / `REASONER_FAILED`). The
watchdog fired **first** and misattributed a slow-but-legitimate reasoner call to a stalled
perception. Two independent defects combined to produce the observed log.

### Defect A — `projectAgentOutput()` forced `PERCEPTION` for the whole first reasoning call

**File:** `extension/src/agent/agentOutput.ts`
**Function:** `projectAgentOutput()`

The projection applied this rule unconditionally:

```ts
if (steps.length === 0) phase = "PERCEPTION";
```

`steps.length === 0` is true for the *entire* first reasoning call, even after
`planningEngineState` had already advanced to `SUBGOAL_SELECTION`. Every non-final payload of
the first cycle was therefore labelled `PERCEPTION` on the wire, regardless of what the
planning machine was actually doing.

**Evidence:** the diagnostic harness `scratch/forensic_phase14_failure.mjs` captured a live
payload with `phase=PERCEPTION` while `pes=SUBGOAL_SELECTION`
(`scratch/forensic_phase14_failure.json`). The dashboard therefore never received a
`LLM_REASONING` stage at all — the reasoner call was invisible to the watchdog.

**Fix:** the PERCEPTION override now requires a genuinely un-started cycle:

```ts
const planReported =
  typeof planningEngineState === "string" && planningEngineState !== "UNINITIALIZED";
if (isFirstCycle && !planReported) phase = "PERCEPTION";
```

`phaseFromPlanningState()` already mapped `SUBGOAL_SELECTION` → `LLM_REASONING`; the override
was shadowing it.

### Defect B — the watchdog's reasoning grace window was dead code

**File:** `frontend/src/adapters/extensionAdapter.ts`
**Function:** `resetWatchdog()`

The 60-second reasoning grace window was gated on:

```ts
if (this.lastLifecycleStage === "REASONING") { ... }
```

`'REASONING'` is not a `PipelineStage`. The real value is `'LLM_REASONING'`. The comparison could
never be true, so the grace branch was unreachable and the 60s stall threshold applied to a
legitimate long reasoner call.

**Fix:** compare against `'LLM_REASONING'`.

### Defect C (found by a test) — the grace window lagged one payload behind

`resetWatchdog()` was invoked **before** `lastLifecycleStage` was updated, so the watchdog was
armed with the *previous* payload's stage. On the first `LLM_REASONING` payload the old
(`PLANNING`/`PERCEPTION`) stage was still in `lastLifecycleStage`, and the grace window was
missed by exactly one cycle — the shape of the observed failure.

**Fix:** derive the stage first, then arm or clear the watchdog.

### Not the cause (explicitly disproven)

- **Not a refused-connection hang.** Probing the backend from the extension origin returns in
  2 ms: `{"ms":2,"outcome":"threw","message":"Failed to fetch"}` — a fast, decisive network
  failure, not a hang.
- **Not Phase 15 / OCR.** The service worker's `perceivePage` callback never passes an
  `ocrEngine` to `coordinateMultimodalPerception`, so `detectContextualInOcr` never runs in the
  agent loop at all.
- **Not PING/PONG.** Proven independent (Part 6 below); left untouched.

---

## 2. RUNTIME TIMELINE

Captured in real Chrome by `scratch/verify_reasoner_failure_path.mjs` against a local stub
reasoner that accepts the connection and delays 40 s before returning a structured
`503 {"error_kind":"timeout"}` — reproducing the real slow-reasoner condition
deterministically.

| Time (ms) | Event | Phase reported |
|---|---|---|
| ~0 | `START_TASK` received → posted to window → content script → background worker | — |
| 95 | `TASK_PROGRESS` `RUNNING` | `PERCEPTION` (correct: `planReported === false`) |
| 126 | `TASK_PROGRESS` `IN_PROGRESS` | **`PLANNING`** (no longer misreported as `PERCEPTION`) |
| ~126 → 44 700 | Reasoner request in flight (stub holds the connection) | `LLM_REASONING` |
| 44 843 | `FAILED` / `TERMINAL` / `REASONER_FAILED` reaches the dashboard | terminal |
| — | **Watchdog never fired** | — |

The exact chain, end to end:

```
Dashboard RUN
 → extensionAdapter.startTask()                 frontend/src/adapters/extensionAdapter.ts
 → content script START_TASK                    extension/src/content/*
 → service worker                               extension/src/background/serviceWorker.ts
 → AgentLoop start                              extension/src/agent/agentLoop.ts
 → harness cycle 1
 → perceivePage()                               (no ocrEngine passed)
 → PERCEPTION_COMPLETE
 → planningEngineState → SUBGOAL_SELECTION
 → projectAgentOutput()                         extension/src/agent/agentOutput.ts
 → notifyProgress() → sendToDashboard()         extension/src/background/serviceWorker.ts
 → content script → adapter handleExtensionProgress()
 → phaseToPipelineStage() → stage → resetWatchdog()
 → dashboard UI
 → requestActionWithBoundedRetry()             extension/src/agent/agentLoop.ts
 → backendAgentProvider (55000 ms)              extension/src/agent/backendAgentProvider.ts
 → POST http://127.0.0.1:8010/api/v1/agent/action
 → backend 503 error_kind=timeout
 → classifyTerminalReason() → REASONER_FAILED
 → terminal FAILED (emitted exactly once)
 → sendToDashboard() → adapter → terminal state, watchdog cleared
```

---

## 3. PERCEPTION STATUS

**Completed.** Not stuck, at any point.

Evidence:

- `perceptionCompletedBeforeReasoning` — assertion PASS in
  `reasoner_failure_path_evidence.json`. Perception completes and the pipeline advances past
  it before the reasoner is ever contacted.
- Perception completes in ~4.6 s **with the backend entirely down**, which rules out any
  perception dependency on the reasoner.
- The watchdog's "Last stage: PERCEPTION" label was a **projection artefact** (Defect A), not
  evidence about perception. The adapter was faithfully reporting the last stage it was given.
- The `perceivePage` callback passes no `ocrEngine`, so the multimodal coordinator runs DOM
  extraction and screenshot capture only. No OCR/Tesseract initialisation is in this path.

---

## 4. REASONER STATUS

| Question | Answer |
|---|---|
| Request actually sent? | **Yes.** The stub backend on `127.0.0.1:8010` received it. |
| Backend reachable? | **Yes** in the acceptance run. In the original run it was not running. |
| Groq reachable? | **Not determinable from the original capture** — the backend process was not up, so no Groq request was ever made. |
| Failure category | Transport/operational: the agent backend was not running. `REASONER_FAILED` is a correct classification. |

The UI label `Groq / gpt-oss-20b` is a **static configured-provider label**, not a statement
that Groq answered. The provider chain is configured in `backend/app/config.py` with a fallback
(`GROQ` primary, then `OPENROUTER`, then `NVIDIA`), `MAX_LLM_ATTEMPTS=1`, and per-provider
timeouts `GROQ_TIMEOUT_SECONDS=30`, `OPENROUTER=45`, `NVIDIA=30`.

Relevant timeout layers:

| Layer | Value | File |
|---|---|---|
| Extension provider race | **55 000 ms** | `extension/src/agent/backendAgentProvider.ts` |
| Backend Groq | 30 s | `backend/app/config.py` |
| Backend OpenRouter | 45 s | `backend/app/config.py` |
| Backend NVIDIA | 30 s | `backend/app/config.py` |
| Backend LLM attempts | 1 | `backend/app/config.py` |
| AgentLoop retry delay | 250 ms | `extension/src/agent/agentLoop.ts` |
| Dashboard watchdog | 60 s stall threshold, 60 s `LLM_REASONING` grace | `frontend/src/adapters/extensionAdapter.ts` |

> Correction to an existing comment: `backendAgentProvider.ts` documents its timeout as
> "35s"; the actual value is **55 000 ms**. The comment is stale. Left as-is to keep the diff
> minimal — flagged here instead.

**Yes: a reasoner failure can legitimately outlast the watchdog** (55 s provider race vs a 60 s
stall threshold that never received a `LLM_REASONING` stage because of Defect A). That is
precisely the inversion the user observed, and it is now fixed at the projection layer rather
than by inflating the timeout.

---

## 5. WATCHDOG STATUS

**Symptom, not cause.** It did not cause the failure; it mislabelled a correct failure.

- **When it starts:** on `startTask()`.
- **When it resets:** on every non-terminal `TASK_PROGRESS` payload, in `resetWatchdog()`.
- **What it considers progress:** any `TASK_PROGRESS` with a non-terminal status.
- **What stage it records:** `this.lastLifecycleStage`, derived from
  `phaseToPipelineStage(payload.interactionPhase)`.
- **When it stops:** on `TERMINAL` status, and on any `PONG_EXTENSION` liveness reply.
- **Terminal clears it:** yes — the terminal payload clears the timer before it can fire.

It needed modification, but **not** a larger timeout, not removal. The 60-second
`LLM_REASONING` grace window that already existed was simply unreachable (Defect B) and lagged
by one payload (Defect C). Both are fixed. The watchdog remains a genuine stall detector: a
real AgentLoop stall that emits no progress for 60 s still fires, now with a correct stage
label.

---

## 6. PING STATUS

**Healthy and unrelated. Untouched.**

PING is a health-polling path only. It is emitted by the dashboard and answered by the
service worker (`PING_RECEIVED_BY_CONTENT_SCRIPT` → `DASHBOARD_PING_SENT_TO_SERVICE_WORKER` →
`CONTENT_SCRIPT_RESPONSE_RECEIVED` → `PONG_EXTENSION_SENT` → `PONG_EXTENSION_RECEIVED`).
It is a distinct message type from `TASK_PROGRESS` and never enters the task state machine.

Verified it cannot cause: AgentLoop restart, watchdog reset, task duplication, perception
duplication, or terminal-state overwrite. Covered by explicit test cases
(`pingDoesNotAffectTaskLifecycle`, `pingCannotOverwriteTerminalState`).

Repeated PINGs occur simply because the dashboard polls on a fixed interval while it waits for
task progress — the reasoner was blocked for 40+ s, so several intervals elapsed. Expected.

---

## 7. TARGET TAB STATUS

**Projection bug. Fixed.**

`Target Tab: localhost:4174` while the page URL correctly read `https://www.google.com/`.

`frontend/src/views/agentView.ts` contained a **hardcoded** `localhost:4174` string in the
`Target Tab` row of the template, with no element id and no update path. It was never bound to
state — a stale artifact of the harness origin, not a reading of the target tab.

**Fix:** `<span id="agent-kv-target">` populated from `state.currentUrl`. The target browser
URL remains `https://www.google.com/` for this test. Covered by
`targetTabLabelTracksCurrentUrl`.

---

## 8. PHASE 15 STATUS

**Not involved. Phase 15 was not removed or modified.**

Proof: `extension/src/background/serviceWorker.ts`'s `perceivePage` callback calls
`coordinateMultimodalPerception()` **without an `ocrEngine` argument**. Therefore:

- `LocalOCREngine` is never constructed.
- `detectContextualInOcr()` is never called.
- Tesseract is never initialised in the agent loop.
- Contextual NLP over OCR text never runs.

Perception completes in ~4.6 s with no OCR cost, which independently confirms it. Phase 15
remains fully intact and is exercised by the Phase 15 suite (8/8) and by `contextualPii` unit
tests.

---

## 9. MINIMAL FIX

Three files. No architecture change, no authority weakened, no phase scope added.

| File | Change |
|---|---|
| `extension/src/agent/agentOutput.ts` | `projectAgentOutput()`: the `PERCEPTION` override now requires `isFirstCycle && !planReported`, where `planReported` is `planningEngineState !== "UNINITIALIZED"`. |
| `frontend/src/adapters/extensionAdapter.ts` | `resetWatchdog()`: compare `lastLifecycleStage` against `'LLM_REASONING'` (was the non-existent `'REASONING'`), and derive the stage **before** arming/clearing the watchdog instead of after. |
| `frontend/src/views/agentView.ts` | `Target Tab` value moved from a hardcoded `localhost:4174` to `#agent-kv-target`, bound to `state.currentUrl`. |

Deliberately **not** done: no watchdog timeout change, no watchdog removal, no PING change, no
Phase 15 change, no privacy-fusion change, no bypass of M5 / Security Critic / confirmation /
containment / harness, no hardcoded reasoner response, no classification of backend failure as
success, no changes to `agentLoop.ts`, `serviceWorker.ts` or the backend.

---

## 10. TEST RESULTS

**Focused (Phase 14):** **77/77** — 63 pre-existing + 14 new.

New `tests/phase14/reasonerFailurePath.test.ts` (14 tests) covers the full matrix requested:

1. reasoner success
2. reasoner unavailable
3. reasoner timeout
4. malformed reasoner response
5. terminal failure reaches dashboard
6. watchdog cleared when terminal failure arrives
7. terminal failure cannot be overwritten
8. PING continues independently
9. target tab label remains correct
   …plus phase labelling, loop terminal `FAILED`, watchdog windows, and screening on the failure path.

It uses a `ScriptedProvider` stub (`ok | unavailable | timeout | malformed`) — **no test depends
on the real Groq service.** Imports `AgentLoopCallbacks` (not `LoopCallbacks`) and `executeAction`
(not `dispatchAction`).

`tests/phase14/agentOutput.test.ts` test `3.3` originally **encoded the bug** (its title said
"plan machine is idle" while the fixture passed `SUBGOAL_SELECTION`). Rewritten as `3.3`, with
`3.3b` added for the genuinely-uninitialised case.

**Regression:** **1138/1138 passing, 98 files.**

**Typecheck:** `npx tsc -b --noEmit` → **5 errors, all pre-existing** in
`extension/src/background/targetResolver.ts` (lines 285, 287, 287, 290, 488), originating from
commit `d1fbf5c`. Count unchanged from baseline; no new errors introduced.

**Build:** `npm run build:extension` → exit 0. `npm run build:frontend` → exit 0.

**Real-Chrome acceptance** (`scratch/verify_reasoner_failure_path.mjs`) — **8/8 PASS**:

- `backendActuallyReachedTheStub`
- `perceptionCompletedBeforeReasoning`
- `phaseWasPlanningWhileAwaitingReasoner`
- `phaseNeverMisreportedAsPerceptionStall`
- `terminalFailedReachedDashboard`
- `terminalReasonIsReasonerFailed`
- `watchdogDidNotFire`
- `terminalArrivedBeforeAnyWatchdog`

**Seam re-verification:** Phase 12 7/7 · Phase 13 9/9 · Phase 13-prod 7/7 · Phase 14-prod 8/8 ·
Phase 14 UI 9/9 · Phase 15 8/8.

**Note:** `pytest` is not installed in this environment (`No module named pytest`). The Python
suite was **not** run and is not claimed.

---

## 11. REMAINING LIMITATIONS

1. **The original capture cannot prove where Groq itself stood.** The backend was not running,
   so no request ever reached Groq. `REASONER_FAILED` was correct, but the original failure
   category is *transport*, not *provider*. This is stated rather than guessed.
2. **The Python/pytest suite is unverified here** — no interpreter environment.
3. **Five pre-existing `tsc` errors** in `targetResolver.ts` remain untouched by design; they
   are unrelated to this defect and predate it.
4. **The stale "35s" comment** in `backendAgentProvider.ts` (actual: 55 000 ms) is still stale;
   fixed only in documentation elsewhere, to keep the diff minimal.
5. **Real Groq was never exercised end-to-end.** The acceptance run uses a stub that reproduces
   the slow-then-503 condition deterministically. A live Groq run would additionally validate
   schema parsing of a successful response.
6. **The watchdog's 60 s stall threshold is unchanged.** If a legitimate reasoner call ever
   exceeds 60 s *and* the provider race is raised above 60 s, the same inversion could recur.
   The provider race (55 s) currently sits safely below it.

---

## 12. FINAL VERDICT

**Fixed.** The failure path is now deterministic, observable and correctly propagated.

```
START_TASK
 → PERCEPTION completes
 → REASONER_ENTER / LLM_REASONING reported on the wire
 → reasoner request fails deterministically
 → REASONER_FAILED generated
 → AgentLoop enters terminal FAILED (once)
 → watchdog cleared
 → dashboard receives terminal FAILED
 → UI shows REASONER_FAILED  (not WATCHDOG_TIMEOUT)
```

The observed `START_TASK → PERCEPTION → WATCHDOG_TIMEOUT → later REASONER_FAILED` chain is
eliminated. The watchdog now observes a real `LLM_REASONING` stage and applies its intended
60-second grace window, instead of misreading a slow reasoner as a dead perception.

**Not fixed / out of scope:** the operational fact that the agent backend must be running for
reasoning to work at all. That is not a code defect. The correct operational fix is to run
`backend/` and supply a valid `GROQ_API_KEY` in Settings → Environment; no code change is
warranted for it.

**Is another engineering phase justified? No.** The three defects were projection and ordering
bugs. They are fixed, covered by 14 deterministic tests and 8 real-Chrome assertions, and the
full 1138-test suite, typecheck count and both builds are unchanged. No further phase is
warranted on the basis of this investigation.
