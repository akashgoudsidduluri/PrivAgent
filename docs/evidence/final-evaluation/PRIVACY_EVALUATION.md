# PrivAgent — Privacy Evaluation

**Commit evaluated:** `593fe72`
**Date:** 2026-09-27

**Scope.** This traces the actual implemented privacy paths from raw page to model-facing context, and states precisely which portions are **live in the autonomous agent loop** versus **separately tested or manual**. No privacy architecture is modified. Claims are graded by the evidence that supports them; see `CLAIM_EVIDENCE_MATRIX.md` §3 for the formal categories.

**Central architectural fact.** The backend is a **reasoner gateway, not a perception service.** It never sees the page. It receives an already-minimized structural payload. There is no cloud OCR call, no cloud vision call, and no "upload the screenshot and ask a model what it sees" path anywhere in `backend/`. This is the strongest privacy property in the system, and it is *structural* rather than merely tested.

---

## 1. The DOM privacy path (LIVE)

```
Page DOM
  → domInteractiveScanner / domDetector        extension/src/privacy/domDetector.ts
  → contextual detection                      extension/src/privacy/contextualPii.ts
  → fusion                                    extension/src/privacy/fusion.ts
  → transmission decision                     extension/src/privacy/privacyDecision.ts
  → world model (sanitized)                   extension/src/worldModel/worldModelSanitizer.ts
  → context minimization                      extension/src/privacy/contextMinimizer.ts
  → raw-value scan                            extension/src/privacy/rawValueScanner.ts
  → buildAgentPayload                         extension/src/privacy/types.ts
  → egress firewall                           extension/src/security/egressFirewall.ts
  → backend (verify_payload_invariants)       backend/app/security.py
  → output screening                          serviceWorker.ts::sendToDashboard
```

Every stage above is on the autonomous path. This is verified by the real-browser run: `buildAgentPayload` and `minimizeAgentContext` are called from `serviceWorker.ts` on every perception cycle, and the reasoner received `detectionCount: 2` structural detections on the fixture.

### Stage notes

**DOM detector + patterns.** Rule- and pattern-based discovery of passwords, OTPs, CVVs, PANs, credit cards, bank accounts, emails, and phone numbers. `patterns.ts` is the single pattern source, reused by both the extension and the backend scanner.

**Contextual detection.** `contextualPii.ts` provides `LightweightContextualDetector` (a local, non-cloud heuristic detector) plus `detectContextualInDomText`, `detectContextualForDomDetections`, `detectContextualInOcr`, and `mapContextualHitToOcrRegion`. This is where a value that is *not* pattern-identifiable on its own (a name next to a label, for instance) becomes a finding.

**Fusion.** `fusePrivacyFindings` merges DOM, OCR, visual, and NLP candidates into `PrivacyFinding`s. The critical invariant is in `buildFinding` and is verified below in §4.

**World model.** `worldModelSanitizer.ts` recursively scans for forbidden credential keys (`value`, `password`, `passwd`, `secret`, `token`, `cvv`, `cvc`, …) and raises `WorldModelPrivacyViolation`. The agent reasons over a *sanitized* world model, so the reasoner cannot see raw page structure that the DOM scanner already found.

**Context minimization.** `minimizeAgentContext` and `buildModelFacingContext` produce the model-facing view. `DEFAULT_MAX_CONTEXT_DETECTIONS = 40` bounds the payload. Task terms are extracted (`extractTaskTerms`) so the payload is relevant, not exhaustive.

**Raw-value scan.** `scanForRawSensitiveValues` with `FORBIDDEN_PAYLOAD_KEYS` (24 keys: `value`, `text`, `textContent`, `innerText`, `rawText`, `rawOCR`, `ocrText`, `password`, `words`, `lines`, `token`, `secret`, `card`, `cardNumber`, `card_number`, `cvv`, `pan`, `accountNumber`, `account_number`, `raw`, `input`, `sensitiveValue`, `sensitive_value`, `pii`, `val`, `fulltext`) plus **pattern** rules (email, Indian phone, card-like digit runs). `STRUCTURAL_VALUE_KEYS` is an explicit allow-list for machine-generated identifiers (`id`, `selector`, `url`, `href`, …) so a legitimate `id` is not mistaken for a leak. Matching is case-insensitive and underscore-agnostic. `assertNoRawSensitiveValues` throws `PrivacyBoundaryError` on violation.

**Egress firewall.** `egressFirewall.ts::validateEgressPayload(payload, destination)` returns a `SecurityDecision`.

**Backend arrival check.** `backend/app/security.py::verify_payload_invariants` performs a *recursive* forbidden-key scan across all dicts and lists at any depth, case-insensitively and underscore-agnostically. `models.py` sets `ConfigDict(extra="forbid")` on every strict model, so an unexpected field is a 422, not a silent drop; `SafeDetectionExport.reject_forbidden_keys` is a field validator. `REQUIRED_STATUS = "sanitized_only"` is the only accepted sanitization status string.

> **Defense in depth:** the same invariant is enforced *twice* — locally before egress, and again at the backend on arrival. Neither side is trusted alone. A local bug cannot silently ship raw PII, and a compromised local layer still meets a server-side refusal.

