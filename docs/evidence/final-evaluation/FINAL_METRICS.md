# PrivAgent — Final Metrics

**Commit evaluated:** `593fe72` · **Measured:** 2026-09-27
**Baseline for comparison:** commit `32c0cb4` (previous validation checkpoint)

**Rules for this document.**
- Every number was **measured in this pass** unless the row explicitly says it comes from a committed evidence artifact.
- Every denominator and methodology is stated.
- **No percentages are published** unless both numerator and denominator are explicit and the methodology is named.
- **No fixture result is converted into a general accuracy metric.** A task that succeeded once is reported as *one success*, not as a success rate.
- Counts are exact for this commit only and are not a quality measure.

---

## 1. Test suite

| Metric | Value | Methodology |
|---|---:|---|
| Total test files | **100** | `find tests -name '*.test.ts'` / vitest file count |
| Total tests | **1163** | vitest `numTotalTests` |
| Passed | **1163** | `npx vitest run` |
| Failed | **0** | same run |
| Test files passing | **100 / 100** | same run |
| Change vs. `32c0cb4` | **none** (1163 → 1163, 100 → 100) | No test was added, removed, or modified in this pass |

### Focused suites (this pass)

| Suite | Result | Command |
|---|---:|---|
| `tests/observedEffect/` + `tests/phase15/` | **84 / 84** across 3 files | `npx vitest run tests/observedEffect/ tests/phase15/` |
| ├─ `effectVerificationObserved.test.ts` | 17 / 17 | |
| ├─ `plannerAffordances.test.ts` | 8 / 8 | |
| └─ `phase15/privacyFusionContextual.test.ts` | 59 / 59 | |

### Test distribution by concern

Derived by filename matching against the test inventory. **These groups overlap** — a file can appear in more than one row, so the rows deliberately do not sum to 1163.

| Concern | Files | Tests | Basis |
|---|---:|---:|---|
| Privacy pipeline | 19 | 250 | dom, patterns, contextual, fusion, decision, rawValue, minimizer, boundaries, redactor, OCR boundary, phase15 |
| Security authorities | 12 | 114 | validator, m5, grounding, semantic, risk, policy, critic, containment, adversarial, securityLab, exclusions, originIsolation |
| Containment / lifecycle | 5 | 105 | containment, targetResolver, targetResolution, tabProvisioning, staleTarget |
| Harness / recovery | 5 | 97 | harness, recoveryEngine, phase10, selfHealing, m11, stage6EffectRecovery |
| Output boundary | 3 | 77 | agentOutput, extensionAdapter, phase14 |
| Provider / reasoner | 7 | 72 | providerFailure, agentProvider, m7Pipeline, registry, retryBound, modelRouter, reasonerFailurePath |
| Effect verification | 4 | 57 | observedEffect, m10BrowserIntelligence, stage6EffectRecovery |

Largest individual files: `phase15/privacyFusionContextual` 59, `phase13/harness` 47, `phase14/agentOutput` 47, `phase12/containment` 43, `phase11/pipelineGates` 41.

---

## 2. Builds and typecheck

| Check | Result | Detail |
|---|---|---|
| `npm run build:extension` | **exit 0** | Manifest V3 bundle |
| `npm run build:frontend` | **exit 0** | Dashboard bundle |
| `npx tsc -b --noEmit` | **5 errors** | All in `extension/src/background/targetResolver.ts` (lines 285, 287, 287, 290, 488) |
| Baseline TypeScript errors | **5** | Unchanged. All are pre-existing `possibly undefined` / `undefined` vs `null` narrowing issues, present before this validation work began. |
| TypeScript errors **introduced** | **0** | — |

The 5 errors sit in target resolution — the same module that enforces containment provisioning. They are type-narrowing issues, not logic defects, and the file was deliberately left untouched.

---

## 3. Real-browser verification

| Check | Result | Substrate |
|---|---|---|
| Real Chrome no-effect control | **9 / 9** | Real Chrome + real content script from `dist/`. **Re-run and confirmed this pass** (2026-09-27T04:45:58Z). |
| Controlled real-reasoner success | **`GOAL_VERIFICATION_SUCCESS`** | Real Chrome + real backend + real Groq. **Re-run and confirmed this pass** (2026-09-27T04:46:13Z). |
| Controlled run — executions | **2** | Two successful runs total, both `SUCCESS` |
| Real Google run | **`FAILED` / `REASONER_FAILED`** | Real Chrome + real Groq. Terminal failure; **not** a goal success. |

**One task shape has ever completed a goal.** Expressed honestly: 1 task shape, 2 successful executions, 1 of 1 page shapes. That is **not** a success rate and must not be presented as one.

### Controlled run — observed outcomes

| Measure | Value |
|---|---|
| Goal Verification | `SUCCESS` (agent-reported) |
| Observed `#result-marker` | `Search results for cats` |
| Observed final URL | `http://localhost:4199/results?q=cats` |
| Reasoner requests on the wire | 2 × `POST /api/v1/agent/action` → 200 |
| Detections sent per request | 2 |
| Planning rounds (history 0 → 1) | 2 |
| Actions dispatched | 2, both `executionSuccess: true` |
| Effect verdicts | `VALUE_STATE_CHANGED` (length 4), `FOCUS_SHIFT_OBSERVED` |
| Confirmation prompts triggered | **0** (threshold not met) |

### Real Google run — observed outcomes

