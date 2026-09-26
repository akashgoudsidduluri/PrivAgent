# Phase 14 Evidence — Agent Interaction & Output Layer

All numbers come from commands actually executed in this repository.

| Item | Command | Result |
| --- | --- | --- |
| Phase 14 focused tests | `npx vitest run tests/phase14/` | **1 file / 46 tests passed** |
| Full regression suite | `npx vitest run` | **95 files / 1048 tests passed** |
| TypeScript | `npx tsc -b --noEmit` | **0 new errors** (5 pre-existing, see §6) |
| Extension build | `npm run build:extension` | **exit 0** |
| Frontend build | `npm run build:frontend` | **exit 0** |
| Real Chrome **production service-worker path** | `node scratch/verify_phase14_production_path.mjs` | **8 / 8 checks PASS** |
| Phase 13 harness regression | `node scratch/verify_phase13_harness.mjs` | **9 / 9 PASS** |
| Phase 13 production-path regression | `node scratch/verify_phase13_production_path.mjs` | **7 / 7 PASS** |
| Phase 12 containment regression | `node scratch/verify_phase12_containment.mjs` | **7 / 7 PASS** |

Regression baseline before this phase: **94 files / 1002 tests**. Delta: **+1 file /
+46 tests**, all Phase 14. **No pre-existing test was modified or removed** —
verified by re-running the authority suites explicitly:
`tests/phase12`, `tests/phase13`, `tests/phase11`, `stage5SecurityPipeline`,
`phase8SecurityCritic`, `phase10RecoveryEngine`, `phase9LongHorizon`,
`targetResolutionAndLifecycle`, `adversarialBoundary` → **12 files / 309 tests
passed**.

---

## 1. What the layer is

A pure, read-only **projection** of agent state into a small, value-free,
user-facing interaction state — plus the output-privacy boundary every
user-facing string crosses.

```
AgentTaskState (authoritative, unchanged)
        │
        ▼  projectAgentOutput()      narrowing · read-only · no write path
AgentInteractionState { activity, terminal, result, artifacts, timeline }
        │
        ▼  screenAgentOutput()       the privacy seam · fail-closed
        │
        ▼
sendToDashboard({ ...state, interaction })   ← the single SW boundary
        │
        ▼
adapter → DashboardAgentState.interaction → agentView
```

### The four properties that make it safe

1. **READ-ONLY AND ONE-WAY.** No write path back into `AgentTaskState`, no
   callback, no side effect. There is no code path from here into authority.
   Pinned by test `6.3` (no function reachable in the payload) and `6.5`/`6.6`
   (every gate, containment and the Harness reach an identical verdict whether
   or not the projection ran).
2. **NARROWING.** Strictly smaller than its input. It can only omit; it never
   invents a fact the agent did not already compute.
3. **NO CHAIN-OF-THOUGHT.** Internal `reason` prose, validation reasons,
   execution errors, model rationale and the decision trace are read
   *internally* to classify a stable code, then discarded. Only closed-vocabulary
   codes and composed headlines cross. Pinned by the P14-5 group (5 tests) and by
   real-Chrome check 5.
4. **NOT AN AUTHORITY.** It cannot influence the loop, the Harness, containment
   or any gate, and it grants nothing.

---

## 2. What was fixed in the layer that already existed

The investigation found the UI was **inferring a stage from English prose** by
substring-matching `data.reason` for `"perception"`, and that **five of the eight
`PipelineStage` values were never assigned**. The live activity line is now
derived from the **real `planningEngineState`** the loop already maintains (14
states) — no new state machine, no string matching, no guessing.

Eleven `AgentTaskState` fields were being dropped by the adapter, including all
Phase 12/13 observability. `containmentDecision` and `harnessRun` were therefore
invisible to the user. Both now surface as value-free **artifacts**.

---

## 3. The output-privacy seam

`screenAgentOutput()` lives in the **service worker**, inside `sendToDashboard`,
and is deliberately minimal: it uses the **existing `scanForRawSensitiveValues`
primitive** and nothing else. No NLP, no OCR, no fusion engine, no
classification system.

