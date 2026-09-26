# Phase 14 — Correction & Re-verification Pass

**Phase:** 14 — Agent Interaction & Output Layer
**Baseline commit:** `274c166 feat: add agent interaction and output layer`
**Nature of this pass:** correction and re-verification. **Not** a rewrite.
**Not committed. Not pushed.**

---

## 1. The reported symptom

A real-browser run showed the runtime reporting

```
[Adapter] response received { status: 'IN_PROGRESS', currentStep: 1, reason: undefined }
```

while the dashboard appeared to display

```
RUNNING
Deciding the next step.

RESULT
No result yet.
```

and the agent state showed `Step 2 of 10 · harness cycle 2`.

---

## 2. Root cause

**There was no field being dropped.** The Phase 14 transport was already intact,
end to end. The report was a misreading of a correctly-rendered UI, plus two
genuine adapter defects that the misreading had masked.

### 2.1 The "contradiction" was one header row, not two sources

`agentView.renderInteraction()` renders the projection's activity summary on the
LEFT of a single header row and the step/cycle counter on the RIGHT of the same
row:

```
[outcome badge]  <activity.summary>              Step N of M · harness cycle K
```

`"Deciding the next step."` is `PHASE_SUMMARY.PLANNING` from
`agentOutput.ts:180`, and `"No result yet."` is the `NONE` result summary from
`agentOutput.ts:343`. **Both come from the structured `interaction` projection**,
as does `"Step 2 of 10 · harness cycle 2"`. They are the same panel reporting
the phase and the position at the same time; they never contradicted each other.

The previous Phase 14 verifier could not see this because it drove a
**synthetic** dashboard page and only inspected the payload. It proved
`interaction` was on the wire; it could not prove what the real UI rendered.

**Confirmed against the real built dashboard** (§5): the live DOM shows

```
FAILED
        Finished.
        Step 1 of 10 · harness cycle 1
           FAILED
           Failed: the reasoning model was unavailable.
           REASONER_FAILED
        Result
        No result yet.
        HARNESS: 1 cycle(s), 0 halt(s)PERCEPTION: 2 cycle(s)
```

Every string there is real agent state, read back out of `frontend/dist`.

### 2.2 `reason: undefined` — expected on the wire, mishandled in the adapter

`AgentTaskState` has no `reason` field. The service worker sends
`{ ...taskState, interaction: screened.output }`, so `reason` is legitimately
absent. The adapter nevertheless:

- **logged** `reason: data.reason` on every progress message, printing a
  permanently-`undefined` field and making the transport look broken;
- **assigned** `reason: data.reason` unconditionally, **overwriting a real
  failure reason with `undefined`** on every subsequent message;
- wrote `error: data.reason` into the receipt, so a genuinely FAILED run
  recorded `error: undefined` and the receipts UI had nothing to show;
- derived the lifecycle stage by sniffing `reason` for the substring
  `"perception"` — a branch that could **never fire**.

---

## 3. Exact fixes

All three are in `frontend/src/adapters/extensionAdapter.ts`. The extension
runtime, the projection, the screening and every security authority are
untouched.

### Fix 1 — the stage reads the structured phase, and the status bar is no longer hardcoded

`currentPipelineStage` was assigned the literal `'BROWSER_EXECUTION'` for the
entire duration of any run, and `lastLifecycleStage` fell back to a dead
substring check. The status bar therefore said `BROWSER_EXECUTION` from the
first perception cycle to the last, and the watchdog's `Last stage: …` message
was uninformative exactly when it was needed.

Both now derive from `interaction.activity.phase` via a new pure
`phaseToPipelineStage()` mapper, with `data.stage` still taking precedence when
the loop supplies it. The mapper only **renames** phases; an absent or unknown
phase falls back to `BROWSER_EXECUTION`, the same default as before. It never
invents a stage.

### Fix 2 — `reason` is a fallback, not an erased field

`resolvedReason = data.reason || interaction.terminal.headline || interaction.terminal.reason || undefined`.
A real legacy reason still wins; otherwise the structured, already-screened
terminal headline supplies it. Both `state.reason` and the receipt's `error`
use it. A healthy in-progress run still leaves `reason` undefined rather than
inventing one.

