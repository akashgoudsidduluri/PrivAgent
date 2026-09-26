# Phase 15 — Privacy Fusion & Contextual PII Detection: Acceptance Report

**Phase:** 15 — Privacy Fusion & Contextual PII Detection
**Repository:** PrivAgent
**Branch:** `main` (synced with `origin/main` at `274c166 feat: add agent interaction and output layer`)
**Status:** Implemented, tested, verified. Reviewed and corrected. **Not committed, not pushed.**
**Date:** 2026-09-26

> **Review pass (2026-09-26).** A post-implementation review found and fixed two
> genuine defects. See §10. Focused suite 55 → **59**; full regression 1102 → **1107**.

---

## 1. Goal

```
DOM detections ─┐
OCR detections ─┼─→ Privacy Fusion ─→ unified sensitive regions ─→ existing redaction / screening
Contextual (NLP)┘
```

The requirement was to combine evidence from multiple perception sources into one
canonical finding rather than treating DOM and OCR independently, and to add a
**lightweight local contextual PII detector** behind a **clearly isolated NLP
adapter interface** — with no cloud NLP, no large model, and no duplicated
privacy or redaction architecture.

---

## 2. Architecture

### 2.1 What already existed (and was reused, not rebuilt)

Phase 15 did **not** introduce a second privacy pipeline. The investigation found
that the canonical fusion layer already existed and was strong:

| Existing component | Role | Phase 15 action |
|---|---|---|
| `extension/src/privacy/patterns.ts` | Regex + validators for every *shape*-based category (email, card, phone, account, PAN, OTP, CVV, address) | **Reused.** The contextual detector runs the existing `PATTERNS.ADDRESS` and `KEYWORDS` tables rather than inventing its own. |
| `extension/src/privacy/domDetector.ts` (M1) | DOM classification | **Reused unchanged.** |
| `extension/src/ocr/ocrDetector.ts`, `spatialOcrLayer.ts` (M3) | Local OCR classification | **Reused unchanged.** |
| `extension/src/privacy/fusion.ts` (M8) | `PrivacyFinding`, `fusePrivacyFindings()`, merge rules | **Extended**, not replaced: one new source, one new adapter, one new field. |
| `extension/src/privacy/privacyDecision.ts` (M8) | The single policy table / authority for "what may leave the device" | **Extended by one literal key.** No policy semantics changed. |
| `extension/src/redaction/redactor.ts`, `overlayManager.ts` (M2) | The only thing that redacts | **Untouched.** |
| `extension/src/privacy/rawValueScanner.ts` | The zero-leak scanner | **Reused** as the assertion primitive in the new tests. |
| `extension/src/agent/agentOutput.ts` (Phase 14) | Interaction projection + `screenAgentOutput()` | **Untouched.** |

There was **no NLP/NER capability anywhere in the codebase** before this phase.
The extension's only runtime dependencies were `tesseract.js` and
`@tesseract.js-data/eng`; the backend is FastAPI/pydantic; the only `tokenize`
in the repo was a word-splitter in `hierarchicalPlanning/plannerContextBuilder.ts`.

### 2.2 The NLP adapter seam

`extension/src/privacy/contextualPii.ts` defines the entire contract:

```ts
export interface ContextualPiiDetector {
  readonly name: string;
  detect(input: ContextualAnalysisInput): ContextualPiiHit[];
}
```

`LightweightContextualDetector` (name `'lightweight-contextual-v1'`) is the
implementation that ships. A real local NER model can be dropped in behind this
interface with **no change** to fusion, redaction, the agent, or any caller.

**Why a heuristic and not a bundled model.** A transformer NER model is
tens–hundreds of MB of WASM/weights and hundreds of ms of inference. PrivAgent's
stated premise is a sub-50 ms local decision cycle inside a Chrome MV3
extension, and its whole value proposition is that raw page text never leaves
the device. A model large enough to matter would break the latency budget; a
small one would be no better than the heuristics. The interface is therefore the
deliverable, and the heuristic is the safe, honest, swappable default.

**The detector is strictly local.** It is synchronous, performs no I/O, opens no
sockets, downloads nothing, and holds no telemetry. This is documented as a
hard rule in the module header because a "privacy feature" that could
exfiltrate text would be an exfiltration primitive.

**It proposes; it never authorizes.** A contextual hit grants no permission,
blocks nothing, and bypasses no gate.

### 2.3 The two perception paths

**OCR + NLP (complementary, in `multimodalCoordinator.ts`):**

```
Screenshot → local OCR → text + word bounding boxes
                        → contextual detection over each line
                        → map each hit's character span back to word boxes
                        → union → fusion candidate
```

