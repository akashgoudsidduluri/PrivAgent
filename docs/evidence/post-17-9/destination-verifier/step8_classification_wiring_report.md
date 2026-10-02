# POST-17.10 Step 8 — Task Classification → Destination Subgoal Gap

**Date:** 2026-10-01
**Type:** classification / decomposition boundary fix.
**Steps 5, 6 and 7 evidence in this directory is retained and not superseded.**

> **Read this first.** The canonical prompt now plans a destination subgoal. But the real agent still never
> reached the catalog, so **full agent-directed E2E remains NOT_PROVEN**. Planning integration and subgoal
> selection are `PROVEN_REAL`; arrival is not. Do not read this as "the demo succeeds".
>
> **Also read `HONESTY INCIDENT` below.** During this step a mutation runner was killed by a harness timeout
> and left a *mutant* committed to production source. It was detected and reverted. That incident, and the
> fix that prevents recurrence, are part of this evidence.

---

## The gap, and the audit that found it

`classifyTaskCategory` is a lexical keyword matcher. `"open the store catalog at <url>"` contains none of its
e-commerce keywords (`buy`, `purchase`, `cart`, `product`, `price`, `order`, `amazon`, `shop`), so it
classified `GENERIC_INTERACTION`.

Step 7 attached the typed declaration to `HighLevelGoal` and to a subgoal — but the audit found it was
**consumed in exactly one place**, the `ECOMMERCE_SEARCH` branch. `INFORMATION_RETRIEVAL`, `FORM_FILL`,
`AUTHENTICATION` and `GENERIC_INTERACTION` each silently discarded it. So an unambiguous typed destination
died at the branch switch:

```
"open the store catalog at http://localhost:4174"
   → DECLARED{ role: LISTING, entryUrl: / }
   → category GENERIC_INTERACTION
   → branch that never reads `declaredDestination`
   → NO destination subgoal
```

## The fix, and the fix that was deliberately NOT made

| | |
|---|---|
| **NOT done** | Add `"catalog"`/`"store"` to the e-commerce keyword list, or rewrite the category to `ECOMMERCE_SEARCH`. That changes **global** classification semantics on a guess, and would mis-file unrelated prompts that merely contain the word. |
| **Done** | The typed declaration is now a **second planning input** alongside the lexical category. It gates a destination subgoal in every branch that does not already produce one. `classifyTaskCategory` is **untouched**; the category still governs everything else. |

One production file changed: **`taskDecomposer.ts`**. `hierarchicalTypes.ts`, `destinationNormalizer.ts`,
`destinationVerifier.ts` and `goalProgressTracker.ts` have **no** Step 8 semantic change. `agentLoop.ts` is
unchanged.

```ts
const addDestinationSubgoal = (): string => {
  if (!declaredDestination) return '';            // ← the gate is the DECLARATION, never the category
  return addSubgoal('NAVIGATE', 'Reach the destination declared in the user request',
    'navigate', [], { type: 'DESTINATION_VERIFIED', ... }, undefined, declaredDestination);
};
```

### Resulting plan for the canonical prompt

```
category: GENERIC_INTERACTION          ← deliberately unchanged

sg1  NAVIGATE  DESTINATION_VERIFIED  READY    carries destination {LISTING, entryUrl /}
sg2  LOCATE    AFFORDANCE_AVAILABLE   PENDING  ← "Controls identified", still BLOCKED, now depends on sg1
sg3  SELECT    STATE_CHANGED          PENDING
sg4  VERIFY    STATE_CHANGED          PENDING
```

`FORM_FILL` and `AUTHENTICATION` gained the same gated subgoal; `ECOMMERCE_SEARCH` is untouched because it
already builds its own.

---

## What is still blocked, deliberately

`b677654` left two producers unverifiable. Step 8 changed **neither**:

| Producer | Status |
|---|---|
| GENERIC LOCATE `"Controls identified"` | **Still blocked.** Existence claim, not a destination claim. Unnamed `AFFORDANCE_AVAILABLE`, cannot be satisfied, now depends on the destination subgoal. |
| ECOMMERCE NAVIGATE `"Store catalog reachable"` | Only used when there is **no** declaration, in which case it reverts to the original unsatisfiable condition (test `8c2`). |