**Output screening.** `sendToDashboard` runs `screenAgentOutput(projectAgentOutput(payload))` and fails closed. The comment at the call site is explicit that this is the *single* output-privacy enforcement point, chosen so the property holds "by construction instead of by remembering to add it at every future call site."

---

## 2. The visual / screenshot / OCR path (PARTIALLY LIVE)

```
Viewport
  → screenshotCapture / captureOrchestrator    extension/src/visualPerception/, extension/src/capture/
  → coordinate mapping (HiDPI)                 extension/src/capture/coordinateMapper.ts
  → multimodal coordination                    extension/src/visualPerception/multimodalCoordinator.ts
      ├─ canvas / visual-region detection       (LIVE)
      └─ OCR recognition                       (DORMANT in the loop — see below)
  → redaction overlays                         extension/src/redaction/
  → fusion                                     same coordinate space as DOM
```

### What is live

Screenshot capture, HiDPI coordinate mapping, canvas detection, visual-region detection, and the redaction overlay layer all run in the autonomous loop. The real-browser controlled run exercised this: `serviceWorker.ts:733` called `coordinateMultimodalPerception(...)` on every cycle and logged `visualDetections`, `screenshotWidth/Height`, `ocrRegions`, and `privacyFindings`. Redaction latency in a real Chrome run was **1.1 ms** (`phase15_real_chrome_evidence.json`).

### What is dormant — and this is stated precisely

`serviceWorker.ts:733` calls:

```ts
const coordination = await coordinateMultimodalPerception({
  tabId: targetTabId,
  windowId: targetTab?.windowId,
  scanReport: scanRes.report,
  pageGeneration: worldModel?.page.pageGeneration ?? 1,
});
```

There is **no `ocrEngine` property**. And `multimodalCoordinator.ts:223` gates the whole OCR branch on:

```ts
if (input.ocrEngine) { ... }
```

Therefore **the OCR recognition branch does not execute in the autonomous agent loop.** Consequently `coordination.ocrRegions` is always empty there, and no OCR-sourced finding can enter fusion from the loop.

This is a **known limitation, not a defect and not a security hole.** The OCR stack is implemented (`ocr/ocrEngine.ts`, `ocrDetector.ts`, `spatialOcrLayer.ts`, `ocrSecurityBoundary.ts`), is unit-tested (9 + 3 + integration + security-boundary tests), and is security-bounded. It runs in the **popup's manual capture flow** (`popup.ts` contains 22 OCR references). Note also that `captureOrchestrator.ts` — which *does* default to a `LocalOCREngine` — is not imported by the service worker at all, so its default never applies on the autonomous path.

**Consequence for any privacy claim:** the "visual/OCR → fusion" half of the privacy pipeline has **strong test evidence and no live autonomous-loop evidence.** Do not present it as active in the production agent loop.

---

## 3. Explicit verification of the required properties

### Raw values are not exported

**Verified — PROVEN_TEST with live corroboration.**

Structural enforcement: forbidden-key sets at three independent layers (extension `rawValueScanner`, world-model sanitizer, backend `security.py` + `models.py`), all recursive, all case- and underscore-insensitive, all backed by `extra="forbid"`.

Live corroboration: the real-Chrome effect seam asserts `snapshotCarriesNoRawValueField` and `snapshotNeverContainsTheTypedValue` — the harness typed a value into a real page, then confirmed the production snapshot channel never carried it. Only `targetValueLength` crossed.

**Honest scope:** this is strong evidence of correct behaviour over the tested surface. It is not a proof that no raw value can ever escape anywhere; that would require adversarial fuzzing not present in this repository.

### Sensitive values use metadata/length where applicable

**Verified.**

- Target values cross every snapshot and telemetry channel as **length only** (`targetValueLength: 4`).
- Detections carry `id`, `type`, `bbox`, `selector`, `length`, `source` — never the value.
- Focus identity is `tag:nth-child(n)`, deliberately not a site-specific identifier, so a snapshot cannot be correlated back to a named page.
- `ContextualPiiHit` and `FusionCandidate` carry `length`, not content.

### Unmappable contextual findings fail closed

**Verified — by construction, and tested.**

`fusion.ts::buildFinding`:

```ts
const unmappable = decision.mustRedact && region === null && !selector;
if (unmappable) evidence.push('fail_closed:unmappable');
...
exportable: unmappable ? false : decision.exportableMetadata,
```

A finding that must be redacted but cannot be located is **not dropped** — dropping would be under-reporting, which is the worse failure. It is escalated: marked `unmappable`, its `exportable` flag is forced to `false`, and the reason is written into the evidence trail. `unmappableMustRedactFindings()` exposes the set so a caller treats it as "coverage is incomplete" rather than assuming every must-redact finding has a maskable region.

### Fusion cannot reduce an existing stronger finding

**Verified — PROVEN_TEST by construction.**

In `buildFinding`, for every field that matters:

| Field | Reduction operator | Property |
|---|---|---|
| category | `severityRank` desc, tie-broken by `maxConfidenceFor` | Strongest category survives |
| confidence | `Math.max` over the group | A weak signal can never lower it |
| region | `unionRegion` | Always ⊇ every member |
| length | `Math.max` over non-null | Never shrinks |
| sources / detectionSources / evidenceIds | `unique(...)` union | Nothing is erased |

The only way a category changes is upward in severity. There is no code path by which merging two findings produces a *weaker* finding than one of its inputs. Covered by `privacyFusion.test.ts` (18) and `phase15/privacyFusionContextual.test.ts` (59).

### Unregistered categories remain fail closed

**Verified.**

`privacyDecision.ts` types the decision space as `NEVER_TRANSMIT | REDACT | MINIMIZE | FAIL_CLOSED` and specifies `FAIL_CLOSED` as "unknown, uncertain, or below-confidence findings — not allowed into context at all and always redacted locally." The `unknown` policy entry resolves to `decision: 'FAIL_CLOSED'`, `severity: 'unknown'`; `policyForCategory` records the escalation reason `policy.unknown_category`, and `PolicyDecisionRecord.uncertain` marks the escalation. The comment on the policy map notes that `face` is reserved so a future visual face detector inherits fail-closed behaviour rather than needing new policy.

### No cloud NLP receives raw private content

**Verified — structurally, not merely by test.**

Two independent reasons:

1. **There is no cloud perception service.** `backend/` contains `config.py`, `models.py`, `security.py`, `text_safety.py`, `reasoner.py`, `evaluation.py`, and the `context`/`agent` routes. It receives an already-minimized `AgentContextPayload` and returns actions. It never receives a DOM, a screenshot, or OCR text.
2. **Contextual PII detection is local.** `LightweightContextualDetector` in `contextualPii.ts` is a deterministic local heuristic. It is not an LLM call, and it runs *before* minimization, on-device.

`backend/app/text_safety.py` scans reasoner-*output* text for PII before it is returned — a second, independent reasoner-output screen, and the mechanism by which the live-Google run's M5-relevant text was caught.

---

## 4. Live vs. test-only summary

| Privacy stage | Autonomous loop | Evidence level |
|---|---|---|
| DOM interactive + pattern detection | **LIVE** | Test (strong) + live (fixture, no PII present) |
| Contextual PII detection (DOM) | **LIVE** | Test (59-test suite) — **not** exercised under a live reasoner (fixture has no PII) |
| Privacy fusion | **LIVE** | Test (18 + 59) + live (ran, trivially — nothing to fuse) |
| Transmission decision / fail-closed policy | **LIVE** | Test (16) |
| World-model sanitization | **LIVE** | Test |
| Context minimization | **LIVE** | Test (17) + live (reasoner received 2 minimized detections) |
| Raw-value scanning | **LIVE** | Test (17 + boundary suites) + live (snapshot channel) |
| Egress firewall | **LIVE** | Test |
| Backend arrival validation | **LIVE** | Test (pytest) |
| Output screening | **LIVE** | Test (47 + 16) + live (terminal state rendered) |
| Screenshot capture + coordinate mapping | **LIVE** | Test (24) + live |
| Canvas / visual-region detection | **LIVE** | Test + live |
| Redaction overlays | **LIVE** | Test + live (1.1 ms) |
| **OCR recognition** | **DORMANT in loop** | Test only; live in popup manual flow |
| **OCR → fusion in the loop** | **DORMANT in loop** | Not reachable from the autonomous path |

---

## 5. Evidence-supported privacy limitations

1. **OCR is dormant in the autonomous loop.** Implemented, tested, and security-bounded — but not on the production autonomous path, so the visual-OCR privacy guarantee is a *test-set* guarantee, not a live one. The README already states this correctly; do not quietly strengthen it.
2. **No PII-bearing page was driven under a live reasoner.** The controlled fixture contains no sensitive data, so end-to-end redaction under a real reasoner is unproven. Redaction is proven on test substrates and on a real-Chrome seam, not on a real-reasoner PII run.
3. **Local-only detection, not exhaustive classification.** The DOM detector finds 8 sensitive categories by pattern. A novel PII format that matches no pattern is not detected — it is simply not recognized as sensitive. Unregistered *categories* fail closed, but unregistered *patterns* are out of scope by design, not by guarantee.
4. **`fulltext` is forbidden, but no semantic guarantee is made about free-form user task text.** The user's own task string is transmitted to the reasoner; that is required for the agent to function and is the user's own input, not page-derived PII.
5. **No formal verification.** These are tested invariants with structural enforcement, not proven guarantees.

---

## 6. Bottom line

The privacy architecture is **structurally sound and genuinely fail-closed at every reduction point**: the backend never sees the page, minimization strips content before egress, the same invariant is enforced on both sides of the network boundary, fusion can only ever strengthen a finding, and anything unmappable or unrecognized is escalated rather than dropped.

Two honest qualifications belong in any presentation: **OCR is dormant in the autonomous loop**, and **no PII-bearing page has been driven under a live reasoner.** Everything else on the DOM path is live and tested.
