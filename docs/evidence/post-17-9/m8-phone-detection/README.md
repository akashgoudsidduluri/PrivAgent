# M8 PHONE-DETECTION GAP — audit, fix and evidence

**Headline classification: `PROVEN_REAL`** (real Chrome) for the detection
change, **`PROVEN_TEST`** for the precision guards, and **0 new false
positives** on the measured corpus.

---

## 1. Root cause

`PATTERNS.PHONE` (`extension/src/privacy/patterns.ts`) matches a bare 10-digit
run only in two ways:

```
(?:\+\d{1,3}[-.\s])?\(?\d{3}\)?[-.\s]\d{3}[-.]\d{4}\b   ← needs separators
(?:(?:\+91|0)?[\s.-]?)?[6-9]\d{4}[\s.-]?\d{5}\b          ← needs [6-9]
\+\d{1,3}[-.\s]\d{1,4}[-.\s]\d{3,4}[-.\s]\d{3,4}\b       ← needs +CC + separators
```

`555XXXXXXX` (a 10-digit value beginning with `5`) starts with `5` and carries no
separators, so **none** of the three
alternatives matched. Confirmed live:

| text | `PATTERNS.PHONE` | `KEYWORDS.PHONE` | `rawValueScanner` |
|---|---|---|---|
| `Support line 555XXXXXXX available 9am` | **false** | false | `[]` |
| `Phone: 555XXXXXXX` | **false** | true | `[]` |
| `Phone: 9876543210` | true | true | `["phone"]` |
| `Phone: (555) 123-4567` | true | true | `["phone"]` |

### Why the [6-9] restriction exists, and why it was NOT relaxed

`[6-9]` is the **Indian mobile numbering plan** (6 = legacy BSNL/MTNL,
7–9 = current). It is deliberate, appears independently in four places
(`patterns.ts`, `rawValueScanner.ts`, `actionValidator.ts`,
`backend/app/text_safety.py`), and is what stops bare amounts and 10-digit IDs
from being read as phones. Relaxing it globally would have been the shortcut
and was rejected.

### A second, independent pre-existing gap

`KEYWORDS.PHONE` holds **underscored** entries (`contact_number`), but real
markup uses **space-separated** labels. `matchesKeyword` does a plain substring
test, so:

```
'Phone Number: 555XXXXXXX'  → keyword=true
'Contact Number: 555XXXXXXX' → keyword=FALSE
```

So even the *contextual* channel missed a plainly-labelled phone. The new rule
reads intent from prose/label text directly rather than relying on that list.

### Six phone sites were audited

| Site | Role | Changed |
|---|---|---|
| `privacy/patterns.ts` | canonical pattern source | **+ new shared helper** |
| `privacy/rawValueScanner.ts` | M8 egress firewall | **+ wired** |
| `privacy/domDetector.ts` (input + text) | DOM detection | **+ wired** |
| `agent/actionValidator.ts` | action-reason PII block | no (deliberate — see Limitations) |
| `ocr/ocrDetector.ts`, `ocr/spatialOcrLayer.ts` | OCR path | no |
| `backend/app/text_safety.py` | model-text egress | **+ mirrored** |

---

## 2. The rule chosen

`hasContextualPhone()` — three independent gates, **all** required, so no single
gate is load-bearing alone:

| Gate | Requirement |
|---|---|
| **G1 shape** | exactly 10 digits, not adjacent to another digit or a dash — a longer numeric token is never split |
| **G2 context** | a phone-intent word (`phone`, `mobile`, `tel`, `contact number`, `support line`, `call`, `hotline`, `dial`, `sms`, `whatsapp`, `enquiry`, …) within 48 chars before **or** after the run |
| **G3 guard** | an explicit non-phone label (`id`, `order`, `invoice`, `tracking`, `zip`, `account`, `timestamp`, `serial`, `sku`, …) immediately before the run **overrides** G2 |

### Why not `\d{10}`

Measured, not assumed. On a 22-string corpus the naive rule produced **13 false
positives**:

| candidate | positives caught | false positives |
|---|---|---|
| bare-10 (forbidden) | 8/8 | **13/16** |
| bare-10 + any keyword | 8/8 | **13/16** |
| bare-10 + nearby keyword | 5/8 | 1/16 |
| **shipped: 3 gates** | **12/12** | **1/22 — and that 1 is pre-existing** |

Generic words are deliberately **not** intent tokens. `"number"` was tried and
rejected: it made `"The number 1234567890 appears"` a phone.

The one remaining false positive (`Code 123-456-7890`) is **pre-existing baseline
behaviour** — `PATTERNS.PHONE.test()` already returned `true` for it before
this change.

---

## 3. Test results — `PROVEN_TEST`

`tests/m8PhoneDetection.test.ts`, **53 tests**, all driving production code.

**Positives (12):** clear context · existing [6-9] phone · formatted US ·
dashed · international · punctuation · prose "call" · prose "support line" ·
contact-number label · mobile · tel · phone-number label.

**Negatives (28):** arbitrary 10-digit · product ID · order ID · invoice ·
tracking · ZIP · postal · price · count · timestamp · epoch · account ·
reference · random prose · UUID-like · 9/11/12-digit serials · phone-word-with-ID-label ·
6/7/8/11/12/13-digit runs in phone context (these pin the **exact** 10-digit
length and the digit boundary).

Also asserted: detection metadata carries no raw value · violation records
contain only `{path, rule}` · context minimization carries no raw value ·
outbound payloads rejected · structural ids (`elem-42`, `wm-g12-abc123`,
`ocr-det-1-…`) do not fire · email/card/PAN/OTP rules unchanged · keyword
channel unchanged · real end-to-end `scanDOM` on the exact prose shape.

One test documents the negative case for the whole design: it asserts that a
naive bare-10 rule *would* have failed >10 of the negatives, so the contextual
gates stay justified.

---

## 4. Mutation results — 8/8 killed, 0 invalid, 0 equivalent

`mutation_results.json`.

| Mutant | Target | Result |
|---|---|---|
| P1 | remove the context gate | **killed** (6) |
| P2 | remove the non-phone label guard | **killed** (2) |
| P3 | loosen digit length to 7+ | **killed** (3) |
| P4 | remove the digit boundary | **killed** (2) |
| P5 | unwire from the M8 raw-value scanner | **killed** (3) |
| P6 | unwire from the DOM text detector | **killed** (2) |
| P7 | restore the original [6-9]-only rule | **killed** (14) |
| P8 | leak the raw value into the violation record | **killed** (2) |

Sources backed up by copy (the work is uncommitted), each edit applied with an
exact-match anchor assertion, and the restore verified byte-identical by md5.

**Two harness defects were found and fixed, and both mattered:**

1. **A non-compiling mutant was scored as "survived."** P7's `\n` became a
   literal newline in the shell, producing a syntax error. The harness counted
   a compile failure as a pass-through, understating the suite. It now reports
   `INVALID` separately and excludes it from the score. P7 was then re-anchored
   and is genuinely killed (14 failures).
2. **P3 and P4 initially survived and were reported honestly as such** — and
   investigating showed they were a *test gap*, not an equivalent mutant: no
   negative covered a 7/8/11/12/13-digit run *in phone context*. Six cases were
   added, and both mutants are now killed. The tests were extended to fit the
   design's stated contract; no existing assertion was changed to fit the
   implementation.

---

## 5. Real Chrome — `PROVEN_REAL`

`real_chrome_results.json`. Real Chrome 153, real built MV3 extension, real
content script driven by the production `PRIVAGENT_SCAN_REQUEST` message from
the real service worker. No reasoner (irrelevant to local detection).

| Check | Result |
|---|---|
| live tab contains the prose phone | true (44-char text, 10 digits) |
| **phone detections from the real scan** | **5** |
| categories detected | `credit_card`, `email`, `input`, `phone` |
| detection metadata shape | `bbox, confidence, id, length, selector, source, type` |
| **raw phone in detections** | **false** |
| world model `Protected Text` regions | **5 of 16** |
| raw phone in world model | false |
| raw phone in serialized report | false |
| raw phone written to evidence file | **false** (grep: 0) |

