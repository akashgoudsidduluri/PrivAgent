# Phase 16 — Generalization & Robustness Validation

**Base commit:** `35a22f8` · **Run date:** 2026-09-27
**Production code changed by this phase:** **none.**

Phase 16 was an evaluation phase. It exercised the existing production pipeline across multiple task categories and reported what it found. It did not redesign the architecture, weaken a security control, replace the real reasoner, or convert a failure into a success.

---

## Documents in this directory

| File | Contents |
|---|---|
| [`PHASE16_GENERALIZATION_MATRIX.md`](./PHASE16_GENERALIZATION_MATRIX.md) | 10 task categories with `PASS` / `FAIL` / `BLOCKED` / `NOT_TESTED`, plus the three defects |
| [`PHASE16_SECURITY_MATRIX.md`](./PHASE16_SECURITY_MATRIX.md) | All 11 authorities: trigger, expected, observed, dispatch?, evidence, limitation |
| [`PHASE16_PRIVACY_MATRIX.md`](./PHASE16_PRIVACY_MATRIX.md) | 6 synthetic PII types end to end |
| [`PHASE16_FAILURE_MATRIX.md`](./PHASE16_FAILURE_MATRIX.md) | 21 observed failures with bypass / leakage columns |
| `phase16_task_suite_evidence.json` | Full real-reasoner suite, 2 runs, 7 categories |
| `phase16_privacy_evidence.json` | Live privacy run on the synthetic-PII page |
| `phase16_ocr_decision.json` | OCR measurement + activation decision |
| `phase16_failsafe_evidence.json` | Real-Chrome no-op / invalid-target / containment |
| `phase16_effect_navigation_diagnostic.json` | Isolated diagnosis of DEFECT 3 |

---

## Headline

| | |
|---|---|
| Real-reasoner task categories exercised | **7** |
| Real-reasoner tasks reaching goal-verified `SUCCESS` | **2 of 7** (SEARCH, SCROLL) — and see DEFECT 2 for SCROLL |
| Deterministic fail-safe categories | **3 of 3 PASS** |
| Real Groq round-trips measured | **14** |
| Synthetic PII types tested | **6** |
| **Raw PII reaching the backend** | **0** |
| **Security authorities bypassed** | **0** |
| **Unauthorized dispatches** | **0** |
| Recovery authorizations | **0** |
| Containment escapes | **0** |
| **Concrete defects found** | **3** (1 a stop condition) |
| Regression | **1222 / 1222**, 102 files (was 1163 / 100) |
| TypeScript | **5** pre-existing errors, **0** introduced |
| Builds | both pass |
| Production code changed | **none** |

---

## What was built for this phase

**Harnesses** (all in `scratch/`, all untracked-by-design artefacts regenerated per run):
- `scratch/phase16_fixtures.mjs` — one deterministic fixture server serving 10 routes across every task category
- `scratch/phase16_cdp.mjs` — shared CDP / server utilities
- `scratch/verify_phase16_task_suite.mjs` — 7 real-reasoner categories
- `scratch/verify_phase16_privacy.mjs` — synthetic-PII run with full outbound capture
- `scratch/verify_phase16_failsafe.mjs` — no-op, invalid target, containment
- `scratch/verify_phase16_effect_navigation.mjs` — isolated DEFECT 3 diagnosis
- `scratch/verify_phase16_ocr_decision.mjs` — OCR measurement and decision

**Tests** (committed, in the regression):
- `tests/phase16/securityAuthorities.test.ts` — 39 tests, 11 authorities exercised individually
- `tests/phase16/generalizationFindings.test.ts` — 20 tests, privacy pipeline + the two `it.fails` defect encodings

---

## The three defects

### DEFECT 1 — the Security Critic classifies ordinary English as prompt injection
`injectionFirewall.ts` includes `/navigate to/i`; `securityCritic.ts:284-298` runs the **model's own reason string** through the page-content injection classifier. A perfectly normal plan sentence is quarantined. **Fails closed** — over-blocking, not a bypass. Ended the MULTI-STEP category in both runs. Not fixed: it is a security control, and the correct scope of the injection scan is a security decision.

