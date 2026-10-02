# PrivAgent — FINAL POST-17.9 EVALUATION / RELEASE AUDIT

**Head:** `85e9790` · **Date:** 2026-09-29

## Release verdict

**CONDITIONAL — one P1 must be resolved before the semantic-observation work is
committed.** Everything else is sound. No P0 exists.

The P1 is **not a released vulnerability**: the affected work is uncommitted.
It is a defect that would be *introduced* by committing it as-is.

---

## 1. Architecture — SOUND

Gate order verified in production code, not inferred from docs:

```
Grounding (agentLoop.ts:1139)
  → M5 validateAction (1211)
    → Security Critic (1337)
      → Risk + semantic verification (1476)
        → confirmation gate (1558)
          → Containment (1694)
            → dispatch (1753)
              → Effect Verification (2013)
                → Goal Verification (2824)
```

**SUCCESS can only originate from current observed evidence.** Verified
specifically:

| Fabrication vector | Status |
|---|---|
| `navigationDestination` read as an observed URL | **Blocked** — documented as INTENT; GV reads `step.url` (observed tab URL) |
| `executionSuccess` as goal evidence | **Blocked** — dispatch state only |
| `previousActions` as evidence | **Blocked** |
| model claim as fact | **Blocked** — no rule reads `lastActionResult.reason` |
| stale world-model acceptance | **Blocked** — generation equality enforced |
| synthetic geometry | **Blocked** |

### Recovery — SOUND

`recoverStaleTarget` **proposes only**. The healed action re-enters
authorization: grounding is re-run at `agentLoop.ts:1226` and M5 at `:1232`.
Recovery cannot authorize itself, fabricate success, or bypass containment.

---

## 2. Security — SOUND

Every authority present, in order, on every action path. 13 focused
security/privacy files: **168 tests pass**. 8 soundness files: **114 pass**.

---

## 3. Privacy — ONE GENUINE DEFECT (P1-01)

Audited by **live serialization**, not keyword grep: synthetic PII pushed
through the real serializers and the emitted bytes inspected.

Clean: DOM detections · minimized payload · model view · `sanitizeRetainedAction`
(`type`/`select` → `valueLength`) · violation records (`{path, rule}` only) ·
agent state · provider wire for email/phone/card/password.

### P1-01 — prose-embedded PII reaches the provider via the new facts channel

**Proven end-to-end.** The literal strings `<PERSON_NAME>` and `<PAN>` appear
in `JSON.stringify(minimizeAgentContext(...).payload)` — the exact object POSTed
to the provider. Also leaking: address, account number, OTP in prose.

**Root cause.** `rawValueScanner` applies **anchored whole-value shapes**:

```
'<PAN>'              -> ['pan']
'PAN <PAN> on file'  -> []
'1234567890'              -> ['account_number']
'Account number <10-DIGITS>' -> []
```

PII embedded in prose matches no anchored shape, so the re-screen passes it.

**Why this is new.** The world model already held this text — but the world
model is **never egressed**. The post-17.9 `semantic_context.facts` channel is
the first provider-visible free-text path in the product. My earlier G5 test
proved facts are a strict subset of the world model; it did not prove that
subset is PII-free.

**Exact remediation required** (not applied — design decision, per instruction):

1. In `factExtraction.ts` `screenFact()`, apply each sensitive shape to
   **substrings** of the candidate, not the whole string.
2. Reuse the existing F-09 person-name heuristic shape on `displayText`; drop on
   match. Do not invent a new name rule.
3. Structurally reduce exposure: extract **label + adjacent value**
   (`Price: 24`) rather than the whole paragraph.
4. Add a regression test asserting no fact matches any prose-embedded PII shape
   and that the minimized payload contains none.
5. Re-run the real-reasoner PROVEN_REAL proof — it depends on this channel.

---

## 4. Observation / goal soundness — SOUND

Deterministic gate suite `post179SemanticObservation.test.ts`: **56 tests**.
Mutation history this cycle: 4 killed, 3 equivalent (masked by a sibling check),
2 compounds killed. M8 phone: **8/8 killed**, 0 invalid, 0 equivalent.

Two harness defects were found and corrected rather than scored around:
a **non-compiling mutant was being counted as "survived"** (understating the
suite), and P3/P4 survived because of a genuine **test gap** — no negative
covered a 7/8/11/12/13-digit run in phone context.

**Note:** the P1-01 remediation must not weaken the ambiguity guard or the
value-identity check that rule 2c depends on.

