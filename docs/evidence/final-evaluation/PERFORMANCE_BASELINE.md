# PrivAgent — Performance Baseline

**Commit evaluated:** `593fe72`
**Date:** 2026-09-27

**Scope.** This document **records what has actually been measured**. It does not optimize, benchmark, or extrapolate. Where a stage has no instrumentation, it says **NOT INSTRUMENTED** rather than producing a number. No figure in this document was estimated, modelled, or carried over from a different environment without being labelled as such.

**One structural caveat that applies to every number here:** most latency figures in this project were recorded by **phase harnesses**, not by a live real-reasoner run. The two live real-reasoner runs did not record per-stage timings. So the local numbers and the reasoner numbers come from different measurement contexts and are **not directly comparable**.

---

## 1. Local decision cycle (Groq excluded)

**Source:** `evaluation/reports/sih_evaluation_report.json`, `docs/M12_EVIDENCE_AUDIT.md` §"What the 45ms P50 / 88ms P95 Actually Includes"
**Substrate:** deterministic local runner + JSDOM. **No real browser. No cloud.**

| Metric | Value | Scope |
|---|---|---|
| Local decision cycle P50 | 45 ms | On-device only |
| Local decision cycle P95 | 88 ms | On-device only |
| DOM candidate extraction (client resource utilization) | 14.2 ms avg, 32 candidates | JSDOM, local only |

**What this includes:** DOM perception, coordinate bounding, candidate extraction, M5 validation, and verification.
**What this does NOT include:** Groq network inference, real browser IPC, real screenshot capture, real OCR.

This is why the README labels it `Local Decision Cycle Latency (Groq Latency Excluded)`. That label is correct and should be preserved.

---

## 2. Real-browser local latencies (Stage 7 harness)

**Source:** `docs/evidence/stage7-real-browser/stage7_real_chrome_evidence.json`
**Substrate:** real headless Chrome over CDP, real extension. No live reasoner.

35 samples collected from two distinct event types — perception cycles (records carrying `visualRegions`) and dispatch actions (records carrying `dispatched`).

| Statistic | Perception-cycle samples | Dispatch-action samples | All samples |
|---|---:|---:|---:|
| n | 21 | 13 | 35 |
| min | 19.41 ms | 2.12 ms | 2.12 ms |
| p50 | 41.55 ms | 11.91 ms | 32.22 ms |
| p95 | — | — | 167.47 ms |
| max | 186.17 ms | 167.47 ms | 186.17 ms |

Per-kind p95 is not reported because n=21 and n=13 are too small for a meaningful 95th percentile; only the pooled figure is quoted.

**Real perception latency (single named measurement):** 19.41 ms
**Full local search end-to-end (this harness, includes harness overhead):** 25,919.71 ms

The 25.9 s figure is a *whole-scenario* number for that harness including its own driving overhead and fixture navigation; it is not a per-step agent latency and should not be quoted as one.

---

## 3. Other measured real-browser latencies

| Stage | Value | Source | Notes |
|---|---:|---|---|
| Redaction overlay | **1.1 ms** | `phase15-privacy-fusion/phase15_real_chrome_evidence.json` | Real Chrome |
| Screenshot capture | **1,772 ms** | `phase3-real-browser/audit_evidence.json` | Real Chrome, single sample — **n=1, not a distribution** |
| Stage-5 end-to-end action | **3,805 ms** | `stage5-real-browser/stage5_real_chrome_evidence.json` | Single measurement |

The 1,772 ms capture figure is worth noting: it is the only screenshot-capture timing in the repository and it is a **single sample from an older phase on a different page**. It is not a reliable performance characteristic, and it should be treated as an anecdote. **Screenshot capture latency is effectively NOT INSTRUMENTED** in any repeatable way.

---

## 4. Reasoner (cloud) latency

**Source:** `docs/evidence/phase14-interaction-output/reasoner_failure_path_evidence.json`

