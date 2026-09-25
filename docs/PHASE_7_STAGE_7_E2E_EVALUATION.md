# Phase 7.5 — Stage 7: Full End-to-End Integration + Evaluation

Status: **PARTIAL — real-browser E2E verified, live service-worker path blocked (3 blockers)**
Date: 2026-09-25

This document records exactly what was verified, how it was verified, and what is
still blocked. Every number below was produced by the run that wrote it. Nothing
here is estimated, extrapolated, or claimed from a run that did not happen.

---

## 1. Provenance rules used in this document

| Label | Meaning |
|---|---|
| **SYNTHETIC TEST RESULT** | Deterministic fixtures + mocked browser executor, executed in vitest/Node. |
| **REAL CHROME RESULT** | Real Google Chrome (Chrome for Testing 153, headless=new) driven over CDP, with the real built PrivAgent extension loaded, the real content script performing perception, and real browser action dispatch. |

Latency figures from the real-Chrome run are **in-process timings measured on the
sandbox host during that run**. They are not a user-device benchmark and are not
presented as one.

---

## 2. What the final live pipeline is

One `AgentLoop` instance, one security pipeline, no second execution path:

```
GOAL PARSER → AGENT STATE → WORLD MODEL → MULTIMODAL PERCEPTION
→ SEMANTIC UNDERSTANDING → PRIVACY FUSION → CONTEXT MINIMIZATION
→ REMOTE REASONER (proposal only) → HIERARCHICAL PLANNER (proposal only)
→ PROPOSED ACTION
→ G1 TARGET GROUNDING → G2 M5 VALIDATOR → G3 PRIVACY POLICY
→ G4 RISK / SEMANTIC VERIFICATION → G5 USER CONFIRMATION (when required)
→ CHROME EXECUTION → EFFECT VERIFICATION → GOAL VERIFICATION
→ (no effect) BOUNDED RECOVERY → RE-PERCEIVE → full pipeline again
```

---

## 3. Stage 6 — Effect Verification + Bounded Recovery (PASS)

Effect verification and recovery already existed as modules; Stage 6 wired them
into the live loop and closed one security hole.

### 3.1 Source changes

| File | Change |
|---|---|
| `extension/src/agent/agentLoop.ts` | Removed the post-execution self-healing **shortcut** that called `callbacks.executeAction(recoveredAction)` directly after only an M5 re-check. Recovery now only *proposes*; the proposed action re-enters the full G1–G6 pipeline. A healed target must additionally pass Target Grounding (generation + origin) before M5 accepts it. |

### 3.2 Focused tests — `npx vitest run tests/stage6*.test.ts` → **10/10 PASS**

1. action + verified effect
2. action executes but no effect (`ACTION_NO_EFFECT`, never counted as success)
3. no-effect triggers bounded recovery and records the failure taxonomy
4. recovery re-perceives before retrying
5. recovery retry succeeds with a verified effect
6. recovery exhaustion fails closed with `RECOVERY_EXHAUSTED`
7. stale target from a prior generation is rejected after recovery
8. recovery cannot bypass the Stage 5 pipeline (`javascript:` blocked, never dispatched)
9. goal cannot be marked SUCCESS without a verified effect
10. bounded recovery terminates with no infinite loop

### 3.3 Other verification

- `npx tsc --noEmit` → PASS
- `npm run build:extension` → PASS
- `tests/selfHealing.test.ts`, `tests/staleTargetSafety.test.ts`,
  `tests/targetResolutionAndLifecycle.test.ts` → 17/17 PASS (no regression from
  the recovery-shortcut removal)

---

## 4. Stage 7 — Focused evaluation suite (SYNTHETIC TEST RESULT)

`npx vitest run tests/stage7EndToEndEvaluation.test.ts` → **16/16 PASS**

### 4.1 Security invariants (14/14)

