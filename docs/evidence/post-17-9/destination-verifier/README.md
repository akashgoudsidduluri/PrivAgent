# POST-17.10 — Destination Verification

**Step 5** — real Chrome destination verification proof (2026-09-30).
**Step 6** — destination declaration semantics audit + entry-URL/destination-URL separation (2026-10-01).

**Commit under test:** `b677654` (affordance-verification remediation, already pushed) + uncommitted Step 4/5/6 destination work.

> **Read this first, for both steps.** The destination verifier is **not wired into the extension bundle**.
> Producers (`taskDecomposer`, `goalProgressTracker`) remain deliberately unwired from Step 4 onward. In both
> steps the *observation* is real Chrome output from the shipped, unpacked-loaded extension, and the *verdict*
> is produced by the real production `verifyDestination()` executed in Node against that captured observation.
> The observation is real; the **call site is not yet production**. This caveat is load-bearing.

---

# STEP 6 — Entry URL vs Destination URL

**Type:** contract-semantics step. Two production files changed; **no** security authority, provider, backend,
producer or target-resolution behaviour changed.

## The problem Step 5 exposed

Step 5 proved the role channel matched a real `LISTING @ 0.99` observation but that the **combined** verdict
was `MISMATCH`, because the user URL `http://localhost:4174` (path `/`) had been recorded as the
**destination URL** while the real catalog is `/results.html`.

That `MISMATCH` was **correct**. `/` is not the page the user asked to reach. The defect was upstream of the
verifier: the user's sentence

```
open the store catalog at http://localhost:4174
```

contains two different things, and the normalizer collapsed them into one field:

| Concept | Value in this sentence |
|---|---|
| **Entry / target site** — where the browser should start | `http://localhost:4174` |
| **Destination** — the state/page the task intends to reach | `store catalog` → `LISTING` |

The fix was **not** to make `/` match `/results.html`. Exact URL verification is unchanged and still
strict. The fix was to represent what the user's URL actually means.

## The contract

```ts
DestinationDeclaration = {
  kind: 'DECLARED',
  role?:     ExplicitPageRole,   // semantic destination constraint  -> verifier
  url?:      NormalizedUrl,      // EXPLICIT destination URL         -> verifier
  entryUrl?: NormalizedUrl,      // entry/target site               -> NOT a verifier constraint
}
```

`entryUrl` provenance is `USER_ENTRY_SITE`; an explicit destination URL keeps provenance `USER_URL`. The
two are distinct fields with distinct meanings; neither is overloaded onto the other.

### Which branch does a user URL take?

Decided **exclusively from the user's own grammar**, never from browser state, DOM, page type, model output,
action intent or task category:

| User sentence | Result |
|---|---|
| `open the store catalog at http://localhost:4174` | `role = LISTING`, `entryUrl = /`, **no** destination URL |
| `open http://localhost:4174/results.html` | `url = /results.html` (explicit destination) |
| `open the store catalog at http://localhost:4174, then check the cart` | `role = LISTING`, `entryUrl = /` — punctuation trimmed, first URL only |

## STEP 3 — the observation can never rewrite the declaration

This is the anti-laundering invariant, asserted in both a unit test and against the real capture. Seeing
`/results.html` in the browser **must not** promote `entryUrl = /` into `url = /results.html`.

```ts
USER:     entryUrl = /        destinationRole = LISTING
BROWSER:  /results.html       LISTING @ 0.99
VERIFIER: role MATCH          declaration untouched
```

Verified on the real capture: `declarationBefore` deep-equals `declarationAfter` after verification
(`unchanged: true`), and `destinationUrlStillAbsent: true`. Mutation **M5** re-injects exactly this rewrite
and is killed by 15 tests.

## STEP 7 — target provisioning needed no adapter

Read-only audit confirmed the entry URL already reaches provisioning on an **independent** path:

- `extractTaskSite` / `extractTargetSite` (`extension/src/agent/goalParser.ts`) — for opening the tab.
- `parseTaskTargetReference` (`extension/src/background/targetResolver.ts`) — for target resolution.

