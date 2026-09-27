# PrivAgent — Final Claim / Evidence Matrix

**Commit evaluated:** `593fe72` (plus the re-verification run recorded in `REPRODUCTION.md` of this directory)
**Evaluation date:** 2026-09-27
**Method:** every claim below was checked against source, tests, and committed evidence. README claims were **not** accepted as evidence. Where a claim could not be substantiated, it is downgraded rather than repeated.

---

## Category definitions

| Category | Meaning |
|---|---|
| **PROVEN_REAL** | Demonstrated by a run against a real browser, the real backend, and the real configured reasoner, with the outcome asserted from **observed** system state. |
| **PROVEN_TEST** | Demonstrated by an automated test over a real or faithful substrate, but not by a full real-browser + real-reasoner run. |
| **CONTROLLED_FIXTURE_PROVEN** | Demonstrated end-to-end on a deterministic local fixture only. Real browser, real reasoner, real gates — but a single known surface. |
| **PARTIALLY_PROVEN** | Part of the claim is proven at a stated level; a material part is not. The split is stated. |
| **NOT_PROVEN** | No evidence exists. Includes "true but never demonstrated." |
| **KNOWN_LIMITATION** | A boundary that is understood, documented, and deliberately not engineered around. Not a defect. |

**Confidence** is stated per row as High / Medium / Low, meaning confidence *in the classification*, not in the system.

---

## 1. Reasoning and provider

| # | Claim | Category | Evidence | Limitation | Confidence |
|---|---|---|---|---|---|
| 1.1 | A real Groq reasoner (`openai/gpt-oss-20b`) generates the browser actions | **PROVEN_REAL** | `post-phase15-e2e/real_reasoner_e2e_evidence.json`; `real_reasoner_controlled_success_evidence.json`. Telemetry: `mode groq`, `apiKeyConfigured true`, `reasonerClass GroqReasoner`. Actions captured off the wire via CDP `Network.requestWillBeSent` on the service worker. | Live external service; availability is not under the project's control. | High |
| 1.2 | The reasoner's output is genuinely generated, not replayed | **PROVEN_REAL** | Two runs of the controlled harness produced **different natural-language reason strings** for step 2 while producing the same correct action. See `REPRODUCTION.md`. | Strong evidence of live generation; not a proof of model nondeterminism in general. | High |
| 1.3 | Configured fallback (`openrouter`) exists and is reported | **PROVEN_REAL** | `configuredFallback: "openrouter"` in both real-reasoner evidence files. Backend log line recorded. | On the successful run the fallback was **not used**. | High |
| 1.4 | Provider rate limits fail closed with zero speculative dispatches | **PROVEN_REAL** | Live-Google run: Groq `rate_limit` + fallback `unexpected_format` → terminal `FAILED` / `REASONER_FAILED`, HTTP 503. Also `phase14-interaction-output/reasoner_failure_path_evidence.json`. Tests: `providerFailure.test.ts` (21). | — | High |
| 1.5 | Provider is reachable from a real deployment | **PROVEN_TEST** | `backend/tests/` pytest suite. | Not re-run in this pass; requires the Python env. | Medium |
| 1.6 | Retry behaviour is adequate for transient rate limits | **NOT_PROVEN** | — | `providerRetries` is 0 and was deliberately left at 0. No controlled experiment establishes retries as the correct fix. **Do not change it on the strength of one observed 429.** | High |

---

## 2. Agent loop and browser execution

