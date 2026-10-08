# A10 — Phase 18.6 §14 Real-Browser Evaluation Matrix

**Harness:** `extension/src/telemetry/a10MatrixHarness.ts` (`phase18.6-a10-1`), self-tested by
`tests/phase18_8_a10HarnessSelfTest.test.ts` (27 tests).
**Driver:** `scratch/a10_matrix_run.mjs` (records one §14 row per real-Chrome run).
**Grader:** `scratch/a10_matrix_grade.ts` (grades with the harness; no grading rule lives in the driver).
**Diagnostic probe:** `scratch/_a10_screen_probe.ts` (F1).
**F1 regression:** `tests/phase18_8_f1StructuralOutputScreen.test.ts` (7 tests).
**Artifacts in this directory:** `artifact.json` (records + run metadata), `graded.json` (verdicts,
summary, privacy scan, coverage), `raw_<row>.json` (the unmodified run artifact of
`scratch/p185_real_run.mjs`, whose header states the provider it actually used),
`<row>.record.json` (the extraction).

**Status: NOT CERTIFIED — all 10 §14 rows executed in real Chrome (10/10 recorded runs), 3 certified
`PASS`, 7 refused `FAIL`, 0 `BLOCKED`, 0 `NOT_RUN`. Every recorded run is `CONTROLLED_PROVIDER`; no
live-provider run exists, so the live-provider rows remain uncertified.**

`--require-pass` exits **1** and `graded.json` records `pass: false` with a per-row reason. No row is
`PASS` without a real-Chrome run, no verdict was hand-edited, and no row was upgraded.

---

## 1. How to reproduce

```bash
node scratch/a10_matrix_run.mjs --list                    # the §14 recipes
node scratch/a10_matrix_run.mjs --execute S10             # run a row (real Chrome)
node scratch/a10_matrix_run.mjs --record S1,S4,S7,S9,S10  # re-derive from raw artifacts, no browser
npx vite-node scratch/a10_matrix_grade.ts                 # grade; --require-pass exits non-zero unless 10/10

# the rows authored for a live provider run under the controlled stub while it owns :8010 —
# the override is stamped into the artifact and the record keeps the CONTROLLED label
A10_PROVIDER=CONTROLLED node scratch/a10_matrix_run.mjs --execute S2
```

Needs: the built extension (`npm run build:extension`, loaded from `dist/` — a product change is only
observable after a rebuild), the dashboard on `:5173`, the shopping fixture on `:4174`, the banking
fixture on `:4175`, and a reasoner gateway on `:8010`.

## 2. Provider honesty

`:8010` was bound, for **every** run recorded here, by the controlled stub already running in this
workspace (`python3 scratch/i8a7a8_controlled_provider.py`, started by the earlier controlled-evidence
work; mode is switchable with `GET /mode?set=<mode>` and the driver restores the previous mode). The
production backend is the FastAPI gateway (`backend/app/main.py`) whose configured port **is** 8010, and
the extension's gateway base is the hard-coded `http://127.0.0.1:8010` — so the live path exists and is
configuration-complete (`reasoner_mode: groq`, API key configured, fallback `openrouter`,
`reasonerClass: GroqReasoner`) but is unreachable while the stub owns the port. Replacing a pre-existing
process on that port is an environment decision, not a test decision, so **it was not taken**: the rows
authored for a live provider were executed as `CONTROLLED_PROVIDER` (labelled as such) or not certified.

**Provider mode is read from the run, not from the recipe.** The raw header
(`PROVEN_REAL_CHROME / CONTROLLED_PROVIDER (stub_mode=…)`) is stamped at run time and read back, so
re-recording cannot relabel a run — and the response telemetry the gateway/stub stamps is now recorded
too (`provider_evidence=response-telemetry=controlled_stub` on every row that reached a provider;
`none (no provider call in this run)` on S1/S9/S10, which never needed one). A live run would have to
show a live provider name there. No run is relabelled `LIVE_PROVIDER`.

## 3. Grading result (`graded.json`)

