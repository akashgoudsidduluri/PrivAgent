# Phase 7.5 — Stage 7: Full End-to-End Integration + Evaluation

Status: **PARTIAL — real-browser E2E verified; one confirmed blocker (B2)**
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
| Terminal status | **SUCCESS** — goal certified against the observed results URL |

Both actions were executed, effect-verified, and the goal was verified against
real observed browser state. An earlier run of this same script terminated
`FAILED` because the perception immediately after a real navigation was rejected;
that did **not** reproduce. The content script already persists its page
generation in `sessionStorage` (`restorePageGeneration`/`persistPageGeneration`),
and a targeted probe confirmed the generation stays monotonic across a real form
navigation (3 → 5 → 6 → 8, `sessionStorage` 4 → 5 → 6 → 7 → 9). Blocker B3 is
therefore **withdrawn as unreproducible**.

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

## 6. Blocker status (exact, with locations)

### STAGE7-B2 — CONFIRMED: the 2 KB planner budget hides the real Google Search control

- **Where:** `extension/src/hierarchicalPlanning/plannerContextBuilder.ts:25`
  (`TARGET_PLANNER_CONTEXT_BUDGET_BYTES = 2048`) and `rankDetections()` (line 93+)
- **Measured on real Google, this run:** the raw content-script scan produced 14
  detections; the reasoner context the loop actually received contained only 4:

  ```
  button:#gbqfbb        (I'm Feeling Lucky)
  button:input[name="btnI"]  (I'm Feeling Lucky variant)
  input:#ti6dpd          (the real search box — present)
  link:a.w5hRs
  ```

  The genuine "Google Search" control (`input[name="btnK"]`) was ranked out by
  the byte budget. The agent therefore typed into the real search box
  (`VALUE_STATE_CHANGED`), clicked a real Google button
  (`URL_NAVIGATION_OBSERVED`) and landed on a real result page
  (`https://en.wikipedia.org/wiki/Cat` via "I'm Feeling Lucky").
- **Why the run is not `SUCCESS`:** goal verification correctly refuses to certify
  it — the observed URL is a result page, not a search-results URL with a `q`
  parameter. The verifier is behaving correctly; the reasoner was never given the
  control that would have produced a SERP.
- **Why not fixed here:** the 2 KB bound is a deliberate, documented contract
  (`plannerContextBuilder.ts:7`) with its own acceptance test
  (`tests/hierarchicalPlanningAcceptance.test.ts:143`). Raising it changes an
  agreed prompt-size budget to make a demo pass, which is a design decision, not
  a wiring fix. Note the builder already preserves capability diversity
  ("never eliminate an entire interaction capability"), which is why an input and
  buttons survive — it just cannot preserve *which* button.

### STAGE7-B1 — WITHDRAWN: interactive controls are not stripped

The earlier claim that `minimizeAgentContext()` drops every interactive control
was **not reproducible**. The current real-browser measurement on the Google page
is:

| Stage | Detections |
|---|---|
| Raw content-script scan | 14 |
| M4 sanitized payload (`buildAgentPayload`) | 14 |
| M8 minimized context (`minimizeAgentContext`) | 14 |
| Interactive detections surviving minimization | 14 |
| Dropped | none |

Direct module checks confirm every interactive category
(`button`, `link`, `input`, `search`, `select`, `form`, `heading`, `element`) and
every sensitive category survives minimization. The live service-worker
perception configuration is therefore **not blocking** (`blocking: false`).

### STAGE7-B3 — WITHDRAWN: post-navigation perception is not stale

A direct probe of the real content script showed the page generation is
monotonic across a real form navigation driven by the extension itself
(`wm` 3 → 5 → 6 → 8; `sessionStorage` 4 → 5 → 6 → 7 → 9), and world model,
active ref and semantic context all agree on the same generation. The single
earlier `FAILED` run did not reproduce in subsequent runs.

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
- Real Chrome: a complete, `SUCCESS`-terminated run — perception → world model →
  semantic understanding → planner → reasoning → all Stage 5 gates → real
  dispatch → effect verification → goal verification, certified against the real
  observed URL.
- Real Chrome on real Google: the agent typed into the real Google search box and
  dispatched a real submit; only the control ranking stopped it from reaching a
  SERP (B2).

What does not work today is a single thing: on a large real page the 2 KB planner
context budget can rank out the one specific control the task needs (B2). The
decision needed is whether to raise that documented budget, or to change how
affordances are ranked inside it. Nothing else was changed unilaterally.
