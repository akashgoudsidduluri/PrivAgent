# Post-17.9 — SEMANTIC OBSERVATION + ANSWER VERIFICATION

**Classification of the headline claim: `PROVEN_REAL`.**

The agent reads a non-interactive textual fact from a live page in real Chrome,
driven by the real Groq reasoner, and Goal Verification certifies `SUCCESS` from
that observation alone. Verified in
`../real-reasoner-multistep/real_reasoner_results.json`.

---

## 1. The gap this closes

PrivAgent could navigate to a product page and *see* `Price: 24` in the DOM, but
Goal Verification could not **certify** a non-interactive textual fact. There was
no evidence type for "the page says X". Before this work a task ending
"…and report the price shown on its product page" could never reach `SUCCESS`:
no action completes it and no interactive element names it.

## 2. Audit finding: the capability partially existed

This was **case B**. Nothing was duplicated:

| Existed already | What it lacked |
|---|---|
| `semanticUnderstanding` subsystem with a `textRegions` channel | No fact extraction, no provenance, nothing for GV to match |
| `SanitizedSemanticContext` already egressing via the backend's `Dict[str, Any]` | No freshness or identity binding |
| `ocr/ocrObservationContract.ts` — provenance + freshness, fail-closed | Not wired to the DOM text channel, and not readable by GV |

The OCR observation contract was the template. Facts derive **only** from data
M8 has already sanitized.

## 3. Data flow

```
world model text regions (already M8-sanitized, 40-char preview)
      │
      ▼
extractSemanticFacts → re-screen EVERY candidate with M8 scanForRawSensitiveValues
      │                 (failure ⇒ DROP + count, never downgrade)
      ▼
SemanticObservation { facts, provenance{tabId, documentUrl, pageGeneration, observedAt} }
      │
      ├── device-local ──▶ goal verification (rule 2c)
      └── sanitized facts only ──▶ reasoner prompt, inside the PRE-EXISTING
                                    `semantic_context.facts` envelope
```

**Evidence only.** Nothing here authorizes an action. It is not readable by
grounding, M5, the Security Critic, risk/confirmation, containment, effect
verification or recovery.

## 4. Two real defects found by running it, not by designing it

### 4.1 F-08 class: field naming is load-bearing

The backend's `verify_payload_invariants` rejects keys named `text`/`value` at
**any depth**. The natural extraction names would have made every real provider
call fail closed with a 422 — invisible to any extension-side test.

```
{"key":"price","text":"Price: 24","value":24}   → REJECTED: Forbidden key 'text'
{"key":"price","displayText":"Price: 24", …}    → ACCEPTED
```

Pinned in both directions by test **G4b** and a real subprocess call into the
backend's own scanner.

### 4.2 Soundness bug in rule 2c — found by the real run

The **first** real-reasoner run returned `SUCCESS` while the tab was still on
`/catalog`, with the reason *"Display fact verified… 'Price' is 'Price: 24'"*.
The catalog lists the **same price** as the product page, and the task's other
obligation — *open the first product listed* — was never met. A fact satisfied
the whole conjunction.

The fix is a statement about the **evidence**, not the task's wording: "the
price" is only determined when the observed page shows exactly **one** candidate
for that key. A listing showing several values has not yet said *which item* is
meant. Pinned by **H3** (catalog cannot certify) and **H4** (product page does).

A follow-up mutation (**M4+M7**) exposed a second hole in the same rule: a fact
sharing the key but carrying an unobserved *value* passed the guard, because only
the key was counted. Now the selected fact must match an observed candidate on
`displayText` **and** `displayValue`. Pinned by **I7**.

> Note: an earlier draft of this fix also added a "scope" guard keyed on the word
> "open" in the task text. It broke 9 passing security tests and was **removed** —
> it was a heuristic on wording, not a property of the evidence.

## 5. Graded claims

