# Phase 17.1 — Step 1: Observation Layer Audit

**Baseline:** `2b10445b048cfd63aa7dc5a5cfcc9482d0a1445b` (Phase 16 remediation, closed)
**Scope of this document:** audit only. No production code was changed to produce it.
**Date:** 2026-09-27

---

## A. Current observation sources

There are exactly **three** places browser state enters the agent. There is no
fourth, and there should not be one.

| # | Source | Component | Authoritative for | Not authoritative for |
|---|---|---|---|---|
| S1 | `chrome.tabs` | service worker | Tab identity, tab URL, `pendingUrl`, load `status`, tab `title` | Page-local DOM, scroll, geometry |
| S2 | Content script | `contentScript.ts` | Page-local DOM, scroll, viewport, modals, focus, value **length**, DOM element count | Tab lifecycle, navigation state |
| S3 | Target-tab screenshot / multimodal coordination | `multimodalCoordinator.ts` | Visual detections, screenshot dimensions, OCR | DOM truth when a screenshot is absent |

**Proxy / non-observation sources currently reaching the same consumers** — these
are the problem. They are not observations:

| # | Pseudo-source | Where | What it actually is |
|---|---|---|---|
| P1 | Context-derived pre-action snapshot | `agentLoop.ts:1444-1458` | Placeholders + proxies (see F1) |
| P2 | Action-derived post-action snapshot | `agentLoop.ts:1722-1776` | The requested action, re-expressed as state (see F2) |
| P3 | Multimodal geometry fallback | `multimodalCoordinator.ts:125-131` | Constants, read from a `window` that does not exist in a service worker |
| P4 | `AgentViewport` zero default | `privacy/types.ts:323` | Literal zeros when no visual report exists |
| P5 | `previousActions` | `agentLoop.ts`, `goalVerifier.ts` | Intent history. Used for scroll goals in `parseScrollGoal`'s callers' absence; **already removed** as proof by the Phase 16 remediation |

---

## B. Current observation fields

### B1. Tab-lifecycle fields (S1)
`targetTabId`, `tab.url`, `tab.pendingUrl`, `tab.status`, `tab.title`.
`title` is read **only** by `targetResolver.ts:420` as a matching heuristic. It is
never carried into any agent-facing observation.

### B2. Page-local fields (S2) — `collectEffectSnapshot()`, `contentScript.ts:433`
```
url: string
scrollX: number
scrollY: number
targetValueLength: number
openModalsCount: number
activeElementSelector?: string
domElementCount: number
timestamp: number
```

### B3. Perception fields (`AgentContextPayload`)
`url`, `timestamp`, `viewport{width,height,scroll_x,scroll_y}`,
`screenshot_dimensions`, `total_elements_scanned`,
`sensitive_elements_detected`, `ocr_metrics`, `detections[]`.

### B4. World-model freshness fields
`worldModel.page.pageGeneration` (monotonic, `sessionStorage`-backed,
incremented **per scan**, not per navigation), `worldModel.id`,
`activeWorldModelRef{pageGeneration, worldModelId}`.

---

## C. Authority of each source, as the code actually enforces it

| Field | Enforced authority | Correct? |
|---|---|---|
| Tab URL | `chrome.tabs`, `pendingUrl \|\| url` (Phase 16 fix) | ✅ correct |
| Navigation status | `chrome.tabs.status`, `waitForTabLoad` | ✅ correct |
| Scroll / viewport | content script, via `readLiveViewportGeometry` (Phase 16 fix) | ✅ correct |
| DOM element count, modals, focus, value length | content script effect snapshot | ✅ correct |
| Perception geometry | content script → `coordinateMultimodalPerception` | ✅ correct |
| **Pre-action state** | **none — fabricated when unavailable** | ❌ **F1** |
| **Post-action state (no channel)** | **none — synthesized from the action** | ❌ **F2** |
| **Pre↔post document identity** | **none** | ❌ **F3** |
| **Dashboard origin** | **hard-coded `http://localhost:5173`** | ❌ **F8** |

---

## D. Freshness behaviour

