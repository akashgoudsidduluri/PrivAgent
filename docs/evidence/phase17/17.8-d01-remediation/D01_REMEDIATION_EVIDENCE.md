# Phase 17.8 — D-01 Remediation Evidence

**Defect:** D-01 — privacy refusal trace reliability.
**Classification:** `FIXED` · `PROVEN_TEST` · `PROVEN_REAL` · `KNOWN_LIMITATION` (one, reported not fixed)
**Status:** remediation complete, **nothing committed, nothing pushed, Phase 17.9 NOT started**.
**Base commit:** `109db62` ("test(security): close the two mutation-audit coverage gaps found in 17.7").

---

## 1. The original defect

M5 correctly refuses a PII-bearing proposed action. While *recording that refusal*,
`AgentDecisionTracer.recordStep` throws `PrivacyBoundaryError`. The exception escapes
`runTask`.

Observed result:

- the security decision remained **fail-closed** — nothing was ever dispatched;
- but the refusal was **not recorded cleanly**: the task ended with no state, no
  reason and no trace at all.

This is a **reliability / observability defect, not an authorization defect**. The
security outcome was already correct before the exception was thrown and is unchanged
by catching it.

## 2. Root cause

`extension/src/agent/decisionTrace.ts:73` runs the raw-value firewall over the **whole**
entry:

```ts
assertNoRawSensitiveValues(fullEntry, { extraStructuralKeys: ['text'], allowedKeyNames: ['text'] })
```

Every entry written by the agent loop includes `proposedAction: action`, and every one of
the ten `tracer.recordStep` call sites in `agentLoop.ts` passes the model's proposal
verbatim. So when the model proposes an action carrying a raw value, the trace that
exists to **record the refusal** is itself rejected for carrying that value.

The loop was therefore correct to refuse and structurally unable to say so.

A note on precision, because the Phase 17.8 report understated this: the 17.8 report said
"two call sites". There are **ten** — at `agentLoop.ts` lines 1092, 1203, 1294, 1350,
1418, 1498, 1734, 1822, 1991, 2315 before the fix, all inside `runTask`, all passing
`proposedAction: action`. All ten are covered.

## 3. Reproduction

Reproduced first with the existing Phase 17.8 probes, not with a new harness:

| Probe | Before | After |
|---|---|---|
| **R2** — PII typed into an ordinary control | `finalStatus: THREW_PrivacyBoundaryError` | `finalStatus: FAILED`, `dispatched: false` |
| **R10** — a PII value typed into an ordinary control | `finalStatus: THREW_PrivacyBoundaryError` | `finalStatus: FAILED`, `dispatched: false` |

Full 16-probe reachability set after the fix: **0 probes throw**, and every probe's
dispatch matches its `expectedDispatch`.

## 4. The exact fix

One file: **`extension/src/agent/agentLoop.ts`**. 87 insertions, 10 deletions.

1. **One import** — `PrivacyBoundaryError` from `../privacy/rawValueScanner`.
2. **One private counter + one public getter** — `decisionTraceWithheldCount` /
   `withheldDecisionTraceSteps`, so a host can see that a trace was incomplete instead
   of being handed a silently truncated one.
3. **One private helper**, `recordDecisionStep(tracer, entry)`, which wraps *only* the
   recording call:

```ts
try {
  tracer.recordStep(entry);
} catch (err) {
  if (!(err instanceof PrivacyBoundaryError)) throw err;
  this.decisionTraceWithheldCount++;
  console.info('[AgentTrace] decision trace withheld', {
    step: entry.step,
    reason: 'RAW_VALUE_IN_PROPOSAL',
  });
}
```

4. **Ten mechanical rewrites** — `tracer.recordStep({` → `this.recordDecisionStep(tracer, {`.

### Why this shape and not another

- **The `try` wraps the recording operation only.** It is not around the loop, not around
  a stage, not around the refusal handler. Everything else in `runTask` is untouched.
- **Only `PrivacyBoundaryError` is caught.** Every other exception is re-thrown
  unchanged, so this cannot become "ignore all tracing errors" — and a test pins that.
- **The marker is value-free by construction.** Its only inputs are `entry.step` (a
  number) and a fixed constant. No action, no page text, no model output, no reason
  string. Asserted on the emitted object, not on the source.
- **No fallback trace entry is written.** `DecisionTraceEntry.proposedAction` is
  required, so a "safe" entry would have to invent a placeholder action. Writing a
  fabricated proposal into an explainability trace is the exact class of fabrication
  this project exists to refuse, so the detailed entry is **withheld**, not replaced.