The contextual pass runs *inside* the local OCR classification stage, while raw
text is still in scope and before it is discarded — the only place reading OCR
text is legitimate. Word offsets are reconstructed by re-joining words with
single spaces, so a span maps to exactly the boxes of the words it covers —
**and that reconstruction is verified, not assumed** (see §10.1).

**DOM + contextual (in `contentScript.ts`):**

```
DOM detections (existing) → for each, read a BOUNDED context window
    (aria-label / title / placeholder / <label for> / immediate parent)
                          → contextual detection
                          → candidate that INHERITS the anchor's selector + bbox
```

The DOM pass deliberately does **not** crawl the page for free text. It analyses
only the already-classified neighbourhood of a confirmed sensitive field, which
is where `"Cardholder: Jane Doe"` PII actually lives. Because each hit inherits
the anchor's own selector and geometry, fusion folds it into the anchor's
existing finding rather than creating a duplicate region.

### 2.4 Fail-closed escalation (new)

A must-redact finding that has **no region and no selector** cannot be masked
reliably. Under-reporting it is the worse failure, so `fusion.ts` now escalates
rather than drops it:

```ts
const unmappable = decision.mustRedact && region === null && !selector;
// → finding.unmappable = true
// → finding.exportable  = false           (forced, even if policy allowed metadata)
// → finding.evidence    += 'fail_closed:unmappable'
```

`unmappableMustRedactFindings(findings)` exposes them so a redaction caller can
treat a non-empty result as "coverage is incomplete".

Note the escalation is driven by the **existing policy**, not by the new source.
A `person_name` finding is `MINIMIZE` (not must-redact), so it is correctly *not*
escalated; an `address` finding is `REDACT` and *is*. This is asserted directly.

### 2.5 Confidence merging (unchanged and re-asserted)

Fusion confidence is the **MAX** across contributors; a weak signal can never
lower a verdict. Category selection is by highest severity, then highest
confidence. Regions are unioned. Merge thresholds are unchanged (0.6 same
category, 0.9 cross category). Phase 15 added a test proving a 0.1-confidence
contributor cannot pull a 0.98 `credit_card` finding down to `MINIMIZE`.

---

## 3. Files changed

### New

| File | Purpose |
|---|---|
| `extension/src/privacy/contextualPii.ts` | The NLP adapter interface, the `LightweightContextualDetector`, the DOM anchor helper, and the OCR span→bbox mapper. |
| `tests/phase15/privacyFusionContextual.test.ts` | 55 focused tests across the 12 required areas. |
| `scratch/verify_phase15_privacy_fusion.mjs` | Real-Chrome CDP verifier for the DOM contextual path. |
| `docs/evidence/phase15-privacy-fusion/phase15_real_chrome_evidence.json` | Machine-readable real-Chrome evidence. |

### Modified

| File | Change |
|---|---|
| `extension/src/privacy/fusion.ts` | `FindingSource` gains `'nlp'`; `PrivacyFinding.unmappable` added; `candidateFromContextualDetection()` adapter; `sourceCounts` gains `nlp`; fail-closed escalation in `buildFinding()`; `unmappableMustRedactFindings()`. |
| `extension/src/privacy/privacyDecision.ts` | One literal key: `bySource` initialiser now includes `nlp: 0`. No policy semantics changed. |
| `extension/src/visualPerception/multimodalCoordinator.ts` | Runs `detectContextualInOcr()` on the local OCR result and feeds the mapped findings into the existing fusion call. |
| `extension/src/content/contentScript.ts` | Runs `detectContextualForDomDetections()` over existing detections and feeds the anchored candidates into the existing fusion call. Redaction and overlay calls untouched. |
| `tests/privacyFusion.test.ts` | One expectation updated for the new `sourceCounts` shape. |
| `tests/contextMinimizer.test.ts` | One expectation updated for the new `sourceCounts` shape. |

### Deliberately NOT changed

`redactor.ts`, `overlayManager.ts`, `patterns.ts`, `domDetector.ts`,
`ocrDetector.ts`, `spatialOcrLayer.ts`, `rawValueScanner.ts`,
`privacyDecision.CATEGORY_POLICY` (contents), `actionValidator.ts`,
`securityCritic.ts`, `riskEngine.ts`, `containment.ts`, `harness.ts`,
`groundingEngine.ts`, `agentOutput.ts`, and every backend file.

---

## 4. Test results

### 4.1 Phase 15 focused suite

```
npx vitest run tests/phase15/
 Test Files  1 passed (1)
      Tests  59 passed (59)
```