| Row | §14 scenario | Provider | Executed | Terminal observed | Verdict | Grader reason |
|---|---|---|---|---|---|---|
| S1 | Wikipedia information lookup | CONTROLLED | yes | SUCCESS | **PASS** | contract satisfied (24/24 verified-current, 0 actions) |
| S2 | Search → result → information | CONTROLLED (`act_then_answer`) | yes | PARTIAL | **FAIL** | cited=0 (ledger 48, verified-current 16) |
| S3 | Multi-page information | CONTROLLED (`act_then_answer`) | yes | PARTIAL | **FAIL** | cited=0 (ledger 48, verified-current 16) |
| S4 | Information requiring scrolling | CONTROLLED (`act_then_answer`) | yes | PARTIAL | **FAIL** | cited=0 (ledger 34, verified-current 14) |
| S5 | Missing information | CONTROLLED (`act_then_answer`) | yes | PARTIAL | **FAIL** | `PARTIAL` ∉ expected `[NEEDS_INFORMATION]` |
| S6 | Stale evidence | CONTROLLED (`freshness_demo`) | yes | FRESHNESS_UNVERIFIED | **FAIL** | `FRESHNESS_UNVERIFIED` ∉ expected set |
| S7 | Sensitive-data page | CONTROLLED (`act_then_answer`) | yes | PARTIAL | **FAIL** | cited=0 (ledger 33, verified-current 11) |
| S8 | Navigation + information | CONTROLLED (`act_then_answer`) | yes | PARTIAL | **FAIL** | cited=0 (ledger 60, verified-current 24) |
| S9 | Ambiguous request | CONTROLLED | yes | NEEDS_CLARIFICATION | **PASS** | contract satisfied (0 provider calls, 0 dispatches) |
| S10 | Provider failure | CONTROLLED (`server_503`) | yes | PROVIDER_UNAVAILABLE | **PASS** | contract satisfied (0 dispatches, 0 speculative actions) |

Rows S2, S3, S4, S7 and S8 accept `PARTIAL` as a terminal — they fail **only** on the citation gate
(the harness requires a verified/current record to be cited for a claim-bearing terminal, §14's
anti-false-success rule). Rows S5 and S6 fail on the terminal set. Nothing failed on privacy, browser
evidence, mandatory fields, destination, generations, URL span or provider-call bounds.

**S1 — PASS (the strongest record here).** Route `PIPELINE`, intent `MIXED_TASK` (destination +
evidence required), the real `https://en.wikipedia.org/wiki/Charminar` page perceived in real Chrome
(screenshot 1265×757, 98 visual regions, 37 privacy findings), 24 semantic facts ingested into the
ledger **all verified-current at generation 2**, and the GoalVerifier satisfied the task by rule `2c`
with `composedVerifiedRecords: 7`. The row is satisfied by a *controlled* provider: real-DOM perception,
ledger freshness and citation-backed completion are proven; real-*provider* behaviour is not (the run
never needed the provider).

**S9 — PASS.** `intent classified {"intent":"AMBIGUOUS","refusal":"AMBIGUOUS_NO_GUESS"}`,
`task not admitted by the intent boundary`, **0 requests to `/api/v1/`**, 0 tabs, 0 dispatches,
terminal `NEEDS_CLARIFICATION` with a truthful user message.

**S10 — PASS.** Three `POST /api/v1/agent/action` calls returned `503`; typed recovery records
`PROVIDER_UNAVAILABLE` / `RETRY_BUDGET_EXHAUSTED`; terminal `PROVIDER_UNAVAILABLE`; 0 dispatches; the
3 verified ledger records present at the time were **not** used to claim an answer.

**S2 / S3 / S8 — FAIL, and the run itself says why.**
`[AgentTrace] terminal proposal received {"proposed":"ANSWER","status":"PARTIAL","supportedRecords":0,
"downgraded":true,"rejected":["INSUFFICIENT_EVIDENCE"]}` followed by
`task terminated {"status":"PARTIAL","supportedRecords":0,"downgraded":true,"answerChars":0}`. The
controlled provider answered *after* acting, cited the verified/current records the device showed it,
and the device resolved them against its own ledger, found **no record that matched the question's
subject**, and refused to compose an answer from them (`answerChars: 0`). The pages these rows ask
about were never actually pursued (the stub scrolls; it does not search), so no subject-matching
evidence ever existed. Cause: **C (provider/environment limitation) with the correct fail-closed
behaviour D** — not a product defect: the product's citation verification worked exactly as designed
and produced no false success.

