# PrivAgent — Security Evaluation

**Commit evaluated:** `593fe72`
**Date:** 2026-09-27

**Scope and non-scope.** This document reviews the *existing* security architecture. It does not modify it, propose changes to it, or assert formal security guarantees. No weakness is reported unless the implementation or an evidence artifact supports it. Where a control is genuinely strong, that is stated plainly; where its evidence is narrower than its design, that is stated too.

**Standing caveat.** PrivAgent has *tested and structurally enforced* controls. It does **not** have formal verification, an external security audit, a penetration test, or a vulnerability-disclosure process. Nothing below should be presented as a guarantee.

---

## Gate order as actually implemented

Read directly from `extension/src/agent/agentLoop.ts` (line numbers from commit `593fe72`):

| # | Stage | Call site |
|---|---|---|
| 1 | Target resolution / containment scope | before the loop |
| 2 | Perception + privacy + context minimization | before planning |
| 3 | **Grounding** — `groundProposedTarget` | 919 |
| 4 | **M5 Action Validator** — `validateAction` | 991 |
| 5 | **Security Critic** — `reviewProposedAction` | 1112 |
| 6 | **Privacy Policy** — `canPerformAction(..., 'agent_llm')` | 1179 |
| 7 | **Semantic verifier** — `verifySemanticAction` | 1252 |
| 8 | **Confidence** — `evaluateExecutionConfidence` | 1254 |
| 9 | **Confirmation** (conditional on risk) | between 8 and 9 |
| 10 | **Containment** — `evaluateContainment` | 1467 |
| 11 | Dispatch | 1655+ |
| 12 | **Effect verification** — `verifyActionEffect` (observed snapshots) | 1765 |
| 13 | **Goal verification** — `verifyTaskGoal` | 1893 region |
| 14 | **Recovery** — `RecoveryEngine.decide` | 1893 |

The order is fixed in code and was **not** modified at any point in the P0-1, P0-2, or controlled-success work.

---

## 1. Grounding

- **Authority:** an action may only target an element that exists in the *current* page generation. This is the first filter and it runs before M5.
- **Enforced at:** `groundingEngine.ts::groundProposedTarget`, called from `agentLoop.ts:919`.
- **Evidence:** `candidateVerification.test.ts`, `m5EndToEnd.test.ts`, `agentBridge.test.ts`. Live run: both accepted actions targeted elements genuinely present (`q`, `go`).
- **Can the reasoner bypass it?** No. The reasoner supplies a target *string*; grounding resolves it against the local world model. A hallucinated ID has nothing to resolve to.
- **Can the dashboard bypass it?** No. Grounding reads the local world model, not dashboard input.
- **Can recovery bypass it?** **No — and this is deliberate.** After a self-heal, grounding and M5 are **re-run on the healed action** (`agentLoop.ts:1001-1007`). Healing re-proposes; it does not authorize.
- **Can containment bypass it?** No. Independent controls; containment runs later and separately.
- **Tested:** yes.
- **Real-browser run:** the accept path, yes. The **reject** path has not been demonstrated with a live reasoner.

## 2. M5 Action Validator

- **Authority:** authoritative structural validation of the action schema. Rejects unsupported types (`eval`, `execScript`, `download`), out-of-bounds targets, geometry violations.
- **Enforced at:** `actionValidator.ts::validateAction`, `agentLoop.ts:991`.
- **Evidence:** `actionValidator.test.ts` (12), `m5EndToEnd.test.ts`. Real Chrome: *"Validated type action on known element 'q'."* / *"Validated click action on known element 'go'."* Real **block**: the Google search-button click was rejected by the downstream PII scanner in the same fail-closed chain.
- **Can the reasoner bypass it?** No.
- **Can the dashboard bypass it?** No.
- **Can recovery bypass it?** No — M5 re-runs on healed actions.
- **Tested:** yes, including injection-shaped inputs.
- **Real-browser run:** yes, both accept and block observed.

## 3. Security Critic

- **Authority:** an *independent* second opinion on the proposed action. It is not a filter the Critic can be talked out of; it returns `ALLOW | REVIEW | BLOCK`.
- **Enforced at:** `securityCritic.ts::reviewProposedAction`, `agentLoop.ts:1112`.
- **Evidence:** `phase8SecurityCritic.test.ts` (19), `m11Robustness.test.ts`, `adversarialBoundary.test.ts`.
- **Bypass analysis:** the Critic is independent of the M5 result and runs after it. A reasoner cannot address it separately; it is evaluating the same action, not the reasoner's self-assessment.
- **Tested:** yes.
- **Real-browser run:** it executed in the live chain; no independent observation of a Critic-specific `BLOCK` was isolated in a live run.

## 4. Privacy Policy

