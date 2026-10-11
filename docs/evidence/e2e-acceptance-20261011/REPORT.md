# Real-Chrome End-to-End Acceptance Run — 2026-10-11

Real Google Chrome, real unpacked extension (built from commit `b1fefb0` into repo-root
`dist/`), real FastAPI gateway on `127.0.0.1:8010` (`backend/run.py`), **live provider**
(Groq `openai/gpt-oss-20b`; per-run canary answered `OK` — 378 ms in the TEST 1 run, 193 ms in the final TEST 2 run). Dashboard: Freebuff preview on
`localhost:5173`. Chrome ran **headful (windowed)** under a virtual X display (Xvfb) — this
is not a headless run.

Harness: `scratch/e2e_acceptance_run.mjs` (scratch test tooling; changes no product code,
weakens no gate — it drives the real dashboard and reads observed browser state via CDP
plus the extension's own screened telemetry).

## Verdicts

| Test | Scope | Verdict |
|---|---|---|
| **TEST 1** — conversation (3 turns) | `What is machine learning?` → `What is PrivAgent?` → `hi` | **PASS** (all 6 cross-checks) |
| **TEST 2** — complete browser task | `Open https://www.google.com and search for Charminar.` | **FAIL** — first failing stage **S6 "search submitted"** (identical in 3 independent runs) |

## TEST 1 — PASS

All three turns settled at terminal status `ANSWER`, reason `CONVERSATIONAL_ANSWER`, with a
real answer body from the live Groq model, rendered in the correct conversation bubble.

| Check | Result | Evidence |
|---|---|---|
| Turns answered in order, all settled | PASS | 3/3 `ANSWER`, no timeouts |
| Answers present and non-empty | PASS | e.g. "Machine learning is a type of artificial intelligence…" |
| Non-repetition | PASS | T1-vs-T2 answer Jaccard 0.016 (threshold 0.8) |
| Turn attribution | PASS | rendered bubble counts 1 → 2 → 3, latest bubble matches typed answer |
| Greeting performs no browser work | PASS | `hi`: all 7 browser markers = 0, 0 new tabs, 0 browser cards |
| No page provenance on conversational answers | PASS | `provenance: null` on every turn |

Artifact: `acceptance_conversation.json`, screenshots `test1_turn{1,2,3}_*.png`, `test1_all_turns.png`.

## TEST 2 — FAIL at S6 (search never submitted)

| Stage | Status | Observed evidence |
|---|---|---|
| S1 target tab provisioned | PASS | target tab first seen at 12.2 s (final run) |
| S2 navigation to Google completed | PASS | URL `https://www.google.com/`, readyState `complete`, read from the actual tab |
| S3 page title/URL read from actual tab | PASS | CDP `Runtime.evaluate` on the target tab |
| S4 search input identified | PASS | `input[name="q"]`, visible |
| S5 search text visibly entered | PASS | **observed** value change in target `ti6dpd`, length 9 ("Charminar"), `VALUE_STATE_CHANGED` |
| **S6 search submitted** | **FAIL** | URL never carried `q=`; the submit step never dispatched |
| S7 results rendered | FAIL | consequence of S6 |
| S8 results read through privacy pipeline | FAIL | consequence of S6 |
| S9 relevant result opened | NOT_RUN | consequence of S6 |
| S10 information extracted | FAIL | terminal body was a failure notice, not extracted information |
| S11 dashboard displays terminal result | PASS | badge `PROVIDER UNAVAILABLE`, headline "Reasoning service unavailable" |
| S12 truthful terminal state | PASS | `PROVIDER_UNAVAILABLE` / `REASONER_FAILED`: "The reasoning service was unavailable, so nothing was changed on the page." |

### Root cause — live model contract violation, refused fail-closed

After the type step succeeded, the reasoner was asked for the submit action and answered
HTTP 200 with a **`click` proposal carrying fields that do not apply to a click**
(`amount, direction, option, url`). The backend's Phase 18.7/A8 applicability gate refused
it deterministically:

```
Reasoner action refused by the applicability gate: model_contract
  (Model action carries field(s) that do not apply to its action type: amount, direction, option, url)
POST /api/v1/agent/action → 502 { error_kind: "model_contract", retryable: false }
```

(`gateway_model_contract_refusal.log` — both retry attempts refused identically.)

The extension classified `MODEL_CONTRACT`, retried once (2 attempts, both refused), then
failed closed: `PROVIDER_UNAVAILABLE`, retry budget exhausted. **Zero speculative
dispatches** — the invalid click was never sent to the page, and nothing on the page
changed after the type step. This is the designed behavior: the service was healthy, the
model answered, the answer violated the action contract, and the runtime refused to act on
it rather than guessing.

**This is a genuine product finding, not a harness or environment artifact:**
- 3/3 independent runs failed at exactly S6 with the same refusal (run 1 original, run 2 + gateway logging, run 3 after harness grading fix).
- The gateway was healthy throughout (canary 200; chat 200; review 200; earlier action steps 200).
- Google's anti-bot interstitial was **not** involved — the run never reached submission.
- The task therefore cannot currently reach `SUCCESS` against the live provider: at the
  submit-search step `openai/gpt-oss-20b` reliably emits an inapplicable-field `click`.

## Harness fix applied during this run

`scratch/e2e_acceptance_run.mjs` stage S10 previously passed on *any* terminal body,
including the provider-unavailable notice. It now requires `finalResult.kind` ∈
{`SUCCESS`, `PARTIAL`}. Run 1's artifact recorded S10 `PASS`; after the fix the same
scenario correctly records `FAIL` (`acceptance_search.json`). No other grading changed.

## Artifacts

| File | Contents |
|---|---|
| `acceptance_conversation.json` | TEST 1 full timeline, per-turn results, verdict, service-worker logs |
| `acceptance_search.json` | TEST 2 final run: stages, samples read from the real tab, steps, markers |
| `acceptance_search_run1_failed_model_contract.json` | first TEST 2 run (pre-grading-fix) |
| `gateway_model_contract_refusal.log` | gateway log: the two 502 model-contract refusals |
| `screenshots/*.png` | dashboard and target-page screenshots per turn/stage |

## Not run / limitations

- S9 (open a result, extract from source) — NOT_RUN, downstream of the S6 failure.
- No `SUCCESS` browser task was claimed or observed in this run; the only proven scope is
  S1–S5 (navigate, locate input, type with observed effect) plus the fail-closed terminal path.
- Reproduction: `E2E_SUITE=search xvfb-run -a node scratch/e2e_acceptance_run.mjs`
  (gateway: `npm run backend`; dashboard: Freebuff preview).