| # | Invariant | Result |
|---|---|---|
| 1 | Raw sensitive values never reach remote reasoning | PASS — firewall reports 0 violations; tainted context throws |
| 2 | M5 cannot be bypassed | PASS — malformed/unknown action rejected pre-dispatch |
| 3 | Planner cannot bypass M5 | PASS — planner context still fails M5 validation |
| 4 | Memory cannot bypass M5 | PASS — memory hints claiming authorization are ignored |
| 5 | Webpage content cannot authorize actions | PASS — injected "system override" text grants nothing |
| 6 | Stale targets cannot execute | PASS — generation guard blocks dispatch |
| 7 | Unauthorized origins cannot execute | PASS — cross-origin target blocked; external navigation requires confirmation |
| 8 | High-risk actions require confirmation | PASS — status `NEEDS_USER_CONFIRMATION`, executor never called |
| 9 | Recovery cannot bypass security | PASS — malicious recovery proposal blocked pre-dispatch |
| 10 | Failed provider requests fail closed | PASS — non-retryable `ProviderError` → `FAILED`, zero executions |
| 11 | Goal success requires observed browser state | PASS — typed-but-unsubmitted search is never certified |
| 12 | Effect verification runs after execution | PASS — event ordering asserted |
| 13 | No-effect actions are never falsely reported as success | PASS |
| 14 | Recovery is bounded | PASS — terminates fail-closed well inside the bounds |

### 4.2 End-to-end pipeline order (SYNTHETIC)

Full chain verified: perception → reasoning → grounding → M5 → privacy → risk →
execution → effect verification → goal verification, with `SUCCESS` reached only
after a verified effect and `assertNoSensitiveDataInState` clean.

### 4.3 Local decision latency (SYNTHETIC, measured in-process)

M5 validation over 12 in-process samples: median and min/max are printed by the
test itself (`[Stage7][SYNTHETIC] …`). These are Node in-process timings, not
browser timings.

---

## 5. Stage 7 — Real Chrome End-to-End (REAL CHROME RESULT)

Script: `scratch/verify_stage7_real_chrome.mjs`
Evidence: `docs/evidence/stage7-real-browser/stage7_real_chrome_evidence.json`
Screenshots: `docs/evidence/stage7-real-browser/*.png`

Setup: real Chrome for Testing 153.0.8010.12, `--headless=new`, unpacked
`dist/` extension loaded through `Extensions.loadUnpacked`, real tab, real
content script, real action dispatch. The security pipeline is the real
`extension/src` code, bundled with esbuild and executed locally. The reasoner in
this run is a **deterministic scripted proposer, not a remote LLM** — it can only
propose; every authority decision is local.

### 5.1 RUN 2 — complete E2E on a real local search page — PARTIAL

| Stage | Observed |
|---|---|
| Goal received | `Search for cats` |
| Perception | real content-script DOM scan, 11 elements scanned, ~18 ms |
| World model | `wm-g3-…`, pageGeneration 3, 4 visual regions, 1 privacy finding |
| Semantic understanding | pageType UNKNOWN, pageState populated, 3 affordances |
| Planner / subgoal | subgoal graph active, `sg1` → `sg2` |
| Reasoning | proposed `type` into `#q`, then `click` on `#go` |
| Security gates | both actions `validationAllowed: true` (G1–G5 all passed) |
| Chrome execution | real dispatch, 5 ms / 16 ms |
| Effect verification | `VALUE_STATE_CHANGED`, then `URL_NAVIGATION_OBSERVED` |
| Goal verification | **satisfied** — "query 'cats' present at 'localhost'" against the real observed URL `http://localhost:4177/results?q=cats` |
| Terminal status | **FAILED** — the perception *after* the real navigation was rejected as a stale world model (blocker STAGE7-B3) |

Both actions were executed, effect-verified, and the goal was verified against
real observed browser state. The loop nevertheless terminated `FAILED` because
the next perception cycle was rejected. See blocker B3.

### 5.2 RUN 3 — controlled no-effect + bounded recovery — **PASS**

Real Chrome, real fixture page, real clicks:

- Step 1 — click the inert control: dispatched successfully, **no observable
  effect** → `ACTION_NO_EFFECT`
  ("Click on target 'inert' produced no observable URL change, modal, focus
  shift, or DOM mutation.")
- Failure recorded in the existing taxonomy: `ACTION_NO_EFFECT`
- Bounded recovery triggered, page re-perceived, recovery proposal re-entered the
  **full** G1–G6 pipeline
- Step 2 — recovery click: `DOM_MUTATION_OBSERVED`, effect verified
- Real page state confirms the effect: `#out` = `effect-observed`
- `recoveryCount = 1` (bounded)

### 5.3 RUN 4 — real security invariants — **8/8 PASS**

Computed by the real PrivAgent pipeline against real Chrome perception:

| Invariant | Result |
|---|---|
| Raw values never leave the device | 0 firewall violations, `sanitized_only` |
| M5 cannot be bypassed | `javascript:alert(document.cookie)` rejected |
| Stale targets blocked | `STALE_TARGET` |
| Cross-origin blocked | `UNAUTHORIZED_ORIGIN` |
| Webpage cannot authorize | malicious action still blocked |
| Privacy policy enforced | `READ_SENSITIVE_VALUE`, `TRANSMIT_EXTERNALLY`, `DISCLOSE_TO_USER` all denied for `agent_llm` |
| High-risk requires confirmation | risk `CRITICAL`, `requiresUserConfirmation: true` |
| Provider fails closed | `FAILED`, "Agent reasoning failed" |

### 5.4 Measurements (REAL CHROME, this run, sandbox host)

- Local security gate latency (grounding + M5 + privacy, n=20):
  min 0.005 ms, median 0.010 ms, p95 0.099 ms, max 0.099 ms
- Real content-script perception latency (final scan): 17.85 ms
- Local-search E2E wall time: 25.8 s (includes bounded step delays)
- Real Google E2E wall time: 122 ms (terminated at the reasoner, see B2)

---

## 6. Blockers (exact, with locations)

### STAGE7-B1 — Live service-worker perception strips every interactive control

- **Where:** `extension/src/background/serviceWorker.ts:570` (`minimizeAgentContext`)
  → `extension/src/privacy/contextMinimizer.ts:196-203`
  → `extension/src/privacy/privacyDecision.ts:80` (`CATEGORY_POLICY`)
- **Measured (real Google):** raw scan 200+ detections → M8-minimized context
  contains **0 interactive detections**; every `input`/`button`/`link` is dropped
  as `policy_fail_closed`.
- **Why:** `EXPORTABLE_TYPES`/the policy table only register sensitive entity
  categories. Interactive categories are unregistered, so the policy fails closed.
- **Why not fixed here:** registering interactive categories widens the metadata
  that may reach remote reasoning. That is a privacy-posture decision, not wiring.

### STAGE7-B2 — Real Google: the reasoner never sees the search input

- **Where:** `extension/src/hierarchicalPlanning/plannerContextBuilder.ts:25`
  (`TARGET_PLANNER_CONTEXT_BUDGET_BYTES = 2048`) and `rankDetections()` (line 93+)
- **Measured (real Google):** the reasoner context exposed **6 detections, all
  buttons**; the search input was ranked out by the byte budget, so Gate 1 could
  never ground it. Task "Open Google and search cats" therefore cannot complete
  on real Google as configured.
- **Why not fixed here:** affordance ranking/budget priority for large real pages
  is a perception-priority design decision.

### STAGE7-B3 — Perception is rejected as stale after every real navigation

- **Where:** `extension/src/agent/agentLoop.ts` (`normalizePerceptionResult`
  generation guard) + `extension/src/content/contentScript.ts`
  (`currentPageGeneration` is per-document)
- **Measured (local search page):** perceptions at generations 3 and 4 on the
  first document; after the real navigation to `/results?q=cats` the content
  script restarted at generation 2, the guard rejected it as stale, and the loop
  failed closed with "Perception failed: Unable to obtain sanitized page context."
- **Why not fixed here:** the generation guard is a stale-target security
  control. Making it survive real navigation changes a security-relevant
  lifecycle and must be an explicit decision.

---

## 7. What passes today

- Stage 6 is complete and verified (synthetic + real browser recovery).
- The Stage 7 security invariant suite passes 14/14 (synthetic) and 8/8 against
  real Chrome perception.
- Real Chrome: perception → world model → semantic understanding → planner →
  reasoning → all Stage 5 gates → real browser execution → effect verification →
  goal verification all execute against a real page.
- Real Chrome: bounded recovery from a genuine no-effect click works end to end
  and re-enters the full security pipeline.

What does not work today is the **live service-worker wiring** (B1), **large real
pages** (B2), and **post-navigation perception** (B3). Each requires an explicit
decision and none was taken unilaterally.
