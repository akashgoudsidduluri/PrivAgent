# Phase 17.1 — Observation Contract

**Baseline:** `2b10445` (Phase 16 remediation, closed)
**Scope:** observation only. Observation is **informational**. It is not an authorization authority, and nothing in this contract can permit an action.

---

## The one invariant

```
"unobservable"  is NOT  "zero"
"stale"         is NOT  "fresh"
an ACTION       is NOT  a browser observation
a MODEL CLAIM   is NOT  a browser observation
a DEFAULT       is NOT  an observation
```

Everything below exists to make that invariant enforceable rather than aspirational.

---

## 1. The four states

Every snapshot field carries an explicit `ObservationState`:

| State | Meaning | Used when |
|---|---|---|
| `OBSERVED` | A real reading was obtained from the authoritative source. | The content script answered. |
| `UNAVAILABLE` | The authoritative source exists but could not be read. | Content script torn down mid-navigation; target not locatable. |
| `STALE` | A reading exists, but it describes a different document. | Pre and post provably span a navigation. |
| `NOT_APPLICABLE` | The field is meaningless for this snapshot. | No target was asked about. |

**A field in any state other than `OBSERVED` is never compared and never contributes to a verdict.** It is reported in the diagnostics so the refusal is legible rather than silent.

Defined in `extension/src/agent/effectVerifier.ts` as `ObservationState`, `SnapshotFieldStates`, `SnapshotObservation`.

---

## 2. Covered fields

| Field | Source | Contract |
|---|---|---|
| `tabId` | `chrome.tabs.query` | OBSERVED when the tab was found; UNAVAILABLE otherwise |
| `url` | `chrome.tabs` — `pendingUrl \|\| url` | OBSERVED when Chrome knows; **authoritative** |
| `pendingUrl` | `chrome.tabs` | OBSERVED when a navigation is in flight |
| `title` | `chrome.tabs.title` | OBSERVED. **New in 17.1 (C7)** — previously discarded. |
| `tabStatus` | `chrome.tabs.status` | OBSERVED |
| `scrollY` / `scrollX` | content script | UNAVAILABLE when the page cannot be read |
| `viewportWidth` / `viewportHeight` | content script via `readLiveViewportGeometry` | UNAVAILABLE when the geometry source is absent |
| `domElementCount` | content script | UNAVAILABLE with the page |
| `openModalsCount` | content script | UNAVAILABLE with the page |
| `activeElementSelector` | content script | UNAVAILABLE with the page |
| `targetValueLength` | content script | **`null` = not locatable; `0` = genuinely empty** (C5) |
| `pageGeneration` | content script's existing monotonic counter | `null` when the page is unreadable |
| `observedAt` | `Date.now()` at read time | always present |
| `pageStateObservable` | service worker | `false` for a tab-only reading |
| `viewportObservable` | service worker, **local only** | `false` when the viewport numbers are the all-zero default (C6) |

---

## 3. Two snapshot shapes

**Fully observed** — `pageReadable: true`. Every page-local field is `OBSERVED`, except `targetValueLength`, which the content script itself resolves to `UNAVAILABLE` when the target cannot be located.

**Tab-only** — `pageReadable: false`, produced when the content script is gone (Phase 16 DEFECT 3). `url`, `title` and `tabStatus` are real readings; every page-local field is `UNAVAILABLE`. The numeric fields are still present as zeros — **which is exactly why the explicit states are load-bearing**.

**Neither source has a URL ⇒ `null` ⇒ the loop fails closed.** Never a guess.

---

## 4. Freshness

| Mechanism | Status |
|---|---|
| `observedAt` per snapshot | OBSERVED, monotonic wall clock at read time |
| `pageGeneration` per page-side snapshot | Reuses the content script's **existing** monotonic counter (it already existed for stale-target protection and simply never reached the snapshot) |
| **Cross-document detection** | **New in 17.1.** If the authoritative URL differs between pre and post, the two readings describe different documents. Every page-local comparison between them is `NOT_APPLICABLE`; only the URL change survives as evidence. |
| World-model `pageGeneration` consistency | Pre-existing, unchanged |

No distributed-systems machinery was introduced. Three numbers and one rule.

---

## 5. What the contract does NOT do

- It does not decide whether an action is allowed. Nothing here is consulted by M5, the Security Critic, containment, the privacy policy, or risk.
- It does not turn an observed effect into task success. Goal verification still owns that.
- It does not widen the outbound payload. `viewportObservable` / `viewportSource` are attached **after** the egress allowlist runs and are stripped at the backend boundary; the wire schema is byte-identical to Phase 16. The `tests/agentBridge.test.ts` allowlist test enforces this and did in fact catch the first attempt.

---

## 6. Removed fabrications (the substance of 17.1)

Two blocks of production code rebuilt browser state that was never read:

**F1 — the fabricated pre-action snapshot** (`agentLoop.ts`):
```
scrollX: 0, scrollY: 0,                        ← placeholders
domElementCount: context.totalElementsScanned  ← a SCAN count, not a DOM count
targetValueLength: detection.length             ← a LABEL length, not an input's value
activeElementSelector: detection.selector       ← a guess
```
compared against a **real** post-action reading. A page that scrolled 500 px from a fabricated baseline of 0 was reported `SCROLL_CHANGED`. This is verbatim the "BAD" example in the 17.1 brief.

**F2 — the post-action synthesis from the requested action** (`agentLoop.ts`):
```
navigate → post.url          = action.url
scroll   → post.scrollY     += action.amount
type     → post.valueLength  = action.text.length
click    → post.domElementCount += 1
```

Both are deleted. Both are now `null`, and `null` is reported as `EFFECT_UNVERIFIABLE`.
