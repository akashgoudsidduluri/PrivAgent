# POST-17.10 Step 7 — Destination Declaration Producer Wiring + Real E2E

**Date:** 2026-10-01
**Type:** controlled integration step.
**Steps 5 and 6 evidence is retained in this directory and is not superseded.**

> **Read this first.** The destination declaration is now wired from the user prompt through the real planner
> into the real progress tracker. The wiring is fail-closed: a destination subgoal completes on an observed
> `MATCH` and on nothing else. But the **real Chrome E2E is PARTIAL** — the agent ran the real loop in a real
> tab and the production tracker correctly *refused* to complete, because the agent never reached the catalog
> under its own planning. See `NOT_PROVEN` and `KNOWN_LIMITATION` below. Do not read this document as "the demo
> now succeeds".

---

## Artifacts

| File | Contents |
|---|---|
| [`step7_real_chrome_results.json`](./step7_real_chrome_results.json) | Real Chrome E2E capture: two production runs, production target-resolution trace, production `[AgentTrace]` subgoal lines, real observations. |
| [`step7_production_decision.json`](./step7_production_decision.json) | Production `decomposeTask` + production `GoalProgressTracker` + production `verifyDestination` executed over the real capture, plus every safety control. |
| [`step7_wiring_report.md`](./step7_wiring_report.md) | This document. |
| [`real_verification_results.json`](./real_verification_results.json), [`real_observation_step5.json`](./real_observation_step5.json), [`real_verification_results_step6.json`](./real_verification_results_step6.json), [`real_observation_step6.json`](./real_observation_step6.json), [`README.md`](./README.md) | Steps 5 and 6, retained verbatim. |

Harnesses (scratch tooling, **not** in the shipped bundle): `scratch/step7_real_chrome.mjs` (Chrome E2E),
`scratch/step7_production_decision.probe.test.ts` (production decision over the capture),
`scratch/mutation_destination_producer_wiring.mjs` (mutation probes).

---

## What was wired

```
user prompt
   └─ normalizeDestination(userPrompt)          ← user input ONLY. No observation in scope.
        └─ HighLevelGoal.destinationDeclaration  (readonly)
             └─ Subgoal.destination             (readonly, destination subgoals only)
                  └─ GoalProgressTracker.verifySubgoalCondition
                       └─ verifyDestination(observation) → MATCH / MISMATCH / UNKNOWN
                            └─ only MATCH completes the subgoal
```

Four production files changed:

| File | Change |
|---|---|
| `hierarchicalTypes.ts` | `HighLevelGoal.destinationDeclaration?`, `Subgoal.destination?`, and the new `DESTINATION_VERIFIED` condition type. |
| `taskDecomposer.ts` | Calls the normalizer **once**, from `userPrompt`, and attaches the result to the goal; attaches the destination to the ECOMMERCE NAVIGATE subgoal. |
| `goalProgressTracker.ts` | The eighth condition type. Reads only the sanitized context. |
| `destinationNormalizer.ts` / `destinationVerifier.ts` | Touched only by the mutation runners writing and restoring the originals. **No semantic change.** |

**`agentLoop.ts` was NOT modified.** It already gated completion on
`verifySubgoalCondition`, so wiring the new condition type into the tracker was sufficient. Verified unchanged
versus `b677654`.

---

## Three design properties, and how each is enforced

### 1. The destination is structurally distinct from everything else

`Subgoal.destination` is the **only** field that carries a destination, so "is this a destination subgoal" is a
type question rather than string matching. It is not `targetEntity` (already load-bearing for element identity
and `ELEMENT_EXISTS`), not `expectedValue` (read as a URL fragment, element name or affordance name by other
condition types), and not `description`.

Mutations that move the destination into any of those fields are not in the suite because the code offers no
such path; test **W1c** asserts the negative directly (`description`, `targetEntity`, `expectedValue` contain
no `LISTING`, and `expectedValue` is empty).

