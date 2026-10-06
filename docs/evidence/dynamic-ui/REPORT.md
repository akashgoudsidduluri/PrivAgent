# PRIVAGENT — DYNAMIC TASK-AWARE UI / CHATGPT-STYLE ACTIVITY UX
## Phase 12 — Evidence Report

**Baseline:** `c8c1ec9` · **Scope:** UI/state-projection only — no security authority was
weakened, moved, or bypassed (diff evidence in §9).

---

### 1. Files changed

**New (this feature)**

| File | Role |
|---|---|
| `frontend/src/ui/uiProjection.ts` | Pure, deterministic, fail-closed, content-safe projection: typed state → *what to display* |
| `tests/dynamicUi.test.ts` | 28 focused tests for the 10 required invariants + XSS + fail-closed |
| `docs/evidence/dynamic-ui/*` | This report, mutation suite/results, real-Chrome evidence, screenshots |
| `scratch/dynamic_ui_run.mjs` | Real-Chrome harness for tests A–F |

**New (normal-chat routing audit — earlier uncommitted work, included in the same delivery)**

`extension/src/agent/conversationRoute.ts`, `tests/finalNormalChatRouting.test.ts`,
`backend/tests/test_agent_chat.py`, `docs/evidence/post-17-10/audit/*` (routing evidence +
mutation results), `scratch/final_chat_run.mjs`, `scratch/package_final_chat.mjs`.

**Modified**

- `frontend/src/components/agentWorkspace.ts` — rewritten to render strictly from the projection (conversation surface / browser surface / diagnostics).
- `frontend/src/adapters/extensionAdapter.ts` — explicit `answerSource` assignment (clears on browser payloads), typed supersession transition, per-run clearing of `interaction`.
- `frontend/src/types/dashboard.ts` — `+answerSource`, `+supersededPreviousTask`, `+'CONVERSATIONAL_ANSWER'` terminal reason (repairing a mangled comment).
- `frontend/src/main.ts`, `frontend/src/components/taskComposer.ts` — empty-state clearing + composer copy.
- `frontend/src/styles/main.css` — dynamic-UI styles (~200 lines appended, tokens only).
- `extension/src/background/serviceWorker.ts` — chat ack/failure relay `answerSource`; **chat-branch runId stamping fix (§3)**. Diff vs baseline: **129 insertions, 0 deletions**.
- `extension/src/content/contentScript.ts` — relays `answerSource` on the START_TASK ack.
- `extension/src/agent/{agentOutput,agentProvider,agentState,backendAgentProvider,intentBoundary}.ts`, `backend/app/{models,reasoner}.py`, `backend/app/routes/agent.py` — audit-phase typed `CONVERSATIONAL_ANSWER` / chat-path plumbing.
- `scratch/i8a7a8_controlled_provider.py` — controlled stub modes for tests C/D.

---

### 2. State / projection architecture

```
user message ──► adapter.startTask ──► contentScript ──► serviceWorker
                                                                 │
                                      conversationRoute / I-1 (unchanged authorities)
                                                                 │
                 ┌──────────── CONVERSATION ◄───────────────────┤──────── PIPELINE ──────────┐
                 │  ack {status:ANSWER, answerSource:CONVERSATION}   I-1 → target resolution  │
                 │  answer payload {status:ANSWER, answer,            → perception → loop     │
                 │    answerSource, runId=<dashboard run>}            → sendToDashboard        │
                 ▼                                                   (screened interaction)    ▼
        adapter: status ANSWER, answerSource CONVERSATION     adapter: typed status + interaction
                 │                                                    │
                 ▼                                                    ▼
        projectUi(state, log)  ◄── pure ──►  surfaces:
          IDLE              — no task (empty-state hero)
          CONVERSATION      — decided ONLY by answerSource==='CONVERSATION'
                              or terminal reason CONVERSATIONAL_ANSWER
                              pending until the ANSWER payload's result card lands
          BROWSER_ACTIVITY  — working label (typed phase/stage → fixed table),
                              event-driven activities (executed steps + reported
                              phases only, keyset merge `step:N`/`phase:X`),
                              terminal result, awaiting-confirmation, superseded
                              notice. stepCounter is null BY DESIGN.
                 │
                 ▼
        agentWorkspace renders projection only — user bubble, assistant bubble
        (typing dots while pending), compact working row, collapsible activity
        (<details>), final-answer panel first, diagnostics collapsed.
```

Properties: the projection has **no write path** into the loop, gates, or service worker;
every user-visible label comes from a fixed vocabulary keyed by typed runtime values
(`PHASE_LABELS`/`STAGE_LABELS`/`ACTION_LABELS`) or a parsed hostname; `state.reason` is
never read; unknown/malformed input fails closed to the smallest honest surface.

