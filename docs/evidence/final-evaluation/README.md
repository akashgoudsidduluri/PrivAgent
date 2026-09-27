# PrivAgent — Final Evaluation

**Commit evaluated:** `593fe72` · **Date:** 2026-09-27

This directory is the final, claim-by-claim evaluation of PrivAgent. Its purpose is to turn the Phase 0–15 engineering work into a **defensible, evidence-backed position**: what is proven, what is not, and what must be said honestly in a presentation.

**No production code was changed to produce any document here.** This pass is documentation- and evidence-only. Phase 16 was not started.

---

## Read in this order

| # | Document | Question it answers |
|---|---|---|
| 1 | [`CLAIM_EVIDENCE_MATRIX.md`](./CLAIM_EVIDENCE_MATRIX.md) | What does PrivAgent actually prove, and at what evidence level? |
| 2 | [`SECURITY_EVALUATION.md`](./SECURITY_EVALUATION.md) | Are the security authorities real, enforced, and unbypassable? |
| 3 | [`PRIVACY_EVALUATION.md`](./PRIVACY_EVALUATION.md) | Can raw PII escape? What is live vs. dormant? |
| 4 | [`AGENT_CAPABILITY_EVALUATION.md`](./AGENT_CAPABILITY_EVALUATION.md) | What can the agent actually do, stage by stage? |
| 5 | [`PERFORMANCE_BASELINE.md`](./PERFORMANCE_BASELINE.md) | What has been measured, and what has not? |
| 6 | [`FAILURE_RECOVERY_MATRIX.md`](./FAILURE_RECOVERY_MATRIX.md) | What happens when things go wrong? |
| 7 | [`FINAL_DEMO_RUNBOOK.md`](./FINAL_DEMO_RUNBOOK.md) | How do I reproduce the success demo? |
| 8 | [`NEGATIVE_DEMO_RUNBOOK.md`](./NEGATIVE_DEMO_RUNBOOK.md) | How do I prove the system can say "no"? |
| 9 | [`FINAL_METRICS.md`](./FINAL_METRICS.md) | What are the exact numbers? |
| 10 | [`REPRODUCTION.md`](./REPRODUCTION.md) | What was actually executed, and what was assumed? |

Supporting evidence from earlier work lives in [`../post-phase15-e2e/`](../post-phase15-e2e/) and the per-phase directories under [`../`](../).

---

## Executive summary

**What PrivAgent proves.** A real cloud reasoner (Groq `openai/gpt-oss-20b`) can propose browser actions, and a local deterministic runtime can refuse to trust them. The full production chain — dashboard → service worker → perception → privacy minimization → planner → real reasoner → normalization → **nine security gates** → containment → real browser dispatch → **observed** effect verification → goal verification — has been carried end to end on real infrastructure, reaching terminal `SUCCESS` on observed browser state.

**What it does not prove.** Generalization. Exactly **one** task shape — a two-action search on a deterministic local fixture — has ever completed a goal. There is no evidence about multi-page live workflows, live error recovery, authenticated sites, cross-origin iframes, virtualized content, or any site where the goal state is not trivially observable in the URL.

**What is deliberately not done.** OCR is dormant in the autonomous loop (the service worker passes no `ocrEngine`). The confirmation gate has never been triggered by a live reasoner. Google's anti-bot interstitial is treated as a product boundary, not an engineering problem. `providerRetries` remains 0 because no experiment justifies changing it.

**Headline numbers.**

| | |
|---|---|
| Regression | **1163 / 1163** across 100 files |
| Real Chrome negative control | **9 / 9** (`ACTION_NO_EFFECT`) |
| Controlled real-reasoner success | **Reproduced, 2 / 2 runs** |
| TypeScript | **5 pre-existing errors, 0 introduced** |
| Builds | **Both pass** |
| Security-authority modifications | **0** |
| Raw PII leaks observed | **0** |
| Production code changed | **None** |

---

## The one distinction that matters

The most common failure mode in browser-agent demonstration is showing a success and calling it proof. PrivAgent's evidence structure is designed to prevent that:

> The controlled success run and the **no-effect falsifier** were established together. `verifyActionEffect` is proven — in the same real browser, against the same production seam — to return `ACTION_NO_EFFECT` when an action dispatches successfully and the page does not move. If that seam could not fail, the `SUCCESS` would mean nothing.

That is why `NEGATIVE_DEMO_RUNBOOK.md` exists and why it should be run immediately after the success demo in any presentation.

---

## The honest one-paragraph summary

> PrivAgent is a privacy-native browser agent whose defining property is that **reasoning is not authority**: a cloud LLM proposes actions from sanitized structural metadata, and a local deterministic runtime validates, gates, authorizes, and verifies every interaction before and after dispatch. This was validated with a real Groq reasoner, a real browser, and the production path — reaching a goal-verified `SUCCESS` on a controlled local fixture, while independently demonstrating that it refuses when it should: blocking an action whose reason text tripped the privacy scanner, refusing to hijack a local port, and reporting `ACTION_NO_EFFECT` when a dispatched action changed nothing. Zero raw PII was observed crossing any boundary, and no security authority was weakened. What is **not** demonstrated is that any of this generalizes beyond a single deterministic page.