- **Authority:** capability-based. Separates what the LLM role may do from what the local user may do, and asserts that the outgoing context is sanitized.
- **Enforced at:** `privacyPolicy.ts::canPerformAction(action, target, 'agent_llm')` at `agentLoop.ts:1179`; `assertSanitizedContextSafe(context)` before egress.
- **Evidence:** `privacyPolicy.test.ts` (4), `planningSecurityBoundary.test.ts` (3), `siteExclusions.test.ts`.
- **Bypass analysis:** the call site hard-codes the role argument `'agent_llm'`. A reasoner cannot obtain the `local_user` role — the role is supplied by local code, not by the model.
- **Tested:** yes.
- **Real-browser run:** executed in the live chain.

## 5. Risk Engine

- **Authority:** scores an action and decides the risk tier.
- **Enforced at:** feeds both the semantic verifier and the confirmation gate; a risk score ≥ threshold pauses for explicit user authorization.
- **Evidence:** `riskEngine.test.ts`.
- **Bypass analysis:** risk is computed **locally** from the action and target. The reasoner has no field by which it can assert or lower a risk score.
- **Tested:** yes.
- **Real-browser run:** neither fixture action met the confirmation threshold. **Confirmation was therefore never exercised in a live real-reasoner run** — it was not skipped, it was not triggered.

## 6. Semantic / Confidence gates

- **Authority:** decides whether the action is *semantically aligned* with the user's stated goal, and whether local confidence is sufficient to execute or to ask.
- **Enforced at:** `semanticVerifier.ts::verifySemanticAction` (`agentLoop.ts:1252`) and `confidenceScorer.ts::evaluateExecutionConfidence` (`:1254`). Outcomes: `ALLOW | REQUIRE_CONFIRMATION | REJECT` and `AUTO_EXECUTE | REQUIRE_CONFIRMATION | BLOCK`.
- **Evidence:** `semanticVerifier.test.ts` (4), `semanticSecurityBoundary.test.ts`, `semanticAcceptance.test.ts`, `goalRelevance.test.ts`.
- **Bypass analysis:** both are pure local functions of (action, task, context, risk). No model input can widen their output set.
- **Tested:** yes.
- **Real-browser run:** executed in the live chain; both actions returned `AUTO_EXECUTE`.

## 7. Confirmation

- **Authority:** explicit user authorization for consequential actions.
- **Enforced at:** conditional branch between confidence and containment; real control is `#agent-confirm-allow` in the dashboard.
- **Evidence:** `riskEngine.test.ts`, `phase11/` interaction tests (39 DOM-execution tests), `docs/evidence/phase11-human-interaction/`.
- **Bypass analysis:** the pending-confirmation state blocks dispatch; it is not a UI-only affordance.
- **Tested:** yes.
- **Real-browser run:** **not triggered.** State this honestly in any demo. See `NEGATIVE_DEMO_RUNBOOK.md` — the M5 block is the available live fail-closed demonstration, not a confirmation prompt.

## 8. Containment

- **Authority:** origin-scoped authorization. An action or navigation is permitted only within the established root host, and only over containable schemes.
- **Enforced at:** `containment.ts::evaluateContainment` (`agentLoop.ts:1467`) and `verifyNavigationContainment` on navigation; scope established by `establishContainmentScope`.
- **Evidence:** `containment.test.ts` (43), `targetResolver.test.ts` (21), `tabProvisioning.test.ts` (26), `docs/evidence/phase12-containment/`. Live: root host `localhost`, initial `http://localhost:4199/`, final `http://localhost:4199/results?q=cats` — both in scope.
- **Bypass analysis:** a port-qualified **local** target is never provisioned or hijacked. The first controlled-run attempt failed with `DESTINATION_REQUIRED` precisely because the resolver refused to open or take over a local port (`targetResolver.ts:110-152`, `:480-528`). This is a **real-browser demonstration of containment refusing to act**, which is stronger evidence than a test alone.
- **Known pre-existing quirk (documented, not changed):** `isDashboardOrigin` defaults to `http://localhost:5173` (`containment.ts:200`). Harnesses run the dashboard on 5174 and set `PRIVAGENT_DASHBOARD_PORT`. This is a configuration default, not a security weakness, and it was deliberately left untouched.
- **Tested:** yes.
- **Real-browser run:** in-scope navigation yes; a live **escape attempt** being blocked was not separately demonstrated in a real-reasoner run.

## 9. Effect Verification