| Mechanism | Exists? | Assessment |
|---|---|---|
| World-model `pageGeneration` consistency check (`agentLoop.normalizePerceptionResult`) | ✅ | Real. Rejects a model whose generation disagrees with its ref. |
| Content-script monotonic `pageGeneration` | ✅ | Real but **increments per scan**, not per navigation. It is an *observation counter*, not a *document identity*. |
| Snapshot `timestamp` | ⚠️ written, **never read** | Dead field. No consumer compares it. |
| Pre↔post same-document proof | ❌ none | **F3** |
| Observation age / staleness | ❌ none | **F4** |

**The honest statement:** the system can detect a *stale world model* but cannot
detect a *stale DOM reading*. A snapshot taken on page A and one taken on page B
are indistinguishable to the effect verifier except by URL, and the URL is only
compared for equality — not used to invalidate the DOM comparison that sits
beside it.

---

## E. Existing fail-closed behaviour (to be preserved exactly)

| Situation | Current behaviour | Verdict |
|---|---|---|
| `getEffectSnapshot` throws / times out, **callback exists** | `agentLoop.ts:1653-1720` → `EFFECT_UNVERIFIABLE`, `ACTION_NO_EFFECT`, bounded, terminal on exhaustion | ✅ **correct, preserve** |
| `chrome.tabs` *and* page both yield no URL | `serviceWorker.ts` returns `null` | ✅ **correct, preserve** |
| Page unreadable mid-navigation | `pageStateObservable: false`, page-side diagnostics forced to "unchanged" | ✅ **correct, preserve** |
| Raw values in context | `assertSanitizedContextSafe` → `FAILED` | ✅ **correct, preserve** |
| Containment uninitialised | `CONTAINMENT_UNINITIALIZED`, every action refused | ✅ **correct, preserve** |

---

## F. Suspected stale / default-value paths

Ranked by severity. **F1 and F2 are the substance of 17.1.**

### F1 — CRITICAL: the pre-action snapshot is fabricated when it cannot be observed
`agentLoop.ts:1444-1458`. When `observeEffectSnapshot` returns `null` (no channel,
or the channel failed), the loop substitutes:

```ts
url: context.url || this.state.currentUrl || '',
scrollX: 0,
scrollY: 0,
domElementCount: context.totalElementsScanned ?? context.detections?.length ?? 0,
openModalsCount: …modal_overlay count… ?? 0,
targetValueLength: context.detections?.find(…)?.length ?? 0,   // ← LABEL length, not input value length
activeElementSelector: …detection.selector,                       // ← a guess
```

This fabricated object is then compared against a **real** post-action reading by
`verifyActionEffect`. That is verbatim the failure mode the Phase 17 brief names
as BAD:

```
before.scrollY = 0   // placeholder
after.scrollY  = 500
→ SCROLL_CHANGED
```

It also fabricates `domElementCount` from a *scan count* and
`targetValueLength` from a *detection label length* — neither is the quantity the
effect verifier compares.

### F2 — CRITICAL: the post-action snapshot is synthesized from the requested action
`agentLoop.ts:1722-1776`. If `postSnapshot` is still missing **and no
`getEffectSnapshot` callback exists**, the loop rebuilds post-state from the
action:

```ts
navigate → newUrl      = action.url;                     // the URL ASKED FOR
scroll   → newScrollY += action.amount;                  // the delta ASKED FOR
type     → newValLen   = (action.text || '').length;    // the LENGTH OF THE REQUESTED TEXT
click    → newDomCount += 1;                            // a fabricated mutation
```

Note the asymmetry that makes this survivable in production today: when a
callback **exists**, the fail-closed block at :1653 fires first and this code is
never reached. It is live for any host that does not wire an observation channel
— i.e. tests, and any future embedder. It is exactly the "action history as
browser-state evidence" pattern the brief forbids.

### F3 — HIGH: pre and post cannot be proven to describe the same document
Snapshots carry no `pageGeneration`, no document id, and `timestamp` is never
compared. If a navigation occurs between the two reads, `domElementCount`,
`scrollY` and `focusChanged` are compared **across two different documents**, and
the resulting "effect" is an artefact of the navigation, not of the action.