- **The original refusal stays authoritative.** It is already recorded by
  `this.recordStep(...)` into `state.steps` and by `state.reason`; neither runs the wire
  firewall, and neither is changed by this fix.

### Explicitly NOT changed

M5 authorization · privacy classification · the raw-value scanner · the decision tracer
itself · Grounding · Security Critic · Risk/Confirmation · Containment · Effect
Verification · Goal Verification · Recovery authorization · `person_name` · D-02.
No refactor, no redesign of the tracer or the loop, no new architecture.

## 5. Security impact

**None. The security posture is identical before and after.**

The throw happened *after* M5 had already refused, on the audit path. Catching it cannot
authorize, retry, weaken or bypass anything. Verified:

- M5 still refuses exactly the same inputs (`M5 still refuses exactly the same inputs`).
- The refused action is still never dispatched (unit test and real browser).
- No SUCCESS can be produced from the refusal.
- The raw-value firewall is untouched and still throws — the D-01 precondition is
  asserted directly in both the unit test and the real-Chrome probe, so the loop half
  cannot pass vacuously by the tracer quietly ceasing to throw.

## 6. Reliability impact

Before: a correct, safe refusal became an unhandled exception and the task produced no
state, no reason and no trace. After: the task reaches a normal terminal
`FAILED` state, the refusal is recorded in `state.steps` and `state.reason`, the trace
is withheld with a value-free marker, and the incompleteness is countable through
`withheldDecisionTraceSteps`.

## 7. Tests

`tests/phase17/phase178D01Remediation.test.ts` — **new, 16 tests, all passing.**

| # | Test | Covers |
|---|---|---|
| 1 | the PII-bearing action reaches M5, and M5 refuses it | brief 1, 2 |
| 2 | the decision tracer really does throw `PrivacyBoundaryError` | brief 3 (precondition gate) |
| 3 | `PrivacyBoundaryError` does NOT escape `runTask` | brief 4 |
| 4 | the task remains in a refusal/failure state, not SUCCESS | brief 5 |
| 5 | the refused action is NOT dispatched | brief 6 |
| 6 | no SUCCESS is produced anywhere in the state | brief 7 |
| 7 | the withheld trace is reported as withheld | — |
| 8 | no raw PII anywhere on the **audited** surface | brief 8, 9 (scoped — see §11) |
| 9 | **KNOWN LIMITATION** — refused action retained in the in-memory step record | §11 |
| 10 | the refusal itself is still recorded in state, with a reason | §4 |
| 11 | **an UNRELATED tracer error still propagates normally** | brief 10 |
| 12 | a normal M5 refusal with a functioning tracer behaves exactly as before | normal path |
| 13 | an unrelated error in the refusal path is not converted into a withheld trace | narrowness |
| 14 | M5 still refuses exactly the same inputs | no authority regression |
| 15 | a benign action is still allowed by M5 | no over-blocking |
| 16 | the withheld marker carries no action, page text or model output | brief: marker safety |

**Test 11 is the one that matters most.** If it regresses, the remediation has silently
become "ignore every tracing error", which would hide genuine bugs in the audit path and
would be worse than the original defect.

Three tests were failing when the file was first written and were corrected, not
papered over:

- a missing `btn-help` detection in the fixture context made "a benign action is still
  allowed by M5" fail on grounding (a test bug — the fixture lacked the target);
- a vacuous assertion on a TS-private method, replaced with an assertion on the marker
  the loop actually emits;
- test 8's scope, discussed honestly in §11 rather than quietly narrowed.

## 8. Mutation results

**Mutation definitions were not changed.** No definition was edited, relaxed or
re-anchored to make a result favourable. Detection is on the **vitest exit code only**
(the loop logs the literal string `M6 failed` on clean runs, so parsing output gives
false failures). Every mutated file was restored and the restore verified.

### Phase 17.8 harness — the six required mutations

| ID | 17.8 baseline | D-01 re-run | Exit |
|---|---|---|---|
| **M5** Effect Verification fabrication | CAUGHT | **CAUGHT** | 1 |
| **M5b** Per-field OBSERVED contract weakened | CAUGHT | **CAUGHT** | 1 |
| **M9** Recovery / self-healing authorization | ESCAPED (proven-equivalent) | **ESCAPED (proven-equivalent)** | 0 |
| **M9b** Healed target trusted without re-gating | CAUGHT | **CAUGHT** | 1 |
| **M11** Privacy egress leak (raw-value firewall disabled) | CAUGHT | **CAUGHT** | 1 |
| **M11b** F-08 re-opened (OCR re-attached to the wire) | CAUGHT | **CAUGHT** | 1 |