**S4 / S7 — FAIL on the same citation gate, after a recipe correction.** Both were first executed with
`scroll_down`, a stub mode that proposes an ACTION on every cycle and **never** a terminal state; the
runs could only end on a bound (`FAILED`), which measured bound exhaustion rather than the row. The
recipe now uses `act_then_answer` (gather, then propose a terminal) and both rows reached `PARTIAL`,
with the same honest `supportedRecords: 0` downgrade as S2/S3/S8. Row 7's privacy property is measured
anyway and is clean: `semantic observation {"droppedSensitive":0,"quarantinedInjection":0}`, **no raw
value anywhere in the artifact**, output screen `CLEAR`.

**S5 — FAIL as a semantic difference, not an error.** The row expects `NEEDS_INFORMATION`; the run
reached `PARTIAL` with `rejected=INSUFFICIENT_EVIDENCE`. That is `verifyTerminalProposal`'s deterministic
ladder: an `ANSWER` proposal with no subject-matched support but verified facts in the ledger is
downgraded to `PARTIAL` ("I have verified facts, just not about your question"), and only falls to
`NEEDS_INFORMATION` when nothing at all is verified. Change class: **A/E (contract semantics)** — the
§14 row and the A9 terminal ladder disagree about which honest terminal this situation deserves.
Changing the ladder to satisfy the row would be changing a verification authority to improve the score,
so it was **not** touched.

**S6 — FAIL on the terminal set.** The stale-evidence row reached `FRESHNESS_UNVERIFIED` (4/4
verified-current records, 2 generations). That is a fail-closed freshness terminal outside the row's
expected set. Whether row 6 should *accept* it is a contract decision, not a code fix, and was **not**
made. The harness also observes that ID-level staleness (`staleEvidenceInvalidated`) is not externally
readable, so a future certification of this row needs either that instrument or a terminal the row
admits.

**Zero false successes.** No row claimed a result it could not support: the only `SUCCESS` has 24
verified-current records and 7 cited ones behind it; five rows that could not support an answer were
downgraded to `PARTIAL` with `answerChars: 0`; the provider outage was reported as an outage; the
ambiguous request cost nothing; and no raw sensitive value appears anywhere in the artifact
(`graded.json` privacy scan clean, 0 findings).

## 4. Findings

**F1 — a machine-generated containment label made the output screen drop the whole terminal
projection. RESOLVED (representation only; the scanner was not weakened).**
Root cause: `screenAgentOutput` scans the projection as whitespace-delimited tokens and
`credential_token` matches any token mixing upper case, lower case and a digit. The CONTAINMENT artifact
label fused a closed-vocabulary code with a derived scope into a single token
(`WITHIN_SCOPE` + `contained:0.1` → `CONTAINMENT:WITHIN_SCOPE:contained:0.1`), which the heuristic
matched; `structureIsClean` then failed and the payload was replaced by the safe empty projection, so
the truthful reason the worker produced never reached the dashboard. The internal metadata was never
user- or model-facing data: it is a diagnostic label, so the correct fix was to stop *representing* two
independent fields as one token. The label is now `` `${code} ${scope}` `` (space separator,
`extension/src/agent/agentOutput.ts`). **No scanner rule, no allowlist and no exclusion was added**: the
label is still scanned with the full rule set, and a genuine credential shape anywhere in it still fails
closed. Evidence: `tests/phase18_8_f1StructuralOutputScreen.test.ts` (7 tests — genuine
credential-like values still block; the containment diagnostic no longer drops unrelated terminal
output; no raw value can enter the diagnostic; screening stays fail-closed on a malformed projection)
and the additions to `tests/phase14/agentOutput.test.ts`. Verified in real Chrome: S4/S7 no longer
report `OUTPUT_SCREEN_BLOCKED`, and the independent artifact scan is clean.