| # | Claim | Category | Evidence | Limitation | Confidence |
|---|---|---|---|---|---|
| 2.1 | Real browser dispatch occurs through the production path | **PROVEN_REAL** | `real_reasoner_controlled_success_evidence.json` — both actions `executionSuccess: true`, dispatched by the real content script. | — | High |
| 2.2 | Effect verification is decided from **observed** browser state | **PROVEN_REAL** | `post-phase15-e2e/observed_effect_no_effect_evidence.json` — 9/9, including `dispatchSuccessDoesNotImplyEffect` and `negativeNoOpIsActionNoEffect`. Re-run this pass, 9/9. | Exercises the production observation + verification seam. The no-effect harness does not drive the full loop (no live reasoner in that seam). | High |
| 2.3 | A real-reasoner task reaches Goal Verification `SUCCESS` | **CONTROLLED_FIXTURE_PROVEN** | `REAL_REASONER_CONTROLLED_SUCCESS_REPORT.md` + evidence JSON. Terminal `SUCCESS`, observed `#result-marker` = `Search results for cats`, final URL `/results?q=cats`. **Reproduced twice.** | One deterministic local fixture, one task, one page shape. This is **not** a general capability claim. | High |
| 2.4 | Broad autonomous web navigation | **NOT_PROVEN** | — | Only one task shape has ever completed. | High |
| 2.5 | Google search success in a headless environment | **KNOWN_LIMITATION** | `real_reasoner_e2e_evidence.json` → `https://www.google.com/sorry/index?...` anti-bot interstitial. | Environmental/product boundary. PrivAgent does not attempt to bypass bot challenges. | High |
| 2.6 | Grounding rejects hallucinated targets | **PROVEN_TEST** | `m5EndToEnd.test.ts`, `candidateVerification.test.ts`, `agentBridge.test.ts`. Live: M5 accepted only elements actually present (`q`, `go`). | Block-path has strong test coverage; block-path has **not** been demonstrated in a live real-reasoner run. | Medium |
| 2.7 | Stale-target / page-generation protection | **PROVEN_TEST** | `staleTargetSafety.test.ts`, `targetResolutionAndLifecycle.test.ts`, `tabProvisioning.test.ts` (26). | — | Medium |
| 2.8 | Long-horizon / multi-step task execution | **PROVEN_TEST** | `phase9LongHorizon.test.ts` (33), `docs/evidence/phase9-long-horizon/`. | Evidence artifact is a phase harness, not a live-reasoner multi-step run. | Medium |

---

## 3. Privacy