**5 caught, 1 proven-equivalent escape (M9), 0 regressions — identical to baseline.**
Full data: `d01_mutation_results.json`.

### Phase 17.7 harness — all fifteen, re-run in full

M1, M2, M3, M4, M5, M5b, M6, M7, M8, M9b, M10, M11, M11b, M12 all **CAUGHT** (13 at the
targeted tier, M11 at the full tier). **M9 survives the entire 117-file suite**, exactly
as at the 17.7 baseline, where it was proven equivalent.

**14 caught / 15, all files restored, no result changed.**

Full data: `d01_mutation_17_7_results.json`. The raw harness output at
`scratch/.mut17_7_results.json` was transient state from this re-run and was deliberately
**restored to its pre-remediation committed version** rather than committed, so this file
is the authoritative D-01 comparison. The baseline it was compared against was confirmed
byte-identical to the HEAD version before the restore.

## 9. Privacy result

- Raw value on the audited surface (decision trace, `state.reason`, failure records,
  every rendered step field): **absent**.
- Raw value in the real browser console (service worker and page): **absent**.
- Raw value in the loop's own log: **absent**.
- Withheld marker fields: exactly `step` (number) and `reason`
  (`RAW_VALUE_IN_PROPOSAL`). The only string in the entire marker is the constant.
- Phase 17.8 benchmark after the fix: 104/104, 0 false allows, 0 false blocks, 46/46
  fail-closed, 0 security bypasses, 0 goal/effect success fabrications, 0 privacy
  leakages, 0 containment/recovery gate bypasses, attack lab 17/17, SIH 75 samples /
  0 leaked / F1 0.9259 (= baseline), egress `NO_LEAK`.
- Security/privacy suite: **20 files, all passing.**

### A note on the security/privacy file count

The 17.8 report recorded that suite as 20 files / 335 tests. Re-running it here selected
the same 20 *filenames* (19 matching `*security*` / `*privacy*`, plus
`tests/rawValueScanner.test.ts`) and they total **315** tests, not 335 — 298 in the 19
plus 17 in `rawValueScanner`. The 20th file in the 17.8 selection was evidently a
different one, worth 37 tests.

This is a **selection** difference, not a regression, and the full-suite arithmetic
settles it: 1547 = 1531 + 16 exactly, so not one test went missing anywhere. The
authoritative statement is that every security and privacy test passes.

## 10. Real-Chrome result — `PROVEN_REAL`

`scratch/d01_real_chrome.ts` → `d01_real_chrome_results.json`. **19/19 checks passed.**

The required observation — *PII-bearing proposed action → M5 refusal → trace handling
does not crash → no dispatch* — was made in real Chromium with the **production-built
MV3 extension** loaded, against a real checkout page.

**Real:** the browser (the same Playwright Chromium binary the earlier phases used),
the production `dist/` extension, the real content script performing a real
`PRIVAGENT_SCAN_REQUEST` DOM privacy scan, the real `buildAgentPayload` +
`minimizeAgentContext` egress path, the production `AgentLoop` / `AgentDecisionTracer` /
M5 / containment imported from source, and **real dispatch** — `executeAction` writes
into the live DOM and the value is read back from the page itself.

**Stubbed, and only this:** the model. A real reasoner cannot be made to deterministically
propose one specific raw value, and D-01 is precisely about what happens when one is
proposed. D-01 does not live in the provider.

Key observations:

| Check | Result |
|---|---|
| the production tracer throws `PrivacyBoundaryError` on this real proposal | **PrivacyBoundaryError** |
| `PrivacyBoundaryError` does NOT escape `runTask` against the real page | no exception |
| the task ends FAILED, not SUCCESS | `FAILED` |
| dispatches to the real page | **0** |
| the real page's recipient input | still `""` — the PII never reached the DOM |
| downstream page effect | still `no-receipt-yet` |
| `withheldDecisionTraceSteps` | `1` — withheld, not fabricated |
| audited surface / browser console / loop log | no raw value in any of them |
| the emitted marker | `{"step":1,"reason":"RAW_VALUE_IN_PROPOSAL"}` |

Real perception produced 2 real detections and identified the recipient input as
`privagent-det-1`.

## 11. Known limitation — reported, NOT fixed

**A refused action's raw value is retained in the loop's in-memory task state.**

The brief asked that no raw PII appear "anywhere in the resulting state". Written
literally, that does not hold, and **it did not hold before D-01 either**:
`state.steps[].action` is the loop's own `StepRecord`, written by `this.recordStep(...)`,
and it has always stored the full proposed action whether or not it was ever dispatched.
It does not pass through the wire firewall that governs the decision trace.

