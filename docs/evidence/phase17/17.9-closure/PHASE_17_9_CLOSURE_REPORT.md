# Phase 17.9 — Final Closure Audit

**Verdict: `PHASE_17_9_COMPLETE`**
**Commits:** `109db62` (17.7 baseline) → `fe21961` (D-01 + 17.8) → `ed9d35e` (D-02). `main == origin/main`.
**New D-items found: none.**
**Production code modified during this audit: none.**

---

## 1. Phase 17.9 scope

Two defects, both inherited from the 17.8 audit and neither a security bypass.

| | Defect | Nature | Outcome |
|---|---|---|---|
| **D-01** | `PrivacyBoundaryError` escaped `runTask` while recording a refusal | Reliability / observability | **FIXED** |
| **D-02** | Goal-alignment recovery was unreachable from every call site | Correctness / dead code | **FIXED** |

Both failed **safe**. D-01 meant a correct refusal destroyed its own audit trail; D-02 meant recovery silently degraded to token similarity. Neither ever dispatched anything unauthorized.

## 2. D-01 closure

`AgentLoop` now wraps the trace-recording call so a `PrivacyBoundaryError` becomes a
value-free withheld marker, and re-throws everything else. The security decision is
unchanged: M5 had already refused before the throw, and nothing about catching it can
authorize, retry or bypass anything.

The tracer itself was not weakened. The firewall still throws — and the D-01
precondition is asserted directly in both the unit test and the real-Chrome probe, so
the loop half cannot pass vacuously by the tracer quietly ceasing to throw.

**Still fixed.** 16/16 focused tests; the tracer still throws `PrivacyBoundaryError` on
the real proposal in Chromium.

## 3. D-02 closure

`recoverStaleTarget` computed its goal hint from a fourth parameter no caller supplied,
so the goal-alignment block could never run. The defect had **three** layers: the call
sites omitted the goal; the three-argument form stored it in a local the hint did not
read; and that local was assigned twice and **read zero times**.

Both production call sites now pass `this.state.taskGoal`, and the hint reads the goal
the function actually resolved.

**Still fixed.** Measured on the production call shape: **0.00 → 0.90**, with a
non-matching goal and a missing goal both holding at 0.00, so fail-closed behaviour is
preserved. Observed firing in real Chromium.

## 4. Final security audit

Performed against current production source, not against the prior reports.

| Question | Finding |
|---|---|
| Any remaining fail-open authorization path? | **None found.** |
| Recovery directly authorizing or dispatching? | **No.** See §5. |
| Fabricated SUCCESS? | **None.** 0 goal fabrications, 0 effect fabrications in the benchmark; recovery success never becomes task success in any of three goal configurations. |
| Fabricated recovery/goal evidence? | **No.** The healed `reason` is regenerated (`Self-healed target (STRATEGY): <selector>`), never copied from the model. |
| Privacy boundary bypass? | **None.** See below. |
| Raw-value leakage into outbound/provider/dashboard? | **None.** No raw value in any browser log, loop log, decision trace or wire payload. |
| D-02 goal propagation bypassing normal gates? | **No.** The goal influences only which candidate recovery *proposes*; adoption still requires GATE 1 and M5. |
| Regression introduced by D-01/D-02? | **None found.** |
| Stale evidence contradicted by current code? | **One**, corrected — see §14. |

### The privacy question D-02 could plausibly have broken

`recoverStaleTarget` copies a `type` action's `text` **verbatim** into the healed
action. Before D-02 that was nearly inert, because the healed action was almost never
proposed. D-02 makes proposals routine, so the laundering path had to be checked
rather than assumed.

It is closed. A `type` action whose text is a raw value is refused by M5 as proposed;
recovery then proposes a goal-aligned replacement that **still carries the same raw
text**; M5 re-validates the healed action and **refuses it again**; the healed reason is
regenerated and contains no raw value; end to end through the loop **nothing is
dispatched**. Recovery cannot launder a raw value past M5.

**14/14 checks passed** (`scratch/closure_privacy_probe.ts`).

## 5. Recovery authorization analysis

This is the area D-02 actually widened, so it was audited exhaustively.

There are exactly **two** recovery entry points in production, and exactly **one**
adoption point.

- **Entry point 1** (`agentLoop.ts:1220`) — M5 refused the proposal, recovery proposes a
  replacement. Adoption happens at **line 1233**, and only inside
  `if (healedVal.allowed)`, where `healedVal` is the result of re-running **GATE 1
  grounding and M5 on the healed action**. After adoption the action continues through
  **GATE 2.5 Security Critic (1327) → GATE 3 Privacy Policy (1400) → GATE 4
  Risk/Semantic (1473) → Containment (1693) → `executeAction` (1751)**. No gate is
  skipped.