| # | Claim | Category | Evidence | Limitation | Confidence |
|---|---|---|---|---|---|
| 3.1 | Zero raw PII in the exported agent context | **PROVEN_TEST** (strongest defensible) | `rawValueScanner.test.ts` (17), `contextMinimizer.test.ts` (17), `centralPrivacyInvariant.test.ts`, `llmPrivacy.test.ts` (30), `securityBoundary.test.ts` / `securityBoundary2.test.ts`, `phase15/privacyFusionContextual.test.ts` (59). Live corroboration: snapshots expose `targetValueLength` only; evidence check `snapshotNeverContainsTheTypedValue` passes in real Chrome. | The **structural** guarantee (forbidden keys, `extra="forbid"`) is strongly tested. A universal "no raw PII ever, anywhere" claim would require fuzzing/adversarial coverage that is not present. **Not upgraded to PROVEN_REAL.** | High |
| 3.2 | Backend rejects unknown/forbidden fields | **PROVEN_TEST** | `backend/app/models.py` — `ConfigDict(extra="forbid")` on all strict models; `reject_forbidden_keys` validator on `SafeDetectionExport`; `security.py::verify_payload_invariants` recursive key scan. | — | High |
| 3.3 | DOM contextual PII detection | **PROVEN_TEST** | `phase15/privacyFusionContextual.test.ts` (59), `domDetector.test.ts`, `patterns.test.ts`, `detectionQuality.test.ts`. | Test-substrate. | Medium |
| 3.4 | DOM contextual PII detection in a live real-reasoner run | **NOT_PROVEN** | The controlled fixture contains no PII, so the detector was never exercised end-to-end under a real reasoner. | — | High |
| 3.5 | Privacy fusion cannot weaken an existing finding | **PROVEN_TEST** | `privacyFusion.test.ts` (18), `phase15/privacyFusionContextual.test.ts` (59). Source: `fusion.ts::buildFinding` — strongest category by severity then confidence; confidence is `Math.max`; region is `unionRegion`. | Verified by reading the implementation, not by a live run. | High |
| 3.6 | Unmappable must-redact findings fail closed | **PROVEN_TEST** | `fusion.ts::buildFinding` sets `unmappable` and forces `exportable: false`, appends `fail_closed:unmappable` evidence. `unmappableMustRedactFindings()` exposes them. Covered in `phase15/`. | No live run exercised an unmappable finding. | High |
| 3.7 | Unregistered categories fail closed | **PROVEN_TEST** | `privacyDecision.ts` — `unknown → FAIL_CLOSED`; `policyForCategory` records `policy.unknown_category`; `privacyDecision.test.ts` (16). | — | High |
| 3.8 | No cloud NLP receives raw private content | **PROVEN_TEST** | The backend is a **reasoner gateway**, not a perception service: it receives only the already-minimized `AgentContextPayload`. There is no cloud OCR or cloud vision call anywhere in `backend/`. | The stronger framing is structural, not merely tested. | High |
| 3.9 | On-device OCR of visual regions | **PROVEN_TEST** | `ocrDetector.test.ts` (9), `ocrEngine.test.ts` (3), `ocrIntegration.test.ts`, `ocrSecurityBoundary.test.ts`, `spatialOcrLayer.test.ts`. | — | High |
| 3.10 | OCR inside the **autonomous agent loop** | **KNOWN_LIMITATION** (dormant) | `serviceWorker.ts:733` calls `coordinateMultimodalPerception({ tabId, windowId, scanReport, pageGeneration })` with **no `ocrEngine`**. `multimodalCoordinator.ts:223` gates on `if (input.ocrEngine)`, so the branch never executes in the loop. | OCR runs in the popup's manual capture flow. It is implemented, unit-tested, and secure — but **not** on the autonomous path. | High |
| 3.11 | Visual redaction of captured pixels | **PROVEN_TEST** | `redactor.test.ts`, `visualRedactor.test.ts`, `redaction/`. Real-Chrome latency recorded (1.1 ms, `phase15_real_chrome_evidence.json`). | — | Medium |
| 3.12 | Zero raw PII leaks observed in any tested path | **PROVEN_TEST** | All forbidden-key scanners, `assertNoRawSensitiveValues`, `assertZeroLeakageInPayload`, `findKnownRawValueLeaks`, plus the live `snapshotNeverContainsTheTypedValue` check. | 0 observed leaks in tested paths. Not a proof of absence. | High |

---

## 4. Security authorities