- **Authority:** observation. It can only **fail an action closed** — `ACTION_NO_EFFECT` or `EFFECT_UNVERIFIABLE`. It grants no authorization and can never promote a blocked action.
- **Enforced at:** `effectVerifier.ts::verifyActionEffect`, `agentLoop.ts:1765`, on snapshots read from the live tab.
- **Evidence:** `effectVerificationObserved.test.ts` (17, includes a regression pin reproducing the old synthesized-post-state behaviour), `plannerAffordances.test.ts` (8), and the real Chrome seam at **9/9** — including `dispatchSuccessDoesNotImplyEffect` (`dispatchSucceeded: true, effectVerified: false`).
- **Fail-closed detail:** a PRE snapshot may fall back; a POST snapshot that cannot be observed **fails the action closed** within the existing retry budget. Snapshots carry `targetValueLength` only — never the value.
- **Bypass analysis:** the reasoner cannot supply snapshots. They are collected by the content script and read from the Chrome tab record.
- **Tested:** yes.
- **Real-browser run:** **yes — both the accept and the reject path.** This is one of the strongest real-browser results in the project.

## 10. Recovery Engine

- **Authority:** decides *whether to keep trying*, within a bounded budget. It is explicitly non-authoritative.
- **Enforced at:** `recoveryEngine.ts::RecoveryEngine.decide`, `agentLoop.ts:1893`; `strategy === 'ABORT'` terminates the task.
- **Evidence:** `phase10RecoveryEngine.test.ts` (23), `m11Robustness.test.ts`, `selfHealing.test.ts` (2), `docs/evidence/phase10-recovery/`.
- **Bypass analysis — important:** recovery may re-propose an action, but that re-proposal **re-enters grounding and M5** (`agentLoop.ts:1001-1007`). Recovery cannot authorize. The budget is finite and exhaustion aborts rather than loops.
- **Tested:** yes.
- **Real-browser run:** recovery fired in the live-Google run (stale/interstitial target); it did not need to fire in the successful fixture run.

## 11. Harness

- **Authority:** **none, by design.** It observes cycle state and enforces runtime bounds (step limits, cycle records, no-progress detection). It is explicitly documented as non-authoritative.
- **Enforced at:** `harness.ts::evaluateHarnessCycle`, `AgentHarness`.
- **Evidence:** `harness.test.ts` (47), `docs/evidence/phase13-harness/` including a production-path artifact.
- **Bypass analysis:** a non-authoritative component cannot be "bypassed" in the security sense, because it grants nothing. The risk would be the inverse — the Harness *failing open* and letting the loop run unbounded. It does not: bounds are finite and `MAX_HARNESS_CYCLE_RECORDS = 64`.
- **Tested:** yes.
- **Real-browser run:** executed in the live chain.

## 12. Output privacy boundary

- **Authority:** everything the user can ever receive is filtered at exactly one place.
- **Enforced at:** `serviceWorker.ts::sendToDashboard` → `screenAgentOutput(projectAgentOutput(payload))`, fails closed. The comment at that call site states the design intent explicitly: screening there makes "screened before crossing the SW → dashboard boundary" true *by construction* rather than by remembering to add it at each call site.
- **Evidence:** `agentOutput.test.ts` (47), `extensionAdapter.test.ts` (16), `docs/evidence/phase14-interaction-output/`.
- **Bypass analysis:** `projectAgentOutput` is a narrowing, read-only translation with no write path back into the loop, Harness, containment, or any gate. It can only remove/reshape what is shown.
- **Tested:** yes.
- **Real-browser run:** yes — the terminal state rendered correctly in the live dashboard.

## 13. Raw-sensitive-value scanning

- **Authority:** rejects any outbound payload containing a forbidden key or a known raw value.
- **Enforced at:** `rawValueScanner.ts` — `FORBIDDEN_PAYLOAD_KEYS`, `STRUCTURAL_VALUE_KEYS`, `scanForRawSensitiveValues`, `assertNoRawSensitiveValues`, `findKnownRawValueLeaks`; mirrored in `backend/app/security.py::verify_payload_invariants` (recursive) and `backend/app/models.py` (`extra="forbid"`, `reject_forbidden_keys`).
- **Evidence:** `rawValueScanner.test.ts` (17), `securityBoundary.test.ts` / `securityBoundary2.test.ts` (15), `ocrSecurityBoundary.test.ts`, `centralPrivacyInvariant.test.ts`. Real Chrome: `snapshotNeverContainsTheTypedValue` and `snapshotCarriesNoRawValueField` both pass.
- **Defense in depth:** enforced **twice** — once locally before egress, once at the backend on arrival. Neither is trusted alone.
- **Bypass analysis:** a structurally-forced key (`value`, `password`, `textContent`) cannot be smuggled through `extra="forbid"`. A validator that raises a `PrivacyBoundaryError` terminates the export.
- **Tested:** yes.
- **Real-browser run:** yes, on the snapshot channel.

## 14. Phase 15 privacy fusion