The 55 tests cover all twelve required areas:

| # | Area | Tests |
|---|---|---|
| 1 | DOM-only sensitive finding | 2 |
| 2 | OCR-only sensitive finding | 2 |
| 3 | NLP / contextual-only finding | 3 |
| 4 | Same PII from multiple sources → one fused finding | 2 |
| 5 | Overlapping DOM + OCR bounding boxes | 3 |
| 6 | Sensitive OCR text → correct bbox | 6 |
| 7 | Contextual name / address detection | 4 |
| 8 | False-positive-sensitive cases | 20 (14 UI strings + 6 behaviour) |
| 9 | Missing / invalid bbox → fail closed | 6 |
| 10 | No raw values in exported metadata | 5 |
| 11 | Phase 14 output screening intact | 3 |
| 12 | Security authorities unchanged | 5 |
### 4.2 Full regression suite

```
npx vitest run
 Test Files  96 passed (96)
      Tests  1107 passed (1107)
```

Baseline before Phase 15 was **95 files / 1048 tests**. Delta: **+1 file, +59
tests**, and the pre-existing 1048 all still pass. No test was deleted or
weakened; the only two edits to existing tests were `sourceCounts` expectations
that gained the new `nlp: 0` key.

### 4.3 TypeScript

```
npx tsc -b --noEmit
```

**5 errors, all pre-existing and unrelated** —
`extension/src/background/targetResolver.ts` lines 285, 287 (×2), 290, 488,
introduced by commit `d1fbf5c`. The count is **unchanged from the Phase 14
baseline**; this phase introduced **zero** new type errors.

### 4.4 Builds

```
npm run build:extension   → exit 0
npm run build:frontend    → exit 0
```

---

## 5. Real-browser verification

**Yes — real Chrome was run.** This is not a claim inferred from unit tests.

### 5.1 New Phase 15 seam

`scratch/verify_phase15_privacy_fusion.mjs` — Chromium `headless=new` driven over
CDP, loading the **built `dist/`** extension, opening a real fixture page, and
sending a real `PRIVAGENT_SCAN_REQUEST` to the real content script.

```
[PHASE 15] REAL CHROME — privacy fusion & contextual PII detection
  DOM detections = credit_card, password, person_name, person_name, link, button
  fused findings = 6, nlp-sourced = 3
  person_name findings = 2 (multi-source = 2)
  raw values found in the world model = 0
  findings referencing UI copy = 0

{
  "domDetectorIntact": true,
  "contextualSignalReachedFusion": true,
  "contextualCategoryIsPersonName": true,
  "contextualFindingIsLocatable": true,
  "fusedNotDuplicated": true,
  "noRawValuesInWorldModel": true,
  "noUiCopyFalsePositives": true,
  "zeroLeakage": true
}

[PHASE 15] ALL CHECKS PASS
```

**8/8 checks pass.** This proves the wiring, not just the unit: the contextual
detector actually runs in the shipped extension, actually reaches
`fusePrivacyFindings()`, and actually merges (2 person_name findings, both
multi-source) rather than duplicating.

The fixture deliberately contains `"Home"`, `"Contact Us"`,
`"Track Your Package"`, `"Place Order"` and `"Order Summary"`; **zero**
findings referenced any of them.

### 5.2 Pre-existing seams re-run as regression

| Seam | Result |
|---|---|
| `scratch/verify_phase12_containment.mjs` | **7/7 PASS** |
| `scratch/verify_phase13_harness.mjs` | **9/9 PASS** |
| `scratch/verify_phase13_production_path.mjs` | **7/7 PASS** |
| `scratch/verify_phase14_production_path.mjs` | **8/8 PASS** |

Those scripts rewrite their own committed evidence files on each run. The
Phase 12/13/14 evidence was restored with `git checkout --` after the re-runs so
those phases' evidence stays frozen at its own verified state. **Only the new
Phase 15 evidence directory is added.**

---

## 6. Privacy invariants

1. **No raw value ever enters a finding.** `ContextualPiiHit` carries
   `type`, `confidence`, `start`, `end`, `length`, `evidence` — a character
   *span* and a character *length*, never the matched substring. A test asserts
   the exact key set.
2. **No raw OCR text, `textContent`, `innerText`, password or token** appears in
   any finding. The whole fused finding set passes
   `scanForRawSensitiveValues()` cleanly, and the same scanner is proven to bite
   when a value is deliberately injected.
3. **Evidence codes are value-free and closed.**
   `dom:* | ocr:* | visual:* | nlp:* | contextual:* | fused:* | fail_closed:*`.