| Measurement | Value | Meaning |
|---|---:|---|
| `slowReasonerMs` | 40,000 ms | A deliberately slow reasoner; the loop's timeout path fired |
| `reasoningEnteredAtMs` | 4,966 ms | Time from run start to entering reasoning |
| `terminalAtMs` | 45,005 ms | Time to terminal state |
| `lastProgressAtMs` | 112 ms | Last progress heartbeat before the stall |

These characterise the **timeout / watchdog path**, not typical Groq latency. They are the evidence that a stalled reasoner is detected and terminated rather than hanging the loop — the behaviour that P0-1's predecessor commit (`e41b8b9`, "stop reporting a slow reasoner as a perception stall") fixed.

**Typical real Groq round-trip latency: NOT INSTRUMENTED.** The two live real-reasoner runs did not record per-request wall-clock timing. The README's stated `~1,200 ms – 2,800 ms` per step comes from earlier manual observation, is **not** from a committed instrumented measurement, and is not reproduced by any artifact in this repository. Treat it as an unverified claim.

---

## 5. Per-stage latency table

| Stage | Instrumented? | Value |
|---|---|---|
| DOM candidate extraction | Yes | 14.2 ms avg (JSDOM, 32 candidates) |
| Local decision cycle (P50 / P95) | Yes | 45 / 88 ms (deterministic local runner) |
| Real perception cycle (real Chrome) | Yes | p50 41.55 ms, max 186.17 ms, n=21 |
| Real perception latency (named) | Yes | 19.41 ms |
| Redaction overlay | Yes | 1.1 ms (real Chrome) |
| Action dispatch (real Chrome) | Yes | p50 11.91 ms, max 167.47 ms, n=13 |
| Planner latency (per-invocation) | **NO** | **NOT INSTRUMENTED** |
| Reasoner round-trip (real Groq) | **NO** | **NOT INSTRUMENTED** — see §4 |
| Effect verification latency | **NO** | **NOT INSTRUMENTED** — the seam records verdicts, not durations |
| Snapshot collection (content script round-trip) | **NO** | **NOT INSTRUMENTED** — 2 s / 3 s *timeouts* exist, no timing telemetry |
| Goal verification latency | **NO** | **NOT INSTRUMENTED** |
| Total agent cycle latency (live reasoner) | **NO** | **NOT INSTRUMENTED** |
| Screenshot capture (repeatable) | **NO** | **NOT INSTRUMENTED** — one 1,772 ms sample, not a distribution |
| OCR cost | **NO** | **NOT INSTRUMENTED** — and the OCR branch is dormant in the autonomous loop, so there is nothing to measure there |
| Model initialization (Tesseract WASM load) | **NO** | **NOT INSTRUMENTED** |
| Memory / heap footprint | **NO** | **NOT INSTRUMENTED** |
| Number of actions per task | Partially | 2 actions for the controlled task; no cross-task distribution exists |

---

## 6. Honest assessment

**What can be said with confidence:** local decision-making is fast — sub-100 ms at p95 on the deterministic runner, and tens of milliseconds per perception cycle in real Chrome. Redaction overhead is negligible at ~1 ms.

**What cannot be said:**
- **No end-to-end live-reasoner latency figure exists.** The single most commercially interesting number — how long a real task takes with a real cloud model — is not instrumented anywhere.
- **The Stage-7 p95 of 167 ms is an order of magnitude above the deterministic-runner's 88 ms p95.** These are different substrates and different workloads; the difference is not explained by any committed measurement. Do not present them as consistent.
- **Screenshot capture is the least-understood cost.** One sample suggests ~1.8 s, which would dominate a cycle, but a single sample cannot support that conclusion. It is the most valuable thing to instrument if performance work is ever authorized.
- **There is no memory or model-initialization data at all.**

**Recommended framing for the presentation:** quote the local decision cycle with its "Groq excluded" label attached, and state plainly that total cycle latency including a real cloud reasoner is not instrumented. Do not construct an end-to-end number by addition — the components were measured on different substrates at different times under different workloads, and summing them would be fabrication.
