# A10 — Phase 18.6 §14 Real-Browser Evaluation Matrix

**Harness:** `extension/src/telemetry/a10MatrixHarness.ts` (`phase18.6-a10-1`), self-tested by
`tests/phase18_8_a10HarnessSelfTest.test.ts` (27 tests).
**Driver:** `scratch/a10_matrix_run.mjs` (records one §14 row per real-Chrome run).
**Grader:** `scratch/a10_matrix_grade.ts` (grades with the harness; no grading rule lives in the driver).
**Diagnostic probe:** `scratch/_a10_screen_probe.ts` (F1).
**Artifacts in this directory:** `artifact.json` (records + run metadata), `graded.json` (verdicts,
summary, privacy scan, coverage), `raw_<row>.json` (the unmodified run artifact of
`scratch/p185_real_run.mjs`, whose header states the provider it actually used),
`<row>.record.json` (the extraction).

**Status: PARTIAL — 5 of 10 rows executed in real Chrome; 3 certified; 2 refused; 5 NOT_RUN.**
No row is `PASS` without a real-Chrome run, and no row was upgraded by hand.

---

## 1. How to reproduce

```bash
node scratch/a10_matrix_run.mjs --list                  # the §14 recipes
node scratch/a10_matrix_run.mjs --execute S9,S10        # run rows (real Chrome)
node scratch/a10_matrix_run.mjs --record S1,S4,S7,S9,S10  # re-derive from raw artifacts, no browser
npx vite-node scratch/a10_matrix_grade.ts               # grade; --require-pass exits non-zero unless 10/10

# a row may be pointed at the controlled provider explicitly; the label travels with the record
A10_PROVIDER=CONTROLLED A10_STUB_MODE=act_then_answer node scratch/a10_matrix_run.mjs --execute S1
```

Needs: the built extension (`npm run build:extension`, loaded from `dist/` — a product change is only
observable after a rebuild), the dashboard on `:5173`, the shopping fixture on `:4174`, the banking
fixture on `:4175`, and a reasoner gateway on `:8010`.

## 2. Provider honesty

`:8010` was bound by `scratch/i8a7a8_controlled_provider.py` (mode switchable with
`GET /mode?set=<mode>`; the driver restores the previous mode) for **every** run recorded here, so
every record is `CONTROLLED_PROVIDER` and the raw header says so
(`PROVEN_REAL_CHROME / CONTROLLED_PROVIDER (stub_mode=…)`, stamped at run time and read back from the
artifact, so re-recording cannot relabel a run). The six remaining rows need the real FastAPI gateway
plus a reachable cloud reasoner; **no run of them is claimed here.**

## 3. Grading result (`graded.json`)

| Row | §14 scenario | Provider | Executed | Terminal observed | Verdict |
|---|---|---|---|---|---|
| S1 | Wikipedia information lookup | CONTROLLED (`act_then_answer`) | yes | SUCCESS | **PASS** |
| S2 | Search → result → information | — | no | — | NOT_RUN |
| S3 | Multi-page information | — | no | — | NOT_RUN |
| S4 | Information requiring scrolling | CONTROLLED (`scroll_down`) | yes | FAILED | **FAIL** |
| S5 | Missing information | — | no | — | NOT_RUN |
| S6 | Stale evidence | — | no | — | NOT_RUN |
| S7 | Sensitive-data page | CONTROLLED (`scroll_down`) | yes | FAILED | **FAIL** |
| S8 | Navigation + information | — | no | — | NOT_RUN |
| S9 | Ambiguous request | CONTROLLED | yes | NEEDS_CLARIFICATION | **PASS** |
| S10 | Provider failure | CONTROLLED (`server_503`) | yes | PROVIDER_UNAVAILABLE | **PASS** |

**S1 — PASS (the strongest record here).** Route `PIPELINE`, intent `MIXED_TASK`
(destination + evidence required), the real `https://en.wikipedia.org/wiki/Charminar` page perceived in
real Chrome (screenshot 1265×757, 98 visual regions, 37 privacy findings), 24 semantic facts ingested
into the ledger **all verified-current at generation 2**, and the GoalVerifier satisfied the task by
rule `2c` with `composedVerifiedRecords: 7` — i.e. the answer was composed from seven verified, current
records. This is §14 row 1's contract satisfied with zero actions and **zero provider calls**: the
device observed the page and answered from what it observed. Note the row is satisfied by a
*controlled* provider — real-DOM perception is proven, real-*provider* behaviour is not (the run never
needed the provider at all).