### DEFECT 2 — a scroll goal is verified by action history, not observed state *(STOP CONDITION)*
`goalVerifier.ts:487-494` decides the scroll goal from `previousActions` alone. Live proof: scrolled **500 px** on a page where the target section is **~3000 px** down; reported `SUCCESS`. Deterministic proof: byte-identical verdicts at `scrollY` 0 and 500. This contradicts the module's own stated contract. **Reported, not patched**, per the stop-condition instruction.

### DEFECT 3 — effect verification cannot observe a navigation
`serviceWorker.ts:902+` reads the authoritative Chrome tab URL, then **discards it** when the content-script half of the snapshot fails. On a navigation the content script is bfcached and `sendMessage` throws, so an action that demonstrably changed the tab is reported `ACTION_NO_EFFECT`. **Fails closed.** Racy: the same SEARCH click was `ACTION_NO_EFFECT` in run 1 and `FOCUS_SHIFT_OBSERVED` in run 2. Not fixed: it changes what counts as an observation.

---

## Performance (measured only)

**REAL Groq round-trip**, request→response on the wire, n=14: **min 364 ms · p50 554 ms · p90 5,616 ms · max 53,331 ms.**

| Task | Wall clock | Cycles | Actions | Outcome |
|---|---:|---:|---:|---|
| CLICK | 1,018 ms | 2 | 0 | FAILED (422 hallucinated target) |
| NAVIGATION | 2,060 ms | 3 | 1 | FAILED (reason over-length) |
| SCROLL | 3,020 ms | 2 | 1 | SUCCESS *(see DEFECT 2)* |
| FORM_FILL | 3,099 ms | 3 | 2 | FAILED (perception) |
| SEARCH | 4,120 ms | 3 | 2 | SUCCESS |
| MULTI_FIELD_FORM | 8,068 ms | 3 | 1 | FAILED (provider 503) |
| MULTI_STEP | 65,279 ms | 5 | 4 | FAILED (Critic block) |

**LOCAL latency** is unchanged from the Phase 15 baseline and is not re-measured here: local decision cycle P50 45 ms / P95 88 ms (Groq excluded). The two must not be summed — they were measured on different substrates at different times.

**NOT INSTRUMENTED in this phase:** per-stage perception latency, effect-verification latency, snapshot round-trip latency. Groq latency dominates total task time in every observed case; the local loop is not the bottleneck.

---

## OCR decision — KEEP OCR DORMANT

**Decision: do not activate OCR in the autonomous loop. No production change.**

The decisive evidence is reachability, not quality: `serviceWorker.ts:733` passes no `ocrEngine`, and `multimodalCoordinator.ts:223` gates the whole branch on it. `ocr_metrics.regions_scanned: 0` in every live run. No Phase 16 task required canvas or image-only text, and there is **no measured evidence that activating OCR improves any task outcome**.

Latency and memory are recorded as **`NOT_MEASURED`** rather than estimated: the shipped Tesseract worker is browser-only (it calls `self.addEventListener`) and cannot be initialised outside a browser, so a Node-side measurement is not possible with the current stack. Paying an unquantified per-cycle cost with no demonstrated benefit is not justified. Revisit only with a corpus of real pages whose goals are unreachable from the DOM alone, and with in-browser cost measured first.

---

## What this phase does NOT establish

- **Not general autonomous browsing.** All pages were local, stable, and enumerable.
- **Not the open web.** No live site was driven.
- **Not multi-page live workflows, authenticated sites, virtualized content, or cross-origin iframes.**
- **Not OCR on the autonomous path.**
- **Not a success rate.** "2 of 7" is seven observations on one fixture, and the two runs of SEARCH disagreed. It is not a percentage and must not be presented as one.

**The strongest defensible statement:** *the security and privacy layers remained authoritative and fail-closed across 7 real-reasoner task categories, 6 synthetic PII types, and 59 deterministic authority tests, with zero bypasses and zero leaks — and doing so exposed three concrete defects, one of which is a genuine goal-verification soundness failure.*
