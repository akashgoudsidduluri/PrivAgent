# Phase 17.1 — Authority / Freshness Matrix

**Baseline:** `2b10445` (Phase 16 remediation, closed)

Every row states who is allowed to answer the question, what happens when they cannot, and whether 17.1 changed any of it.

---

## 1. Authority — who may speak for what

| Question | Authoritative source | Subordinate (may inform, may not decide) | Never a source | Changed in 17.1? |
|---|---|---|---|---|
| Which tab is the target? | `chrome.tabs.query` | — | agent state, model output, action history | no |
| Where is the tab? | `chrome.tabs` — `pendingUrl \|\| url` | content-script `location.href` | action's `url` field, `previousActions`, model output | **yes** — the action's `url` is no longer a fallback |
| Is a navigation in flight? | `chrome.tabs.status` / `pendingUrl` | — | dispatch success | no |
| What is the page's scroll? | content script | — | `action.amount`, `execResult.scrollDelta`, `previousActions` | **yes** — synthesis removed |
| What is the viewport? | content script (via `readLiveViewportGeometry`) | — | the `window`-based constants in the SW (unreachable there) | partly — 17.1 labels the constants as `UNAVAILABLE` instead of letting them pass as readings |
| What does the DOM look like? | content script | — | `context.totalElementsScanned`, `detections.length` | **yes** — those proxies are gone |
| What is a field's length? | content script, `null` if not locatable | — | `detection.length` (a label length) | **yes** |
| What is the page title? | `chrome.tabs.title` | — | `document.title` at scan time | **yes** — now carried at all |
| Is the page readable? | the snapshot's own `pageReadable` / field states | — | the presence of zeros | **yes** |
| Where is our own dashboard? | `message.originUrl` | — | the literal `http://localhost:5173` | **yes** — C8 |
| Did the action do anything? | effect verification, over two observations | — | the action itself, the provider's claim, action history | **yes** — F2 removed |
| Is the user's goal met? | goal verification, over observations | — | action history, dispatch success | no (Phase 16 already fixed scroll) |

---

## 2. Freshness — how staleness is detected

| Relationship | Mechanism | Verdict when stale |
|---|---|---|
| pre snapshot ↔ post snapshot | authoritative URL equality | `crossDocument: true`; all page-local comparisons `NOT_APPLICABLE`; only the URL change is evidence |
| page ↔ page | content script `pageGeneration` (pre-existing counter) | recorded per snapshot; `null` when unreadable |
| world model ↔ active ref | pre-existing generation consistency check | perception returns `null` → `FAILED` (unchanged) |
| observation ↔ now | `observedAt` | recorded; **not** used to expire a snapshot (no TTL was introduced — see limitations) |
| target ↔ reality | containment + grounding + M5 (pre-existing) | unchanged |

---

## 3. Fail-closed behaviour, before and after

| Situation | Phase 16 behaviour | Phase 17.1 behaviour | Direction |
|---|---|---|---|
| Page unreadable, tab URL known | tab-only snapshot, `pageStateObservable: false` | same, now with explicit per-field `UNAVAILABLE` | tighter |
| Page unreadable, no tab URL | `null` → `EFFECT_UNVERIFIABLE` | same | same |
| Page unreadable, URL unchanged | `ACTION_NO_EFFECT` | **`EFFECT_UNVERIFIABLE`** | **tighter** — the old label claimed the page was read |
| **Pre-state unreadable, post readable** | **fabricated baseline → possibly a false effect** | **`EFFECT_UNVERIFIABLE`** | **much tighter** |
| **No post-state, no channel** | **synthesized from the action → a fabricated effect** | **`EFFECT_UNVERIFIABLE`** | **much tighter** |
| Navigation, content script gone | `URL_NAVIGATION_OBSERVED` | `URL_NAVIGATION_OBSERVED` | same (Phase 16 fix preserved) |
| Cross-document DOM difference | counted as a DOM mutation | **not counted** | tighter |
| Scroll goal, viewport unobserved | decided against zeros | `IN_PROGRESS` | tighter |

**Every row is either unchanged or strictly more conservative. No row became more permissive.**

---

## 4. Security authority — unchanged

| Authority | 17.1 change |
|---|---|
| Grounding | none |
| One-action planning | none |
| M5 Privacy Firewall | none |
| Security Critic | none |
| Risk / confirmation | none |
| Containment | none — except that C8 makes the existing dashboard guard **fire correctly** |
| Effect verification | **tightened** (no fabricated effects; cross-document comparisons voided) |
| Goal verification | **tightened** (refuses a non-observable viewport) |
| Recovery | none |
| Harness | none |
| Privacy payload | **unchanged on the wire** — local flags stripped at the egress allowlist |

**Observation is informational. It cannot authorize anything.** No code path was added that lets an observation permit an action, and no gate was reordered.