**S9 — PASS.** `intent classified {"intent":"AMBIGUOUS","refusal":"AMBIGUOUS_NO_GUESS"}`,
`task not admitted by the intent boundary`, **0 requests to `/api/v1/`**, 0 tabs, 0 dispatches,
terminal `NEEDS_CLARIFICATION` with a truthful user message.

**S10 — PASS.** Three `POST /api/v1/agent/action` calls returned `503`; typed recovery records
`PROVIDER_UNAVAILABLE` / `RETRY_BUDGET_EXHAUSTED`; terminal `PROVIDER_UNAVAILABLE`; 0 dispatches; the
3 verified ledger records present at the time were **not** used to claim an answer.

**S4 — FAIL.** 6 dispatches (3 `EFFECT_VERIFIED`, 3 `ACTION_NO_EFFECT`), then
`Recovery limit exceeded for NO_EFFECT after 2 bounded attempts.` — a bounded, truthful stop. It fails
for two reasons: `FAILED` is not in the row's expected terminal set, and the run's own self-check is
unclean (**F1**). Ledger: 60 records, 14 verified-current, 9 page generations, 6 scrolls, no
step-bound exhaustion.

**S7 — FAIL.** 4 dispatches, terminal `FAILED`, ledger 60 records / 11 verified-current,
`semantic observation {"droppedSensitive":0,"quarantinedInjection":0}`, and **no raw value anywhere in
the recorded artifact** (the independent scan over every record is clean). It fails on the terminal set
and on F1, not on a privacy breach.

**Zero false successes.** No row claimed a result it could not support: the only `SUCCESS` has 24
verified-current records and 7 cited ones behind it; the provider outage was reported as an outage; the
ambiguous request cost nothing; and no raw sensitive value appears anywhere in the artifact.

## 4. Findings

**F1 — a machine-generated containment label makes the output screen drop the whole terminal
projection. (Cause identified.)**
Reproducible on both action-bearing runs, absent on the action-free ones:

```
[AgentTrace] output screen {"verdict":"BLOCKED","audit":"OUTPUT_SCREEN_BLOCKED (1 finding(s))","outcome":"FAILED",
  "phase":"TERMINAL","resultKind":"NONE","structuralViolations":[{"field":"artifacts[0]","rule":"credential_token"}]}
```

