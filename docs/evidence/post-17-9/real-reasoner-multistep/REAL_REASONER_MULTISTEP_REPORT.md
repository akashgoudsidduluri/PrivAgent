# Post-17.9 — Real-Reasoner Multi-Step SUCCESS Proof

**Date:** 2026-09-28 · **Post-audit update:** 2026-09-29
**Work type:** Evidence task, plus **one production fix** (see §0 — the audit below found a real
synchronization defect and fixed it).
**Harness:** `scratch/rr_multistep_proof.mjs`, reusing `scratch/phase16_cdp.mjs` helpers and
`scratch/phase176_fixture.mjs` unchanged. Controls: `scratch/rr_controls.ts`.

> **§1–§12 below are the PRE-AUDIT record from 2026-09-28. They are kept unchanged**
> so the original NOT_PROVEN result, its measurements and its characterisation remain
> auditable. **§1's verdict line and §11's limitations list are superseded by §0.**
> Read §0 first: it states what was actually wrong, what was fixed, and what is still
> not proven.

---

## 0. POST-AUDIT UPDATE — the stale-world-model rejection was a FALSE POSITIVE

### 0.1 Verdict

| | Pre-audit (2026-09-28) | Post-audit (2026-09-29) |
|---|---|---|
| Attempts run | 5 | 6 |
| Attempts with ≥1 real provider cycle | 5/5 | 5/6 |
| Real provider calls | 20 (20×200) | 21 (**16×200**, 4×503 rate-limit, 1 timed out) |
| `rejecting stale world model before attachment` | **5/5 attempts** | **0/6 attempts** |
| Loop died on `Perception failed: Unable to obtain sanitized page context` | **5/5 attempts** | **0/6 attempts** |
| Best attempt | 4 calls / 4 actions / 3 effects | **6 calls / 6 actions / 5 effects** |
| Reached `/product/alpha-widget`, observed `product-detail` + `Price: 24` | 5/5 | 6/6 attempts that got past cycle 1 |
| **Observation-backed SUCCESS** | **NOT PROVEN** | **NOT PROVEN — different, later blocker (§0.6)** |

**Classification:**

* **PROVEN_REAL** — the stale-world-model rejection was a *false* positive, at a named code
  address, with the numbers to prove it (§0.2, §0.4).
* **PROVEN_REAL** — the fix removes that rejection in real Chrome against the real reasoner:
  **0 rejections across 6 post-fix attempts**, with the loop reaching the product page and
  continuing past the point where it previously died.
* **PROVEN_TEST** — 13 new regression tests; **5 of them fail against the pre-fix code** and all
  pass with it (§0.7).
* **NOT_PROVEN** — multi-step SUCCESS. Goal Verification is now *reached and consulted* and
  returns `IN_PROGRESS`; it has no observed evidence type that can certify this goal on this
  fixture (§0.6).
* **KNOWN_LIMITATION** — the sanitized agent context carries no page text, so the model cannot
  see the value it is asked to report and re-proposes a futile scroll (§0.6).

### 0.2 Exact root cause

The loop's page-generation counter is **anchored to the page** — after every successful
perception `state.currentPageGeneration = worldModel.page.pageGeneration` — and the stale guard in
`normalizePerceptionResult` refuses a world model whose generation is below that anchor:

```ts
const localGeneration = this.state.currentPageGeneration || this.state.perceptionGeneration;
if (localGeneration > 0 && liveGeneration < localGeneration) {   // ← fired
  console.warn('[AgentLoop] rejecting stale world model before attachment', { ... });
  return null;   // → 'Perception failed: Unable to obtain sanitized page context.'
}
```

The `ACTION_NO_EFFECT` recovery path advanced that counter **twice for one world-model build**:

```ts
// on entering recovery                       // after the mandatory re-perception
advancePageGeneration(this.state);            // ← bumped
...                                           advancePageGeneration(this.state);   // ← bumped again
const fresh = await perceivePage();            this.state.currentPageGeneration = this.state.perceptionGeneration;
```