The destination subgoal is structurally typed `DESTINATION_VERIFIED`. Mutation **M13** swaps it back to
`AFFORDANCE_AVAILABLE` and is killed by 10 tests.

---

## STEP 10 test matrix

`tests/classificationDestinationGap.test.ts` — **40/40**.

| | Prompt | Expected | Result |
|---|---|---|---|
| W1 | `open the store catalog at <url>` | `GENERIC_INTERACTION` + `LISTING` + `entryUrl` + destination subgoal | ✅ |
| W2 | `click the submit button` | `NONE`, no destination subgoal | ✅ |
| W3 | `type hello into the search box` | `NONE`, no destination subgoal | ✅ |
| W4 | `open the checkout page at <url>` | `CHECKOUT`, destination subgoal, **without** e-commerce keywords | ✅ |
| W5 | `open the contact form at <url>` | `FORM`, destination subgoal — and this lands in the **FORM_FILL** branch, proving the fix is not branch-specific | ✅ |
| W6 | `open the widget` | `UNSUPPORTED`, no subgoal | ✅ |
| W7 | `open the results` | `AMBIGUOUS`, no subgoal, never resolved to LISTING | ✅ |
| W8 | ten prompts across all flows | never >1 destination subgoal, never >1 NAVIGATE, prerequisites resolve | ✅ |
| W9 | affordance-rich pages | no destination subgoal created, never a completion | ✅ |
| W10 | `LISTING` observed with `NONE` declared | planner invents nothing | ✅ |

### The negative half matters most