### F4 — HIGH: no observation-state vocabulary exists
`PreActionSnapshot` and `PostActionSnapshot` are **structurally identical**
interfaces. `pageStateObservable` exists only on the post side and only via an
untyped cast (`(post as {pageStateObservable?: boolean})`). There is no
`domObservable`, no `visualObservable`, and no `NOT_APPLICABLE`. "Unobservable"
can only be expressed as `null` for the whole snapshot — never per field.

### F5 — HIGH: `targetValueLength: 0` conflates "empty" with "element not found"
`contentScript.ts:433`. Both the `if (el)` false branch and the `catch` produce
`0`. For a `type` action, `0` is therefore ambiguous between an empty field and a
missing target.

### F6 — MEDIUM: `AgentViewport` reports all zeros when no visual report exists
`privacy/types.ts:323`. `viewport.height === 0` is indistinguishable from a real
zero-height viewport. `goalVerifier` reads this field, so a non-observable
viewport is silently indistinguishable from an unscrollable one.

### F7 — MEDIUM: tab `title` is never observed
Required by the 17.1 contract; currently available from `chrome.tabs` but
discarded everywhere except a resolver heuristic.

### F8 — HIGH (security-relevant observation gap): the dashboard origin is hard-coded
`serviceWorker.ts:573` passes the literal `'http://localhost:5173'` to
`establishContainmentScope`, and `isDashboardUrl()` matches **only** port `5173`.
`message.originUrl` — the real dashboard origin — is already available and *is*
passed to `resolveTargetWebTab` at :497, but not to the containment scope.

The Phase 16 harness served the dashboard on **5175**. On any non-5173 port the
agent's own control surface is not recognised as such, and containment can be
scoped to it. The guard exists; it is simply never told the truth.

**This is an observation defect, not a security relaxation.** Fixing it makes an
existing refusal *more* reliable. It is called out separately for review.

### F9 — MEDIUM: geometry fallback still applies when the content script is unreadable
`readLiveViewportGeometry` returns `null`, and the coordinator then falls back to
the `window`-based constants (1280×800, scroll 0). Those constants are
indistinguishable from an observation.

---

## G. Proposed changes for 17.1

Only changes justified by the findings above. Nothing else.

| # | Change | Addresses | Risk to security |
|---|---|---|---|
| **C1** | Introduce one explicit observation contract: per-field `OBSERVED / UNAVAILABLE / STALE / NOT_APPLICABLE`, carried on **both** pre and post. Reuse existing snapshot shapes; no second state system. | F4 | none |
| **C2** | **Delete the pre-action fabrication.** No observation channel or failed read ⇒ pre is `UNAVAILABLE` ⇒ `verifyActionEffect` returns `EFFECT_UNVERIFIABLE`. | **F1** | strengthens |
| **C3** | **Delete the post-action synthesis.** Same fail-closed treatment as the existing post path. | **F2** | strengthens |
| **C4** | Stamp the content script's existing monotonic counter + `observedAt` into snapshots. In the effect verifier, if the authoritative URL differs between pre and post, mark DOM/scroll/focus comparisons `NOT_APPLICABLE` and evaluate only the URL change. | F3 | none |
| **C5** | Content script reports `targetValueLength: number \| null`, `null` = target not locatable, `0` = genuinely empty. | F5 | none |
| **C6** | Mark the perception viewport explicitly observable / not, and have the scroll goal verifier refuse a non-observable viewport rather than reading zeros. Wire schema to the backend stays byte-identical. | F6 | strengthens |
| **C7** | Carry `tab.title` from `chrome.tabs` into the tab-authoritative observation. | F7 | none |
| **C8** | Pass the **real** dashboard origin (`message.originUrl`, defaulting to the current literal) to `isDashboardUrl` and `establishContainmentScope`. | F8 | **strengthens** |

### Explicitly NOT proposed
- No new goal types (17.2).
- No OCR activation (17.3).
- No iframe/virtualized/canvas work (17.4–17.6).
- No change to execution bounds, recovery, or the harness (17.7+).
- No weakening of any gate to make C2/C3 less disruptive. Where C2/C3 change a
  test's expectation, the test's *fixture* is corrected or the behaviour is
  recorded as a deliberate fail-closed change — the test is not deleted.

### Expected blast radius
C2 and C3 will change results for any test host that currently relies on
synthesized snapshots. That is the point of the phase, but it must be measured
and reported, not assumed.