| # | Claim | Category | Evidence | Limitation | Confidence |
|---|---|---|---|---|---|
| 4.1 | Grounding, M5, Security Critic, Privacy Policy, Risk, Semantic/Confidence, Confirmation, Containment, Effect Verification, Recovery, Harness all exist, are wired into the loop, and execute in the production order | **PROVEN_REAL** | Gate sequence confirmed in `agentLoop.ts` (grounding 919 → M5 991 → Critic 1112 → policy 1179 → semantic 1252 → confidence 1254 → containment 1467 → effect 1765 → goal/recovery). Live run shows M5 firing on both actions. | — | High |
| 4.2 | M5 blocks an action whose reason text trips the PII scanner | **PROVEN_REAL** | `real_reasoner_e2e_evidence.json` — Google search-button click blocked; reason text contained "cats", read as possible `person_name`. | Correct fail-closed behaviour. **Not a defect. Scanner not weakened.** | High |
| 4.3 | The reasoner cannot execute browser actions directly | **PROVEN_TEST** | Structural: `agentBridge.ts` exposes only `checkBackendHealth` and `sendSanitizedContext`; the reasoner returns data that the loop must pass through grounding/M5/Critic/policy/containment. Live: no reasoner-supplied field reached dispatch unvalidated. | — | High |
| 4.4 | The dashboard cannot execute browser actions directly | **PROVEN_TEST** | `serviceWorker.ts::sendToDashboard` is one-way; `projectAgentOutput` is a narrowing read-only translation with no write path back into the loop or any gate. `tests/phase14/agentOutput.test.ts` (47). | — | High |
| 4.5 | Effect verification grants no authorization | **PROVEN_REAL** | `verifyActionEffect` is observation-only and can only fail an action closed (`ACTION_NO_EFFECT` / `EFFECT_UNVERIFIABLE`); live `ACTION_NO_EFFECT` with `dispatchSucceeded: true, effectVerified: false`. | — | High |
| 4.6 | Containment is origin-scoped and enforced at dispatch | **PROVEN_TEST** | `containment.test.ts` (43), `targetResolver.test.ts` (21), `docs/evidence/phase12-containment/`. Live: containment root host `localhost`, initial and final URLs both in scope. | The live run stayed **inside** scope; no live run demonstrated a live **escape** being blocked. | Medium |
| 4.7 | Port-qualified local targets are never provisioned or hijacked | **PROVEN_REAL** | First controlled-run attempt failed `DESTINATION_REQUIRED` — the resolver refused to open or hijack a local port. `targetResolver.ts:110-152`, `:480-528`. | Correct fail-closed behaviour. | High |
| 4.8 | Recovery is bounded and cannot exceed the retry budget | **PROVEN_TEST** | `phase10RecoveryEngine.test.ts` (23), `m11Robustness.test.ts`, `selfHealing.test.ts`, `docs/evidence/phase10-recovery/`. | — | High |
| 4.9 | Harness is non-authoritative | **PROVEN_TEST** | `harness.test.ts` (47). Harness observes and bounds; it does not authorize. | — | High |
| 4.10 | Prompt-injection resistance | **PROVEN_TEST** | `securityLab.test.ts`, `adversarialBoundary.test.ts`, `injectionFirewall.ts`, `evaluation/securityLab/`. | Test-set only (README already scopes this). | Medium |
| 4.11 | No security authority was weakened or reordered | **PROVEN_REAL** | `git status` over `extension/src/{agent,privacy,ocr,background,content}/`, `backend/`, `frontend/src/` empty across the validation work. `providerRetries` untouched at 0. | — | High |
| 4.12 | Formal security guarantees | **NOT_PROVEN** | — | No formal verification, no external security audit, no penetration test, no published CVE process. This project has **tested and structurally-enforced** controls, not *proven* guarantees. | High |

---

## 5. Output layer and telemetry

| # | Claim | Category | Evidence | Limitation | Confidence |
|---|---|---|---|---|---|
| 5.1 | Everything the user can receive is screened at one boundary | **PROVEN_TEST** | `serviceWorker.ts::sendToDashboard` → `screenAgentOutput(projectAgentOutput(...))`, fails closed. `agentOutput.test.ts` (47), `extensionAdapter.test.ts` (16), `docs/evidence/phase14-interaction-output/`. | — | High |
| 5.2 | UI reports effect state honestly | **PROVEN_REAL** | `formatEffectVerification()` renders `VERIFIED` / `NO EFFECT` / `PENDING`. Step-6 text no longer claims DOM mutation. | — | High |
| 5.3 | Telemetry contains no user data | **PROVEN_TEST** | `telemetry/privacyTelemetry.ts`, `telemetryAndEvaluation.test.ts`; all artifacts in `docs/evidence/` scanned (0 secret/PII matches). | — | Medium |
| 5.4 | M12 evaluation metrics are production-representative | **NOT_PROVEN** | README already scopes every metric as "test-set or fixture only." | Correctly labelled. Do not present as live accuracy. | High |

---

## 6. Summary of the honest position

**What PrivAgent proves, in one sentence:** that a real cloud reasoner can propose actions, that a local deterministic runtime can refuse to trust them, and that the entire chain can be carried to an observed, verified goal on a controlled page.

**What it does not prove:** that it works broadly, that it works on the open web, that it is formally secure, or that the OCR/perception layer is active on the autonomous path.

**The single most important caveat:** the one task that reached `SUCCESS` is a two-action search on a local fixture. Everything above should be read with that in mind.
