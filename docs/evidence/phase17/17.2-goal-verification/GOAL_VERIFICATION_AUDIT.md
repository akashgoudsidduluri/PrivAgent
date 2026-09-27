# PHASE 17.2 — GOAL VERIFICATION AUDIT

**Status:** COMPLETE — audit only, no code changed.
**Baseline commit:** `4fb476f` (Phase 17.1 approved)
**Date:** 2026-09-27
**Scope:** `extension/src/agent/goalVerifier.ts` (689 lines), `effectVerifier.ts` (487),
`agentLoop.ts`, `serviceWorker.ts`, `contentScript.ts`, `visualPerception/`, world model,
existing goal tests, Phase 16 remediation tests, Phase 17.1 tests/evidence.

---

## 0. HEADLINE: THE AUDIT TRIGGERED A STOP CONDITION

**Section 13 of the Phase 17.2 brief lists these stop conditions. The audit found
TWO of them present in the current code, in goal verification itself:**

| Stop condition | Present? | Evidence |
|---|---|---|
| Goal verifier consumes `previousActions` as evidence | **YES — 7 sites** | `goalVerifier.ts:507,508,524,525,620,637,638,655,678` |
| Requested action parameters establish success | **YES — 1 site** | `goalVerifier.ts:560` via `navigationDestination` |

The brief says: *"STOP immediately if you discover… goal verifier consumes
previousActions as evidence… requested action parameters establish success. Do not
work around these problems."*

**This document is the stop report.** Per the brief, implementation should not
proceed past this point without an explicit decision from the project owner,
because resolving the findings requires *changing the success criteria of six
existing goal types* — and four of those goal types currently have tests asserting
the old (unsound) behaviour.

The remainder of this audit is the evidence for that decision. It is written so
the choice can be made deliberately rather than by accident.

---

## 1. CURRENT GOAL TYPES

`verifyTaskGoal(task, state, context)` dispatches in priority order. Nine branches:

| # | Line | Branch | Goal shape | Evidence used today | Sound? |
|---|---|---|---|---|---|
| 1 | 465 | Generic search | "search X" | observed `context.url` query param | **YES** |
| 1b | 493 | Google search | "search for"/"search google" on a Google host | observed URL, **else `previousActions`** | **NO** |
| 2 | 517 | Login | "login" | URL away from login **AND** `previousActions` type+click | **PARTIAL** |
| 2b | 550 | Multi-page research | "find the A, B and C … multiple pages" | `currentUrl` + `step.url` + **`step.navigationDestination`** | **NO** |
| 3 | 588 | Shopping / constraints | maxPrice/size/color/"bag"/"product" | candidates + `isResultsOrProductPage`; second path uses **`previousActions` click** | **PARTIAL** |
| 4 | 632 | Banking transactions | "details" + "transaction" | **`previousActions` only** (≥3, a click, a scroll) | **NO — no observation at all** |
| 5 | 649 | Account number | "account number" | a `click` step + detections; **`previousActions` click** | **PARTIAL** |
| 6 | 671 | Scroll | "scroll" | observed scrollY/viewport/detections (Phase 17.1 hardened) | **YES** |
| 7 | 675 | Account details | "details" | **`previousActions` click only** | **NO** |
| — | 687 | default | anything else | never satisfied | **YES** (fails closed) |

---

## 2. FABRICATED / ASSUMED SIGNALS — THE FINDINGS

### F17.2-1 (CRITICAL) — Branch 4 verifies a banking goal with ZERO observation

```ts
// goalVerifier.ts:636-641
const hasClicked  = state.previousActions.some((a) => a.action === 'click');
const hasScrolled = state.previousActions.some((a) => a.action === 'scroll');
if (state.previousActions.length >= 3 && hasClicked && hasScrolled) {
  return { satisfied: true, status: 'SUCCESS',
           reason: 'Navigated to and verified recent account transaction history.' };
}
```