4. **Text stays local.** The detector is synchronous, does no I/O, and is only
   ever handed text the caller already holds in memory.
5. **Fusion is perception, not authorization.** `fusePrivacyFindings()` returns
   a `FusionResult` with exactly six keys and grants no permission. Verdicts
   still come solely from `privacyDecision.decideTransmission()`.
6. **Unregistered categories fail closed.** `organization` and `location` are not
   in `CATEGORY_POLICY`, so the pre-existing
   `policy.unknown_category` path makes them `FAIL_CLOSED`,
   `mustRedact: true`, `exportableMetadata: false` — with no policy edit.
7. **Unlocatable must-redact findings are escalated, not dropped**
   (`unmappable` + forced `exportable: false`).
8. **The redaction engine is still the only thing that redacts.** The contextual
   signal is fusion metadata; it neither redacted nor un-redacted anything.
   `report.leakageCount` remained `0` in the real-Chrome run.
9. **The Phase 14 output boundary is untouched.** `projectAgentOutput()` and
   `screenAgentOutput()` are unmodified, and all three of their behaviours
   (clear / redacted / blocked) are re-asserted in the Phase 15 suite.
10. **No security authority was modified, moved, widened or bypassed.** Verified
    in test area 12 and by inspection of the diff.

---

## 7. Limitations & tradeoffs

1. **The detector is a heuristic, not a model.** It finds *cued* names,
   addresses, organizations and locations well; it does not do general NER.
   Lowercase names, transliterated names, and names in languages the
   capitalization heuristic does not fit are missed. This is stated plainly
   rather than papered over — the adapter interface is the real deliverable, and
   the heuristic is the honest swappable default.
2. **False positives are controlled by a closed list, not by a model.** The
   `NON_NAME_TOKENS` / `LABEL_TOKENS` sets encode common UI vocabulary. A site
   whose chrome uses capitalised words outside that list will produce low-
   confidence (0.45) weak hits. Those are *deliberately* below
   `person_name.minConfidence` (0.5), so the **existing policy layer**, not the
   detector, escalates them to `FAIL_CLOSED`. A broader vocabulary is a
   maintenance cost and a genuine limitation.
3. **The DOM pass only analyses anchors the DOM detector already found.** Free
   text elsewhere on the page is not scanned for contextual PII. A full page
   text sweep would be a materially larger and riskier change; this phase kept
   the blast radius small on purpose.
4. **The DOM pass is bounded**: 60 anchors, 400 context characters, 4 hits per
   anchor, immediate parent only. This keeps the per-scan cost inside the
   existing local budget, at the cost of missing a name more than one container
   away from its field.
5. **Word-box mapping fails closed on any degenerate box** touching a hit's span.
   A single OCR engine glitch in the middle of a name makes the whole hit
   unmappable. That is the intended trade: over-report an unmappable sensitive
   finding rather than redact the wrong pixels.
6. **`location` and `organization` are unregistered categories.** They fail
   closed permanently. Registering them with a real policy is a deliberate
   future decision, not an oversight.
7. **Spans are approximate.** A hit's span can include an adjacent label token
   (e.g. `"Holder Jane Doe"` rather than `"Jane Doe"`). This is metadata only
   and never leaks text, but it means `length` is an upper bound, not an exact
   character count of the name.
8. **OCR was not exercised in the real-Chrome Phase 15 seam.** The fixture has no
   canvas or non-DOM visual region, and headless Tesseract adds minutes of
   startup. The OCR span→bbox mapping, the clamping, the fail-closed path, and
   the coordinator-level wiring are covered by unit tests — the last of these
   now runs the real `coordinateMultimodalPerception` with a mock OCR engine and
   asserts an `nlp`-sourced finding with the correct region. **This is stated
   rather than implied.**
9. **The OCR → contextual path has no production caller yet.**
   `coordinateMultimodalPerception` only runs OCR when the caller supplies an
   `ocrEngine`, and the service worker does not. The wiring is therefore proven
   and ready but dormant in the agent loop. See §11.

---

## 8. Reasoner / backend limitations

- The **backend reasoner is intentionally not running** during browser
  verification, so agent runs terminate at the reasoning step with
  `REASONER_FAILED`. This is the same condition recorded in the Phase 14
  evidence, and it means the per-action security gates (M5, Security Critic,
  Risk/Confirmation) have nothing to evaluate in those runs. They are unmodified
  and are covered by the regression suite.
- **`pytest` is unavailable in this environment** (`No module named pytest`), so
  the Python backend suite could not be executed. No backend file was changed in
  this phase, so there is no backend delta to regress.