### 2. The declaration has exactly one source: the user's words

`normalizeDestination(userPrompt)` is called once, and every field of the resulting type is `readonly`.
`currentUrl` and `worldModel` are in scope on both sides of that call and are deliberately **not** passed to
it. Tests **W2a/b** decompose the same prompt against `LISTING`, `PRODUCT_DETAIL` and `CHECKOUT` observations
and a `worldModel`, and assert the declaration is byte-identical.

### 3. Only an observed MATCH completes it

`SubgoalObservation` has no `executionSuccess`, no `action`, no `action.url`, no `navigationDestination`, no
`previousActions` and no model output as fields — so they cannot be consulted even accidentally. The
`DESTINATION_VERIFIED` branch reads `subgoal.destination` and the sanitized `semantic_context`, and calls
`verifyDestination`. Anything other than `MATCH` returns `satisfied: false`.

---

## What is still blocked, deliberately

`b677654` left two producers unverifiable. Step 7 resolved **one** and left the other alone:

| Producer | Status |
|---|---|
| ECOMMERCE NAVIGATE "Store catalog reachable" | **Wired.** A destination claim now has destination semantics, so it gets a typed destination instead of a fabricated affordance name. |
| GENERIC LOCATE "Controls identified" | **Still blocked.** This is an EXISTENCE claim, not a destination claim; no first-class existence observation exists. It keeps the unnamed, unsatisfiable `AFFORDANCE_AVAILABLE` condition. |

The `AFFORDANCE_AVAILABLE` contract test that encoded the old "producers stay blocked" invariant was updated —
**strengthened, not weakened**: it now additionally asserts the destination producer is no longer an
`AFFORDANCE_AVAILABLE` producer at all, that the role lives in the typed field, and that affordances still
prove nothing about it. Test **8c2** was added to prove that with **no** user declaration the producer reverts
to the original fail-closed condition, so Step 7 did not buy it a completion it did not previously have.

---

## A DOCUMENTED PLANNING GAP (reported, not patched)

`classifyTaskCategory('open the store catalog at http://localhost:4174')` returns **`GENERIC_INTERACTION`** —
none of its e-commerce keywords (`buy`, `purchase`, `cart`, `product`, `price`, `order`, `amazon`, `shop`)
appear. The `GENERIC_INTERACTION` flow owns **no NAVIGATE subgoal**; its first subgoal is the existence claim
above. So for the canonical Step 5/6 prompt:

- the declaration **is** produced — `DECLARED[LISTING]` + `entryUrl http://localhost:4174/`;
- **no subgoal claims the destination**, so there is nothing that can complete it.

This is a **task-classification gap, not a broken wire.** It is recorded in tests **W0a–d** and confirmed on
the real capture. It was **not** fixed: editing task classification to make the demo succeed is exactly the
heuristic shortcut this integration is instructed to avoid, and it would re-plan unrelated tasks. Flagged for
review as a decision for you.

---

## STEP 19/20 — Real Chrome E2E

Production extension, rebuilt and loaded unpacked; real configured reasoner; no scripted proposer. Two runs in
one real Chrome session. Target tabs were provisioned by **production** `targetResolver`, not by the harness.

| | Run `canonical` | Run `ecommerce` |
|---|---|---|
| Task | `open the store catalog at http://localhost:4174` | `…and open the first product listed` |
| `classifyTaskCategory` | `GENERIC_INTERACTION` | `ECOMMERCE_SEARCH` |
| Declaration | `DECLARED[LISTING]` + `entryUrl /` | `DECLARED[LISTING]` + `entryUrl /` |
| Destination subgoal planned | **none** (W0 gap) | **`sg1`, `DESTINATION_VERIFIED`** |
| Target tab provisioned | `1393410538` → `http://localhost:4174/` | `1393410540` → `http://localhost:4174/` |
| Provider calls | 1 | 4 |
| Page the agent actually reached | `/` — `UNKNOWN @ 0.10` gen 3 | `/search.html` — `UNKNOWN @ 0.10` gen 9 |
| Real destination verdict on that page | n/a (no destination subgoal) | **NOT satisfied** |
| Production trace | M6 failed → terminal | M5 → security critic → privacy policy → safety review → `ACTION_EXECUTED + EFFECT_VERIFIED` → **`subgoal NOT completed — no observed evidence`** → `ACTION_NO_EFFECT` → recovery → M6 failed → terminal |