- **Entry point 2** (`agentLoop.ts:1772`) — execution failed, recovery records a
  proposal. It **never reassigns `action`**. Nothing is dispatched from this branch; the
  proposal is recorded for the next loop iteration to re-enter the pipeline.

**Recovery may propose. It may never authorize. Verified in source.**

### M9 is genuinely equivalent, and structurally so

M9 has escaped the suite since 17.7. "Escapes" has two meanings — true equivalence, or
a coverage gap — and D-02 widened what recovery proposes, so this audit re-derived it
rather than accepting the label.

**M9's anchor is `if (healedVal.allowed) {` at line 1233.** Replacing it with `if (true)`
still runs the body, which assigns **both** `action` and `validation = healedVal`. Since
`healedVal.allowed` is false, the very next gate — `if (!validation.allowed)` at line
1248 — takes the refusal path. **The adoption M9 performs is immediately discarded.**

That is why **M9b is caught and M9 is not**: M9b's anchor additionally covers the two
assignment lines and neutralises `validation`, so the line 1248 gate is bypassed and the
wrongly-typed healed target really is dispatched.

Measured directly (`scratch/m9_equivalence_probe.ts`), with the source restored and
verified by hash:

| Scenario | Baseline | Under M9 | |
|---|---|---|---|
| goal-aligned candidate is a `button` | dispatched `[txn-history]` | dispatched `[txn-history]` | identical |
| goal-aligned candidate is a `heading` | dispatched `[]` | dispatched `[]` | identical |

**Equivalence is structural, not accidental** — a single variable (`validation`) is set
by both the normal and the healed path, and that is what line 1248 consults. D-02 did
not widen M9's escape surface.

**This is not a production defect.** Production has `if (healedVal.allowed)` and refuses
correctly.

## 6. M9 / M9b / R12

| | Expected | Actual | |
|---|---|---|---|
| **M9** | ESCAPED (proven-equivalent) | ESCAPED, exit 0 | unchanged |
| **M9b** | CAUGHT | CAUGHT, exit 1 | unchanged |
| **R12** | `expectedDispatch: false` | `dispatched: false`, `FAILED`, no throw | fail-closed |

## 7. H1 / H2 / H3

| Case | Expected | Actual | |
|---|---|---|---|
| **H1** | `RECOVERED` | `RECOVERED` | correct |
| **H2** | `REFUSED` | `REFUSED` — healed target failed re-grounding (`TARGET_MISMATCH`) | correct |
| **H3** | `NOT_RECOVERED` | `NOT_RECOVERED` | correct |

The H1 and H3 rationales were updated in 17.9 to stop describing D-02 as a dead branch.

## 8. Privacy / security verification

| Check | Result |
|---|---|
| Security / privacy suite | **20 files / 315 tests, all passing** |
| Benchmark privacy leakages | **0** |
| Egress boundary | **`NO_LEAK`** |
| SIH PII corpus | 75 samples, **0 leaked**, F1 0.9259 (= baseline) |
| Attack lab | **17/17 neutralized** |
| `person_name` | **untouched** — 0 matches in the phase production diff |
| Raw value in browser / loop logs | **absent** |
| Raw value in decision trace | **absent** |
| Recovery laundering a raw value past M5 | **closed** (14/14) |

## 9. Mutation results

| | Result |
|---|---|
| Phase 17.7 harness, all 15 | **14 caught**, M9 proven-equivalent, **all files restored** |
| Definitions changed | **none** |
| Detection | vitest exit code only |
| Verdict | **identical to baseline — 0 regressions** |

The full fifteen were re-run during the D-02 remediation. The working tree was then
confirmed to match `ed9d35e` for **every code path** before this audit, and M9/M9b were
run again during closure. Mutation definitions were not touched at any point.

## 10. Full regression and builds

| Check | Result |
|---|---|
| D-01 suite | 16/16 |
| D-02 suite | 13/13 |
| D-01 + D-02 combined | **29/29** |
| Phase 17.8 benchmark | **23/23**; **104/104** cases |
| False allows / false blocks | **0 / 0** |
| Fail-closed | **46/46** |
| Security / privacy | **20 files / 315** |
| `tests/phase17` | **13 files / 273** |
| Full regression | **118 files / 1560 tests** |
| Backend pytest | **215 passed** |
| `tsc --noEmit` | **0 errors** |
| `npm run build:extension` | **exit 0** |
| `npm run build:frontend` | **exit 0** |
| `git diff --check` | clean |
| `git diff --cached --check` | clean |

