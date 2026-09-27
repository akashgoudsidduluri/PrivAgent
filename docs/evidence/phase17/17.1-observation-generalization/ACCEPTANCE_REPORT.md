# Phase 17.1 — Acceptance Report

**Baseline:** `2b10445` (Phase 16 remediation, closed)
**Scope implemented:** 17.1 Observation Generalization only. **17.2 not started.**

---

## 1. Acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Observation sources are documented | ✅ | `OBSERVATION_AUDIT.md` §A — three real sources (S1–S3) and five pseudo-sources (P1–P5) |
| 2 | Authority rules are explicit | ✅ | `AUTHORITY_FRESHNESS_MATRIX.md` §1 |
| 3 | `unavailable != default` | ✅ | F1 and F2 deleted; `EffectStatus.EFFECT_UNVERIFIABLE` added; focused tests §17.1-3/5/8/9 |
| 4 | `stale != fresh` | ✅ | `crossDocument` rule; `pageGeneration` stamped; §17.1-2/11/15 |
| 5 | `chrome.tabs` remains authoritative for browser lifecycle | ✅ | §17.1-14; `pendingUrl \|\| url` preserved |
| 6 | Content script remains authoritative for page-local state | ✅ | §17.1-4/5/6/7 |
| 7 | AgentLoop uses the unified observation contract | ✅ | `preSnapshot`/`postSnapshot` now carry `observation`; loop fails closed when either is null |
| 8 | EffectVerifier consumes it correctly | ✅ | per-action required-field set; `EFFECT_UNVERIFIABLE` |
| 9 | No previous-action shortcut remains as observation evidence | ✅ | §17.1-12; scroll-goal history shortcut removed in Phase 16 and re-asserted here |
| 10 | Focused tests pass | ✅ | **28 / 28** in `tests/phase17/observationGeneralization.test.ts` |
| 11 | Full regression passes | ✅ | **1315 / 1315** across **106** files |
| 12 | TypeScript status is known | ✅ | **5 errors, all pre-existing** in `targetResolver.ts`; **0 new** |
| 13 | Extension build passes | ✅ | `npm run build:extension` |
| 14 | Frontend build passes | ✅ | `npm run build:frontend` |
| 15 | Real Chrome tests pass | ✅ | **8 / 8** cases A–H in `real_chrome_evidence.json` |
| 16 | Evidence is written | ✅ | this directory |
| 17 | No security gate was weakened | ✅ | §4 below |
| 18 | No unrelated scope was added | ✅ | §5 below |

---

## 2. Test results

| Suite | Result |
|---|---|
| `tests/phase17/observationGeneralization.test.ts` (new) | **28 / 28** |
| Full regression `npx vitest run` | **1315 / 1315**, 106 files |
| Baseline at `2b10445` | 1287 / 1287, 105 files |
| Security + privacy authority suites | **228 / 228** |
| `npx tsc -b --noEmit` | **5**, all pre-existing `targetResolver.ts` |
| `npm run build:extension` | pass |
| `npm run build:frontend` | pass |

**Nothing was deleted.** The delta is +28 tests, +1 test file, +1 test helper. No existing test was removed, skipped, or had its assertion relaxed — with one documented refinement noted in §6.

---

## 3. Real-Chrome results (A–H)

| Case | Result | Measured |
|---|---|---|
| **A** normal page observation | ✅ | tab URL, title, scroll, DOM read from their authoritative sources |
| **B** scroll observation | ✅ | `scrollY` read live; a real `window.scrollTo` moved it and the reading followed |
| **C** navigation observation | ✅ | tab URL moved; page reading followed; tab and page agreed |
| **D** navigation, content script unavailable | ✅ | `UNAVAILABLE` observed in the teardown window; tab URL still authoritative; **no fabricated geometry** |
| **E** back/forward/bfcache | ✅ | generation advanced across documents; frozen page reported unavailable, not as a stale zero |
| **F** target-tab switching | ✅ | distinct tab ids, distinct URLs, no cross-contamination |
| **G** dashboard never a target | ✅ | real origin reaching the guard (C8) |
| **H** no fabricated geometry | ✅ | contract recorded and proved by the unit suites |

Every value read back from a real browser. No scripted proposer, no injected action, no asserted verdict.

---

## 4. Security regression (STEP 11)

