# PHASE 17.4 — LONG-HORIZON RELIABILITY ACCEPTANCE REPORT

**HEAD at start:** `1bf0fcb` (Phase 17.3)
**HEAD now:** `89817c6` — D1–D4 were committed there. **D5 remediation is a later, uncommitted change set on top and is not part of that commit.**
**Phase 17.4 work:** uncommitted, awaiting review
**Audit:** [`LONG_HORIZON_AUDIT.md`](./LONG_HORIZON_AUDIT.md) · **D5 audit:** [`LONG_HORIZON_AUDIT_D5.md`](./LONG_HORIZON_AUDIT_D5.md)
**Machine evidence:** [`long_horizon_evidence.json`](./long_horizon_evidence.json), [`real_reasoner_evidence.json`](./real_reasoner_evidence.json), [`d5_sw_restart_evidence.json`](./d5_sw_restart_evidence.json)

> This report covers two change sets: D1–D4 (§§1–12) and the later **D5
> remediation (§13)**. They are kept separate on purpose, so the earlier
> result is not restated or inflated by the later one.

---

## 1. Baseline

| Measure | Before 17.4 | After 17.4 |
|---|---|---|
| Test files | 108 | **109** |
| Tests | 1355 | **1385** (all passing) — and **1406** after the D5 change set (§13) |
| `tsc -b --noEmit` | **0 errors** | **0 errors** |

D5 baseline (at `89817c6`, before the D5 change set): **109 files / 1385 tests**,
`tsc` 0 errors, both builds green.
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
| **D5** MEDIUM | Long-horizon state is per-`AgentLoop`-instance and is lost across an MV3 service-worker restart, resetting every bound mid-task. | Deferred at the time; **remediated later** — see §13 and [`LONG_HORIZON_AUDIT_D5.md`](./LONG_HORIZON_AUDIT_D5.md). | **FIXED (D5 change set)** |
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
| Long-horizon state across a service-worker restart | **PROVEN_TEST** + **PARTIAL** real Chrome — see §13 |
| Real-reasoner long-horizon behaviour | **NOT_PROVEN** (model never invoked) |
| Open-web long-horizon reliability | **NOT_PROVEN** — every real run here is a controlled local fixture |
| `SUBGOAL_BUDGET_EXHAUSTED` accounting under replanning | **NOT_PROVEN** (D7, open) |

## 11. Known limitations

1. **D5** — *remediated in the D5 change set, see §13.* The residual limitation is
   now only that MV3 eviction durability rests on Chrome's documented
   `chrome.storage.session` contract rather than on an induced eviction in this run.
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

---

## 13. D5 remediation — separate change set, on top of `89817c6`

Full design audit: [`LONG_HORIZON_AUDIT_D5.md`](./LONG_HORIZON_AUDIT_D5.md).
Machine evidence: [`d5_sw_restart_evidence.json`](./d5_sw_restart_evidence.json).
Sections 1–12 above are **not restated** by this section.

### 13.1 Root cause

`agentLoop.ts:300` held the tracker as a `private readonly` instance field created in
the field initialiser. The service worker keeps the `AgentLoop` in a module-level
`activeLoop`, and MV3 evicts the whole JS context when idle. On revival a fresh
`AgentLoop` is constructed and `longHorizon.initialize()` runs again, so
`actionCount`, `recoveryCount`, `consecutiveNoProgress`, `totalNoProgress`, the
fingerprint ring, the last observation and the subgoal lifecycle all return to zero
**mid-task**. The bounds are the only thing preventing an unbounded run, so this is
the one D-class defect that could turn a bounded failure into an unbounded one.

### 13.2 Task identity

`hierarchicalGoal.goalId` is derived from the task *text*, so two runs of
"search for cats" share it — it is **not** a run identity and cannot be used as one.
A per-run `runId` is therefore minted once inside `runTask()`, which is the single
point at which a task begins, initialises the tracker, and terminates. It is an
identity token for reliability state, **not** a credential; it grants nothing.

### 13.3 Chosen persistence design