**Test counts.** 17.8 baseline was 116 files / 1531 tests. Closure is **118 / 1560** —
**+2 files, +29 tests**, exactly the two remediation files. Nothing removed, no assertion
weakened. Backend unchanged at 215.

## 11. Real-Chrome result — `PROVEN_REAL`

Both existing probes re-run at closure. **No new harness was built**; the D-02 probe
reuses `scratch/phase16_cdp.mjs`.

| Probe | Checks | Result |
|---|---|---|
| `scratch/d01_real_chrome.ts` | **19/19** | D-01 still fixed — `PrivacyBoundaryError` still thrown by the tracer, still not escaping `runTask`, page input still empty |
| `scratch/d02_real_chrome.ts` | **12/12** | D-02 firing in production — healed goal-aligned control dispatched, original refused control never dispatched, page shows `history-opened` |

**Real:** Chromium, the production-built MV3 extension, the real content-script DOM
scan, the real egress path, the production `AgentLoop`/M5/grounding/containment, and real
dispatch into the live page.

**Stubbed, and only this:** the model provider. A real reasoner cannot be made to
deterministically propose one specific refused action, and neither defect lives in the
provider.

## 12. Known limitations — carried forward

1. **`state.steps[].action` retains a refused action's raw value in memory.** Predates
   D-01. Never dispatched, traced, sent to the provider or rendered. Documented and
   pinned by a test. **Not fixed in 17.9, by instruction.**
2. **Goal alignment is two hard-coded branches** (`transaction`/`history` → 0.90,
   `account`/`details` → 0.88). D-02 made the branch reachable, not general. Widening
   the vocabulary is a design question and was deliberately not taken.
3. **M9 remains a proven-equivalent mutant.** Structural, and re-derived here. Not a
   coverage gap.

## 13. NOT_PROVEN capabilities

- **Real-reasoner multi-step SUCCESS through the product path** — unchanged from 17.8.
  Not reinterpreted as a security defect; provider and `person_name` logic untouched.
- **Behaviour under a real provider outage or rate limit** — not observed.

## 14. Remaining repository-hygiene issues

None of these is a PrivAgent security-authority defect.

1. **`benchmark_results.json` is rewritten by running the benchmark.** Timings differ
   each run; every substantive field is verified identical. Not altered.
2. **The two real-Chrome probes rewrite their committed evidence with volatile Chrome
   tab IDs.** Verdicts and check counts are identical — verified by diff, which showed
   only two integers changed.
3. **`scratch/` has no `.gitignore` rule**, so harness journals and results are
   untracked noise that must be excluded by hand at every commit. Not changed.
4. **One stale evidence claim found and corrected.** The 17.8 report still presented
   D-02 as an open defect. A forward reference to the 17.9 resolution was added — the
   finding itself is preserved as the historical record, and the note also records the
   **third** layer (the write-only local) that 17.8's "two reasons" did not name. This
   is the only file changed during the audit, and it is documentation, not code.

## 15. Final Phase 17.9 verdict

| Closure criterion | Status |
|---|---|
| D-01 remains fixed | yes |
| D-02 remains fixed | yes |
| Recovery cannot bypass authorization | yes — verified in source |
| No new security/privacy D-item found | yes |
| M9 still proven-equivalent | yes — re-derived, structural |
| M9b caught | yes |
| R12 remains fail-closed | yes |
| H1/H2/H3 correct | yes |
| No raw-value egress regression | yes |
| Full regression and builds pass | yes — 1560/1560, 215, tsc, both builds |
| Known limitations explicitly carried forward | yes — three |
| No unexplained production diff | yes — two files, both explained and committed |

### Classification summary

| Capability | Status |
|---|---|
| D-01 fixed; refusal tracing non-fatal; firewall unweakened | **`PROVEN_TEST`** + **`PROVEN_REAL`** |
| D-02 fixed; goal-alignment recovery reachable and gated | **`PROVEN_TEST`** + **`PROVEN_REAL`** |
| Recovery cannot authorize or dispatch | **`PROVEN_TEST`** + source-verified |
| Raw values cannot be laundered through a healed action | **`PROVEN_TEST`** |
| M9 equivalence, structurally derived | **`PROVEN_TEST`** |
| `state.steps[].action` raw-value retention | **`KNOWN_LIMITATION`** |
| Two hard-coded goal-alignment branches | **`KNOWN_LIMITATION`** |
| Real-reasoner multi-step SUCCESS | **`NOT_PROVEN`** |
| Provider-outage behaviour | **`NOT_PROVEN`** |
| Benchmark artifact churn | **hygiene, not a defect** |

**`PHASE_17_9_COMPLETE`.** No unresolved security or privacy defect from the 17.9 scope
remains. Three limitations are carried forward explicitly, and no Phase 18 work has
begun.