---

### 3. Real-Chrome defect found & fixed (this session)

**Symptom:** live tests A/B/F stayed on the typing indicator forever (`assistantBody=null`,
67/67 samples) although the SW forwarded `{status:ANSWER}`.

**Evidence — dashboard console captured by the harness during the pre-fix run
(observed verbatim; that capture was superseded by the passing re-run now stored
in `real_chrome_ui_live.json`, which shows the same case with the drop line
absent):**

```
[AgentTrace] Dropping stale progress from superseded runId
  {incomingRunId:0, activeRunId:1, incomingTask:hi, activeTask:hi}
```

**Cause:** the chat branch stamped the answer payload with `activeTaskRunId`
(`runId = activeTaskRunId`, initial `0`), but the branch correctly never claims
ownership — the ownership block that would set it to the dashboard's runId (`1`) runs
only for pipeline tasks. `sendToDashboard` forwards `rawPayload.runId`, and the adapter
drops any payload whose runId is not its current run. The final answer was therefore
always dropped on a fresh session and `pending` never resolved.

**Fix (serviceWorker.ts chat branch, no ownership change):**

```ts
const chatOwnerToken = activeTaskRunId;                                    // suppression guard (unchanged semantics)
const chatRunId = typeof message.runId === 'number' ? message.runId : activeTaskRunId;  // payload stamp
```

- Suppression guard now compares `chatOwnerToken !== activeTaskRunId` — identical
  semantics to before (ownership change while the answer is in flight ⇒ suppressed).
- The payload carries the dashboard's own runId ⇒ delivered ⇒ `pending` resolves.
- **Ownership is still never claimed by chat** — a casual message cannot supersede a
  running task; the branch still returns before the ownership block, performs zero tab
  / perception / dispatch calls, and its structural tests (16, 17, 17b) still pass.
- Dashboard adapter drop rules were **not** loosened; the stale-progress guard for
  browser runs is intact (`tests/taskConcurrencyOwnership.test.ts` 7/7 pass).

---

### 4. Focused test results — Phase 10

```
tests/dynamicUi.test.ts               28 passed  (all 10 required invariants,
                                                  multi-turn 12a–12d, XSS escape,
                                                  fail-closed, label-table-only)
tests/finalNormalChatRouting.test.ts  19 passed  (routing unchanged)
tests/taskConcurrencyOwnership.test.ts 7 passed  (stale-run guard intact)
                                              ─────────────────────────
                                                     54 passed, 0 failed
```

Covers: conversation→no browser UI, browser→dynamic UI, activity-only-with-event,
no fabricated steps, terminal replaces active, cancellation, supersession,
clarification, failure, commit-unknown, content-safety, routing unchanged.

### 5. Mutation results — Phase 10

`docs/evidence/dynamic-ui/ui_mutation_suite.mjs` → `ui_mutation_results.json` (re-run on
final code):

```
M1 KILLED   "always render browser activity"  (conversation branch made dead)
M2 KILLED   "always render Step 1 of 10"      (fabricated step counter restored)
M3 KILLED   "conversation route displays the browser timeline / task card"
                              3/3 killed, 0 survivors, 0 not applied
```

### 6. Full regression — Phase 10/12

```
vitest   168 files / 2892 tests … 2892 passed  (baseline 167/2864 + new dynamicUi 28)
pytest   backend 670 passed
```

### 7. TypeScript / build

```
npx tsc --noEmit        0 errors   (type-checks tests/ and frontend/)
npm run build           0          (extension → dist/, loaded by the Chrome harness)
npm run build:frontend  0          (dashboard → frontend/dist/)
```

### 8. REAL Chrome evidence — Phase 9 (production extension, real CDP Chrome)

Harness: `scratch/dynamic_ui_run.mjs`. Provider mode detected by canary and recorded
honestly per run.

**Live suite — `real_chrome_ui_live.json` (LIVE_PROVIDER, real FastAPI :8010,
model `openai/gpt-oss-20b`) — 4/4 PASS:**

| Test | Input | Result | Key observations |
|---|---|---|---|
| **A** normal chat | `hi` | **PASS** | surface=`conversation`; assistant: *"Hello! How can I help you today?"*; chatAccepted=1; targetResolution/tabProvisioned/actionExecuted/intentClassified **all 0**; zero banned chrome |
| **B** knowledge | *What is machine learning?* | **PASS** | surface=`conversation`; assistant: *"Machine learning is a type of artificial intelligence…"*; typing indicator observed then resolved; all browser counts 0 |
| **E** failure | *Find the latest information about Charminar.* | **PASS** | surface=`browser`; panel=`final-response-panel failure`, headline *"Reasoning service unavailable"* (live provider fail-closed, 0 dispatched actions — no fake success); observed dynamic labels: `Planning the next action`, `Reading the page`, `Reasoning service unavailable`; activity preserved; composer ready |
| **F** return to chat | `hi` (same session after E) | **PASS** | surface=`conversation`; clean UI; no stale Charminar content, no timeline; browser counts 0 |

