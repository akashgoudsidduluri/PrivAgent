# PHASE 17.4 — LONG-HORIZON RELIABILITY ACCEPTANCE REPORT

**HEAD at start:** `1bf0fcb` (Phase 17.3)
**Phase 17.4 work:** uncommitted, awaiting review
**Audit:** [`LONG_HORIZON_AUDIT.md`](./LONG_HORIZON_AUDIT.md)
**Machine evidence:** [`long_horizon_evidence.json`](./long_horizon_evidence.json), [`real_reasoner_evidence.json`](./real_reasoner_evidence.json)

---

## 1. Baseline

| Measure | Before 17.4 | After 17.4 |
|---|---|---|
| Test files | 108 | **109** |
| Tests | 1355 | **1385** (all passing) |
| `tsc -b --noEmit` | **0 errors** | **0 errors** |
| `build:extension` | pass | **pass** |
| `build:frontend` | pass | **pass** |
| `git diff --check` | clean | **clean** |

Phase 17.3 was clean, committed and pushed as `1bf0fcb`. A stale local clone initially
made it look absent; `git fetch` resolved it and local `main` fast-forwarded (local
`main` was a verified ancestor, so no commit was at risk). `scratch/phase17_3_uncommitted.patch`
did not exist. `scratch/verify_phase17_3_real_chrome.mjs` is present and untouched.

---

## 2. Defects found and fixed

The audit separated defects from protections. Four were fixed; one is documented as a
limitation; two are deliberately out of scope.

| ID | Defect | Fix | Status |
|---|---|---|---|
| **D1** HIGH | Stagnation detection could never fire. The sole call site passed `subgoalJustCompleted` derived from `lastActionResult.success`, so every successful dispatch counted as progress and `consecutiveNoProgress` never advanced. | `assessProgress` now derives `meaningful` from **observed change only**; the dispatch-derived value is no longer passed at all. | **FIXED** |
| **D2** MEDIUM | The fingerprint's action component was dead — the call site passed `undefined`, so it was permanently `'observe'`. | The attempted action is now passed in. | **FIXED** |
| **D3** MEDIUM | `(context as any).typed_value_length` read a field `AgentContextPayload` does not declare; the cast hid it and the value was permanently `0`, making a progress signal unreachable. | Cast and phantom field removed; the signal is declared unavailable rather than faked. | **FIXED** |
| **D4** MEDIUM | The long-horizon layer consumed **no** observation provenance, while 17.1 and 17.3 had both established exactly those gates for other consumers. | Reused `isSameDocumentIdentity` (17.3) and the 17.1 `viewportObservable` flag. No new contract invented. | **FIXED** |
| **D5** MEDIUM | Long-horizon state is per-`AgentLoop`-instance and is lost across an MV3 service-worker restart, resetting every bound mid-task. | Documented, **not implemented** — persistence needs a storage and restore contract, which is a design question. | **KNOWN LIMITATION** |
| **D6** LOW | `resumeWithConfirmation` re-dispatches a grounded action without re-validating against the current page generation. | Not changed — that alters authorization semantics, which this phase must not touch. | **OUT OF SCOPE** |
| **D7** LOW | `SUBGOAL_BUDGET_EXHAUSTED` accounting was not verified end-to-end. | Not claimed either way. | **OPEN QUESTION** |

### One further defect the tests found

The new test suite failed on first run and exposed a real one: `fingerprintObservation`
omitted the observed geometry entirely, so a page that genuinely **scrolled** produced
the same fingerprint as one that had not moved. Legitimate repeated scrolling was
therefore indistinguishable from a stuck page, and the loop detector fired on both. The
fingerprint now includes the observed geometry, with a distinct marker for the
unobservable case so "we could not read it" never collapses into "we read it and it did
not change". This is requirement 3C, and it was not visible in the source audit — only
in the test.

**Root cause in both cases:** the module's contract and its production wiring had
drifted apart. Both fixes are deliberately in the pure functions rather than at the call
site, so the rule holds for every present and future caller.

---

## 3. What was NOT changed