**The entry URL reached the target resolver in both runs** — `http://localhost:4174/`, not `/results.html` and
not anything the harness injected. The `entryUrl` was never used as a destination constraint.

### Production decision function over the real observations

Executed in Node with the **real** production `decomposeTask`, `GoalProgressTracker` and `verifyDestination`
against the real captured observations:

| Real observation | Destination subgoal |
|---|---|
| `/` — `UNKNOWN @ 0.10` gen 3 (**agent-directed**) | not satisfied |
| `/search.html` — `UNKNOWN @ 0.10` gen 9 (**agent-directed**) | **not satisfied** |
| `/results.html` — `LISTING @ 0.99` gen 11 (harness navigation) | **satisfied** |
| `/product.html` — `UNKNOWN @ 0.10` gen 13 (harness navigation) | not satisfied |

### Safety controls (all on real observations)

| Control | Result |
|---|---|
| Wrong destination — declared `CHECKOUT`, observed real `LISTING @ 0.99` | **MISMATCH** |
| Unknown destination — declared `LISTING`, observed real `UNKNOWN @ 0.10` | **UNKNOWN** |
| Exact URL — declared destination `/`, observed real `/results.html` | **MISMATCH** |
| Exact URL — declared destination `/results.html`, observed real `/results.html` | **MATCH** |
| Stale — real catalog gen 11 verified at real current gen 13 | **UNKNOWN** |
| Role — production subgoal declaration on real catalog | **MATCH** |
| Immutability — declaration before vs after verification | **unchanged** |

---

## Evidence classification

### PROVEN_REAL
- Production `targetResolver` provisioned `http://localhost:4174/` from the user's URL in both real runs. The
  entry URL is preserved end to end through production code.
- The **wired destination subgoal was selected in a real browser** and the production tracker **refused to
  complete it** — in-browser trace line:
  `[AgentTrace] subgoal NOT completed — no observed evidence`. The agent had reached `/search.html`
  (`UNKNOWN @ 0.10`), so the fail-closed behaviour is real, not asserted.
- Real production perception still yields `LISTING @ 0.99` on the fixture catalog and `UNKNOWN @ 0.10` on
  `/` and `/search.html`, at real generations 3 → 5 → 7 → 9 → 11 → 13.
- The full real action pipeline ran unchanged alongside the wiring: M5 validation, security critic, privacy
  policy, safety review, containment decision, effect verification.

### PROVEN_TEST
- **158/158** destination normalizer + verifier (unchanged by Step 7).
- **47/47** new `tests/destinationProducerWiring.test.ts`.
- **26/26** affordance contract, **85/85** planning, **158/158** security/privacy.
- **128 files / 1965 tests** full regression.
- Mutation testing, all four suites:

| Suite | Result |
|---|---|
| `mutation_destination_producer_wiring.mjs` (new, 14 mutants) | **14/14 killed**, 0 survived, 0 invalid |
| `mutation_destination_entry_url.mjs` (Step 6, 11) | **11/11 killed** |
| `mutation_destination_verifier.mjs` (Step 4/5, 12) | **12/12 killed** |
| `mutation_destination_normalizer.mjs` (Step 4/5, 15) | **14/15 killed**, 1 survived |

**Survivor, stated plainly:** `M9` — `DestinationProvenance = string`. Genuinely equivalent, unchanged from
Step 4: the type is erased at runtime and no behaviour depends on it. Not reclassified as killed.