### Fix 3 — the misleading log line

`[Adapter] response received` / `[AgentTrace] dashboard received TASK_PROGRESS`
now report `hasInteraction`, `interactionPhase` and `interactionOutcome` — the
fields that actually explain the transport — instead of a dead `reason`.

### Not changed, deliberately

No new event bus, no second state store, no new transport protocol, no second
output architecture, and no substring-based activity inference restored. The
existing adapter → `DashboardAgentState` → `agentView.update()` path is reused
as-is.

---

## 4. PING investigation

| Question | Finding |
|---|---|
| **Why does PING repeat?** | `ExtensionAgentAdapter` sets exactly **one** `setInterval(checkExtensionConnected, 15000)` plus one 200 ms initial ping. `startTask()` adds one more on demand, deliberately, as a fresh connectivity check. |
| **What causes it?** | A 15-second connectivity watchdog, plus the MV3 service-worker wake-up retry (one 600 ms retry when Chrome returns "Receiving end does not exist"). |
| **Is it normal health polling?** | **Yes.** Nothing was changed. |
| **Does it create duplicate `TASK_PROGRESS`?** | **No.** The PING path is `dashboard → contentScript → SW (PRIVAGENT_DASHBOARD_PING) → PONG_EXTENSION`. It never emits progress. |
| **Does it cause duplicate UI updates?** | **No.** A PONG only sets `extensionConnected` and calls `notifyExtensionStatus()`. It never calls `notify()`, so `handleStateChange` → `agentView.update()` is never invoked from the PING path. |
| **Multiple watchdogs/intervals?** | **No.** Exactly one interval per adapter, cleared in `destroy()`. Now pinned by a fake-timer test asserting the exact call count at 0 ms, 15 s, 60 s and after `destroy()`. |

**Why several PONG log lines appear per PING:** the PONG is received by *two*
legitimate listeners — the adapter's permanent `setupMessageBridge()` handler and
the per-ping handler created inside `checkExtensionConnected()`. That is two
consumers of one event, not two polls. Harmless; left alone.

**Observed in the real browser:** `pings sent = 1, pongs = 1, taskProgress = 4`.
The run was short, so only the initial ping fired. The four progress payloads
came from the service worker. Repeated `status:step` pairs are the agent
reporting per-step progress, not ping duplication — this is asserted, not assumed.

---

## 5. Real-Chrome verification

`scratch/verify_phase14_ui_correction.mjs` — Chromium `headless=new` over CDP,
loading the **real** extension from `dist/` and serving the **real built
dashboard** from `frontend/dist` (not a stand-in). It drives a real task, then
captures the live `TASK_PROGRESS` payloads, reads the rendered DOM, and inspects
the service-worker console.

Task: `open google and search cats`. Backend reasoner intentionally offline, so
the run ends at reasoning with `REASONER_FAILED`.

```
{
  "terminalReached": true,
  "everyPayloadCarriesInteraction": true,
  "allStructuredFieldsPresent": true,
  "renderedDomShowsPayloadState": true,
  "stepCounterRendered": true,
  "harnessCycleRendered": true,
  "pingIsHealthPollingOnly": true,
  "noForbiddenKeysOnTheWire": true,
  "outputScreenedInServiceWorker": true
}

[PHASE 14 UI] ALL CHECKS PASS
```

**9/9.** Structured fields verified present on the wire:
`interaction`, `interaction.activity`, `.phase`, `.summary`, `interaction.result`,
`interaction.outcome`, `interaction.terminal`, `interaction.terminal.headline`.
Step counter and harness-cycle text verified present **in the rendered DOM**.

Privacy: no forbidden key (`value`, `textContent`, `innerText`, `rawOCR`,
`ocrText`, `password`, `cardNumber`, `accountNumber`) anywhere in the
`interaction` object; `screenAgentOutput()` confirmed invoked in the service
worker before transport.

**The one field the report asked about that does not exist:**
`interaction.harnessRun` and `interaction.containmentDecision` are **not** part
of the Phase 14 projection, and were never intended to be. Harness and
containment reach the UI as `interaction.activity.cycle` and as timeline /
artifact entries (`HARNESS: 1 cycle(s), 0 halt(s)`). Adding duplicate copies
under new keys would create a second source of truth for the same state, so
they were not added.