---

## 5. Real Chrome matrix

Graded strictly — nothing upgraded because a test passes.

| # | Case | Class | Basis |
|---|---|---|---|
| E | Multi-step local fixture | **PROVEN_REAL** | `/` → `/catalog` → `/product/alpha-widget` |
| F | Semantic answer verification | **PROVEN_REAL** | `successCameExclusivelyFromObservation: true` |
| G | DOM PII redaction | **PROVEN_REAL** | 5/16 `Protected Text`, zero raw in detections |
| H | Contextual phone detection | **PROVEN_REAL** | 5 detections via production content script |
| A–D | navigation / typing / click / scroll | PROVEN_TEST | no fresh run this pass |
| I | OCR / non-DOM | PROVEN_TEST | branch documented dormant in the loop |
| J | Injection | PROVEN_TEST | CASE 10 + `contentTrust: page-data-untrusted` |
| K | Out-of-containment | PROVEN_TEST | suite green, no fresh run |
| L | No-effect action | PROVEN_TEST | `ACTION_NO_EFFECT` documented |
| M | Recovery | PROVEN_TEST | re-enters grounding + M5 verified in code |

---

## 6. Real reasoner — PROVEN_REAL, controlled fixture

Groq `openai/gpt-oss-20b` via a fresh local backend (port 8011 — the
pre-existing backend on 8010 predated the `reasoner.py` prompt change and would
have served the old prompt).

3 provider calls, 3 actions dispatched, 2 observed effects,
`anyProviderCallCarriedSyntheticPII: false`,
`verdictInputs: {reachedProduct: true, markerObserved: true, priceObserved: true, finalGoalStatus: SUCCESS}`.

**No claim of open-web autonomous browsing.** Controlled fixture only.
Rate limiting is handled fail-closed.

---

## 7. Performance — local and provider separated

| Local stage | p50 | p95 |
|---|---|---|
| world model build (pre-existing) | 12.717 ms | 23.858 ms |
| semantic observation | 0.013 ms | 0.051 ms |
| observe → verify end-to-end | 0.079 ms | 0.168 ms |
| contextual phone rule | 0.0004 ms | 0.0009 ms |

**Provider RTT: 472 ms** (n=3) — reported **separately**, never combined.
Both post-17.9 additions are <1 ms at p95 against a 23.9 ms pre-existing stage.

---

## 8. Test / build verification

| Check | Result |
|---|---|
| Focused security/privacy (13 files) | **168 pass** |
| Soundness (8 files) | **114 pass** |
| **Full extension regression** | **122 files / 1704 tests** |
| **Backend** | **222 pass** |
| `tsc --noEmit` | clean |
| Extension build | clean (contentScript 117.09 kB) |
| Frontend build | clean |
| `git diff --check` | clean |

No assertions removed or weakened, no security test deleted, no `.skip`/`.only`,
no secrets added, no raw PII in evidence.

---

## 9. Capability classification

| Capability | Class |
|---|---|
| Semantic observation + answer verification (mechanism) | **PROVEN_REAL** |
| Contextual phone detection | **PROVEN_REAL** |
| World-model generation sync | PROVEN_TEST |
| Grounding / M5 / Critic / Risk / Containment / Effect / Recovery | PROVEN_TEST |
| Prompt-injection defence | PROVEN_TEST |
| Privacy fusion / minimization / egress | PROVEN_TEST |
| **Prose-embedded PII → provider** | **P1 DEFECT** |
| Open-web autonomous browsing | NOT_PROVEN |
| Authenticated sites / cross-origin iframes | NOT_PROVEN |
| OCR autonomous reasoning | KNOWN_LIMITATION |
| US bare 2–5-leading phone recall | KNOWN_LIMITATION (deliberate) |
| `actionValidator` [6-9] | KNOWN_LIMITATION (by design) |
| Provider rate limits / latency | KNOWN_LIMITATION |

---

## 10. Recommendation

1. **Resolve P1-01 before committing the semantic-observation work.** The
   uncommitted tree is currently the only place this exposure exists.
2. `actionValidator` and the OCR path: leave alone. Both are separate design
   questions and neither is established as necessary by current evidence.
3. After remediation, re-run the real-reasoner proof — the multi-step result
   depends on the facts channel being both useful and safe.
4. No other scope expansion is warranted by this audit.

**Nothing committed or pushed during this audit.** Push performed at the user's
request covered only the already-committed M8 work (`4a132f2..85e9790`).