Neither consults the destination declaration, and `targetResolver.ts` was **not modified**. The separation is
therefore structural, not enforced by an adapter:

```
USER PROMPT ──┬── entry site ──> targetResolver ──> open / navigate
              └── destination declaration ──> destinationVerifier ──> MATCH / MISMATCH / UNKNOWN
```

## The real Step 6 declaration and the real combined verdict

Fresh real Chrome capture (new session, new tab), production normalizer, production verifier:

```json
DECLARATION (real normalizeDestination output)
{
  "kind": "DECLARED",
  "role":     { "provenance": "EXPLICIT_PAGE_ROLE", "acceptablePageTypes": ["LISTING"] },
  "entryUrl": { "provenance": "USER_ENTRY_SITE",
                "origin": "http://localhost:4174", "path": "/",
                "rawUrl": "http://localhost:4174" }
}
                                       ← no "url" field: no destination URL was declared

OBSERVATION (real Chrome tab 428613125)
  url    : http://localhost:4174/results.html
  pageType: LISTING      confidence: 0.99      pageGeneration: 5

COMBINED VERIFIER RESULT
  MATCH — "Observed page identity LISTING at confidence 0.99 is one of the declared roles [LISTING]."
```

This is a legitimate combined `MATCH`: the only declared constraint is the role, and the role genuinely
matched a real observation. **No URL constraint was added, removed, relaxed or bypassed to get here.**

### The Step 5 rejection is preserved, not erased

The exact Step 5 verdict is re-asserted on the **same real observation** in the Step 6 run, by deliberately
using the entry URL *as* a destination URL:

```
REGRESSION CHECK (conflated contract, same real observation)
  MISMATCH — "Observed URL http://localhost:4174/results.html differs from the
              declared destination http://localhost:4174/."
```

Exact URL comparison is therefore demonstrably still strict: the separation did **not** weaken it.

## Step 6 real-verification matrix

All rows use the real production normalizer and verifier against the real Step 6 capture.

| Case | Declaration | Real observation | Verdict |
|---|---|---|---|
| obs1 combined | `LISTING` + `entryUrl /` | `UNKNOWN` 0.10 gen 3 | **UNKNOWN** |
| obs2 **combined** | `LISTING` + `entryUrl /` | `LISTING` 0.99 gen 5 | **MATCH** |
| conflated regression | `LISTING` + url `/` | `LISTING` 0.99 gen 5 | **MISMATCH** |
| immutability | `LISTING` + `entryUrl /` | `LISTING` 0.99 gen 5 | declaration byte-identical after verify |
| negative control | `DECLARED[CHECKOUT]` | `LISTING` 0.99 gen 5 | **MISMATCH** |
| explicit destination | url `/results.html` | real `LISTING` 0.99 gen 5 | **MATCH** |
| explicit destination | url `/results.html` | real `UNKNOWN` 0.10 gen 7 | **MISMATCH** |
| absence control | `LISTING` + `entryUrl /` | real `UNKNOWN` 0.10 gen 3 | **UNKNOWN** |
| staleness control | `LISTING` + `entryUrl /` | obs2 (gen 5) at current gen 7 | **UNKNOWN** |

## Artifacts

| File | Contents |
|---|---|
| [`real_verification_results_step6.json`](./real_verification_results_step6.json) | **Step 6 (current).** Real verdicts from the real normalizer + real verifier over the fresh Step 6 capture, the immutability proof, the conflated-contract regression check, and the call-boundary audit. |
| [`real_observation_step6.json`](./real_observation_step6.json) | Step 6 real Chrome capture — target tab `428613125`, three real observations at generations 3 / 5 / 7. |
| [`real_verification_results.json`](./real_verification_results.json) | **Step 5 (historical, retained verbatim).** The combined `MISMATCH` and the role-only `MATCH`. |
| [`real_observation_step5.json`](./real_observation_step5.json) | Step 5 capture archive, copied verbatim out of the untouched Step 5 results file. |