| Decision | Choice | Why |
|---|---|---|
| Store | `chrome.storage.session` (never `.local`) | MV3's in-memory session area, held by the browser process, survives worker eviction, **never written to disk** |
| Fallback | in-memory store, `persistenceAvailable: false` surfaced in state | degradation is explicit, never silent |
| Write point | **every cycle**, immediately after the long-horizon block | the task may never reach a terminal exit |
| Clear point | **every terminal exit** — `SUCCESS`, `FAILED`, `STOPPED` | secondary guard behind `runId` |
| Persisted | `actionCount`, `recoveryCount`, `consecutiveNoProgress`, `totalNoProgress`, bounded `fingerprints`, `lastObservation`, subgoal `{id,status,attempts}`, `lastLoop`, `lastStallReason` | exactly the fields that decide a bound, nothing else |
| Not persisted | `originalGoal` (only a `stableHash` digest), subgoal `description`, discovery `label` | free text and model-authored text may contain PII |
| Identity/versioning | `runId`, `goalDigest`, `schemaVersion`, `updatedAt` | rejects stale, foreign and incompatible records |
| Final gate | full serialized record passed through the existing `scanForRawSensitiveValues` before every write | same input-boundary defence `addDiscovery()` already uses |

Bounds themselves (`maxTotalActions`, `maxConsecutiveNoProgress`, `maxRepeatedStates`,
`maxStallActions`, `maxReplans`) are **construction parameters, not accumulated
state** — so a refused record cannot hand the agent unlimited budget.

### 13.4 Lifecycle and fail-closed behaviour

| Scenario | Behaviour |
|---|---|
| NEW TASK | no record, or a different `runId` → fresh tracker |
| SAME TASK + SW RESTART | `runId` matches → counters, fingerprints, last observation, subgoals restored |
| TASK COMPLETES | record cleared; terminal verdict never overwritten by restore |
| TASK EXPLICITLY RESET | record cleared; next task cannot inherit counters |
| NEW TASK AFTER OLD TASK | cleared on terminal exit **and** `runId` differs — double-guarded |
| PERSISTENCE FAILURE | record **refused and deleted**, fresh *fully bounded* tracker, `restoreStatus` surfaced |

Rejection rules on load: wrong `schemaVersion`; `runId` mismatch; `goalDigest`
mismatch; missing or non-numeric counter; negative counter; over-long array; subgoal
without an `id`. **All are refusals, never repairs.** Rejecting rather than failing
the task is deliberate: a corrupt blob would otherwise brick the agent, and the
existing semantics for "no usable state" are already "fresh bounded task". The
refusal is **never silent** — the status is carried on the loop and surfaced.

### 13.5 Privacy and authority

Persisted state is **metadata only**. The two exclusions are structural (the fields
are never written at all), not filtered after the fact. No raw page text, PII,
DOM, screenshots, passwords, OCR text, or model prompts/responses are inputs to this
record, and **no new outbound data path is created** — it is local extension state
consumed by one reliability class.

`LongHorizonTracker` remains a reliability mechanism only: it holds no gates, and
restoring a record can only make the agent **stop sooner**, never proceed. Verified
by test that goal `SUCCESS` cannot be created from tracker state, from recovery, or
from budget exhaustion (tests M, N, O below). `extension/src/privacy/`,
`extension/src/security/` and `extension/src/content/` are **byte-identical to
`89817c6`**; the security/privacy authority suite is **148/148 across 9 files**.

### 13.6 Manifest permission change — authority surface, flagged

`"storage"` was **added to `extension/manifest.json` permissions.** This is a
change to the extension's authority surface and is called out here rather than
buried.

It was not assumed to be needed — it was proven, by probing inside the **real**
service worker of the **real built extension**:

```
before manifest change:  hasStorage:false  local:false  session:false
after  manifest change:  hasStorage:true   local:true   session:true  roundTrip:true
```

Without it, D5 persistence is **dead code in the shipped build**. The same defect
has been silently affecting `memory/memoryStore.ts`, which guards on
`chrome.storage?.local` rather than on a permission — an object-existence check
that passes while the API throws.

Rejected alternative: degrade to memory. That would leave D5 unimplemented in
production. `storage` is the minimum permission that makes the required capability
exist; it exposes no API beyond `storage.local`/`session`/`sync` and adds no
warning that reveals user data. The availability probe and the explicit
`persistenceAvailable: false` degradation are **retained** regardless, so a build
or browser without the API fails loudly instead of silently losing bounds.

### 13.7 Focused tests

`tests/phase17/longHorizonPersistence.test.ts` — **21 tests, all passing.**

