# PrivAgent — Agent Capability Evaluation

**Commit evaluated:** `593fe72`
**Date:** 2026-09-27

**Scope.** This evaluates the agent loop stage by stage, using **only actual evidence**. The four grades below are deliberately coarse, and the bar for `REAL BROWSER PROVEN` is high: a run in real Chrome, through the production service worker, driven by the real configured reasoner, with the outcome asserted from observed system state.

| Grade | Meaning |
|---|---|
| **REAL BROWSER PROVEN** | Demonstrated in real Chrome on the production path with the real reasoner. |
| **CONTROLLED FIXTURE PROVEN** | Real browser + real reasoner + real gates, but only against a deterministic local fixture. |
| **TEST-ONLY PROVEN** | Implemented and covered by automated tests on a real or faithful substrate. |
| **NOT YET PROVEN** | Implemented, or partially implemented, with no evidence at the level above. |

---

## Stage-by-stage

### 1. Task intake — **REAL BROWSER PROVEN**
A task string entered in the real dashboard and submitted via the real RUN control (`#agent-run-btn`) drove two live runs. Evidence: `real_reasoner_controlled_success_evidence.json`, `real_reasoner_e2e_evidence.json`.
*Note:* the topbar run button only focuses the input; the real control is `#agent-run-btn`.

### 2. Target resolution — **REAL BROWSER PROVEN (both outcomes)**
Live evidence covers *both* directions:
- **Adoption path:** the pre-opened fixture tab was adopted, origin `http://localhost:4199`, tab ID recorded, initial URL `http://localhost:4199/`, final URL `http://localhost:4199/results?q=cats`.
- **Refusal path:** the first attempt failed with `DESTINATION_REQUIRED` because a port-qualified local target must already be open. The resolver refused to provision or hijack a local port. This is a real-browser demonstration of a safety refusal, not merely a test.

### 3. Perception — **REAL BROWSER PROVEN**
Real DOM scanning and real multimodal coordination ran on every cycle. The service worker logged `visualDetections`, `screenshotWidth/Height`, `ocrRegions`, and `privacyFindings` from the real page.
*Qualification:* the **OCR branch is dormant** here — see `PRIVACY_EVALUATION.md` §2. The fixture contains no PII, so the privacy half of perception was not meaningfully exercised.

### 4. World model — **TEST-ONLY PROVEN**
`browserWorldModel.test.ts` (16), `accessibilityTree.test.ts`, `spatialRelationships.test.ts` (9), `entityGraph`/`spatialEngine` code. Built and used on the live path, but no live assertion was made about its contents.

### 5. Planning — **REAL BROWSER PROVEN**
A real multi-round plan executed. The wire capture shows two real reasoner requests with `historyLength` progressing `0 → 1` — a genuine second planning round, not a replayed first response.

### 6. Real reasoner — **REAL BROWSER PROVEN**
Groq `openai/gpt-oss-20b`, `apiKeyConfigured: true`, `reasonerClass: GroqReasoner`, two `POST /api/v1/agent/action` → 200 OK. **Reproducibility evidence:** two independent runs produced *different* natural-language reason strings for the same step while producing the same correct action — see `REPRODUCTION.md`. The reasoner is genuinely generating, not replaying.

### 7. Action normalization — **REAL BROWSER PROVEN**
Real model output was normalized into the typed action schema (`type` / `click`) with target and text. Two different reasoner outputs normalized cleanly to two valid actions.

### 8. Grounding — **REAL BROWSER PROVEN (accept path only)**
Both actions grounded to elements genuinely present (`q`, `go`). The **reject** path under a live reasoner was not demonstrated; it is covered by `candidateVerification.test.ts` and `m5EndToEnd.test.ts`.

### 9. Security gates — **REAL BROWSER PROVEN (executed; both accept and block observed across runs)**
All gates executed in the production order. Accept observed twice. Block observed in the live-Google run, where the reason text tripped the PII scanner and M5 failed closed. See `SECURITY_EVALUATION.md` for the full table.

### 10. Containment — **REAL BROWSER PROVEN (in-scope path + one refusal)**
Root host `localhost`; both initial and final URLs in scope. The local-port refusal above is a live containment refusal. A live **escape** attempt being blocked was not separately demonstrated with a real reasoner.

### 11. Dispatch — **REAL BROWSER PROVEN**
Both actions `executionSuccess: true`, executed by the real content script in the real tab. The effect seam independently records `dispatchSucceeded: true` for a case where the *effect* nonetheless failed.

### 12. Observed effect verification — **REAL BROWSER PROVEN (accept and reject)**
This is one of the project's strongest results.
- Accept: `VALUE_STATE_CHANGED` (observed length 4), `FOCUS_SHIFT_OBSERVED`.
- Reject: real Chrome, scroll at boundary, requested 600 px, **observed delta 0** → `ACTION_NO_EFFECT`, with `dispatchSucceeded: true, effectVerified: false`. 9/9 checks, re-run and confirmed this pass.
The verifier is fed snapshots read from the live tab. The earlier defect — synthesizing post-state from the requested action — is pinned by a regression test.