- **Authority:** unifies DOM, OCR, visual, and contextual findings into one coordinate map, and decides transmission per category.
- **Enforced at:** `fusion.ts::fusePrivacyFindings` → `buildFinding`; `privacyDecision.ts::decideTransmission` / `policyForCategory`.
- **Evidence:** `phase15/privacyFusionContextual.test.ts` (59), `privacyFusion.test.ts` (18), `privacyDecision.test.ts` (16), `docs/evidence/phase15-privacy-fusion/`.
- **Can fusion weaken a finding?** **No, by construction.** In `buildFinding`:
  - the surviving **category** is chosen by `severityRank` first, then by max confidence;
  - the surviving **confidence** is `Math.max` over the group — a weaker signal can never lower it;
  - the surviving **region** is `unionRegion` — always at least as large as any member;
  - a must-redact finding with no region and no selector is **escalated**: `unmappable = true`, `exportable` forced to `false`, and `fail_closed:unmappable` appended to the evidence trail.
- **Unregistered categories:** `privacyDecision.ts` maps `unknown → FAIL_CLOSED` and records `policy.unknown_category`.
- **Tested:** yes, including a regression pin on the escalation path.
- **Real-browser run:** fusion ran in the live chain. The controlled fixture contains no PII, so a *redaction* outcome was not exercised end-to-end under a real reasoner.

---

## Cross-cutting questions

### Can the reasoner execute a browser action directly?

**No.** The reasoner's only product is data returned over HTTP. `agentBridge.ts` exposes exactly two outbound capabilities — `checkBackendHealth()` and `sendSanitizedContext()`. There is no inbound channel from the reasoner to any browser API, and the returned action must clear steps 3–10 of the gate order above. Verified structurally *and* in the live run, where the reasoner's proposal passed through nine independent stages before dispatch.

### Can the dashboard execute a browser action directly?

**No.** The dashboard is a control surface. Data flows dashboard → service worker as *requests to run a task*; the agent then derives its own actions from perception. The reverse direction (worker → dashboard) is one-way and screened. There is no dashboard field that reaches `chrome.tabs` or `chrome.scripting` without the full gate chain.

### Can recovery bypass a security authority?

**No.** Recovery re-proposes; it does not authorize. Healed actions re-enter grounding and M5 (`agentLoop.ts:1001-1007`). The recovery budget is finite and exhaustion produces `ABORT`, not escalation.

### Can containment bypass another authority?

**No.** Containment is an additional restriction layered on top of the others, evaluated at its own point in the chain. It cannot widen what an earlier stage allowed.

### Can effect verification grant authorization?

**No, and this is a structural property worth stating plainly.** Effect verification is the only gate that runs *after* dispatch. It is observation-only: its entire output space is "the requested effect happened" or "it did not / cannot be observed." It has no code path that permits an action. `verifyActionEffect` returning a positive verdict is a *record*, not a *grant*.

### Is any sensitive value introduced into output artifacts?

**No value was observed in any artifact.** All files under `docs/evidence/` were scanned during this pass: zero matches for key/authorization/token patterns. Target values appear only as lengths (`targetValueLength: 4`); focus identity only as `tag:nth-child(n)`. The Groq key was never printed, never logged, and never written to an artifact.

---

## Evidence-supported limitations

These are the only limitations this evaluation supports. They are stated as scope boundaries, not as vulnerabilities.

1. **Several control paths have design + test evidence but no isolated live demonstration**: the confirmation gate (never triggered), the containment *escape* block, a Critic-specific `BLOCK`, and the grounding *reject* path under a live reasoner. The controls are implemented and tested; the live run simply did not need them.
2. **OCR is dormant in the autonomous loop** — the service worker does not pass an `ocrEngine`, so the visual OCR branch never executes there. It is implemented, unit-tested, and boundary-secure, but it is not on the production autonomous path.
3. **No formal verification, no external audit, no penetration test.** Controls are enforced by code and covered by 1163 tests; that is evidence of behaviour, not a proof of absence of defects.
4. **`isDashboardOrigin` hardcodes `http://localhost:5173`** as a default. Pre-existing, documented, and a configuration default rather than an authority — left untouched by design in this pass.
5. **5 pre-existing TypeScript errors remain** in `targetResolver.ts`. They are type-narrowing issues in the target-resolution path, unchanged across the entire validation work. They do not affect runtime behaviour, and the file remains the enforcement point for containment provisioning, which is why it was left alone.

---

## Bottom line

The security architecture is **coherent, ordered, and genuinely fail-closed**, and it behaved correctly under a live reasoner — including refusing to act on a local port and refusing an action whose reason text tripped the PII scanner. No authority was weakened, reordered, or bypassed at any point in the validation work, and `git status` over every security-relevant source path is empty.

The correct characterization is: **well-tested and structurally-enforced controls, with a live demonstration of the accept, block, and no-effect paths — and no claim of formal security guarantee.**