**Evidence policy honoured:** the artifact records metadata, booleans and
lengths only. The synthetic value never appears in it (verified by grep), and
neither do the synthetic email or PAN.

---

## 6. Privacy regression — `PROVEN_TEST`

| Suite | Result |
|---|---|
| patterns, domDetector, privacyFusion, centralPrivacyInvariant | 46 pass |
| ocrSecurityBoundary, securityBoundary, worldModelPrivacyBoundary, privacyPolicy, llmPrivacy | 50 pass |
| redactor, visualRedactor, telemetryAndEvaluation | 20 pass |
| full extension suite | **122 files / 1704 tests** (baseline 121/1651) |

- **No regression** for email, card, PAN, password, OTP, CVV, name, address.
- **No new raw-value egress** — the rule only ever *adds* a `phone` violation.
- **No telemetry/dashboard leakage** — detection records are `{type, confidence,
  source, id, bbox, length, selector}`.
- **No provider payload leakage** — verified at the real-Chrome egress boundary.
- The change is **strictly additive**: it can add a `phone` hit, never remove one.

---

## 7. Performance — `PROVEN_TEST`

`performance_results.json`, 200 warmup + 2000 measured, 44-string corpus.

| Metric | Value |
|---|---|
| contextual rule alone | p50 0.0004 ms · p95 0.0009 ms |
| raw-value scanner **after** | p50 0.003 ms · p95 0.0052 ms |
| pre-change phone check | p50 0.0002 ms · p95 0.0004 ms |
| **overhead (p95)** | **+0.0048 ms** |

**FP corpus delta:** 44 strings → **5 newly flagged, 0 lost**. All 5 newly
flagged strings were inspected and are genuine phones; **zero** non-phone
strings were newly flagged. No pre-existing detection disappeared.

---

## 8. Limitations

- **`KNOWN_LIMITATION` — `actionValidator.ts` unchanged.** Its
  `INDIAN_PHONE_PATTERN` still requires [6-9] or a separator, so a model
  *reason* containing the prose form is still not blocked. This is deliberate:
  that gate blocks actions, and loosening it risks blocking legitimate actions.
  It is a separate decision and was left to the audit rather than changed here.
- **`KNOWN_LIMITATION` — the OCR path uses the old `PATTERNS.PHONE` only.**
  Text rendered inside a canvas will not gain the contextual form.
- **`KNOWN_LIMITATION` — false negatives remain by design.** A bare 10-digit
  number with no phone context is deliberately *not* flagged, because the corpus
  evidence shows it is far more often an identifier.
- **`NOT_PROVEN` — a real US number beginning 2–5 with no label.** A 10-digit
  US landline in prose with no phone-related word nearby is still missed. This
  is the deliberate precision/recall trade, not an oversight.
- **`NOT_PROVEN` — open-web numbers.** Every measurement here is the synthetic
  local fixture; no claim is made about real-world numbering plans beyond the
  Indian/US formats already encoded.
- Precision figures are **corpus-based**, not a production precision rate.

---

## 9. Files

**Production (4, +140/−6 — additive only):**
- `extension/src/privacy/patterns.ts` — new `hasContextualPhone()` + intent/label vocabularies
- `extension/src/privacy/rawValueScanner.ts` — wired into M8 `valueRuleViolations`
- `extension/src/privacy/domDetector.ts` — wired into the input and text detectors
- `backend/app/text_safety.py` — mirrored rule for model-text egress

**Tests:** `tests/m8PhoneDetection.test.ts` (53, new file — no existing test file
was modified, and no `.skip`/`.only` was introduced).

**Harnesses:** `scratch/phone_fixture.mjs`, `scratch/phone_real_chrome.mjs`,
`scratch/phone_mutation.sh`.

No Phase 18 was created. No unrelated PII type was changed. Nothing was
committed or pushed.