"**Verified** recent account transaction history" is returned with **no browser
observation whatsoever** — no URL check, no DOM check, no geometry. The reason
string actively misdescribes the evidence. Three dispatched actions on a page that
never loaded a single transaction row produces a *verification* of transaction
history. This is the exact `ACTION REQUEST → ASSUMED RESULT → SUCCESS` chain the
brief prohibits.

### F17.2-2 (CRITICAL) — Branch 7 "Account details" is a click counter

```ts
// goalVerifier.ts:677-682
if (state.previousActions.some((a) => a.action === 'click')) {
  return { satisfied: true, status: 'SUCCESS', reason: 'Account details view opened.' };
}
```

A click was *dispatched* → "view opened". Nothing about the view was observed.
Note this is unreachable in practice only because branch 4 catches the same words
first; a task containing "details" but not "transaction" lands here.

### F17.2-3 (CRITICAL) — Branch 1b: search succeeds on dispatched actions

```ts
// goalVerifier.ts:507-513
const hasTyped      = state.previousActions.some((a) => a.action === 'type');
const hasSubmitted  = state.previousActions.some((a) => a.action === 'click' || a.action === 'navigate');
if (hasTyped && hasSubmitted) {
  return { satisfied: true, status: 'SUCCESS',
           reason: 'Google search submission actions verified; search request dispatched.' };
}
```

Branch 1 (generic search) is sound and runs first for most search phrasings, so
this is a narrower hole — but it is real for the phrasings that fall through to
1b, and it asserts *"submission actions verified"* from dispatch records alone.

### F17.2-4 (CRITICAL) — Branch 2b counts a REQUESTED URL as an observed page

```ts
// goalVerifier.ts:556-561
for (const step of state.steps) {
  if (!step.executionSuccess) continue;
  if (step.url) observedUrls.add(step.url);
  if (step.navigationDestination) observedUrls.add(step.navigationDestination);  // ← REQUESTED
}
```

`navigationDestination` is set at `agentLoop.ts:2240` and `:2260` from
`destination = isNavigate ? action.url! : undefined` — the URL the **model asked
for**, before dispatch. `executionSuccess` means dispatch returned success, not
that the browser went there.

The surrounding comment asserts these are *"pages the agent actually reached"* and
that the rule *"derives success ONLY from observed evidence"*. That claim is false
for this line. A navigate action that was dispatched and returned success but was
blocked, redirected, or never committed still contributes its **requested** URL to
the evidence set, and `urlMentionsResearchItem` can then certify a research goal
from it.

This is the most subtle of the findings: the code's own documentation states the
invariant the code violates.

### F17.2-5 (MODERATE) — Branches 2, 3b, 5 mix observation with action history

These are not pure fabrication — each also consults real observed state — but each
requires a dispatched action as an *additional* necessary condition:

- Branch 2 (login): `wasOnLoginPage && isNowAwayFromLogin && hasTyped && hasClickedSubmit`.
  The URL transition alone is genuine evidence. The action-history conjunct means a
  login whose transition was observed *but whose actions were not recorded* fails
  closed — over-strict, and unsound in the opposite direction: it treats the
  presence of dispatched actions as necessary evidence.
- Branch 3b: `currentUrl.includes('product') && previousActions.some(click)`.
- Branch 5: `steps.some(click && executionSuccess && targetType==='account_number')`.

### F17.2-6 (MODERATE) — No staleness or document-identity check on goal evidence

Neither `context.url`, `state.currentUrl`, `state.steps[].url`, nor
`state.observedScrollY` carries an observation timestamp or document identity.
The Phase 17.1 contract added `observedAt` / `pageGeneration` / `tabId` to
**effect** snapshots, but the **goal** layer consumes `context.url` — a bare
string with no provenance. So:

- A goal can be satisfied from a URL observed before a subsequent navigation.
- There is no way to express "this observation is STALE" at the goal layer, so
  requirement §5 (cross-document safety) and test 12 (cross-document stale
  evidence → no false success) cannot currently be *expressed*, let alone enforced.