| Req | Coverage |
|---|---|
| A | state round-trips across a simulated SW restart |
| B | repetition count survives |
| C | stagnation counts survive |
| D | recovery / repeated-strategy state survives |
| E | budget-relevant counts survive; **no SUCCESS** is derived from them |
| F | a persisted tracker **cannot** be restored into a different task (refused **and** deleted) |
| G | explicit reset / terminal clear removes old state |
| H | **11 malformed-input cases**, each refused |
| I | old `schemaVersion` refused |
| J | no persisted record → fresh task |
| K | two independent tasks stay isolated |
| L | metadata only — asserts no `value`, `textContent`, `innerText`, `password`, OCR raw text, screenshot or PII |
| M | goal SUCCESS still cannot be created from tracker state |
| N | recovery still cannot create SUCCESS |
| O | budget exhaustion still cannot create SUCCESS |

Plus two end-to-end cases through the real `AgentLoop`: a write-then-clear over a
full run, and an unchanged run with no store configured.

**No existing test was weakened or deleted.** 0 assertions removed, 0 `it()` blocks
removed, 1 file added.

### 13.8 Mutation results — 5 / 5 caught

Harness `scratch/mut17_4_d5.mjs`, per-file backups, assert-once anchors, tree
verified clean afterwards (no stray `.mutbak`).

| # | Mutation | Result |
|---|---|---|
| **M1** | disable restore | **CAUGHT** (7 tests failed) |
| **M2** | accept state for the wrong `taskId` | **CAUGHT** (2 tests failed) |
| **M3** | treat malformed / old-schema state as valid | **CAUGHT** (1 test failed) |
| **M4** | stop persisting counters and the fingerprint ring | **CAUGHT** (6 tests failed) |
| **M5** | allow old tracker state to leak into a new task | **CAUGHT** (3 tests failed) |

Each was reported only after the test actually failed under the mutant.

### 13.9 Real Chrome — **PARTIAL**, deliberately downgraded

`scratch/verify_phase17_4_d5_sw_restart.mjs` → `d5_sw_restart_evidence.json`.
Recorded **separately** from the existing journey result; that 7/7 result is not
restated or altered here.

**What is real:** real headless Chrome, the real built MV3 extension, the real
service worker, real `chrome.storage.session`. A production-serialized record was
written and read back (`actionCount=4`, `fingerprints=4`, `schemaVersion=1`), it
survived detaching the service-worker debugger and attaching a fresh CDP context,
and the **production** validator + restore recovered the counts and the loop
detection. A control shows a fresh tracker would have had `actionCount=0` and
`loopDetected=false`.

**What is not proven:** the eviction itself. `ServiceWorker.stopWorker` could not
be issued — the `ServiceWorker` CDP domain is unavailable on the browser-level
target in this Chromium build:

```
{"code":-32601,"message":"'ServiceWorker.enable' wasn't found"}
```

So the worker context was never destroyed, and the durability of
`chrome.storage.session` across a **true** eviction rests on Chrome's documented
contract, **not** on this run. The verdict is recorded as `PARTIAL` with
`serviceWorkerGenuinelyTerminated: false` rather than taking a false green.

### 13.10 D6 assessment — no scope change

`resumeWithConfirmation` re-dispatches an already-authorized action without
re-validating against the current page generation. **It does not bypass an
authoritative gate**: the action reached that point only because it had already
passed Grounding, M5, the Privacy Firewall, the Security Critic and
Risk/Confirmation — that is precisely why the loop paused. The redispatch is
continuation, not a new proposal, and afterwards the action still goes through
effect verification and goal verification. **Not changed.**

### 13.11 D5 regression totals

| Measure | Value |
|---|---|
| Test files | 110 (was 109) |
| Tests | **1406 / 1406 passing** (was 1385) |
| `tsc -b --noEmit` | **0 errors** |
| `build:extension` / `build:frontend` | both exit 0 |
| `git diff --check` | clean |
| Security/privacy authority suite | **148 / 148 across 9 files** |
| `privacy/`, `security/`, `content/` vs `89817c6` | byte-identical |
| 17.4 focused suites re-run | `longHorizonReliability` 30/30, `longHorizonPersistence` 21/21 |
| Mutation suite | **5 / 5** |

### 13.12 Residual limitations for D5

1. MV3 eviction durability is proven by Chrome's **documented contract**, not by an
   induced eviction in this run (§13.9).
2. The record is bounded to one active run by design; there is deliberately **no**
   cross-task or cross-session reliability memory.
3. Discoveries are not persisted (their labels are model-authored text); a resumed
   task rediscovers them.
4. `D5` persistence covers the long-horizon tracker only. The other
   per-instance loop state was not in scope.