`perceivePage()` builds exactly one world model, so the loop consumed **three** generation steps
per two builds (two recovery bumps plus the next cycle's bump). The counter therefore ran *ahead*
of the page, and the next genuinely fresh model was refused as stale. The guard was reporting a
model that was the freshest the page had.

**Proven by measurement, not inference.** Instrumenting the harness to capture the guard's own
payload across the real run (`pre_fix_generation_desync.json`, attempt 1):

```
perception started   perceptionGeneration = 7  → complete: worldModelId = wm-g8   (accepted)
  … the ACTION_NO_EFFECT recovery ran here …
perception started   perceptionGeneration = 11 → REJECTED
  localGeneration 11, worldModelGeneration 10, refGeneration 10, worldModelId wm-g10
```

The loop advanced 8 → 11 (+3) while the content script advanced 8 → 10 (+2). 10 < 11 → refused.
The rejected model, `wm-g10`, was the newest one the page had.

**Why it is a false positive and not correct staleness.** The content script builds a fresh world
model on *every* scan request and increments its own generation each time; the service worker
re-validates `ref.pageGeneration === worldModel.page.pageGeneration` before attachment. Freshness
is guaranteed by the build, not by the loop's counter. The counter is only a defence-in-depth
lower bound, and the recovery path pushed it above the page's own value.

### 0.3 The fix

Two production files, ~15 lines net.

`extension/src/agent/agentState.ts` — the invalidation and the counter advance are now separable.
A new `invalidatePageGenerationState(state, generation?)` performs what the recovery path actually
needs (clear `visitedElementIds`, null `activeWorldModelRef`, invalidate the generation);
`advancePageGeneration` now delegates to it and keeps its existing contract exactly (it still
advances both counters), so its other two call sites are unchanged.

`extension/src/agent/agentLoop.ts` — the recovery path now:

1. **invalidates without advancing** (`invalidatePageGenerationState`) — stale-target protection is
   preserved, the spurious counter bump is removed; and
2. **re-anchors** the counter to the generation the fresh perception actually observed
   (`normalized.worldModel?.page?.pageGeneration`), mirroring what the perception cycle already does.

The stale guard itself is **byte-for-byte unchanged**, as are M5, Grounding, the Security Critic,
Risk/Confirmation, Containment, Effect Verification, Goal Verification, Recovery authorisation,
the privacy boundary, F-09 and the egress firewall. No observation is fabricated, no stale model
is accepted, and nothing is derived from `previousActions`, `executionSuccess`, a requested URL or
a model claim: the counter can now only ever move *towards* what the browser reported.

### 0.4 Reproduction (Task 1)

Re-ran the existing harness, unmodified, before touching any production code. The failure
reproduced exactly as reported (2/2 attempts): `/` → `/catalog` → `/product/alpha-widget` observed
live, `product-detail` + `Price: 24` read from the DOM, then
`rejecting stale world model before attachment` → `M6 failed` → `Perception failed` → `FAILED`.

Harness reliability was hardened first, because the first two diagnostic runs died on CDP
`Inspected target navigated or closed`: a crashed run left Chrome holding the CDP port, so the next
run attached to a *stale* browser, and `tidy()` never exited the process. The harness now reaps a
foreign browser on its CDP port before launching, kills Chrome by profile path and port, and exits
deterministically. **Every number in §0.5 is from a run that passed that preflight.**

### 0.5 Post-fix real-Chrome results (Task 5)

Build: the real `dist/` extension, rebuilt from the fixed source. Provider: the configured backend
(groq `openai/gpt-oss-20b`). No scripted proposer, no stubbed provider.

| # | Provider calls | Actions | Effects | URLs visited | Ended on | Stale rejections |
|---|---|---|---|---|---|---|
| 1 | 6 (6×200) | 6 | 5 | `/`, `/catalog`, `/product/alpha-widget` | recovery bound (3 × futile scroll) | **0** |
| 2 | 5 (4×200, 1×503) | 4 | 3 | `/`, `/catalog`, `/product/alpha-widget` | provider 503 rate-limit | **0** |
| 3 | 2 (1×200, 1 timeout) | 1 | 1 | `/`, `/catalog` | provider timeout | **0** |
| retry 1 | 5 (4×200, 1×503) | 4 | 3 | `/`, `/catalog`, `/product/alpha-widget` | provider 503 rate-limit | **0** |
| retry 2 | 2 (1×200, 1×503) | 1 | 1 | `/`, `/catalog` | provider 503 rate-limit | **0** |
| retry 3 | 1 (1×503) | 0 | 0 | `/` | provider 503 rate-limit | **0** |

Attempt 1 is the strongest run and the direct comparison with the pre-audit baseline:

| | Pre-fix | Post-fix |
|---|---|---|
| Provider calls | 4 (4×200) | **6 (6×200)** |
| Browser actions | 4 | **6** |
| Observed effects | 3 | **5** |
| Ended on | `Perception failed` (0 actions left possible) | recovery bound after the 3rd futile scroll |

Its per-step record, from the live tab:

| Step | Proposed | M5 | Security Critic | Effect |
|---|---|---|---|---|
| 1 | `click browse-catalog` | ✅ | — | `URL_NAVIGATION_OBSERVED` → `/catalog` |
| 2 | `click alpha-widget-link` | — | **BLOCK `GOAL_MISMATCH`** | not dispatched |
| 3 | `click alpha-widget-link` | ✅ | pass | `URL_NAVIGATION_OBSERVED` → `/product/alpha-widget` |
| 4 | `scroll down 300` | ✅ | pass | `ACTION_NO_EFFECT` → recovery `REPERCEIVE` |
| 5 | `scroll down 300` | ✅ | pass | `ACTION_NO_EFFECT` → recovery |
| 6 | `scroll down 300` | ✅ | pass | `ACTION_NO_EFFECT` → recovery bound exceeded |

Note step 2→3: the Security Critic refused a live model proposal and the recovery path then retried
it successfully. The recovery path is exercised and healthy — it simply no longer poisons the
page-generation counter.

**Performance** (recorded, not optimised): provider RTT p50 391 ms (min 372, max 8436) for the
6-call attempt; local observation latency p50 2 ms; attempt wall time 14.1 s (attempt 2: 33.3 s,
provider-dominated).

### 0.6 The remaining blocker — separately classified, NOT fixed here

With the false rejection gone, the loop reaches the product page and Goal Verification is now
*consulted* on the fresh observation. It returns `IN_PROGRESS`, and the run ends on the recovery
bound instead. Two independent causes, both outside this fix's scope:

**(a) The model cannot see the value it is asked to report — KNOWN_LIMITATION.** The sanitized
context carries interaction detections, not page text. The model's own reasons make the consequence
explicit — it believes the price is not visible, so it re-proposes `scroll down 300` on a page that
fits in the viewport. Three futile scrolls exhaust the bounded recovery and the task fails closed.
The recovery bound and the failure classification are correct behaviour given those proposals.

**(b) Goal Verification has no observed evidence type for this goal — NOT_PROVEN.**
`verifyTaskGoal`'s shopping rule certifies a product goal when a *qualifying candidate* is
extracted from an observed detection whose id/selector names a product/item/card/result, on a
product URL. Probed deterministically against the real fixture DOM (no model, no browser):

| Page | `classifyPage` | detections matching product/item/card/result | candidates | verifier |
|---|---|---|---|---|
| `/catalog` | `unknown` | **0** | **0** | `IN_PROGRESS` |
| `/product/alpha-widget` | `unknown` | **0** | **0** | `IN_PROGRESS` |

Product-page interactive ids are `nav-home, nav-catalog, nav-cart, qty, add-to-cart,
back-to-catalog`; the price element (`#product-alpha-widget-price-24`) is not interactive and so is
never a detection. Being *on* the product page therefore cannot certify a goal about a value shown
on it, and the verifier correctly refuses rather than fabricating success. The codebase already
documents this gap (Phase 17.2A: *"the sanitized context carries no row content. Phase 17.2 proper
adds the text/content goal type for that"*).

Adding a goal type, changing the fixture, or rewriting the task wording to make SUCCESS reachable
would all be manufacturing the result. Per the task's stop conditions this was reported instead.

### 0.7 Tests (Task 4)

`tests/post179WorldModelGeneration.test.ts` — **13 tests, new**. Coverage:

| # | Property |
|---|---|
| A1 | `invalidatePageGenerationState` clears generation-derived state **without** advancing the counter |
| A2 | `advancePageGeneration` keeps its contract (counter advances, state cleared) |
| B1 | an earlier-generation world model is rejected |
| B1b | …and is still rejected after a navigation-time generation advance |
| B2 | a fresh model for the new generation is accepted |
| B3 | a same-document observation at the current generation is accepted |
| B5 | a reference/payload generation disagreement is rejected |
| C6 | **after an ACTION_NO_EFFECT recovery the counter never runs ahead of the newest generation the page reported**, with no stale rejection and no `Perception failed` |
| C7 | after a recovery the counter equals the generation the fresh perception observed |
| C8 | a recovery whose re-perception **fails** still cannot drift the counter, and fabricates no observation or success |
| D9 | the old double-advance arithmetic rejects a fresh model; the fixed path accepts it |
| E10 | being on the product page never fabricates SUCCESS for a value-reading goal |
| F4 | a provider response computed from a superseded observation is still refused, never dispatched |

**Verified to fail without the fix.** With the two production files reverted to HEAD (stash, run,
restore, byte-compared against a backup): **5 of 13 fail** — A1, C6, C7, C8 and D9 — and the
failures are the defect itself (`Perception failed` / the refusal of a fresh model). With the fix,
13/13 pass. The other 8 are non-weakening pins: they pass either way, which is what "the guard was
not touched" has to look like.

### 0.8 Mutation check — the success-evidence boundary

Two mutants of `verifyTaskGoal`, both reverted afterwards (`goalVerifier.ts` byte-identical to HEAD).

| # | Mutation | Result |
|---|---|---|
| M1 | shopping SUCCESS no longer requires `qualifying.length > 0` (outer conjunct removed) | **not caught — and provably equivalent**: the inner `if (best)` guard still requires an observed candidate, so the mutant cannot return SUCCESS. Not a success-evidence defect. |
| M2 | the boundary itself: SUCCESS returned on a product URL with **no** qualifying candidate | **caught** by the new **E10** (and by nothing else — `goalEvidenceFabrication.test.ts` does not cover this conjunct) |

M2 is the fabrication this boundary exists to prevent, and E10 is what catches it.

### 0.9 Limitations introduced or remaining

1. **Multi-step SUCCESS is NOT_PROVEN** — blocked by §0.6(a)+(b), neither of which is this defect.
2. **The `navigate`-action path still advances the counter unconditionally** (`agentLoop.ts`, the
   post-navigation settle branch). It is the same *class* of unsupported bump, but it was **not**
   observed to misfire in any run: a real navigation re-loads the content script, which builds a
   world model and keeps the page counter ahead. Left unchanged deliberately — the proven bug was
   the recovery path, and changing an unproven path is not this task. Flagged for the backlog.
3. **Provider rate limiting is now the dominant environmental blocker.** 2 of 6 post-fix attempts'
   calls returned `HTTP 503: groq (rate_limit)` and the openrouter fallback also failed. Longer
   tasks cannot currently be run repeatedly.
4. The popup render path remains structurally safe but not browser-proven (unchanged from before).
5. No test asserts the fixture's own DOM shape, so §0.6(b) is recorded as a probe artifact rather
   than a pinned test; E10 pins the *behaviour* (no fabricated success) without pinning the fixture.

### 0.10 Artifacts and files

| File | Status |
|---|---|
| `extension/src/agent/agentState.ts` | **modified** — `invalidatePageGenerationState`; `advancePageGeneration` delegates |
| `extension/src/agent/agentLoop.ts` | **modified** — recovery path: invalidate-without-advance + re-anchor |
| `tests/post179WorldModelGeneration.test.ts` | **new** — 13 regression tests |
| `scratch/rr_multistep_proof.mjs` | modified — CDP preflight/reaping, deterministic exit, whitelisted identity metadata |
| `docs/evidence/post-17-9/real-reasoner-multistep/real_reasoner_results.json` | replaced — post-fix run, 3 attempts |
| `docs/evidence/post-17-9/real-reasoner-multistep/real_reasoner_results_retry_ratelimited.json` | new — follow-up retest (provider 503) |
| `docs/evidence/post-17-9/real-reasoner-multistep/pre_fix_generation_desync.json` | new — pre-fix instrumented run carrying the guard's own numbers |
| `docs/evidence/post-17-9/real-reasoner-multistep/goal_verification_coverage_probe.json` | new — deterministic §0.6(b) probe |
| **Evidence contents** | metadata and booleans only. **0 email addresses, 0 card-shaped values, no raw page text, no request bodies.** |

**Verification run:** full regression **120 files / 1595 tests** (was 119/1582 — +1 file, +13 tests)
· security/privacy **20 files / 320** · backend pytests **215** · `tsc --noEmit` exit 0 ·
`build:extension` exit 0 · `build:frontend` exit 0 · `git diff --check` clean.

---

## 1. Verdict up front (PRE-AUDIT, 2026-09-28 — superseded by §0)

| | |
|---|---|
| Real reasoner reached on the wire | **YES — 20 calls, 20/20 HTTP 200** |
| Real browser actions dispatched | **20 across 5 attempts (4 per attempt)** |
| Real observed effects | **15 across 5 attempts (3 per attempt)** |
| Live tab genuinely navigated | **5/5 attempts** — `/` → `/catalog` → `/product/alpha-widget` |
| Observed DOM evidence on the product page | **5/5** — `data-marker="product-detail"`, `Price: 24` |
| **Observation-backed SUCCESS** | **NOT PROVEN** |
| Security + privacy controls | **12/12 held** |

**The chain was proven up to and including two real actions with two real observed effects.
The final leg — Goal Verification returning SUCCESS — was NOT reached, and the reason is a
fail-closed production guard, not a provider or harness failure.**

---

## 2. What ran, and what was genuinely real

The full production path, with nothing stubbed in the success run:

```
real dashboard build (frontend/dist)
  → real MV3 service worker (dist/, loaded via Extensions.loadUnpacked)
  → production AgentLoop
  → production BackendAgentProvider
  → live local backend 127.0.0.1:8010
  → groq  openai/gpt-oss-20b          (real model, no stub, no scripted proposer)
  → content script → real page in real Chrome (Playwright chromium, CDP)
```

Backend health at run time:

```json
{ "reasoner": "groq", "reasonerStatus": "AVAILABLE", "model": "openai/gpt-oss-20b",
  "fallbackConfigured": true, "privacyFirewall": "ACTIVE", "sensitiveDataSent": 0 }
```

No authority was modified, disabled, or reconfigured: not M5, Grounding, the Security Critic,
Risk/Confirmation, Containment, Effect Verification, Goal Verification, Recovery, or the privacy
boundary. The diff for this task contains no production file.

---

## 3. The blocker, characterised

Every attempt terminates with the same line:

```
state.reason = "Perception failed: Unable to obtain sanitized page context."
```

Traced to a single service-worker log line immediately before it:

```
[AgentLoop] rejecting stale world model before attachment
[AgentTrace] M6 failed
```

**Mechanism.** After the model clicks `alpha-widget-link`, the browser performs a real
navigation. The page generation advances, and the loop's in-flight world model is rejected as
stale. `normalizePerceptionResult` returns `null`, the loop fails closed, and the run ends
**before Goal Verification is ever consulted**. This is the same family as the Phase 17.5
"STALE RESPONSE REJECTION" guard, and it fires here on the last step of the task.

**Why this is reported rather than fixed.** It is a deliberate fail-closed staleness guard, and
the task instructions forbid changing production code to make the run succeed. It is fail-safe:
the consequence is a refused task, never an unauthorized dispatch.

Notably the *first* navigation (click `browse-catalog`) does NOT trip this guard — it completes
with `EFFECT_VERIFIED`. The guard fires specifically on the click-triggered navigation to the
product page.

---

## 4. The per-cycle evidence (attempt 1 of 5, representative)

Every action below was proposed by the real model. The `reason` strings are model-authored.

| Step | Proposed action | Model reason | M5 | Security Critic | Dispatched | Effect |
|---|---|---|---|---|---|---|
| 1 | `click browse-catalog` | "Open the store catalog to view the product list" | ✅ | — | yes | `EFFECT_VERIFIED` |
| 2 | `click alpha-widget-link` | "Open the first product listed in the catalog to view its product page and price" | — | **BLOCK `GOAL_MISMATCH`** | **no** | — |
| 3 | `click alpha-widget-link` | (same intent, re-proposed) | ✅ | pass | yes | `ACTION_NO_EFFECT` → recovery `REPERCEIVE` |
| 4 | `scroll up 300` | "The product page is loaded but the price element is not visible in the current viewport; scrolling up may reveal the product details and price…" | ✅ | pass | yes | — |

Then: `perception started` → `rejecting stale world model` → `M6 failed`.

The Security Critic blocking step 2 with `GOAL_MISMATCH` is a **real refusal by a real
authority on a real model proposal**, and the loop correctly refused to dispatch it.

---

## 5. Goal-wording finding (F-09, `person_name`)

The first version of this task used the user's example goal, naming the product:

> `Find the Alpha Widget product on the store at http://localhost:4291 and report the price shown for it.`

**Result: 6/6 attempts refused by the backend before any action was produced.**

```
HTTP 503: Reasoning unavailable: Model-emitted reason rejected by text-safety scan (rule=person_name)
```

This is a **security control failing closed**, and it was not modified, bypassed, or worked
around. A probe then established the mechanism precisely: the heuristic reads the **model's own
`reason` string**, and the model echoes the product name because the goal and the page both
display it. A goal that does not name the product yields bigram-free reasons.

Adopted goal (disclosed, not a gate change):

> `Open the store catalog at http://localhost:4291, open the first product listed, and report the price shown on its product page.`

With this wording: **0 refusals, 20/20 provider calls HTTP 200.** The product identity is still
resolved by the model from the live page — the task still requires real discovery.

An intermediate wording that omitted the site URL failed with `No target web tab is open`, so the
URL is retained. That is harness/task wording, not a gate.

---

## 6. Results table — 5 attempts

| # | Provider calls | HTTP status | Actions | Effects | Live tab moved | Reached product | Goal status |
|---|---|---|---|---|---|---|---|
| 1 | 4 | 4×200 | 4 | 3 | yes | yes | FAILED |
| 2 | 4 | 4×200 | 4 | 3 | yes | yes | FAILED |
| 3 | 4 | 4×200 | 4 | 3 | yes | yes | FAILED |
| 4 | 4 | 4×200 | 4 | 3 | yes | yes | FAILED |
| 5 | 4 | 4×200 | 4 | 3 | yes | yes | FAILED |
| **Total** | **20** | **20×200** | **20** | **15** | **5/5** | **5/5** | **0 SUCCESS** |

Distinct real action targets: `browse-catalog`, `alpha-widget-link`.

---

## 7. Performance (recorded, not optimised)

| Metric | Observed |
|---|---|
| Provider RTT p50 per attempt | 373 ms · 461 ms · 1682 ms · 2905 ms · 393 ms |
| Provider RTT max (single call) | 14 379 ms |
| Local observation latency p50 | 1–2 ms |
| Total task wall time | 5.5 s · 13.9 s · 14.6 s · 17.0 s · 24.2 s |

Provider latency is the dominant term and is well within free-tier behaviour; no rate limiting
(`429`) and no `503` occurred in the final run.

---

## 8. Security negative controls — 12/12, each with a paired control

Produced by `scratch/rr_controls.ts` against production authorities. Machine-readable copy in
`security_controls.json`.

| # | Control | Authority | Result |
|---|---|---|---|
| 1 | Wrong target (`does-not-exist-9f3a`) | Grounding | **refused**, confidence 0% |
| 2 | Cross-origin navigation | Containment | **refused** `CROSS_ORIGIN_NAVIGATION_DENIED` |
| 3 | `javascript:` navigation | Security Critic | **BLOCK** `UNSAFE_PROTOCOL` |
| 4 | Injected page content ("Ignore all previous instructions…") | Provenance classifier | **HOSTILE** |
| 4b | *Control:* ordinary page text | Provenance classifier | UNTRUSTED, not HOSTILE |
| 5 | Cross-origin nav, composed authority | Critic **defers by design**, containment blocks | **refused** |
| 6 | PII-bearing `type` action | M5 | **refused** |
| 7 | Raw PII in a perceived context | `rawValueScanner` | **`PrivacyBoundaryError`** |
| 7b | *Control:* same shape, no value | `rawValueScanner` | passes |
| 8 | Forbidden raw key in a provider payload | Egress firewall | **BLOCK** `"value":` |
| 8b | *Control:* identical payload, no raw key | Egress firewall | ALLOW |
| 9 | Any real provider call carried synthetic PII | Wire capture | **false** |

**An architectural correction worth recording.** My first privacy control asserted that the
egress firewall would block a payload merely because a free-text field contained an email
address. It did not — and on inspection that expectation was wrong, not the firewall. The egress
firewall is a **key-shape** guard: it blocks forbidden raw *keys* (`"value":`, `"rawtext":`,
`"rawocr":`…). Its `FORBIDDEN_EGRESS_PATTERNS` loop is present but its body is entirely
comments, so it contributes nothing. The **value-level** backstop is `rawValueScanner`, which
the firewall's own comment defers to ("M4 handles that"). Both are now exercised, each paired
with a control so a block can only be attributed to the right cause. This is a pre-existing
property of the design, not a defect introduced here, and it is not changed by this task.

---

## 9. Observation integrity

The user's criterion is that SUCCESS must be unobtainable from `previousActions`,
`executionSuccess`, a requested URL, action history, model claim, or synthetic post-action state.

Since this run never reached Goal Verification, that property is **not claimed from this run**.
It is instead established by the existing suite `tests/phase17/goalEvidenceFabrication.test.ts`
(21 tests), which covers every listed source explicitly, including the positive control:

- "an arbitrarily long click history satisfies no goal on its own"
- "executionSuccess alone cannot establish a goal"
- "a REQUESTED url is not an OBSERVED page even when dispatch succeeded"
- "action.url cannot establish navigation success (a blocked/failed nav)"
- "visitedElementIds (populated from action.target) is not evidence"
- "a model 'reason' string asserting completion changes nothing"
- "a fabricated fallback/default observation cannot establish success"
- "an empty perception with a full action history is not success"
- "an OBSERVED transaction surface is what establishes it instead" *(positive control)*

The harness additionally only ever accepts SUCCESS if the live DOM independently shows the
product URL, the `product-detail` marker, and a non-empty price. That condition was met 5/5 —
and still correctly refused to report SUCCESS, because the product itself said FAILED.

---

## 10. Classification

| Claim | Class | Basis |
|---|---|---|
| Real reasoner invoked, real actions proposed, real dispatch, real observed navigation and effects, 5/5 | **PROVEN_REAL** | Live run, 20 provider calls on the wire |
| Two real actions with two real observed effects | **PROVEN_REAL** | `EFFECT_VERIFIED`, `ACTION_NO_EFFECT`, transitions observed in the live DOM |
| Real Security Critic refusal on a real model proposal | **PROVEN_REAL** | Step 2 `GOAL_MISMATCH`, not dispatched |
| Deterministic local fixture drives the whole path | **CONTROLLED_FIXTURE_PROVEN** | `scratch/phase176_fixture.mjs`, unchanged |
| 12/12 security + privacy controls fail closed | **PROVEN_TEST** | `scratch/rr_controls.ts`, each with a paired control |
| SUCCESS cannot be fabricated from non-observation | **PROVEN_TEST** | `goalEvidenceFabrication.test.ts`, 21 tests |
| **Observation-backed multi-step SUCCESS** | **NOT_PROVEN** | Goal Verification never consulted; stale-world-model guard fails the run closed |
| Real-reasoner behaviour on the open web | **NOT_PROVEN** | Out of scope for this task; prior attempts were rate-limit blocked |
| `person_name` heuristic (F-09) over-trigger | **KNOWN_LIMITATION** | 6/6 refusals on a product-naming goal; not fixed, not bypassed |

---

## 11. Remaining limitations

1. **Multi-step SUCCESS is unproven in real Chrome.** Everything up to Goal Verification is
   proven; the guard in §3 stops the run first.
2. **F-09 `person_name` over-trigger** (pre-existing, P2, deliberately untouched). Any goal that
   names a product makes the real model echo the name in its reason, and the whole request is
   refused with 503. Reproduced 6/6. A security-reviewed fix remains a separate piece of work.
3. **The egress firewall is a key-shape guard, not a value scanner** (§8). Value-level
   protection is upstream in `rawValueScanner`. Recorded so the two are not conflated.
4. **`FORBIDDEN_EGRESS_PATTERNS` in `egressFirewall.ts` is dead code** — the loop body is
   entirely comments. Not changed here.
5. Provider latency is occasionally high (max single call 14.4 s). No `429` occurred in the
   final run, but free-tier rate limiting remains a risk for longer tasks.
6. **Not a mutation run.** The success-evidence boundary is already covered by
   `goalEvidenceFabrication.test.ts`; a mutation harness was not warranted because SUCCESS was
   never reached and there was no new success-evidence code to mutate.

---

## 12. Files

| File | Status |
|---|---|
| `docs/evidence/post-17-9/real-reasoner-multistep/REAL_REASONER_MULTISTEP_REPORT.md` | new |
| `docs/evidence/post-17-9/real-reasoner-multistep/real_reasoner_results.json` | new — 5 attempts, per-cycle evidence |
| `docs/evidence/post-17-9/real-reasoner-multistep/security_controls.json` | new — 12 controls |
| `scratch/rr_multistep_proof.mjs` | new harness |
| `scratch/rr_controls.ts` | new controls |
| `scratch/rr_liveness.ts`, `scratch/f09_probe.ts` | new probes (liveness, F-09 mechanism) |
| **Production code** | **unchanged — zero files** |

No raw page text, PII, or secret is recorded in any evidence artifact. Wire evidence is captured
as metadata and booleans only (`contextUrl`, `detectionCount`, `bodyBytes`,
`containsSyntheticPII`); request bodies are never copied into evidence.