Harnesses (scratch tooling, **not** part of the shipped bundle):
`scratch/destination_real_chrome.mjs` (Chrome capture),
`scratch/destination_verify_step6_real.probe.test.ts` (Step 6 real verification),
`scratch/destination_verify_real.probe.test.ts` (Step 5 real verification).

## Environment (both steps)

| | |
|---|---|
| Chrome | `153.0.8010.12` (real Chromium, CDP-driven) |
| Extension | loaded unpacked from `dist/` — production build, `npm run build:extension` |
| Fixture | `http://localhost:4174` — `demo/shopping-fixture` (`/`, `/search.html`, `/results.html`, `/product.html`) |
| Dashboard | `http://localhost:5173` |
| Backend | `http://localhost:8010` (`/api/v1/health` → reasoner Groq) |
| Task issued verbatim | `open the store catalog at http://localhost:4174` |

Target tab was provisioned by production code (`TARGET_RESOLUTION_STARTED` → `CANDIDATES(2)` →
`PROVISIONED` → `READY` → containment established → `SELECTED`), i.e. the tab was **not** opened by the harness.

## Call boundary and privacy (Step 6, measured on the real run)

```
observationKeys       : [pageGeneration, semantic, url]
semanticKeys          : [confidence, pageGeneration, pageType]
declarationKeys       : [entryUrl, kind, role]
carriesForbiddenField : []
roleIsMetadataOnly    : true
verdictCarriesPageText: false
```

`action.url`, `executionSuccess`, `previousActions`, `navigationDestination`, model output, planned
destination, page text, entity labels and affordance descriptions remain **structurally unreachable**: the
`DestinationObservation` type still admits only `url`, `pageGeneration` and
`semantic{pageType, confidence, pageGeneration}`. No field was added for testing. The declaration is
metadata only (`LISTING` + a normalized URL); `verifyDestination()` is a pure local function and adds **no**
provider egress. No raw input values, page text, DOM content, model output or PII appears in any artifact.

## Test and mutation results

| Suite | Result |
|---|---|
| `tests/destinationNormalizer.test.ts` | **95/95** (was 86 — +9 for the entry/destination grammar) |
| `tests/destinationVerifier.test.ts` | **63/63** (was 49 — +14 for the entryUrl-is-not-a-constraint invariant) |
| **Focused combined** | **158/158** |
| `scratch/mutation_destination_entry_url.mjs` (Step 6, new) | **11/11 killed**, 0 survived, 0 invalid |
| `scratch/mutation_destination_verifier.mjs` (Step 4/5) | **12/12 killed** |
| `scratch/mutation_destination_normalizer.mjs` (Step 4/5) | **14/15 killed**, 1 survived |
| Full regression | **127 files / 1917 tests** |
| `npx tsc --noEmit` | PASS |
| `npm run build:extension` | PASS |
| `npm run build:frontend` | PASS |
| `git diff --check` | PASS |

No assertion was removed or weakened. Two Step 4 tests that encoded the old conflated contract were
**strengthened**, not relaxed: they now additionally assert that no destination URL was emitted.

### The Step 6 mutation suite, mapped to the nine required categories

| # | Category | Killed by |
|---|---|---|
| M1 | treat `entryUrl` as `destinationUrl` (re-conflate) | 12 failed |
| M2 | discard `entryUrl` | 9 failed |
| M3 | observed URL overwrites the declaration (**evidence laundering**) | 15 failed |
| M4 | make `/` match any path — the exact Step 5 failure | 3 failed |
| M5 | ignore the explicit destination URL channel | 18 failed |
| M6 | fall back to `entryUrl` when there is no `destinationUrl` | 5 failed |
| M7 | ignore the page-role constraint | 19 failed |
| M8 | bypass the stale-observation refusal | 1 failed |
| M9 | turn an `UNKNOWN` channel into a `MATCH` | 17 failed |
| M10 | swallow trailing punctuation, losing the URL on a real sentence | 1 failed |
| M11 | strip only the first URL, letting a later URL pollute the noun slot | 1 failed |