---

## 6. Tests

**Phase 14 focused:** `tests/phase14/agentOutput.test.ts` **46** +
`tests/phase14/extensionAdapter.test.ts` **16** (new) = **62/62 pass**.

The new adapter suite covers: structured-projection consumption; every field the
UI renders; malformed-payload degradation; input immutability; phase→stage
mapping for all six phases; the dead substring branch staying dead; legacy
`reason` precedence; structured-terminal fallback; healthy runs leaving
`reason` undefined; PING touching no agent state; PONG not notifying agent
state; exactly one 15 s interval and `destroy()` cleanup; and duplicate-payload
idempotence.

**Full regression:** **1123/1123 pass** across **97 files**.
Phase 14 baseline was 1048/95; Phase 15 added +59; this pass added +16.

**TypeScript:** **5 errors, all pre-existing** in
`extension/src/background/targetResolver.ts` (lines 285, 287 ×2, 290, 488 from
commit `d1fbf5c`). **0 new.**

**Builds:** `npm run build:extension` **exit 0**;
`npm run build:frontend` **exit 0**.

**Real-browser seams re-run as regression:**

| Seam | Result |
|---|---|
| `verify_phase12_containment.mjs` | **7/7** |
| `verify_phase13_harness.mjs` | **9/9** |
| `verify_phase13_production_path.mjs` | **7/7** |
| `verify_phase14_production_path.mjs` | **8/8** |
| `verify_phase14_ui_correction.mjs` *(new)* | **9/9** |
| `verify_phase15_privacy_fusion.mjs` | **8/8** |

Frozen Phase 12/13/14 evidence files were restored with `git checkout --` after
the re-runs so those phases' evidence stays pinned to their own verified state.

---

## 7. Security authorities

**None modified.** `M5 Privacy Firewall`, the Security Critic, Risk/Confirmation,
Grounding, Effect Verification, Goal Verification, the Recovery Engine and Phase 12
Containment are all untouched, and none was moved, widened or bypassed.

Service-worker gate traces from the real run: `perception: true`,
`containmentEstablished: true`, `harnessConsulted: true`; `m5`, `securityCritic`
and `privacyPolicy` show `false` **only because the reasoner is offline and the
run ended at reasoning, so no action was ever proposed for them to evaluate.**
That is the same condition recorded in the original Phase 14 evidence. Those
gates remain authoritative and are covered by the regression suite.

The adapter remains a **read-only consumer** of the projection. It has no write
path back into the loop, the Harness, containment or any gate, and it adds no
privacy filtering of its own — screening still happens in the service worker,
before the payload crosses the boundary.

---

## 8. Limitations and caveats

1. **The run ends at reasoning.** The reasoner backend is intentionally not
   running, so no action is proposed and the per-action gates are never
   exercised in the browser. `REASONER_FAILED` is the correct, fail-closed
   outcome, and it is itself a useful assertion: a terminal outcome, a reason
   code and a headline all reached the UI.
2. **The confirmation gate's positive path is untested in-browser.** Authorize →
   resume cannot be reached without a working reasoner. The dashboard → content
   script → service worker → `resumeWithConfirmation` chain is verified by the
   existing Phase 14 seam; only the completion is not.
3. **`pytest` remains unavailable** (`No module named pytest`), so the Python
   backend suite could not be run. No backend file was changed in this pass.
4. **The `statusbar-stage` is a rename, not new information.** It now shows the
   real phase instead of a constant, but it is derived from the same projection
   — deliberately, to avoid a second source of truth.
5. **Artifacts can concatenate.** The rendered panel shows
   `HARNESS: 1 cycle(s), 0 halt(s)PERCEPTION: 2 cycle(s)` as adjacent badges
   with no separator. Cosmetic only; no data is lost or merged incorrectly. Left
   alone to keep the diff minimal.
6. **The synthetic-dashboard gap is closed but the two harnesses now overlap.**
   `verify_phase14_production_path.mjs` proves the SW→dashboard wire contract
   against a minimal page; `verify_phase14_ui_correction.mjs` proves the real
   rendered UI. Both are kept: the first is faster and catches transport
   regressions the second cannot see as precisely.