**Honesty notes on the mutation work.** Every kill is an assertion failure; the runner reports a mutant whose
anchor no longer matches as `INVALID`, and `INVALID` is never counted as a kill (0 invalid across all four
suites). One mutant **survived the first run**: **M7** ("complete a destination subgoal from `action.url`"),
because no test ever let its predicate fire — the requested path was never a substring of the observed URL.
That is a test gap, not an equivalent mutant, so test **W4b2** was added: the browser genuinely *is* on
`/results.html?utm=1` and the action genuinely requested it, yet an `UNKNOWN` classification must not complete.
M7 was then killed legitimately. The converse is also asserted in that test so the mutant cannot be killed by
merely inverting the predicate.

### CONTROLLED_FIXTURE_PROVEN
- The production decision function returning **satisfied** on the real catalog observation. The observation is
  real; the **arrival at the catalog was a harness navigation**, not agent-directed, and is labelled as such in
  both JSON artifacts. This is *not* an end-to-end success.
- The exact-URL and staleness controls, which reuse real observations but are computed in Node.

### NOT_PROVEN
- **A destination subgoal completing inside the browser.** The real agent never navigated to `/results.html`
  under its own planning; it reached `/search.html`, then hit `ACTION_NO_EFFECT`, recovery, and an M6 failure.
  So `Real destination subgoal: NOT_REACHED` (COMPLETED was never observed in-browser).
- **Authoritative Goal Verification succeeding.** The run ended in `M6 failed → terminal progress emitted`; the
  goal verifier was never reached with a satisfied state. `NOT_REACHED`.
- **The canonical prompt reaching a destination subgoal at all** (the W0 classification gap).

### KNOWN_LIMITATION
- **The service worker exposes no read-out for the planner.** The production subgoal record is therefore read
  from the loop's own `[AgentTrace]` console output, whose structured arguments render as the string `"Object"`
  in this capture. The `subgoalId` and `category` of the refusing subgoal are not recoverable from the capture,
  so "that line is the destination subgoal" rests on it being the only completion attempt in a plan with one
  `DESTINATION_VERIFIED` subgoal.
- **`agentLoop.ts` was not modified**, so the in-browser completion path could not be observed positively
  without also fabricating a planner that navigates to the catalog. Preferring fail-closed over demo success
  was the instructed trade-off.
- Groq free tier is ≈3 requests/minute for `openai/gpt-oss-20b`; these are single short runs, not performance
  results.
- The existing prose-embedded-PII P1 was **not** touched, as instructed. It was not encountered by this
  integration.

---

## Production changes in Step 7

Changed: `hierarchicalTypes.ts`, `taskDecomposer.ts`, `goalProgressTracker.ts`.
Tests: `tests/destinationProducerWiring.test.ts` (new), `tests/affordanceAvailableContract.test.ts` (updated,
strengthened).
Scratch: `scratch/step7_real_chrome.mjs`, `scratch/step7_production_decision.probe.test.ts`,
`scratch/mutation_destination_producer_wiring.mjs`.

**Unchanged versus `b677654`:** `agentLoop`, `goalVerifier`, `targetResolver`, `containment`, `groundingEngine`,
`privacyPolicy`, `recoveryEngine`, `riskEngine`, `securityCritic`, `privacyDecision`, backend/provider,
`pageClassifier` semantics. `goalVerifier`, `targetResolver`, `pageClassifier` and the backend still carry
**pre-existing uncommitted work from earlier tasks** — their mtimes predate Step 7. No security authority was
modified. No provider egress was added: `backendAgentProvider`, `openRouterProvider`, `contextMinimizer` and
`agentLoop` contain no reference to `destinationDeclaration`, `verifyDestination` or `destinationNormalizer`
(verified in tests **W8a/b**), and `verifyDestination` performs no network call (**W8d**).

Nothing was committed or pushed.