---

## 9. Verification summary

| Gate | Status |
|---|---|
| Phase 15 focused suite | **59/59 pass** |
| Full regression suite | **1107/1107 pass** (96 files; baseline 1048/95) |
| `npx tsc -b --noEmit` | **5 errors, all pre-existing** `targetResolver.ts`; 0 new |
| `npm run build:extension` | **exit 0** |
| `npm run build:frontend` | **exit 0** |
| Phase 15 real-Chrome seam | **8/8 pass** |
| Phase 12 containment (regression) | **7/7 pass** |
| Phase 13 harness (regression) | **9/9 pass** |
| Phase 13 production path (regression) | **7/7 pass** |
| Phase 14 production path (regression) | **8/8 pass** |

**Not committed. Not pushed. Phase 16 not started.**

---

## 10. Review pass — defects found and fixed

A post-implementation review re-read every Phase 15 file against this report
rather than trusting the report. Two genuine defects were found. Neither was
cosmetic.

### 10.1 OCR span → bbox could silently mask the wrong pixels (correctness)

**The defect.** A hit's span is an offset into the OCR **line text**, but the
boxes belong to the OCR **words**. The mapper reconciled the two by assuming
`line.text === words.map(w => w.text).join(' ')`.

That assumption does not hold in the real engine. `ocrEngine.ts` keeps
`line.text` verbatim from Tesseract, but **drops any word with no text or no
bounding box** (`if (!lw.text || !lw.bbox) continue;`). Every offset after the
first dropped word is therefore shifted, and the mapper happily returned a box
for the wrong words.

Measured, before the fix:

| Case | Hit covers | Box returned | Correct box |
|---|---|---|---|
| `Kumar` dropped (no bbox) | `"Rajesh Kumar"` | `[150,100,55,16]` | `[150,100,120,16]` |
| `To` dropped (middle of line) | `"To Rajesh Kumar"` | `[60,100,130,16]` — swallowed the neighbouring word | name only |

The first case leaves **half a person's name visible** while reporting the region
as redacted. That is precisely the failure class this phase exists to prevent,
and the original tests missed it only because their fixture was perfectly
self-consistent.

**The fix.** The invariant is now **verified, not assumed**.
`mapContextualHitToOcrRegion(hit, words, lineText)` reconstructs the join and
returns `null` when it does not match `lineText` exactly. `detectContextualInOcr`
always supplies `lineText`, so the production path fails closed: the finding is
returned with `unmappable: true` and fusion escalates it rather than masking
wrong pixels. The two-argument form remains available for callers that already
know the join is exact, and is documented as a pure-geometry call.

Two regression tests pin this: one asserts the old, wrong answer is what the
geometry alone produces, and that supplying `lineText` turns it into `null`; the
other asserts mapping still succeeds when the join does match.

### 10.2 Unbounded contextual OCR candidates (robustness)

`detectContextualInOcr` had no cap. A text-heavy capture produces one candidate
per capitalised run per line, and fusion grouping is O(candidates²) — so the
perception step could quietly become the slowest part of the agent loop on a
dense page. Bounded now: 80 lines, 60 findings, via early return.

### 10.3 Also corrected

A stale docstring on `buildAnchorContextText` described dropping duplicate
sources when the code strips them. Fixed while in the file. No behaviour change.

### 10.4 Re-verified after the fixes

Focused **59/59**, full regression **1107/1107**, TypeScript **5 pre-existing
errors / 0 new**, both builds **exit 0**, Phase 15 real-Chrome **8/8**.

---

## 11. Open item: the OCR → contextual path has no production caller

`coordinateMultimodalPerception` only enters its OCR branch when the caller
passes an `ocrEngine`. The service worker calls it **without one**
(`serviceWorker.ts:733`), so in the agent loop the OCR branch — and therefore
the contextual OCR pass — never executes today. The only live OCR caller is the
popup's manual capture flow, which does not use the coordinator.

This was **not** introduced by Phase 15; the conditional predates it. The wiring
is correct and now proven by a coordinator-level test.

It was deliberately **not** changed here. Supplying a `LocalOCREngine` to the
agent's per-cycle perception would add Tesseract WASM initialisation and
recognition — seconds — to every agent cycle, inside an MV3 service worker that
can be evicted. That is an architectural and latency decision, not a correctness
fix, and the brief explicitly says not to modify unrelated agent behaviour or
expand scope without evidence that it is required.

**Recommended follow-up (not done here):** decide whether OCR belongs in the
agent hot loop, and if so make it opt-in or budgeted rather than unconditional.