`verdict: BLOCKED` with **1** finding is the `!structureIsClean(output)` path of
`screenAgentOutput` (`extension/src/agent/agentOutput.ts`); the payload is then replaced by
`safeBlockedProjection('UNKNOWN')`, so the user sees the generic card ("The task could not be
completed. I stopped safely without repeating actions.") while the truthful reason the worker produced
never reaches the dashboard. S10 — same shape, no action — renders its specific reason.

The `structuralViolations` field is new (this phase): the screen previously reported a count only, so a
dropped payload was undiagnosable in the field. With it, the run itself names the offender:
`artifacts[0]` is the CONTAINMENT artifact, `CONTAINMENT:${code}:${scope}`, and for these IP-literal
fixtures the scope is `contained:0.1` (F2), i.e. the label `CONTAINMENT:WITHIN_SCOPE:contained:0.1`.
`scratch/_a10_screen_probe.ts` confirms that exact string trips the scan as `credential_token`, and also
that `contained:0.1` alone is clean — the trip comes from the assembled `<CODE>:<kind>:<digit.digit>`
shape. It further shows the rule is a **strong** rule, so this is **not** fixable by declaring the field
structural (`STRUCTURAL_VALUE_KEYS`); it needs either a shape allowlist for machine-generated
identifiers (validate `action:outcome` and `kind:label` against their closed vocabularies and a safe
charset) or the same treatment the raw-value scanner documents for structural keys. Deciding that is a
privacy-boundary change and was **not** made here: this phase added the diagnostic only, and the
audit trail above is the evidence such a change needs.

**F2 — the containment root host for an IPv4 literal collapses to its last two octets.**
`containment scope established {"rootHost":"0.1"}` for a target of `http://127.0.0.1:4174`, and
`containment decision {"code":"WITHIN_SCOPE","scope":"contained:0.1"}`. `deriveRootHost` keeps the last
two dot-separated labels (`extension/src/agent/containment.ts`), which is right for DNS names and wrong
for IP literals: with root host `0.1`, `hostWithinScope('10.0.0.1', '0.1')` is **true**
(`endsWith('.0.1')`), so a task scoped to `127.0.0.1` treats another IP-literal origin as inside its
scope. Containment was not bypassed in these runs, and this phase did not modify it (DO-NOT-MODIFY);
the fix is small (an IPv4 literal is one host, not a hierarchical name) but needs its own tests. F2 also
supplies the scope text that makes F1 fire.

**F3 — citations are observable as counts, and now read; the ids are not. (Corrected.)**
An earlier draft of this report claimed nothing recorded what an answer cited. That was wrong for the
counts: an accepted terminal proposal already logs `supportedRecords` (verified + subject-matched
citations) and the GoalVerifier path composes its answer from the ledger. What was missing was the
*count for the composed path*, so this phase added `composedVerifiedRecords` to
`[AgentTrace] goal verification satisfied` (`extension/src/agent/agentLoop.ts`, count only — never the
claims) and the driver reads either source into `citedEvidenceRefs` + `citationSource`. Both paths are
verified in real runs: S1's `SUCCESS` carries `composedVerifiedRecords: 7`. The harness refuses to
credit a count with no named source, and still refuses to *infer* a citation: a row whose artifact
carries neither count is graded as uncited. Remaining gap: the record **ids** a terminal cites are still
not logged, so the cross-check “the cited id exists in the ledger” can only be done inside the product,
not from the artifact.

**F4 — a §14 recipe must be a task the I-1 boundary admits, or it measures the boundary.**
S7's first recipe ("scroll down through the account page") was refused as `AMBIGUOUS_NO_GUESS` and
produced `NEEDS_CLARIFICATION` with **zero perception of the sensitive fixture** — a correct refusal, an
invalid row-7 measurement. Corrected to "find the account balance shown on this page" and re-recorded.

**F5 — a §14 recipe must also assert the ROUTE, or the conversation route answers it.**
S1's first recipe ("tell me about charminar", Wikipedia tab open) was routed
`chat route classified {"route":"CONVERSATION","code":"DEFINITIONAL_KNOWLEDGE"}`, answered directly with
**0 tabs, 0 actions, 0 ledger records and 1 provider call** — the row would have measured the
conversation route. The recipe now carries the page requirement ("open wikipedia and tell me about
charminar" → `PIPELINE` + `MIXED_TASK`). Two harness corrections came out of this and S1:
`SUCCESS` is a legitimate terminal for the information rows when the GoalVerifier's verdict and cited
evidence are both present (§14's row-1 trap is "SUCCESS **with 0 verified records**", so the matrix now
encodes it that way instead of rejecting `SUCCESS` outright), and a browser-required row with no
dispatched action must show page engagement (`pageEngaged`: a perceived context URL, an ingested ledger,
or an observed generation) rather than being failed for having dispatched nothing.

## 5. What is needed to complete the matrix

1. **A live gateway on `:8010` plus a reachable cloud reasoner** for the six LIVE rows (S2, S3, S5, S6,
   S8 and a live-provider repeat of S1); row 7 additionally needs the independent model-facing capture
   that a stub bypasses.
2. **An F1 decision** (shape allowlist for machine-generated identifiers, or keep the drop and accept
   that an action-bearing run's projection is lost), then a re-run of S4/S7 to separate "the run did not
   complete the task" from "the payload was dropped".
3. **F2's fix** before rows 7/8 are re-run against any origin other than a single fixture.
4. Optionally, the cited **ids** (F3) so citations can be cross-checked from the artifact.

## 6. Non-claims

* No live-provider result is claimed: every recorded run is `CONTROLLED_PROVIDER`, and 5 rows are
  NOT_RUN.
* The matrix is **not** certified: `npx vite-node scratch/a10_matrix_grade.ts --require-pass` exits
  non-zero, and `graded.json` records `pass: false` with per-row reasons.
* S4 and S7 are recorded as `FAIL`; their `FAIL` is a refusal to certify, not evidence that a raw value
  reached a model — the independent scan over every recorded field is clean, and both privacy findings
  come from the execution-side self-check that F1 poisons.
* S1's PASS proves real-DOM perception, ledger freshness and citation-backed completion under a scripted
  provider. It does **not** prove real-provider behaviour.