**Controlled suite — `real_chrome_ui_controlled.json` (CONTROLLED_PROVIDER,
`scratch/i8a7a8_controlled_provider.py` on :8010) — 2/2 PASS:**

| Test | Input / mode | Result | Key observations |
|---|---|---|---|
| **C** browser search | *search for cats* (`act_then_answer`) | **PASS** | surface=`browser`; real events drove the labels: `Reading the page` → `Planning the next action` → `Looking further down the page` (real scroll) → recovery; 2 actions executed, 8 perceptions; panel `notice` *"Partly answered"* (truthful PARTIAL); no fabricated steps; activity count 5 |
| **D** navigation | *open Wikipedia* (`navigate_wikipedia`) | **PASS** | navigation activity **`Opening en.wikipedia.org`** from the real navigate action; tabProvisioned=1, 3 actions executed; terminal is a truthful `failure` — *"The page did not change when I acted on it, so I stopped instead of repeating the same action"* (fail-closed effect verification; no stuck loading; activity collapsed behind diagnostics with 6 activities) |

Screenshots: `docs/evidence/dynamic-ui/shots/{A,B,E,F}_live.png`, `{C,D}_control
led.png`. Raw per-case samples, SW logs, dashboard console logs and marker counts are
inside each JSON.

Honesty notes: E is a genuine live-provider fail-closed run (A8 applicability gate /
text-safety), not a scripted failure; D's terminal is a real failure verdict, not a
demo success; C/D are labelled CONTROLLED_PROVIDER (stub) and never presented as live
model output.

### 9. Security authorities & privacy scan

- **Diff vs baseline for `serviceWorker.ts`: 129 insertions / 0 deletions.** The chat
  route is purely additive and sits *above* I-1; `screenAgentOutput` (single output
  screen), I-1, target resolution, ownership, A12/A14/A16, verification and
  containment code paths are byte-identical. The runId fix changes two local
  variables in the chat branch only.
- Structural routing tests 16/17/17b (branch precedes every browser stage; performs no
  tab/perception/dispatch call; unconditional early exit) — pass.
- Projection never reads `state.reason` (grep-verified; only comments mention it).
- Every dynamic string in the workspace passes through `escapeHtml` (grep-verified
  against every `${…}` interpolation); XSS test asserts no element creation.
- Activity labels come only from fixed tables/hostname — no raw action arguments, no
  DOM, no prompts, no CoT, no provider text.
- **Sensitive-value scan of all evidence JSONs (emails, phones, PAN, cvv/password/otp
  assignments, bearer tokens, `sk_`/`gsk_` keys, Authorization): 0 hits.**

### 10. Acceptance criteria

| Criterion | Status | Proof |
|---|---|---|
| Normal chat has no browser-agent UI | ✅ | A, F (real Chrome) + tests 1, 12a–c |
| Knowledge questions have no browser-agent UI | ✅ | B (real Chrome) + test 1 |
| Browser tasks dynamically show relevant activity | ✅ | C, D, E (real Chrome) |
| Activity driven by real runtime state | ✅ | labels in §8 map 1:1 to observed events |
| No fixed "Step 1 of 10" | ✅ | `stepCounter: null` by design; M2 killed; banned in harness |
| No fabricated thinking / no CoT | ✅ | fixed label tables only; M1/M3 killed |
| Final answers visually primary | ✅ | final panel before diagnostics; activity `<details>` |
| Activity compact/collapsible | ✅ | `<details id=activity-details>` collapsed at terminal |
| Failure/clarification/cancellation truthful | ✅ | E, D terminals; projection tests 5–9 |
| Security authorities untouched | ✅ | §9 diff + tests 16/17/17b + concurrency 7/7 |
| Real Chrome: chat / browser / return-to-chat | ✅ | A–F all PASS |
| Focused tests / mutations / regression / builds / privacy scan | ✅ | §4–§7, §9 |
| Working tree clean | ✅ | after commit |
| Commit created | ✅ | see §11 |

### 11. Commit

Feature commit (this report, all code, tests and evidence included):

```
72ffb59309d10d5278723c61704c3b7a14429bfc
feat(ui): dynamic task-aware dashboard — chat looks like chat, browser work looks like work
```

(The hash could not be embedded in the commit that contains this file; it is
stamped here in the follow-up commit `docs(evidence): stamp feature commit hash`.)