**17.1 does NOT:**
- bypass M5 — untouched
- bypass the Security Critic — untouched
- bypass Grounding — untouched
- bypass Containment — untouched; **C8 makes its dashboard guard fire correctly**, which is a strengthening
- authorize actions — no code path was added that lets an observation permit an action
- turn observations into authorization — the effect verifier still can only fail an action closed, and `EFFECT_UNVERIFIABLE` is a refusal
- allow model claims to become browser facts — §17.1-13 asserts the verdict is a pure function of two readings, unaffected by the action object or its `reason`

Verified by the **228 passing** security/privacy authority tests and by the diff itself: the only gate-adjacent changes are strict refinements of the *effect* and *goal* verifiers, both of which can only refuse.

**Privacy:** the outbound payload is **byte-identical**. The two new local flags are attached after the egress allowlist and stripped at the backend boundary. The `tests/agentBridge.test.ts` allowlist test caught the first attempt and forced this — that guard working is the evidence.

---

## 5. Scope held

Not started, not touched: 17.2 Goal Verification 2.0 (no new goal types — 17.1 only makes existing inputs reliable), 17.3 OCR, 17.4 visual/canvas, 17.5 dynamic content, 17.6 iframes, 17.7 long-horizon, 17.8 provider robustness, 17.9/17.10 evaluation.

Also deliberately untouched, per instruction: the `GOAL_MISMATCH` over-block, Google anti-bot, execution bounds, privacy boundaries, OCR activation.

---

## 6. One documented assertion refinement

`tests/phase16-remediation/navigationObservation.test.ts` asserted `ACTION_NO_EFFECT` for a tab-only reading with an unchanged URL. 17.1 reports `EFFECT_UNVERIFIABLE` there.

The invariant the test protects is **unchanged and still asserted**: `hasEffect === false`, no effect claimed in either direction, and the verdict still fails closed. Only the label is stricter, because `ACTION_NO_EFFECT` asserts something about the browser that was never read. The refined assertion is *more* specific, not weaker, and the file now states the reasoning inline.

---

## 7. Remaining limitations

1. **No observation TTL.** `observedAt` is recorded but nothing expires a snapshot. A cross-document mismatch is caught via the URL, not via age. Chosen deliberately: a TTL would be a policy decision belonging to 17.2, and a wrong one would discard real evidence.
2. **`pageGeneration` advances per scan, not per navigation.** It is a monotonic observation counter reused from the pre-existing stale-target mechanism, not a document identity. Document identity is carried by the authoritative URL, which is the stronger signal anyway.
3. **Cross-document detection is URL-based.** A same-URL DOM swap (SPA route change, in-page rewrite) is not detected as cross-document. The world-model generation check covers part of that; full dynamic-content handling is 17.5.
4. **Test fixtures were repaired, not the product.** 60 AgentLoop constructions across 9 files had **no observation channel at all** — a configuration the real product never has, since the service worker always supplies `getEffectSnapshot`. They had been passing only because of the deleted fabrications. They now model the browser explicitly via `tests/helpers/observingHost.ts`. **No assertion was changed**; the effect-verification suite (`stage6`) still states its expected pre/post state explicitly rather than using the simulator.
5. **A host with no observation channel can no longer complete any action.** This is the intended, correct consequence, and it is a real behavioural change for any embedder that does not wire `getEffectSnapshot`.
6. **Perception latency and memory impact: `NOT_MEASURED`.** Only the observation round trip is instrumented. See `real_chrome_evidence.json → performance`.

---

## 8. Performance (STEP 10)

| Metric | Value |
|---|---|
| Observation round trip, **p50** | **6 ms** |
| Observation round trip, **p95** | **15 ms** |
| min / max (n=30) | 2 ms / 16 ms |
| Added overhead vs Phase 16 | `NOT_MEASURED` — no pre-change build was available to A/B; not estimated |
| Perception latency before / after | `NOT_MEASURED` — not instrumented; not estimated |
| Memory impact | `NOT_MEASURED` — not estimated |

What the measurement covers: one `chrome.tabs.query` + one `chrome.tabs.get` + one content-script `PRIVAGENT_GET_EFFECT_SNAPSHOT`, timed inside the real service worker. 17.1 adds the per-field contract to that **same** round trip and introduces **no new IPC call**.