Most of the file exists to prove the fix does not spill. Eight undeclared generic prompts are asserted to gain
**no** destination subgoal, **no** NAVIGATE subgoal, and to keep failing closed. Mutations **M2** ("create one
whenever the category is `GENERIC_INTERACTION`") and **M3** ("…whenever `ECOMMERCE`") are both killed —
those are exactly the wrong fixes, and they are now provably wrong.

### Two of my test premises were wrong, and were corrected against reality

- `'type hello into the search box'` classifies as `INFORMATION_RETRIEVAL` (the word "search"), not
  `GENERIC_INTERACTION`. Pre-existing behaviour; the assertion now records it and asserts the property that
  actually matters — no destination subgoal either way.
- With a URL present, an unmapped or ambiguous head falls through to *"the URL is itself the destination"*
  (the Step 6 contract), so `open the first product at <url>` is `DECLARED` with `url: /`, **not**
  `UNSUPPORTED`. W6/W7 were restated without a URL to isolate the role channel, and **W6c** now additionally
  proves that prompt declares a destination URL and *never* a `PRODUCT` role.

---

## HONESTY INCIDENT — a mutation runner corrupted production source

Partway through this step, a harness timeout (180s) killed
`scratch/mutation_destination_producer_wiring.mjs` **between a mutant edit and its restore**. The mutant was
left written to `extension/src/hierarchicalPlanning/goalProgressTracker.ts`:

```ts
result.kind === 'MATCH' || result.kind === 'MISMATCH',   // ← MUTANT, on disk
```

That is a real shipped bug: it would have accepted `MISMATCH` as destination completion. It was caught
because the *next* mutation suite reported three `INVALID` anchors — the corrupted line no longer matched.
Restored immediately, verified by `tsc` and by 178 focused tests, and all numbers in this report are from
**after** the restore.

**Root cause:** the runner only restored on its normal path. **Fix applied:** the runner now restores on
`SIGINT`, `SIGTERM`, `SIGHUP`, `SIGQUIT`, `exit` and `uncaughtException`, and `INVALID` is reported distinctly
so an interrupted run can never be mistaken for a clean one.

**Recorded rather than hidden** because the detection was accidental, not designed: the safety net that caught
it was an unrelated suite's anchor mismatch.

---

## STEP 11 — Mutation testing

`scratch/mutation_classification_destination_gap.mjs` — **14/14 killed, 0 survived, 0 invalid.**

| | Mutant | Killed by |
|---|---|---|
| M1 | plan a destination subgoal with **no** declaration | 4 failed |
| M2 | create one whenever category is `GENERIC_INTERACTION` | 4 failed |
| M3 | create one whenever category is `ECOMMERCE` | 4 failed |
| M4 | carry the destination in `targetEntity` | 13 failed |
| M5 | satisfy from affordance existence | 25 failed |
| M6 | create the destination from the observed page type | 34 failed |
| M7 | create the destination from a requested `action.url` | 2 failed |
| M8 | duplicate the destination subgoal | 10 failed |
| M9 | resolve `AMBIGUOUS` into `LISTING` | 4 failed |
| M10 | turn `UNSUPPORTED` into a destination subgoal | 2 failed |
| M11 | derive the declaration from the observed `currentUrl` | 15 failed |
| M12 | a planned destination subgoal marks the task `COMPLETED` | 2 failed |
| M13 | use `AFFORDANCE_AVAILABLE` instead of `DESTINATION_VERIFIED` | 10 failed |
| M14 | let a destination MATCH set the goal status | 1 failed |

**Two survivors on the first run, both handled honestly — neither was counted as a kill:**

- **M11 (original)** read a `modelDestination` option that does not exist, so its branch never fired. That is a
  **test gap**, not an equivalent mutant. Replaced with a mutant that genuinely fires — deriving the
  declaration from the observed `currentUrl` — and a real test gap was closed
  (`the declaration is a function of the prompt alone`).
- **M12 (original)** only appended `"Task SUCCESS asserted."` to a **log string**. It changed a message, not
  behaviour, so it was a badly-designed mutant rather than an equivalent one. Replaced with two that
  genuinely violate the invariant: setting `highLevelGoal.status = 'COMPLETED'`, and writing a goal status on
  `MATCH`. Both die.

Every kill is an assertion failure; compile errors and unmatched anchors are reported `INVALID` and are never
counted.

### All suites

| Suite | Result |
|---|---|
| `mutation_classification_destination_gap.mjs` (new) | **14/14** |
| `mutation_destination_producer_wiring.mjs` | **14/14** |
| `mutation_destination_entry_url.mjs` | **11/11** |
| `mutation_destination_verifier.mjs` | **12/12** |
| `mutation_destination_normalizer.mjs` | **14/15**, 1 survived |
| **Total** | **65/66** |

**Survivor:** `M9` — `DestinationProvenance = string`. Genuinely equivalent, unchanged since Step 4: the type
is erased at runtime and no behaviour depends on it. Not reclassified as killed.

---

## STEP 12/13/14 — Real Chrome

Production extension, rebuilt and loaded unpacked; real configured reasoner; no scripted proposer; no
injected subgoal or declaration.

**Task:** `open the store catalog at http://localhost:4174`
**Category:** `GENERIC_INTERACTION` — unchanged
**Declaration:** `DECLARED{ role: [LISTING], entryUrl: http://localhost:4174/ }`
**Target tab `717701666` provisioned by production `targetResolver` at `http://localhost:4174/`**

Real production trace:

```
subgoal selected → requesting reasoning → action validated by M5 → security critic
→ privacy policy → safety review → executeAction
→ ACTION_EXECUTED + EFFECT_VERIFIED
→ subgoal NOT completed — no observed evidence          ← the destination subgoal, refusing
→ POST_NAVIGATION_SETTLE / URL_VERIFY / CONTENT_SCRIPT_READY
→ M6 next step → … → M6 failed → terminal progress emitted
```

**A. Planning proof — `PROVEN_REAL`.** The destination subgoal was **SELECTED** by the real planner in a real
tab (it is the only `READY` subgoal in the plan, since `LOCATE` now depends on it), a real action executed,
and the real tracker refused to complete it. 4 provider calls.

**B. Destination verification proof — unchanged `PROVEN_REAL` from Step 6.** Not re-run, not downgraded.

**C. Full agent-directed arrival — `NOT_PROVEN`.** The agent navigated to `/search.html`
(`UNKNOWN @ 0.10`, generation 9), not to `/results.html`. It never reached the catalog, so **no in-browser
destination `MATCH` exists**. `Real Chrome destination subgoal: NOT_REACHED` for completion, `SELECTED` for
selection.

An earlier run of the same prompt failed at the first provider call (`M6 failed`, 1 call). Per STEP 14 that is
recorded as a **provider failure, not a planning defect** — nothing was bypassed, no scripted action added,
no retry loop, no privacy or security logic touched.

### Production decision over the real observations

| Real observation | Destination subgoal |
|---|---|
| `/search.html` — `UNKNOWN @ 0.10` gen 9 (**agent-directed**) | **not satisfied** |
| `/results.html` — `LISTING @ 0.99` gen 11 (harness navigation) | **satisfied** |
| `/product.html` — `UNKNOWN @ 0.10` gen 13 (harness navigation) | not satisfied |

### Controls on real observations

| Control | Result |
|---|---|
| Wrong destination — declared `CHECKOUT`, real `LISTING @ 0.99` | **MISMATCH** |
| Unknown destination — declared `LISTING`, real agent-reached page | **UNKNOWN** |
| Exact URL — declared destination `/`, real `/results.html` | **MISMATCH** |
| Stale — real catalog gen 11 at real current gen 13 | **UNKNOWN** |
| Production declaration on the real catalog | **MATCH** |
| Immutability | **unchanged** |
| Entry URL is not a destination constraint | `url: absent`, `entryUrl: present` — and the role still matched `/results.html` |

---

## Evidence classification

### PROVEN_REAL
- Production `targetResolver` provisioned `http://localhost:4174/` from the user's URL.
- The planner **selected** the newly-created destination subgoal in a real browser.
- The production tracker **refused to complete** it on the page the agent actually reached, in-browser:
  `subgoal NOT completed — no observed evidence`. Fail-closed is real, not asserted.
- The full real action pipeline ran unchanged alongside the fix: M5, security critic, privacy policy, safety
  review, containment, effect verification.
- Real perception still yields `LISTING @ 0.99` on `/results.html` and `UNKNOWN @ 0.10` on `/` and
  `/search.html`.

### PROVEN_TEST
- 247/247 focused destination + planning; 85/85 goal-progress, decomposer and planning; 158/158
  security/privacy; **129 files / 2007 tests** full regression; `tsc`, both builds and `git diff --check` PASS.
- Mutation testing: **65/66 killed**, 1 genuinely equivalent survivor, 0 invalid.

### CONTROLLED_FIXTURE_PROVEN
- The production decision returning *satisfied* on the real catalog observation. The observation is real; the
  **arrival was a harness navigation** (`agentDirected: false` in the JSON), not agent-directed. This is not
  end-to-end success.

### NOT_PROVEN
- **Full agent-directed E2E.** The real agent never reached `/results.html`; no in-browser destination `MATCH`,
  no in-browser `COMPLETED`.
- **Authoritative Goal Verification succeeding.** Runs ended in `M6 failed → terminal progress emitted`.

### KNOWN_LIMITATION
- The service worker exposes no read-out for the planner; the production subgoal record is read from the
  loop's `[AgentTrace]` console output, whose structured arguments render as `"Object"`. That the refusing
  line is the *destination* subgoal rests on it being the only completion attempt in a plan with exactly one
  `DESTINATION_VERIFIED` subgoal.
- **The agent's own navigation heuristics are the remaining blocker**, not the classification gap. It chose
  `/search.html` over the catalog. Fixing that is planner/reasoner behaviour, outside this step's scope and
  explicitly not to be forced.
- Groq free tier ≈3 requests/minute; one run failed on its first provider call.
- The prose-embedded-PII P1 was not touched, as instructed, and was not encountered.

---

## Artifacts

| File | Contents |
|---|---|
| [`step8_classification_wiring_report.md`](./step8_classification_wiring_report.md) | This document. |
| [`step8_real_chrome_results.json`](./step8_real_chrome_results.json) | Real Chrome E2E capture: production trace, real observations. |
| [`step8_planning_results.json`](./step8_planning_results.json) | Production decomposer + tracker over that capture, plus every control. |
| `step7_*`, `real_verification_results*.json`, `real_observation_step*.json`, `README.md` | Steps 5–7, retained verbatim. |

Harnesses (scratch, not in the bundle): `scratch/step8_real_chrome.mjs`,
`scratch/step8_planning.probe.test.ts`, `scratch/mutation_classification_destination_gap.mjs`.

**Security authorities unchanged versus `b677654`:** `containment`, `groundingEngine`, `privacyPolicy`,
`recoveryEngine`, `riskEngine`, `securityCritic`, `privacyDecision`, `agentLoop`. No provider egress was
added — `destinationDeclaration`, `verifyDestination` and `destinationNormalizer` appear in **no**
payload-construction path. `goalVerifier`, `targetResolver`, the privacy modules and the backend still carry
**pre-existing uncommitted work from earlier tasks**, untouched here.

Nothing was committed or pushed.