No new state machine. No new bounds system. No change to any gate, gate ordering, or
authorization path. No change to any goal-verification rule. No change to any defaults.
No new goal type. No OCR change. No visual-perception change.

`securityCritic.ts`, `containment.ts`, `harness.ts`, `riskEngine.ts`,
`actionValidator.ts`, `effectVerifier.ts`, `privacyPolicy.ts`, `agentBridge.ts`,
`rawValueScanner.ts`, and the whole `privacy/`, `security/` and `content/` trees are
**byte-identical to `1bf0fcb`**.

---

## 4. Tests

`tests/phase17/longHorizonReliability.test.ts` — **30 tests, all passing.**

| Area | Coverage |
|---|---|
| A | 5+ action task; progress per cycle; goal still verifier-only |
| B | repeated identical failed action; action changes the fingerprint |
| C | repeated action with **changing** observed state is not a loop |
| D/E | alternating A→B→A→B oscillation; recovery cannot terminate successfully |
| F/G/H/I | unobservable geometry; stale observation; document transition via 17.3 identity; `observeFromContext` carries the flag |
| J/K | every hard bound; budget exhaustion is not a verdict |
| L/M | completed subgoal is terminal; replan preserves completed; all-subgoals-done is not goal completion |
| N/O/P/Q | the 17.2A invariants still hold on the long-horizon path |
| R | **loop-level end-to-end** — the wiring, through the real `AgentLoop` |

Describe R is the one that matters most, because the pure-function tests cannot see the
call site. It includes the precise reproduction of D1: gates all happy, action grounded,
validated, dispatched, **and** effect-verified (the DOM really does change every cycle),
while the long-horizon observation stays byte-identical. Before 17.4 that could not be
detected; it now stops on an observation-backed bound well short of the 30-step ceiling.

**No existing assertion was weakened or deleted.** 0 assertions removed, 0 `it()` blocks
removed, 1 file added.

---

## 5. Mutation results — 6 / 6 caught

Harness `scratch/mut17_4.mjs`, assert-once anchors, verified tree restoration.

| # | Mutation | Result |
|---|---|---|
| **M1** | disable stagnation detection | **CAUGHT** (2 tests) |
| **M2** | ignore stale/unobservable observations | **CAUGHT** (2 tests) |
| **M3** | allow repeated failed action indefinitely | **CAUGHT** (4 tests) |
| **M4** | convert budget exhaustion to success | **CAUGHT** (3 tests) |
| **M5** | allow recovery to terminate successfully | **CAUGHT** (1 test) |
| **M6** | bypass the terminal/bounds check and re-inject dispatch bookkeeping | **CAUGHT** (1 test) |

M2 and M6 were **not** caught on the first attempt — the first test suite asserted the
wrong thing in both cases. Both were strengthened rather than the mutations dismissed:
M2 got a case where two *different* unobservable geometries must not read as movement,
and M6 got the loop-level end-to-end tests. The harness itself also had a real bug (two
edits to one file shared a single backup path, so `restore` reinstated the mutation) that
left the tree dirty; it is fixed, and the tree was verified clean afterwards.

---

## 6. Real Chrome — PROVEN_REAL for the reliability layer

`scratch/verify_phase17_4_long_horizon.mjs` → `long_horizon_evidence.json`.

**Substrate, stated precisely:** real headless Chrome, the real built MV3 extension, the
real service worker and content script, and **real trusted `Input.dispatchMouseEvent`
input at real element coordinates**, producing real navigations and real scrolls. The
**proposer was a deterministic fixture, not the model** — reproducibility is the point,
since the reliability layer is what is under test. The reliability *decisions* were made
by the identical production modules fed those real observations, because production
`verifyTaskGoal` is bundled and not exported to the service worker. **This is a hybrid
and is labelled one.**

### Positive: a genuine 12-cycle journey — **PROVEN_REAL**

12 real interactions across **7 distinct real pages**, with a real effect verdict after
every cycle and real observed progress at every cycle:

| # | Action | Effect verdict | Progress | URL after |
|---|---|---|---|---|
| 1 | open fixture home | ACTION_NO_EFFECT (first cycle) | ✓ | `/` |
| 2 | click `#go` | EFFECT_NAVIGATION | ✓ | `/results?q=` |
| 3 | click `#open-result` | EFFECT_NAVIGATION | ✓ | `/product?id=1` |
| 4 | click `#back-link` | EFFECT_NAVIGATION | ✓ | `/products` |
| 5 | click `#details-link` | EFFECT_NAVIGATION | ✓ | `/product?id=1` |
| 6 | click `#back-link` | EFFECT_NAVIGATION | ✓ | `/products` |
| 7 | click `#nav-pricing` | EFFECT_NAVIGATION | ✓ | `/pricing` |
| 8 | navigate `/long` | EFFECT_NAVIGATION | ✓ | `/long` |
| 9 | scroll 600 | **EFFECT_SCROLL** | ✓ | `/long` (scrollY changed) |
| 10 | scroll 600 more | **EFFECT_SCROLL** | ✓ | `/long` (scrollY changed) |
| 11 | navigate `/` | EFFECT_NAVIGATION | ✓ | `/` |
| 12 | type `cats` + click `#go` | EFFECT_NAVIGATION | ✓ | **`/results?q=cats`** |

**The task did not succeed because the sequence ended.** It succeeded at cycle 12 and
not before, because the goal verifier read `?q=cats` out of the *observed* URL:

> `Search goal verified against observed results URL: query 'cats' present at 'localhost'.`

Cycles 9–10 are the direct real-browser confirmation of the fingerprint fix: two real
scrolls, each with a genuinely changed `scrollY`, were each read as **progress**, not as
a repeated state. Before the fix they would have been indistinguishable from a stuck page.

### Negative: six cases, all recorded — **PROVEN_REAL**

| Case | Action | Effect verdict | Goal verdict | Recovery | Harness | Pass |
|---|---|---|---|---|---|---|
| 1 repeated failing action | click a target that does not exist, 4× | ACTION_NO_EFFECT (page re-read) | not satisfied | REPLAN on 3rd cycle | TERMINAL_BOUND | ✓ |
| 2 stale observation | none — observation only | N/A | not satisfied | no progress signal emitted | — | ✓ |
| 3 recovery loop | A→B→A→B across real fixture paths | EFFECT_NAVIGATION | not satisfied | REPLAN, `ALTERNATING_LOOP` | — | ✓ |
| 4 target-tab drift | `chrome.tabs.query` in the real SW | N/A | not satisfied | pinned target revalidated per cycle | — | ✓ |
| 5 budget exhaustion | dispatch until a bound fires | EFFECT_NAVIGATION | not satisfied | none — a bound is not a verdict | TERMINAL_BOUND | ✓ |
| 6 terminal-state restart | `resumeWithConfirmation()` after terminal | **N/A — no dispatch occurred** | not satisfied | **BLOCKED — resume refused** | — | ✓ |

Case 6 is the important one: the resume was **refused by a thrown error**, and the task
status was not `SUCCESS`. No action was dispatched and the terminal verdict was not
overwritten.

---

## 7. Real reasoner — **NOT_PROVEN**

`scratch/verify_phase17_4_real_reasoner.mjs` → `real_reasoner_evidence.json`.

The provider **is** configured (`groq`, `openai/gpt-oss-20b`, key present). The run was
attempted and **failed with HTTP 422 from `POST /api/v1/agent/action`**.

**The model was never invoked — 0 model cycles.** Root cause: `BackendAgentProvider`
hardcodes its endpoint to `127.0.0.1:8010`; the harness backend was first started on
8061, and on a retry at 8010 that port was already held by a foreign process, so the
harness backend never bound (its log is empty). A secondary possible cause is that the
hand-built `AgentContextPayload` does not match the backend's strict `extra="forbid"`
model — not isolated, because the port conflict made the first failure ambiguous.

**This is not evidence that the real reasoner is broken**, and it is explicitly not
evidence of real-reasoner long-horizon behaviour at all, because no model call happened.
**No scripted proposer was substituted in its place.** Fixing it needs port 8010 freed
and the context produced through the production `buildSanitizedAgentContext` /
`minimizeAgentContext` path rather than a synthesised object; that is harness work
outside this change set, and this phase does not claim the result.