| Measure | Value |
|---|---|
| Terminal status | `FAILED` |
| Failure reason | `REASONER_FAILED` |
| Provider chain | Groq `rate_limit` + OpenRouter `unexpected_format` → HTTP 503 |
| Actions that dispatched | 3 of 4 proposed |
| Distinctions evaluated | 8 (**7 true, 1 false**) |
| M5 blocks | 1 (reason text "cats" read as possible `person_name`) |
| Final URL | `https://www.google.com/sorry/index?...` (anti-bot interstitial) |

**The single false distinction is recorded, not hidden.**

---

## 4. Security-authority modifications

| Measure | Value |
|---|---:|
| Security-authority files modified during final validation | **0** |
| Gate-order changes | **0** |
| Privacy-boundary changes | **0** |
| `providerRetries` changed | **No** (remains `0`) |
| Scanners weakened / retuned | **No** |
| Containment semantics changed | **No** |
| `dashboardOrigin` changed | **No** (pre-existing default, documented) |
| Google anti-bot behaviour modified | **No** (correctly left alone) |

Verified by `git status` over `extension/src/{agent,privacy,ocr,background,content}/`, `backend/`, and `frontend/src/` — **empty**. The entire final-evaluation pass is documentation- and evidence-only.

> **Net production code change across the whole post-Phase-15 work: 2 commits, both from the real-reasoner run** — the observed-effect fix (`b4bc3f5`) and the `buildAgentPayload` detection-merge fix (`32c0cb4`). The controlled-success round and this evaluation round changed **zero** production lines.

---

## 5. Privacy measurements

| Measure | Value | Methodology |
|---|---:|---|
| Raw PII leaks observed in tested paths | **0** | Forbidden-key + pattern scan over every payload path; plus the real-Chrome checks `snapshotCarriesNoRawValueField` and `snapshotNeverContainsTheTypedValue` |
| Secret/key matches across `docs/evidence/**` | **0** | Scanned for key/authorization/token/bearer patterns during this pass |
| `GROQ_API_KEY` printed to any output or artifact | **No** | Telemetry reports `apiKeyConfigured: true` only; `keyValueNeverPrinted: true` |
| Target values crossing a boundary | **Length only** | `targetValueLength: 4` — never the value |
| Focus identity format | `tag:nth-child(n)` | Never a site-specific identifier |
| OCR in the autonomous agent loop | **Dormant** | Service worker passes no `ocrEngine`; `multimodalCoordinator.ts:223` gates on it |
| PII-bearing page driven under a live reasoner | **None** | The controlled fixture contains no PII |

> **"Zero leaks" is a measured count over the tested surface, not a proof of absence.** The structurally enforced part (forbidden keys, `extra="forbid"`, defensive duplication at the backend) is stronger than a count; the count simply confirms no observed violation.

---

## 6. Performance — measured only

| Stage | Value | Substrate |
|---|---:|---|
| Local decision cycle P50 / P95 | 45 / 88 ms | Deterministic local runner (Groq excluded) — committed artifact |
| DOM candidate extraction | 14.2 ms avg, 32 candidates | JSDOM — committed artifact |
| Real perception cycle (real Chrome) | p50 41.55 ms, max 186.17 ms, **n=21** | Stage 7 harness |
| Real dispatch action (real Chrome) | p50 11.91 ms, max 167.47 ms, **n=13** | Stage 7 harness |
| Redaction overlay | 1.1 ms | Real Chrome — committed artifact |
| Screenshot capture | 1,772 ms, **n=1** | Real Chrome — single sample, **not a distribution** |
| Real Groq round-trip | **NOT INSTRUMENTED** | No committed per-request timing exists |
| Planner / effect-verification / goal-verification latency | **NOT INSTRUMENTED** | — |
| Total live cycle latency | **NOT INSTRUMENTED** | — |
| Memory / model-initialization cost | **NOT INSTRUMENTED** | — |

The README's stated `~1,200–2,800 ms` per-step Groq latency comes from earlier manual observation, is **not** backed by a committed instrumented measurement, and should be presented as unverified.

Full detail and the reasoning behind each `NOT INSTRUMENTED` verdict: `PERFORMANCE_BASELINE.md`.

---

## 7. Claims by evidence grade

Full reasoning in `CLAIM_EVIDENCE_MATRIX.md`.

| Grade | Count of major claims | Examples |
|---|---:|---|
| `PROVEN_REAL` | 14 | Real Groq generation, real dispatch, observed effect verification, M5 block, local-port refusal, provider fail-closed |
| `PROVEN_TEST` | 16 | Zero raw PII in context, fusion non-reduction, backend `extra="forbid"`, recovery bounded, output screening |
| `CONTROLLED_FIXTURE_PROVEN` | 1 | Goal Verification `SUCCESS` |
| `NOT_PROVEN` | 5 | Broad autonomous navigation, formal security guarantees, live grounding reject, live containment escape, PII page under live reasoner |
| `KNOWN_LIMITATION` | 2 | Google anti-bot, OCR dormant in the loop |

*(Counts are of the rows in the matrix, not of every sentence in the project.)*

---

## 8. Summary

| | |
|---|---|
| Regression | **1163 / 1163, 100 files** |
| Builds | **Both pass** |
| TypeScript | **5 pre-existing errors, 0 introduced** |
| Real Chrome negative control | **9 / 9** |
| Controlled real-reasoner goal success | **Reproduced, 2 / 2 runs** |
| Security-authority modifications | **0** |
| Raw PII leaks observed | **0** |
| Production code changed this round | **None** |

**The honest headline:** the engineering is complete and internally consistent, the full production chain is proven end to end against a controlled fixture with a real reasoner, and the system's ability to *refuse* is demonstrated at least as clearly as its ability to succeed. **What remains unproven is generalization** — and nothing in this document should be read as claiming it.