### 13. Goal verification — **CONTROLLED FIXTURE PROVEN**
Terminal `SUCCESS`, `goalStatus SUCCESS`, reason *"Search goal verified against observed results URL: query 'cats' present at 'localhost'."* Produced by the **unmodified** production `verifyTaskGoal`. The harness asserted the agent's terminal state *and* read the DOM marker `#result-marker` = `Search results for cats` independently; it never asserts the verdict itself and never injects a result.

`verifyTaskGoal` satisfies a search goal only from an **observed** `?q=<intent>` on a non-root pathname. A typed-but-unsubmitted value is never success — which is exactly why the two-step fixture needed a real submit before it could pass.

### 14. Recovery / termination — **TEST-ONLY PROVEN**
`phase10RecoveryEngine.test.ts` (23), `m11Robustness.test.ts`, `selfHealing.test.ts` (2), `docs/evidence/phase10-recovery/`. Recovery fired in the live-Google run (stale/interstitial target) but was not required in the successful fixture run. Healed actions re-enter grounding and M5, so recovery cannot authorize.

---

## Capability summary

| Capability | Grade |
|---|---|
| Real task intake through the dashboard UI | REAL BROWSER PROVEN |
| Target tab adoption | REAL BROWSER PROVEN |
| Refusal to provision/hijack a local port | REAL BROWSER PROVEN |
| Real perception (DOM + visual regions) | REAL BROWSER PROVEN |
| **OCR perception in the autonomous loop** | **NOT YET PROVEN** — dormant by design |
| Multi-round planning | REAL BROWSER PROVEN |
| Real Groq reasoner generation | REAL BROWSER PROVEN |
| Action normalization | REAL BROWSER PROVEN |
| Grounding (accept) | REAL BROWSER PROVEN |
| Grounding (reject) under live reasoner | TEST-ONLY PROVEN |
| Security gate chain execution | REAL BROWSER PROVEN |
| Security gate **blocking** under live reasoner | REAL BROWSER PROVEN |
| Confirmation prompt under live reasoner | TEST-ONLY PROVEN — never triggered |
| Containment in-scope navigation | REAL BROWSER PROVEN |
| Containment escape block under live reasoner | TEST-ONLY PROVEN |
| Real browser dispatch | REAL BROWSER PROVEN |
| Observed effect verification (accept) | REAL BROWSER PROVEN |
| Observed effect verification (`ACTION_NO_EFFECT`) | REAL BROWSER PROVEN |
| **Goal verification SUCCESS** | **CONTROLLED FIXTURE PROVEN** |
| Goal verification SUCCESS on a live public site | NOT YET PROVEN — blocked by anti-bot |
| Provider fail-closed | REAL BROWSER PROVEN |
| Bounded recovery | TEST-ONLY PROVEN |
| PII-bearing page under a live reasoner | NOT YET PROVEN |
| **Broad autonomous web navigation** | **NOT YET PROVEN** |

---

## The honest position

**What is genuinely demonstrated:** the full production chain — dashboard → service worker → perception → minimization → planner → real cloud reasoner → normalization → nine security gates → containment → real dispatch → observed effect verification → goal verification — can be carried end to end on real infrastructure, with the security layer independently demonstrably capable of refusing.

**What is not:** that it generalizes. The single completed task is a two-action search on a local page whose DOM the harness wrote. One task shape is not a capability claim. There is no evidence about: multi-page workflows under a live reasoner, error recovery on live sites, pages with heavy virtualization or iframes, sites that need authentication, or any site where the goal state is not trivially observable in the URL.

**Why the live-Google run did not reach SUCCESS — the precise sequence:**
1. `buildAgentPayload` was dropping all interactive affordances (`detectionCount: 0`) because it *replaced* DOM detections with a visual report containing only sensitive entities. **Real defect, found and fixed** in `extension/src/privacy/types.ts`; `0 → 7` after the fix.
2. The search-button click was then **correctly blocked** — the reason text contained "cats", read as a possible `person_name`. Not a defect; the scanner was not weakened.
3. Google served its anti-bot interstitial, so the tab landed on `https://www.google.com/sorry/index?...` instead of results.
4. The reasoner then returned `rate_limit` on Groq and `unexpected_format` on the fallback → terminal `FAILED` / `REASONER_FAILED`.

Each of those is recorded honestly in `REAL_REASONER_E2E_REPORT.md`. None was engineered around.

---

## What must not be claimed

- ❌ "PrivAgent autonomously completes browser tasks."
- ❌ "The agent navigates the web."
- ❌ "End-to-end success is demonstrated."
- ❌ "Goal verification passes on real websites."

✅ **The defensible statement:** *"A real-reasoner controlled browser task reached verified goal success. The full production chain — real Groq reasoning, nine security gates, real browser dispatch, observed effect verification, and goal verification on observed state — was carried end to end against a deterministic local fixture, with the security layer independently demonstrably refusing when it should. Generalization to the open web is not demonstrated."*