Screening sits inside `sendToDashboard` rather than at individual call sites
because it is the **single point every outbound payload crosses** — per-step
progress, the final task state, and every hand-built early-failure payload. This
makes "screened before crossing the SW → dashboard boundary" true *by
construction* rather than by remembering to add it at each future call site.
The first implementation screened only `onStepProgress` and real-Chrome check 3
caught the gap immediately: the terminal payload bypassed it.

It is the exact mirror of Phase 12:

```
CONTAINMENT (Phase 12)   protects what the agent DOES
OUTPUT SCREEN (Phase 14) protects what the agent SAYS
```

It fails closed two distinct ways:

| Condition | Verdict | Behaviour |
| --- | --- | --- |
| Malformed payload | `BLOCKED` | replaced with a safe empty terminal-FAILED projection |
| Raw-value shape in a **closed-vocabulary** field | `BLOCKED` | whole payload dropped — a corrupt structural field cannot be half-trusted |
| Raw-value shape in a **page-derived display** field | `REDACTED` | that field is withheld; one bad title does not lose a good result |
| Nothing detected | `CLEAR` | passed through untouched |

---

## 4. Files changed

| File | Change |
| --- | --- |
| `extension/src/agent/agentOutput.ts` | **NEW** (≈560 lines) — projection, terminal-reason classifier, phase derivation, screening |
| `extension/src/background/serviceWorker.ts` | **+28** — 2 imports, and the projection + screening block inside `sendToDashboard` |
| `frontend/src/types/dashboard.ts` | **+82** — the Phase 14 vocabulary mirrored for the UI |
| `frontend/src/adapters/extensionAdapter.ts` | **+72** — `normalizeInteraction()` (defensive parsing) and mapping `data.interaction` |
| `frontend/src/views/agentView.ts` | **+113** — the Activity / Result / Terminal / Artifacts panel |
| `tests/phase14/agentOutput.test.ts` | **NEW** — 46 focused tests |
| `scratch/verify_phase14_production_path.mjs` | **NEW** — real-Chrome production verification |
| `docs/evidence/phase14-interaction-output/*` | **NEW** — this report + JSON evidence |
| `extension/src/hierarchicalPlanning/taskDecomposer.ts` | **+14** — the `decomposeTask` fix carried over from the previous turn (unrelated to Phase 14) |

**Zero changes** to: `groundingEngine`, `actionValidator`, `securityCritic`,
`privacyPolicy`, `riskEngine`, `effectVerifier`, `goalVerifier`,
`recoveryEngine`, **`containment.ts`**, **`harness.ts`**, `agentLoop.ts`,
`resumeWithConfirmation()`, `contentScript.ts`, `manifest.json`, the backend.

Verified mechanically: `git diff --stat` over all of those paths is **empty**.

No new permission, message type, browser API, transport, event bus, or store.
The existing per-step payload still goes to the existing dashboard channel; the
only change is one extra `interaction` field.

---

## 5. Real-browser evidence (8 / 8)

Driven through the **actual production path**: real dashboard page → real
extension content script → real service worker loaded from `dist/` → real target
resolution and containment scope → real `AgentLoop` (real Harness) → real
content-script perception → `projectAgentOutput` → `screenAgentOutput` →
`sendToDashboard`.

| # | Check | Result |
| --- | --- | --- |
| 1 | `interactionProjectionReachesDashboard` | PASS — 4/4 payloads carry `interaction` |
| 2 | `liveActivityPresent` | PASS — `"Reading the page."` → `"Finished."` |
| 3 | `structuredTerminalOutcome` | PASS — `{outcome: FAILED, reason: REASONER_FAILED, headline: "Failed: the reasoning model was unavailable."}` |
| 4 | `outputScreeningInvokedInServiceWorker` | PASS — 4 invocations observed in the real SW console |
| 5 | `noChainOfThought` | PASS — 0 leaks; no gate prose, trace, or internal `reason` in the payload |
| 6 | `confirmationChainIntact` | PASS — `CONFIRM_ACTION` posted from the real dashboard content script reached the SW handler |
| 7 | `containmentHeld` | PASS — the live target page never left the contained origin |
| 8 | `harnessStillRunning` | PASS — `harness cycle` still observed in the real SW console |

