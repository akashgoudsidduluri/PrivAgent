# Phase 17.3 — OCR & Advanced Non-DOM Perception Architecture Audit

**Baseline Commit:** `4fb476f` (Phase 17.1 Observation Generalization)  
**Date:** 2026-09-27  
**Module Scope:** Extension OCR engine, screenshot coordinate mapping, spatial OCR layer, multimodal coordinator, service worker perception loop, privacy fusion, context minimization, and observation contract integration.

---

## 1. Executive Summary

PrivAgent has maintained an on-device OCR subsystem (`extension/src/ocr/`) since early milestones (M3). However, in the autonomous background agent loop (`serviceWorker.ts` $\to$ `agentLoop.ts`), OCR was **deliberately kept dormant**:
- `serviceWorker.ts` invoked `coordinateMultimodalPerception(...)` without supplying an `ocrEngine`.
- As a result, the `if (input.ocrEngine)` branch inside `multimodalCoordinator.ts` was bypassed during autonomous task execution.
- Real OCR only executed in the extension popup's manual inspection flow (`popup.ts`).

Phase 17.3 establishes the architecture to safely activate genuine local OCR in the autonomous perception loop, bound its execution, ensure complete screenshot provenance, preserve strict fail-closed privacy firewalls, and integrate OCR into the Phase 17.1 Observation Contract (`OBSERVED`, `UNAVAILABLE`, `STALE`, `NOT_APPLICABLE`).

---

## 2. Current OCR Implementation & Components

The current codebase contains the following OCR modules:

| File | Purpose | Active Context |
|---|---|---|
| `extension/src/ocr/types.ts` | Type definitions: `InternalOCRResult`, `InternalOCRLine`, `InternalOCRWord`, `OCRWordBox`, `SafeOCRDetection`, `OCREngine` | Popup, unit tests |
| `extension/src/ocr/ocrEngine.ts` | `LocalOCREngine` (wraps Tesseract.js WebAssembly worker) and `MockOCREngine` | Popup only (`LocalOCREngine`), tests (`MockOCREngine`) |
| `extension/src/ocr/ocrDetector.ts` | `detectSensitiveOCRRegions` (regex matching for PAN, card, email, phone, CVV, OTP) | Popup, spatial OCR layer |
| `extension/src/ocr/spatialOcrLayer.ts` | `processSpatialOCRResult`, `classifyOCRTextPrivacy`, `convertToSafeOCRRegions`, `fuseSpatialOCRWithDOM` | Multimodal coordinator (unit-tested only) |
| `extension/src/ocr/ocrSecurityBoundary.ts` | `verifySafeOCRDetection`, `assertZeroLeakageInPayload` | Tests and runtime assertions |
| `extension/src/visualPerception/multimodalCoordinator.ts` | Coordinates screenshot capture, coordinate mapping, OCR execution, and privacy fusion | Autonomous loop (calls without `ocrEngine`), unit tests |
| `extension/src/privacy/contextualPii.ts` | `detectContextualInOcr`, `mapContextualHitToOcrRegion` (NLP label cues for person names, addresses in OCR text) | Multimodal coordinator (calls inside OCR branch) |
| `extension/src/popup/popup.ts` | Manual "Capture & Redact" UI: captures active tab, initializes `LocalOCREngine`, classifies sensitive regions, renders preview canvas | User-interactive popup only |

---

## 3. Why OCR Was Kept Dormant in the Autonomous Agent Loop

The autonomous agent loop runs under the Chrome Manifest V3 **Background Service Worker** (`serviceWorker.ts`). In MV3, running Tesseract.js directly inside `serviceWorker.ts` encountered three severe structural constraints:

1. **Absence of `Worker` in ServiceWorkerGlobalScope:**
   Chrome's V8 implementation of Service Workers does not support nested web workers. Executing `new Worker(...)` or `tesseract.js`'s `createWorker(...)` inside `serviceWorker.ts` throws:
   ```
   ReferenceError: Worker is not defined
   ```
   Service workers lack DOM (`document`, `window`, `HTMLCanvasElement`, `HTMLImageElement`) and cannot instantiate Web Workers.

2. **Service Worker Lifetime & Ephemeral Process Model:**
   MV3 Service Workers terminate after 30 seconds of inactivity or when Chrome reclaims memory. Initializing Tesseract WebAssembly, compiling `tesseract-core-simd.wasm`, and downloading/parsing the `eng.traineddata.gz` dictionary (~4 MB gzipped, ~25 MB uncompressed) on an ephemeral thread causes initialization timeouts, memory churn, or aborted recognition requests.

3. **Latency vs. Agent Cycle Budget:**
   PrivAgent targets a local decision cycle of $P50 < 50\text{ ms}$. Full-page OCR across a $1920 \times 1080$ retina screenshot can take $800\text{ ms} - 2500\text{ ms}$. Blocking the perception cycle unconditionally on every step degraded agent responsiveness.

**Resolution in Phase 17.3:**
Chrome MV3 provides the **`chrome.offscreen` API** (available in Chrome 109+; PrivAgent targets Chrome $\ge 120$). By establishing a dedicated offscreen document (`offscreen.html`), PrivAgent can run genuine, isolated, WebAssembly-accelerated `LocalOCREngine` with a full DOM/Worker environment. The Service Worker communicates with the offscreen document via local Chrome runtime messaging.

---

## 4. End-to-End Data Flow & Privacy Boundary

The planned data flow enforces that **raw OCR text never leaves the local device**:

```
1. TARGET TAB VIEWPORT
   │ (chrome.tabs.captureVisibleTab)
   ▼
2. CAPTURED SCREENSHOT (PNG dataURL)
   │ Validated Tab ID, Window ID, Observed Geometry, Timestamp
   ▼
3. LOCAL OCR ENGINE (Offscreen Document / LocalOCREngine)
   │ Isolated WebAssembly execution inside extension origin
   ▼
4. RAW OCR TOKENS (lines, words, confidence, word boxes)
   │ LOCAL ONLY: ephemeral memory, never serialized or logged
   ▼
5. ON-DEVICE PRIVACY SCANNING & CLASSIFICATION
   ├─ Rule-based Pattern Scanner (PATTERNS: email, phone, card, pan, cvv, otp)
   ├─ Raw Value Firewall (scanForRawSensitiveValues)
   └─ Contextual PII Scanner (detectContextualInOcr: person_name, address)
   ▼
6. COORDINATE RECONCILIATION & PROVENANCE CHECK
   │ Verify word bbox overlaps, clamp to viewport/screenshot bounds
   │ Detect unmappable sensitive spans (fail closed)
   ▼
7. PRIVACY FUSION (fusePrivacyFindings)
   │ Unify DOM detections + Visual detections + OCR sensitive regions + Contextual hits
   ▼
8. OBSERVATION CONTRACT
   │ Explicit state: OBSERVED | UNAVAILABLE | STALE | NOT_APPLICABLE
   │ Document & PageGeneration stamping
   ▼
9. SAFE SANITIZED REPRESENTATION
   ├─ WorldModel: SafeOCRRegion[] (bbox, confidence, isSensitive, sanitizedPreview for safe text only)
   └─ AgentContextPayload: AgentOCRMetrics, zero raw credentials
   ▼
10. REASONER / BACKEND
   Zero raw PII transmitted. Strictly sanitized structural tokens and geometric bounds.
```

---

## 5. Coordinate Mapping & Geometry Realities

OCR produces bounding boxes relative to the captured screenshot bitmap pixels $[x_0, y_0, x_1, y_1]$. Translating these to browser CSS viewport coordinates requires:
- `scaleX = screenshotWidth / viewportWidth`
- `scaleY = screenshotHeight / viewportHeight`
- Observed `scrollX`, `scrollY`, and `devicePixelRatio` from the live content script (`readLiveViewportGeometry`).

**Invariants:**
- Never assume `scrollX = 0`, `scrollY = 0`, or `dpr = 1`.
- If viewport geometry is unavailable or degenerate ($w \le 0, h \le 0$), OCR mapping must be rejected as `UNAVAILABLE`.
- Any OCR detection with invalid bounds ($x_1 \le x_0$, $y_1 \le y_0$, negative dimensions, or `NaN`) must fail closed.

---

## 6. Current Tests & Baseline Verification

Existing OCR coverage in the test suite:
- `tests/ocrDetector.test.ts` (10 tests): PII regex detection across synthetic OCR token trees (email, PAN, credit card, phone, CVV, OTP).
- `tests/ocrSecurityBoundary.test.ts` (6 tests): Validates that `SafeOCRDetection` rejects forbidden raw text keys (`text`, `value`, `rawOCR`, etc.) and verifies zero leakage in JSON serialization.
- `tests/spatialOcrLayer.test.ts`: Tests `processSpatialOCRResult`, `classifyOCRTextPrivacy`, and fusion with DOM candidates.
- `tests/multimodalCoordinator.test.ts`: Tests coordinate mapping and fusion with `MockOCREngine`.
- `tests/contextualPii.test.ts`: Tests contextual NLP cues on OCR lines and `mapContextualHitToOcrRegion`.

---

## 7. Limitations to Remediate in Phase 17.3

1. **Dormant in Loop:** The autonomous loop currently passes no OCR engine to `coordinateMultimodalPerception`.
2. **Missing Offscreen Document:** MV3 service worker cannot host `Worker`; `chrome.offscreen` document needs creation and manifest declaration.
3. **No Observation Contract for OCR:** OCR results currently lack explicit provenance (`OBSERVED`, `UNAVAILABLE`, `STALE`, `NOT_APPLICABLE`) and document freshness checks.
4. **Safe Text Ingestion for Non-DOM Content:** When non-sensitive text (headings, labels, instructions) appears in a canvas or image, the reasoner needs safe sanitized access to understand non-DOM content, while strictly filtering sensitive entities.
5. **Worker Lifecycle & Timeout Handling:** Needs bounded timeout (e.g. 5–10s) and graceful fail-closed degradation so a slow OCR call never hangs the agent loop.

---

## 8. Exact Production Files to Change

1. `extension/manifest.json`: Add `"offscreen"` permission.
2. `extension/vite.config.ts`: Add `offscreen.html` to Vite build rollup inputs.
3. `extension/src/offscreen/offscreen.html` & `offscreen.ts`: Offscreen execution harness for `LocalOCREngine`.
4. `extension/src/ocr/offscreenOcrClient.ts`: Service-worker-side client managing offscreen document lifecycle, timeouts, and OCR recognition requests.
5. `extension/src/ocr/ocrObservationContract.ts`: Strongly typed provenance, freshness, and status contract (`OBSERVED`, `UNAVAILABLE`, `STALE`, `NOT_APPLICABLE`).
6. `extension/src/background/serviceWorker.ts`: Pass offscreen OCR engine into `coordinateMultimodalPerception` in the autonomous loop, verify target tab provenance before capture.
7. `extension/src/visualPerception/multimodalCoordinator.ts`: Enforce screenshot provenance, attach OCR observation contract, map safe non-DOM text into world model and context.
8. `extension/src/worldModel/types.ts`: Update `SafeOCRRegion` to carry sanitized text preview for verified safe non-DOM content.
9. `extension/src/agent/goalVerifier.ts`: Enable visual/OCR goal verification for non-DOM text and visual headings (collaborative and non-breaking).