---

## 8. Performance — measured only

From `long_horizon_evidence.json`:

- **Per-cycle: p50 788 ms, p90 973 ms, min 612 ms, max 993 ms** (12 cycles)
- **Total wall clock: recorded in the JSON**
- **Caveat, stated rather than buried:** each cycle includes a deliberate **700 ms settle
  sleep** after every trusted input event, so the number is dominated by that settle and
  is **not** a measure of agent work. It is reported as measured, with its cause.
- **Observation overhead:** NOT separately measured — a single `Runtime.evaluate` round
  trip folded into the cycle figure.
- **Memory:** NOT measured — no reliable in-harness measurement was available, so none
  is reported.
- **Provider latency:** separate; the real-reasoner run did not reach the model, so no
  provider latency is claimed.

---

## 9. Security / privacy regression — **PASS**

| Authority | Result |
|---|---|
| M5 / action validation | unchanged, byte-identical |
| Security Critic | unchanged, byte-identical |
| Risk / confirmation | unchanged, byte-identical |
| Effect verification authorization boundary | unchanged, byte-identical |
| Goal verification evidence rules | unchanged — 17.2A invariants intact |
| Containment | unchanged, byte-identical |
| Privacy fusion | unchanged, byte-identical |
| OCR redaction (17.3) | unchanged; `tests/phase17/ocrObservation.test.ts` green |
| Output privacy boundary | unchanged, byte-identical |
| Injection defenses | unchanged, byte-identical |
| Observed-effect fail-closed | unchanged |

Gate ordering is unchanged: 17.4 introduces no gate and reorders none.
Security/privacy regression set: **148 / 148 passing** across 9 files.

---

## 10. Status summary

| Claim | Status |
|---|---|
| Stagnation detection fires on repeated dispatch with an unchanged observation | **PROVEN_REAL** + PROVEN_TEST |
| Legitimate repeated action with changing observed state is not flagged | **PROVEN_REAL** (cycles 9–10) |
| Budget exhaustion never becomes SUCCESS | **PROVEN_REAL** + PROVEN_TEST |
| Recovery cannot terminate successfully | **PROVEN_REAL** + PROVEN_TEST |
| Terminal state cannot restart | **PROVEN_REAL** + PROVEN_TEST |
| Target-tab drift is handled | **PROVEN_REAL** (case 4) |
| 12-cycle real journey reaching a verifier-decided SUCCESS | **PROVEN_REAL** (fixture-paged) |
| Long-horizon state across a service-worker restart | **KNOWN_LIMITATION** |
| Real-reasoner long-horizon behaviour | **NOT_PROVEN** (model never invoked) |
| Open-web long-horizon reliability | **NOT_PROVEN** — every real run here is a controlled local fixture |
| `SUBGOAL_BUDGET_EXHAUSTED` accounting under replanning | **NOT_PROVEN** (D7, open) |

## 11. Known limitations

1. **D5** — long-horizon counters, fingerprints, completed subgoals and discoveries are
   lost if the MV3 service worker is terminated mid-task, resetting every bound.
2. **Real reasoner** — not exercised; see §7.
3. **Controlled fixture only** — every real-browser run used the local fixture. Nothing
   here is a claim about open-web long-horizon behaviour.
4. **Cycle latency** is dominated by a deliberate settle sleep, not agent work.
5. **`targetValueLength` progress signal remains unavailable** — no sanitized context
   field carries it. It is now declared unavailable rather than silently faked. Reading
   it belongs to Phase 17.2 proper's DOM/text goal type.
6. **`UNVERIFIABLE` still absent** from `GoalVerificationResult` (17.2 gap), so an unmet
   goal and an unsatisfiable goal remain indistinguishable.
7. **D6** — a confirmed action is re-dispatched without re-validating against the current
   page generation.

## 12. Non-goals

Not attempted, by instruction: Phase 17.5, Phase 17.6, new goal types, the three-state
goal contract, OCR changes, visual-perception redesign, and any change to a security or
privacy authority.