**F2 — the containment root host for an IPv4 literal collapses to its last two octets. CONFIRMED, NOT
MODIFIED.** `containment scope established {"rootHost":"0.1"}` for `http://127.0.0.1:4174`, so
`hostWithinScope('10.0.0.1', '0.1')` is true (`endsWith('.0.1')`) and a task scoped to `127.0.0.1`
treats another IP-literal origin as inside its scope. Affected cases: every IPv4-literal fixture target
(`127.0.0.1:4174`, `127.0.0.1:4175`, `127.0.0.1:8010` → root host `0.1`). It did **not** affect any run
recorded here (no row acted across origins; containment was never bypassed), and it supplies the scope
text that made F1 fire. `extension/src/agent/containment.ts` is on the plan's DO-NOT-MODIFY list, so it
is unchanged: the fix (an IPv4 literal is one host, not a hierarchical name) needs its own task and its
own tests.

**F3 — citation observability. RESOLVED (metadata only), with one residual gap.**
An accepted terminal already logged the *count* of supported records, and the GoalVerifier path logs the
count it composed from; what could not be seen was **which** records, and **why** a proposal was
downgraded. `[AgentTrace] terminal proposal received` now also logs `supportedRecordIds` (the ids the
accepted terminal was supported by) and `rejected` (the closed-enum rejection codes). Both are
value-free: a record id is a deterministic hash of `sourceUrl|pageGeneration|key`, never claim text, and
the codes are an enum; the ledger, the claims and the raw values stay on the device. Proven in a real
run: S2's trace now reads `"supportedRecords":0,"rejected":["INSUFFICIENT_EVIDENCE"]`, which is what
makes the S2/S3/S8 classification (C+D) evidence-backed rather than inferred. Residual gap: when a
terminal has **no** supported records there are, by definition, no ids to log, so "cited nothing" and
"cited records that did not resolve" are still distinguished only by the rejection codes — and on older
artifacts recorded before the instrument, `citedEvidenceIds` is 0 because it was not observable, which
the record's notes state explicitly so it is never read as "zero citations".

**F4 — a §14 recipe must be a task the I-1 boundary admits, or it measures the boundary.**
S7's first recipe ("scroll down through the account page") was refused as `AMBIGUOUS_NO_GUESS` and
produced `NEEDS_CLARIFICATION` with **zero perception of the sensitive fixture** — a correct refusal, an
invalid row-7 measurement. Corrected to "find the account balance shown on this page" and re-recorded.

**F5 — a §14 recipe must also assert the ROUTE, and a mode that cannot terminate cannot measure a
terminal.**
S1's first recipe ("tell me about charminar", Wikipedia tab open) was routed
`chat route classified {"route":"CONVERSATION","code":"DEFINITIONAL_KNOWLEDGE"}` and answered directly
with 0 tabs, 0 actions, 0 ledger records — the row would have measured the conversation route. The
recipe now carries the page requirement. Separately, S4/S7 were first driven by `scroll_down`, which
cannot propose a terminal; corrected to `act_then_answer` (see §3). Both corrections are recipe-only:
normal-chat routing, browser-task classification and containment are untouched.

## 5. What is needed to close A10

1. **A live gateway on `:8010` plus a reachable cloud reasoner.** The port is currently owned by the
   controlled stub; the live path needs that process stopped and `npm run backend` started in its place
   (with the reasoner key already configured), then S2, S3, S5, S6, S8 and a live-provider repeat of S1
   re-run against it, with `provider_evidence` showing a live provider name. This is an environment
   decision (a pre-existing process) and was **not** taken unilaterally.
2. **A provider that pursues the subject.** The citation-gate failures (S2, S3, S4, S7, S8) are caused
   by a controlled provider that never gathers content about the asked subject. A live reasoner would
   search; a controlled fixture could too, with a mode that performs a subject-bearing action.