The value never left the process: not dispatched, not traced, not sent to a provider, not
rendered to a dashboard — all asserted in the unit test and observed in the real browser.

It was deliberately **not** fixed here. Closing it means changing the loop's step-record
data model, which is a different defect with a different blast radius, and the D-01 scope
forbids it. The test named `KNOWN LIMITATION: the refused action is retained verbatim in
the in-memory step record` pins the current behaviour exactly, so the gap stays visible in
CI and cannot drift silently in either direction. It is referred onward as a candidate
follow-up defect for an explicit decision.

## 12. Verification record

| Check | Result |
|---|---|
| `git diff --check` | **clean** |
| Focused D-01 tests | **16/16 passing** |
| Phase 17.8 benchmark | **23/23 passing**; 104/104 cases; 16/16 probes, 0 throwing |
| Phase 17.7 mutation audit (15) | **14 caught, M9 proven-equivalent, all restored** |
| Phase 17.8 mutations (6 required) | **5 caught, M9 equivalent — identical to baseline** |
| Security / privacy suite | **20 files, all passing** (see the note in §9 on 315 vs 335) |
| `tests/phase17` | **12 files / 260 tests, all passing** |
| Mutation-targeted suite | **63 files / 945 tests, all passing** |
| Full regression | **117 files / 1547 tests, all passing** |
| Backend pytest | **215 passed** |
| `tsc --noEmit` | **PASS (0 errors)** |
| `npm run build:extension` | **exit 0** |
| `npm run build:frontend` | **exit 0** |
| Real Chrome | **19/19 — PROVEN_REAL** |

### Test-count comparison against the 17.8 baseline

| | 17.8 baseline | After D-01 | Delta |
|---|---|---|---|
| Files | 116 | **117** | **+1** |
| Tests | 1531 | **1547** | **+16** |
| Backend pytest | 215 | **215** | 0 |

The entire increase is the new D-01 file. **Nothing was removed and no assertion was
weakened.** The 17.8 benchmark file is unchanged at 23 tests, and the new D-01 file adds
16. The three initially-failing tests were fixed at their causes (a missing fixture
detection, a vacuous private-method assertion, and an honestly re-scoped assertion) —
one of which added a test, taking the file from 15 to 16.

## 13. Files changed

### Production — one file

| File | Change |
|---|---|
| `extension/src/agent/agentLoop.ts` | +87 / −10: 1 import, 1 counter, 1 getter, 1 private helper, 10 call-site rewrites |

### Tests — one new file

| File | Change |
|---|---|
| `tests/phase17/phase178D01Remediation.test.ts` | **new**, 16 tests |

### Evidence

| File | Contents |
|---|---|
| `docs/evidence/phase17/17.8-d01-remediation/D01_REMEDIATION_EVIDENCE.md` | this report |
| `docs/evidence/phase17/17.8-d01-remediation/d01_mutation_results.json` | the six required mutations |
| `docs/evidence/phase17/17.8-d01-remediation/d01_mutation_17_7_results.json` | the fifteen-mutation 17.7 re-run comparison |
| `docs/evidence/phase17/17.8-d01-remediation/d01_real_chrome_results.json` | 19 real-Chrome checks |
| `scratch/d01_real_chrome.ts` | the real-Chrome probe (non-production) |

### Changed earlier, by Phase 17.8 — not by this remediation

`tsconfig.json` (adds `evaluation/phase17_8/**/*` to `include`) and
`scratch/mut17_7.mjs` (a one-line import guard for the 17.8 harness, documented in the
17.8 report §12.7) are pre-existing 17.8 changes, carried in the working tree, and are
included here only because nothing is committed yet.

## 14. Final classification

| Finding | Classification |
|---|---|
| D-01 — `PrivacyBoundaryError` escaping `runTask` while recording a refusal | **`FIXED`** |
| Proven by 16 focused regression tests, including the narrowness test | **`PROVEN_TEST`** |
| Proven in real Chromium with the production extension and a real page | **`PROVEN_REAL`** |
| Refused action's raw value retained in the in-memory step record | **`KNOWN_LIMITATION`** — reported, referred onward, not fixed |
| D-02 — goal-semantic recovery is inert | untouched, still documented |
| Real-reasoner multi-step SUCCESS through the product path | still `NOT_PROVEN` (out of scope) |

**D-01 is closed. No production behaviour outside `AgentLoop`'s trace call was changed.
Nothing is committed. Nothing is pushed. Phase 17.9 has not been started.**
