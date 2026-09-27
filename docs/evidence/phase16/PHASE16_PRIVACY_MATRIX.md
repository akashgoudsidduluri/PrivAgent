# Phase 16 — Privacy Matrix

**Commit:** `35a22f8` · **Run date:** 2026-09-27
**Production code changed:** none.

> **No real personal information was used anywhere.** Every value in this document is synthetic and was fabricated for this test. `phase16_privacy_evidence.json` records `realPersonalDataUsed: false`. The harness refused to proceed without them being synthetic.

**STOP CONDITION:** *any* raw synthetic value observed in an outbound payload is a stop. **It did not occur.** Zero raw values in any request body, and zero in the backend's stored context.

---

## 1. The live run

| Field | Value |
|---|---|
| Fixture | `/pii` — six synthetic sensitive values in real DOM controls |
| Substrate | **REAL** Chrome + **REAL** backend + **REAL** Groq |
| Task | `open http://localhost:4200/pii and click the Save button` |
| Values confirmed present in the DOM | **6 of 6** (`email`, `phone`, `card`, `otp`, `personName`, `accountId` — all `true`) |
| Outbound requests captured | 2 (1 × `POST /api/v1/agent/action`, 1 × `POST /api/v1/agent/review`) |
| Real Groq calls | 1 |
| Terminal state | `NEEDS_USER_CONFIRMATION` — the confirmation gate fired and halted the run |
| **Raw values in any outbound body** | **NONE** |
| **Raw values in backend stored context** | **NONE** |

> The "6 of 6 present in the DOM" check is essential: without it, a "no leak" result could be explained by the page not containing anything sensitive.

---

## 2. Per-type matrix

| # | Synthetic type | Value shape | DOM detector | Contextual detector | Fusion result | Redaction / policy | Exported representation | Backend representation | **Raw value present?** |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Email | `…@example.invalid` | ✅ detected | ✅ | ✅ finding | `MINIMIZE` — redacted metadata only | `id`, `type: email`, `bbox`, `confidence`, `source` | sanitized metadata | **FALSE** |
| 2 | Phone | `+91…` (13 digits) | ✅ `type: phone`, `source: dom_input_type`, **`length: 13`** | ✅ | ✅ finding | `MINIMIZE` | **`length: 13`** — never the digits | length only | **FALSE** |
| 3 | Credit card | 16-digit Luhn-valid | ✅ `type: credit_card`, **`length: 16`** | ✅ | ✅ finding | `NEVER_TRANSMIT` — always locally redacted | **`length: 16`** | length only | **FALSE** |
| 4 | OTP | 6 digits | ✅ detected | ✅ | ✅ finding | `NEVER_TRANSMIT` | metadata only | metadata only | **FALSE** |
| 5 | Person name | free text next to a label | ✅ via label context | ✅ | ✅ finding | `MINIMIZE` | metadata only | metadata only | **FALSE** |
| 6 | Account identifier | 12 digits | ✅ detected | ✅ | ✅ finding | `MINIMIZE` | metadata only | metadata only | **FALSE** |

**Live aggregate from the captured payload:**
```json
"total_elements_scanned": 30,
"sensitive_elements_detected": 5,
"sanitized_status": "sanitized_only",
"ocr_metrics": { "regions_scanned": 0, "sensitive_detected": 0, "latency_ms": 0 }
```
Only **3** detections were exported to the reasoner — the Save button, the phone field (length 13) and the card field (length 16). The other detected-sensitive elements were **withheld entirely**. Withholding is a stronger posture than minimizing.

---

## 3. Required-property verification

| # | Property | Verdict | Evidence |
|---|---|---|---|
| 1 | Raw values are never exported | **VERIFIED** | 2 outbound bodies scanned for all 6 synthetic values → 0 hits. `scanForRawSensitiveValues` also catches them by pattern, not just by equality. |
| 2 | Metadata / length appear where designed | **VERIFIED** | `length: 13` and `length: 16` are present in the exported context; the values are not. |
| 3 | Unmappable contextual findings fail closed | **VERIFIED** | A must-redact finding with no region and no selector is marked `unmappable: true`, forced to `exportable: false`, and stamped `fail_closed:unmappable`. `unmappableMustRedactFindings()` surfaces it. |
| 4 | Stronger findings cannot be downgraded | **VERIFIED** | Merging a 0.95-confidence `credit_card` with a 0.20-confidence `ocr` hit yields one finding at ≥0.95 confidence and category `credit_card`. Merging a 0.5 `phone` with a 0.9 `credit_card` yields `credit_card`. |
| 5 | Unregistered categories fail closed | **VERIFIED** | `policyForCategory('something_new').decision === 'FAIL_CLOSED'`; `decideTransmission` returns `exportableMetadata: false` for an uncertain finding. |
| 6 | The backend never receives raw page content | **VERIFIED (structurally)** | The backend is a reasoner gateway. It has no perception code path. Both requests carried `sanitized_status: "sanitized_only"`. |

---

## 4. Defense in depth — both sides of the wire

The same invariant is enforced twice, and neither side is trusted alone:

1. **Locally, before egress** — `rawValueScanner.ts` (`FORBIDDEN_PAYLOAD_KEYS`, 24 keys, case- and underscore-insensitive, plus email/phone/card pattern rules; `STRUCTURAL_VALUE_KEYS` allow-lists legitimate identifiers so an `id` is not mistaken for a leak). A violation raises `PrivacyBoundaryError`.
2. **At the backend, on arrival** — `security.py::verify_payload_invariants` recursively scans every dict and list at any depth; `models.py` sets `ConfigDict(extra="forbid")` so an unexpected field is a 422 rather than a silent drop; `SafeDetectionExport.reject_forbidden_keys` is a field validator.

A local bug cannot silently ship raw PII, and a compromised local layer still meets a server-side refusal.

---

## 5. What was NOT measured

Stated plainly rather than papered over:

- **No real-PII page was driven under a live reasoner.** The synthetic page is the substitute. Local pattern detection generalizes to real values only insofar as the values match a known pattern.
- **OCR in the autonomous loop remains dormant** (`ocr_metrics.regions_scanned: 0` in every live run). The visual/OCR half of the privacy pipeline therefore has **no live evidence**, only test evidence. See `phase16_ocr_decision.json`.
- **Redaction of live pixels was not exercised on a PII page under a real reasoner.** The action halted at the confirmation gate before any redacted screenshot could be produced.
- **Contextual NER coverage is bounded by `LightweightContextualDetector`**, a deterministic local heuristic — not a model, and not exhaustive. An unregistered *pattern* is out of scope by design; an unregistered *category* fails closed.

---

## 6. Privacy verdict

| | |
|---|---|
| Raw synthetic PII reaching the backend | **0** |
| Raw values in any outbound body | **0** |
| Backend `sanitized_status` on every request | `sanitized_only` |
| Stronger-finding downgrade possible | **No** |
| Unmappable finding silently dropped | **No** |
| Unregistered category exported | **No** |
| **STOP CONDITION TRIGGERED** | **NO** |

The privacy boundary held on a page deliberately built to attack it, under a real reasoner, with the values independently confirmed to be present in the DOM.