Every kill is an assertion failure, not a syntax error — the runner reports a mutant whose anchor no longer
matches as `INVALID`, and `INVALID` is never counted as a kill. (The Step 6 suite reported 0 invalid.)

**The one surviving mutant is M9 in the Step 4 normalizer suite**, unchanged from Step 4 and reported as such:
`DestinationProvenance = string` is an equivalent mutant — the type is erased at runtime and no behaviour
depends on it. It was not reclassified as killed.

## A pre-existing defect found and fixed in Step 6

While building the Case-A test matrix I found the normalizer's URL regex swallowed trailing sentence
punctuation (`http://localhost:4174,`), so `new URL()` rejected the port, the URL channel was lost
**entirely**, and only the *first* URL was stripped from the token stream — letting a later URL's tokens leak
into the noun slot and produce a spurious `UNSUPPORTED` declaration on ordinary punctuated sentences. Both
are fixed (trailing-punctuation trim + global URL strip). This is a genuine defect fix in the normalizer, not
a loosening: mutations M10 and M11 re-break it and are killed.

## Production changes

### Step 5
**NONE.** No file under `extension/`, `backend/`, or any security authority was modified.
`pageClassifier.ts` was touched only in Step 4, to export the already-hardcoded `0.50` floor as
`MIN_PAGE_CLASSIFICATION_CONFIDENCE` — behaviour-neutral, so the verifier and the classifier share one threshold.

### Step 6
- `extension/src/planning/destinationNormalizer.ts` — `entryUrl` field with `USER_ENTRY_SITE` provenance;
  punctuation trim; global URL strip.
- `extension/src/planning/destinationVerifier.ts` — `entryUrl` is not a destination constraint; it is
  excluded from the declared-constraint list. MATCH/MISMATCH/UNKNOWN semantics, the confidence floor, the
  exact URL comparison and the page-generation freshness check are all **unchanged**.

Verified unchanged versus `b677654`: `taskDecomposer`, `goalProgressTracker`, `agentLoop`, `containment`,
`groundingEngine`, `privacyPolicy`, `recoveryEngine`, `riskEngine`, `securityCritic`, `privacyDecision`.
`goalParser.ts`, `goalVerifier.ts`, `targetResolver.ts`, the privacy modules and the backend still carry
**pre-existing uncommitted work from earlier tasks** — their mtimes predate Step 6 and Step 6 did not touch
them. Producer wiring remains **NOT DONE** and forbidden until this evidence is reviewed.

---

# STEP 5 — Real Chrome Destination Verification Proof (historical, retained)

**Date:** 2026-09-30. **Type:** integration / evidence step. **No production code was changed in Step 5.**

## STEP 2 / STEP 3 — What the real classifier actually produced

Three real observations, captured from the production perception → semantic-understanding path (tab `726604639`):

| # | Label | Observed URL | `pageType` | confidence | `pageGeneration` |
|---|---|---|---|---|---|
| obs1 | `agent-reached-page` | `http://localhost:4174/` | `UNKNOWN` | `0.10` | `3` |
| obs2 | `catalog-results-html` | `http://localhost:4174/results.html` | **`LISTING`** | **`0.99`** | `5` |
| obs3 | `product-html` | `http://localhost:4174/product.html` | `UNKNOWN` | `0.10` | `7` |

**The real classifier genuinely produces `LISTING @ 0.99` on the fixture catalog.** This was discovered, not
forced: the classifier emits it structurally — *"Multiple repeatable item cards detected (count: 4)"*. The
confidence floor was **not** lowered, no fallback was invented, and `pageClassifier.ts` was not modified in
Step 5. No `PRODUCT` semantic page type exists and none was created.

Page generation genuinely increments across documents (3 → 5 → 7), which is what makes the staleness control
real rather than synthetic.