| Claim | Grade | Evidence |
|---|---|---|
| Multi-step SUCCESS from a non-interactive fact, real reasoner + real Chrome | **PROVEN_REAL** | `real_reasoner_results.json`, `PROVEN_REAL`, `successCameExclusivelyFromObservation: true` |
| Facts are extracted only from already-M8-sanitized data | **PROVEN_TEST** | §A, G5, G5b |
| Extraction cannot widen the privacy boundary of its inputs | **PROVEN_TEST** | G5 — every fact is a strict subset of text upstream already emitted |
| Stale / wrong-page / wrong-tab / future-generation evidence rejected | **PROVEN_TEST** | §C cases 4, 5, 6, 12, 12b, 12c |
| A model claim can never certify a goal | **PROVEN_TEST** | §D cases 7, 8, 14, I7 |
| Injection-shaped page text is data, never evidence, never an instruction | **PROVEN_TEST** | CASE 10, backend `contentTrust: page-data-untrusted` |
| PII never becomes a fact (re-screen) | **PROVEN_TEST** | CASE 9, 9b; mutant M5 |
| Egress payload passes the **backend's own** key scanner | **PROVEN_TEST** | G4, G4b — real `app.security.verify_payload_invariants` in a subprocess |
| Provenance never crosses the egress boundary | **PROVEN_TEST** | G3 |
| Local cost is negligible | **PROVEN_TEST** | `performance_results.json` |
| Mutants killed | **PARTIALLY_PROVEN** | 4/7 single mutants killed; 3 are **equivalent** (see below) |
| Open-web (non-fixture) multi-step success | **NOT_PROVEN** | out of scope; see Limitations |

## 6. Mutation testing — reported honestly

`mutation_results.json`. **4 killed, 3 equivalent, 2 compounds killed.**

| Mutant | Target | Result |
|---|---|---|
| M1 | fabricate a fact when none observed | **equivalent** (survives alone) |
| M2 | accept stale evidence (drop age check) | **killed** — CASE 4 |
| M3 | accept wrong-page evidence (drop identity check) | **killed** — CASE 12, H2b |
| M4 | accept a model claim alone | **equivalent** (survives alone) |
| M5 | remove the M8 re-screen | **killed** — CASE 9b |
| M6 | remove the ambiguity guard | **killed** — H3, I4 |
| M7 | drop the value-identity check | **equivalent** (survives alone) |
| **M1+M7** | fabricate **and** no identity check | **killed** — CASE 10, I7 |
| **M4+M7** | model claim **and** no identity check | **killed** — I7 |

M1, M4 and M7 each survive **in isolation** because another check masks them.
They are reported as equivalent mutants, **not** as passes. The compounds are
what demonstrate the two independent checks together close the hole. The harness
asserts an exact-match anchor per edit and verifies a byte-identical restore
(md5) after the run.

## 7. Performance

`performance_results.json` — 50 warmup + 300 measured iterations, jsdom, real
production functions, real fixture.

| Page | observe p50 | observe p95 | observe→verify p95 | facts |
|---|---|---|---|---|
| realistic (fixture product page) | 0.013 ms | 0.051 ms | 0.168 ms | 3 |
| adversarial (30 regions, long text, injection, PII) | 0.091 ms | 0.158 ms | 0.233 ms | 24 |

The new path is ~1–5% of the pre-existing world-model build it sits beside
(p95 23.9 ms realistic), so it is not a meaningful addition to cycle latency.

## 8. Limitations

- **NOT_PROVEN** — open-web, non-fixture multi-step success. Every real-browser
  result here is the local Phase 17.6 fixture (used unmodified). Live sites hit
  anti-bot interstitials; that boundary is not attempted.
- **Known M8 gap (pre-existing, not introduced here)** — the M8 phone rule
  requires a `[6-9]` leading digit or separators, so an unformatted number like
  `5551234567` in prose is not flagged. Verified this is pre-existing behaviour
  in the world-model path too; this work did not weaken it. Worth a separate fix.
- **A page that displays exactly one price for the key will certify**, even if
  the goal arguably wanted a different page. The ambiguity guard is
  evidence-shaped, not intent-shaped; that is deliberate, and the alternative
  (wording heuristics) is what broke 9 tests.
- **Rule 2c is read-only.** It can never authorize or satisfy a task that
  requires an effect, by design.

## 9. Files

**New production** — `extension/src/semanticObservation/{types,factExtraction,freshness,index}.ts`
**Modified production** — `agent/goalVerifier.ts`, `agent/backendAgentProvider.ts`,
`agent/openRouterProvider.ts`, `background/serviceWorker.ts`,
`privacy/{types,contextMinimizer}.ts`,
`semanticUnderstanding/{semanticTypes,semanticContext}.ts`, `backend/app/reasoner.py`
**Tests** — `tests/post179SemanticObservation.test.ts` (56),
`backend/tests/test_semantic_facts_prompt.py` (7)
**Harnesses** — `scratch/so_mutation.sh`, `scratch/so_perf.test.ts` (bench-only config)

No gate was weakened. F-09 `person_name` and the egress firewall are untouched.
Nothing was committed or pushed.