3. **An F2 fix** (IPv4 root host) before rows 7/8 are re-run against any origin other than a single
   fixture — with its own tests, as a separate task.
4. **A contract decision for rows 5 and 6** (`PARTIAL` vs `NEEDS_INFORMATION`; whether a fail-closed
   freshness terminal satisfies the stale-evidence row). Both need the A9 terminal semantics to be
   revisited deliberately — not changed to move a matrix score.

## 6. Verification (exact commands, this change set)

| Check | Command | Result |
|---|---|---|
| TypeScript | `npx tsc -b --noEmit` | exit 0 |
| Full suite | `npx vitest run --reporter=dot` | **172 files / 2966 tests passed** |
| A10 harness self-tests | `npx vitest run tests/phase18_8_a10HarnessSelfTest.test.ts` | 27/27 passed |
| F1 focused | `npx vitest run tests/phase18_8_f1StructuralOutputScreen.test.ts tests/phase14/agentOutput.test.ts` | 2 files / 54 tests passed |
| Extension build | `npm run build:extension` | built |
| Frontend build | `npm run build:frontend` | built |
| Backend tests | `backend/.venv/bin/python -m pytest tests/ -q` | **670 passed** (`npm run test:backend` cannot run here: it calls `python`, which this image does not provide — pre-existing environment mismatch, not a code change) |
| Matrix execution | `node scratch/a10_matrix_run.mjs --execute …` | 10/10 rows executed in real Chrome |
| Grading | `npx vite-node scratch/a10_matrix_grade.ts` | 3 PASS / 7 FAIL, privacy clean, `pass: false` |
| Certification gate | `npx vite-node scratch/a10_matrix_grade.ts --require-pass` | **exit 1** (truthful) |
| Artifact integrity | record ↔ raw artifact ↔ `artifact.json` ↔ `graded.json` ↔ this report | 10/10 records agree; no PASS on a non-clean run; no FAIL reason contradicting its record |

## 7. I-5 re-execution note (2026-10-08)

The I-5 information-task success contract (`docs/I5_INFORMATION_TASK_VERIFICATION.md`)
hoisted the evidence precondition in `verifyTaskGoal` so no rule can certify an
information task's SUCCESS ahead of it. Rows **S1, S2, S6, S7, S9 and S10 were
re-executed in real Chrome on the post-I-5 build**; their raw artifacts in this
directory are that build's. Their outcomes and verdicts are unchanged, which is the
point of the regression: S1 still reaches an evidence-backed `SUCCESS` (rule `2c`, 7
composed verified records), the insufficient-evidence rows still fail closed, and
**no false SUCCESS was introduced** — `graded.json` remains 3 PASS / 7 FAIL, privacy
clean, `--require-pass` exits 1.

Rows **S3, S4, S5 and S8 were not re-executed** after I-5: they are the same
insufficient-evidence class already re-observed through S2 (same downgrade, same
citation gate), and re-running them would spend browser time without adding a new
distinction. Their raw artifacts therefore predate the I-5 build and are labelled as
such here rather than being presented as post-I-5 evidence.

## 8. Non-claims

* **A10 is NOT CERTIFIED.** 3 of 10 rows are certified; 5 of the 7 refusals are caused by a controlled
  provider that cannot gather subject-matched evidence, 2 by contract semantics.
* **No live-provider result is claimed.** Every recorded run is `CONTROLLED_PROVIDER`, proven from the
  run's own labels and response telemetry — never relabelled.
* S4/S7's `FAIL` is a refusal to certify on the citation gate, not evidence that a raw value reached a
  model: the independent scan over every recorded field is clean, and row 7's privacy path behaved
  correctly.
* S1's `PASS` proves real-DOM perception, ledger freshness and citation-backed completion under a
  scripted provider. It does **not** prove real-provider behaviour.
* F2 is confirmed and deliberately unfixed; F1 was fixed without weakening the privacy boundary, and no
  security authority (Grounding, M5, Security Critic, Risk/Confirmation, Effect Verification, Goal
  Verification, Recovery, Containment, A12/A14/A16, output screening, routing) was modified to obtain a
  verdict.