## The Step 5 declaration — the conflated contract, and why its MISMATCH was correct

```json
{
  "kind": "DECLARED",
  "role": { "provenance": "EXPLICIT_PAGE_ROLE", "acceptablePageTypes": ["LISTING"] },
  "url":  { "provenance": "USER_URL", "origin": "http://localhost:4174", "path": "/", "rawUrl": "http://localhost:4174" }
}
```

Because `/` was recorded as the **destination URL**, and the real catalog is `/results.html`, the honest
combined verdict was **MISMATCH**. That was correct behaviour — the URL channel compares exactly and refuses
to be slack, which is precisely the property under test. The role channel independently returned `MATCH` on
the same real observation.

**Step 6 did not weaken this rejection — it fixed the declaration that caused it.** The conflated verdict is
re-asserted above on the same real observation and still returns `MISMATCH`.

## Step 5 verdicts (historical)

| Case | Declaration | Real observation | Verdict |
|---|---|---|---|
| obs1 combined | `DECLARED[LISTING]` + url `/` | `UNKNOWN` 0.10 gen 3 | **UNKNOWN** |
| obs2 combined | `DECLARED[LISTING]` + url `/` | `LISTING` 0.99 gen 5 | **MISMATCH** |
| obs2 role channel only | `DECLARED[LISTING]` | `LISTING` 0.99 gen 5 | **MATCH** |
| negative control | `DECLARED[CHECKOUT]` | `LISTING` 0.99 gen 5 | **MISMATCH** |
| negative control | `DECLARED[LISTING]` | real `UNKNOWN` landing gen 3 | **UNKNOWN** |
| staleness control | `DECLARED[LISTING]` | obs2 (gen 5) at current gen 7 | **UNKNOWN** |

## Evidence classification — Step 5 (historical)

### PROVEN_REAL
- A real Chrome tab, driven by the production extension, genuinely classifies the fixture catalog as
  `LISTING @ 0.99`.
- The real `verifyDestination()` returned **MATCH** on that real observation for a real `DECLARED[LISTING]`
  declaration, on the **role channel**.
- The real **URL** channel returned MISMATCH against a genuinely differing observed URL — proof the URL
  channel is not slack.
- Real cross-document staleness (gen 5 vs gen 7, both captured live) returned UNKNOWN.

### PROVEN_TEST
- Normalizer grammar 86 tests; verifier contract 49 tests; combined **135/135**.
- Verifier mutation testing **12/12 killed**. M1 was rewritten after an initial kill that was really only a
  syntax error; M11 initially survived and was killed only after adding a test asserting verdict
  *attribution*. Both are recorded as such.

### NOT_PROVEN (Step 5)
- **A combined-channel `MATCH` on the real catalog** — *now PROVEN_REAL under the Step 6 contract.*
- **The verifier running inside the browser at decision time** — still not wired; see KNOWN_LIMITATION.
- **The agent actually reaching the catalog under its own planning.** Only 1 provider call completed in the
  capture; obs2 was reached by harness navigation, not by a planner-chosen subgoal.
- **Full agent-run progress envelope** was `null` in the capture, and service-worker console args rendered as
  the string `"Object"` rather than key/value pairs, so per-step progress detail is missing.

---

## KNOWN_LIMITATION (both steps)
- **The verifier is not in the bundle.** Producers are intentionally unwired, so `verifyDestination()` was
  executed in Node against the real captured observation. The observation is real; the call site is not yet
  production. This is a consequence of the "producers remain unwired" scope, not a fabrication — but it means
  **the destination system is still not working end to end**, even after Step 6's combined real `MATCH`.
- **The entry URL is not yet consumed by a producer.** Step 6 established that `targetResolver` already
  provisions it on an independent path, so no adapter was needed — but no producer currently *reads* the
  destination declaration at all. The contract is proven; the wiring is not written.
- Groq free tier is ≈3 requests/minute for `openai/gpt-oss-20b`; the captures are single short runs and are
  not statistical performance results.