`GoalVerificationResult` has no `UNVERIFIABLE` status at all — only
`satisfied: boolean` + `TaskStatus`. The three-way distinction the brief requires
(§2) is structurally absent.

### F17.2-7 (MODERATE) — Visual evidence is not reachable from goal verification

`AgentContextPayload` carries no visual/OCR findings. `coordinateMultimodalPerception`
returns `visualReport` + `ocrRegions` into the world model, but nothing plumbs
either into the context the goal verifier reads. Visual evidence therefore
**cannot currently produce success** — which fails *closed* (safe) but leaves
requirement §3 unimplemented.

Critically, `MultimodalPerceptionInput.tabId` is **optional** and
`screenshotCapture.ts` never records which tab an image came from. There is
therefore **no provenance field** with which to satisfy requirement §3
("from the actual target tab") or test 15 ("visual evidence from wrong/non-target
tab → rejected"). Any 17.2 visual work must first add tab provenance; it cannot
be verified without it.

### F17.2-8 (LOW) — Shopping success is reachable on a URL substring

Branch 3 accepts `currentUrl.includes('search')` as a "results page". A URL merely
*containing* the substring is treated as a results page. Weak, but it is an
observation, not a fabrication.

---

## 3. AUTHORITATIVE OBSERVATION SOURCES (what 17.2 may rely on)

| Source | Where | Provenance carried? |
|---|---|---|
| `chrome.tabs` URL/title | `serviceWorker.ts:1055-1145` | ✅ `tabId`, `observedAt`, `tabLifecycleObserved` |
| Content-script snapshot | `contentScript.ts:489` | ✅ per-field `ObservationState`, `pageGeneration` |
| Viewport geometry | `types.ts` `viewport` | ⚠️ `viewportObservable`/`viewportSource` (17.1 C6, local only) |
| Detections / bbox | `context.detections` | ⚠️ no timestamp, no document id |
| `context.url` | minimizer | ❌ **bare string — no provenance at all** |
| Visual / OCR | `visualPerception/` | ❌ **not in context; no tab id on capture** |

**The two rows marked ❌ are the blocker.** Goal verification's primary input
(`context.url`) has no provenance, and visual evidence has none at all.

---

## 4. WHERE EACH KIND OF VERIFICATION OCCURS TODAY

- **URL:** branches 1, 1b, 2, 2b, 3, 3b — all on `currentUrl` = `context.url || state.currentUrl || ''`.
  Note the `||` fallback: if `context.url` is empty the **stale task-state URL** is
  substituted, with no staleness signal.
- **DOM / text:** branch 5 only (detections), and indirectly branch 3 (candidate
  extraction from detection selectors/ids). There is no general text-content goal
  verification — requirement §6 types **C (click/result)**, **D (text/content)**,
  and **F (form/value)** have **no sound implementation today**.
- **Geometry / scroll:** branch 6 only, and it is the best-hardened code in the
  file (Phase 17.1 C6 gate, `isDetectionInViewport`, baseline requirement).
- **Visual:** nowhere. See F17.2-7.

---

## 5. WHERE STALE OBSERVATIONS CAN ACCIDENTALLY PRODUCE SUCCESS

1. `const currentUrl = context.url || state.currentUrl || ''` — an empty
   `context.url` silently falls back to the last known task-state URL, which may
   describe a document the agent has since left.
2. `state.steps[].url` (branch 2b) is written at record time and never invalidated
   by a later navigation.
3. `state.observedScrollY` is compared against `state.initialScrollY` with no
   shared-document check — a page that navigated to a *taller* page would report
   the same `scrollY` and satisfy a "scrolled N px" goal from a fresh-looking
   number.
4. There is no `observedAt` at the goal layer at all (F17.2-6), so no staleness
   check is expressible.

---

## 6. CASES CURRENTLY RETURNING SUCCESS WITHOUT SUFFICIENT EVIDENCE

| Case | Goal | Evidence required today | Should require |
|---|---|---|---|
| A | "show my account transactions" | 3 dispatched actions incl. click+scroll | observed transactions DOM/text on the current document |
| B | "open account details" | one dispatched click | observed details view (URL transition or content) |
| C | "search google for X" (fallthrough) | a dispatched type + click/navigate | observed `q=` on the live results URL |
| D | research goal, item matching a **requested** URL | requested `navigationDestination` | observed committed URL for that step |
| E | login where actions were recorded | URL transition + dispatched actions | URL transition alone (already sufficient) |
| F | shopping product detail | URL contains "product" + dispatched click | observed product detail state |

---

## 7. AUTHORITY BOUNDARY — CONFIRMED INTACT

`agentLoop.ts:2361-2372` — `isTaskGoalSatisfied` sets `state.goalStatus` and
`state.reason` only, and returns a boolean consumed as loop control flow. It does
**not** authorize any action, bypass any gate, or mutate risk/confirmation state.
Goal verification is not authorization today, and nothing in 17.2 should change
that. The `previousActions` findings are a **soundness** defect in *when success is
claimed*, not a **security-boundary** defect — the blast radius is a false
SUCCESS/early loop termination, not a privilege escalation.

Security authorities (`securityCritic`, `injectionFirewall`, `containment`,
`rawValueScanner`, `harness`, `riskEngine`, M5 validation) are **not implicated**
by any finding above and are not touched by this audit.

---

## 8. WHAT 17.2 MUST BUILD (once unblocked)

1. A `GoalEvidence`/`GoalVerdict` contract with `VERIFIED_SUCCESS` /
   `VERIFIED_FAILURE` / `UNVERIFIABLE`, mapped onto the existing `TaskStatus` so
   the loop's `satisfied` boolean semantics are preserved.
2. Provenance on goal-layer inputs: `context.url` must carry an observation stamp
   and document identity, or 17.2 must introduce a goal-evidence envelope that
   does.
3. Removal of `previousActions` and `navigationDestination` as success evidence
   from branches 1b, 2, 2b, 3b, 4, 5, 7 — replacing each with observed state.
4. New goal types C, D, F, G (click/result, text/content, form/value,
   multi-condition) with the §6 sufficiency tables written down.
5. Visual evidence gated on tab provenance, capture success, document identity and
   freshness — which **requires adding tab provenance to capture first**.
6. Conservative combination rules: conflicting evidence must not yield success.

## 9. EXPLICITLY OUT OF SCOPE (17.3+)

OCR integration, canvas/visual perception build-out, dynamic content handling,
iframes, long-horizon reliability, provider robustness, evaluation harness. §3
here is **consuming** already-captured visual evidence, not producing it.

---

## 10. DECISION REQUIRED

The brief instructs: **stop** on the two conditions in §0, and **do not work
around them**. The findings cannot be fixed without changing what six goal types
accept as proof, and four existing tests assert the current behaviour
(`tests/goalVerifier.test.ts` login; `tests/phase16/*`; `tests/stage7*` I11).

Options, with consequences:

- **A — Unblock as specified.** Implement §8 in full. Expect ~4 existing tests to
  be *correctly* invalidated where they assert action-history success. Each
  refinement must be documented with its reason, per §12.
- **B — Scope 17.2 to the sound path only.** Harden branches 1 and 6 (already
  sound), add the verdict contract and staleness/provenance, and **defer** the
  seven `previousActions` sites. Cheaper, no test churn, but leaves the CRITICAL
  findings live and does not deliver the brief's objective.
- **C — Treat as a separate remediation phase.** Close the fabrication findings as
  their own focused change (they are small and self-contained), then run 17.2 on
  solid ground. Cleanest audit trail; adds a phase.

Recommendation: **C**, or **A** if the goal-type expansion is wanted now. I have
not implemented anything and have not modified any test.