Check 3 is the clearest demonstration of the anti-CoT design: the raw internal
prose is still what the loop produces, and the user sees a classified code and a
composed headline instead.

---

## 6. Limitations and caveats — read before judging this phase

1. **A positive confirmation round-trip was not exercised.** Check 6 proves the
   dashboard → content script → service worker → `resumeWithConfirmation` chain
   is intact end to end, but the reasoner backend is not running in this
   environment, so the run never reaches `NEEDS_USER_CONFIRMATION`. A genuine
   authorize → resume → complete cycle is therefore **not** proven here. It
   remains covered by the existing `agentLoop.test.ts` confirmation tests and by
   `resumeWithConfirmation()` being byte-for-byte unmodified.

2. **The per-action security gates did not fire in the real-Chrome run.** The
   backend is offline, so the reasoner never proposed an action and M5, the
   Security Critic, the Privacy Firewall, Risk/Confirmation and
   Containment-at-dispatch had nothing to evaluate. The reasoner failure is
   *upstream* of them; no gate was skipped or bypassed by this layer. They are
   covered by the 309-test authority suite, which passes.

3. **The unchanged confirmation and security paths remain covered by the
   existing regression suite.** Neither `resumeWithConfirmation()` nor any
   security module was modified by this phase — verified mechanically, the
   `git diff --stat` over all of them is empty — so their coverage is
   unchanged rather than reduced. The 309-test authority suite (phase 8/9/10/
   11/12/13, stage 5, target lifecycle, adversarial) passes, and the existing
   `agentLoop.test.ts` confirmation tests are untouched.

4. **Screening reuses the existing scanner's sensitivity**, which is tuned for
   detecting PII shapes in transit payloads. It reliably catches card numbers,
   emails, phones, `CVV:` and `otp:` forms; it does **not** catch a bare
   `password hunter2`. That is a deliberate boundary for this phase — the seam
   is established with existing primitives, and a fuller output-classification
   layer is future work. **A `CLEAR` verdict does NOT mean "provably clean".**

5. **`activity.phase` has limited granularity during repeated perception
   cycles.** The plan state machine only advances once an action has been
   proposed, so mid-task the phase reflects the gate/execute stage rather than
   "re-perceiving". Honest rather than wrong; a fix would need a state the loop
   does not currently maintain.

6. **5 pre-existing `tsc` errors** in `extension/src/background/targetResolver.ts`,
   verified pre-existing on a clean tree. Phase 14 adds **0** new errors. Note
   that the suite passed and the build passed at one intermediate point while
   `tsc` had 2 new errors — vitest strips types and Vite does not typecheck, so
   **only `tsc` catches these**. That is worth remembering in CI.

7. **Headless Chromium** (`--headless=new`), matching the Phase 9–13 harnesses.
   Backend pytest not runnable (`No module named pytest`); no backend code was
   changed.

8. **Phase 12/13 evidence files were restored after being regenerated** by the
   regression re-runs, so their committed evidence stays frozen.

---

## 7. Verdict

**PASS.**

Phase 14 adds an Interaction & Output Layer that is a narrowing, read-only,
value-free projection plus a fail-closed output screen. It introduces no
authority, no gate, no second loop, no new transport, event bus, store,
permission, message type or browser API. Every existing security module is
unmodified and unreordered; `resumeWithConfirmation()` is untouched; Phase 12
Containment and Phase 13 Harness are untouched and still verified green in real
Chrome.

The single outstanding verification gap is §6.1: the confirmation chain is proven
intact but a full `NEEDS_USER_CONFIRMATION → authorize → resume → completion`
cycle could not be exercised without a live reasoner backend. §6.2 follows from
it. §6.3 notes that the unchanged confirmation and security paths remain covered
by the existing regression suite.
