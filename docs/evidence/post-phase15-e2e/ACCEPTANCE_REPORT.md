# Post-Phase-15 Validation & Effect-Verification Closure — Acceptance Report

**Scope:** two P0 findings only. Not a numbered phase. Phase 16 was not started.
**Base:** `e41b8b9`

---

## 1. Summary

| Objective | Result |
|---|---|
| **P0-1** Replace synthetic effect verification with observed browser state | **DONE** |
| **P0-2** Prove a genuine real-reasoner → real-Chrome autonomous run | **NOT ACHIEVED — blocked by environment, recorded honestly** |

P0-1 is closed and verified in real Chrome, including the negative case the
previous implementation could not produce. P0-2 could not be run: there is no
`GROQ_API_KEY` and the Python backend dependencies are not installed. **No
scripted proposer was substituted, and no synthetic response was used to stand
in for a real reasoner.** Section 6 records exactly where the run stops.

---

## 2. P0-1 — What was wrong

`AgentLoopCallbacks.getEffectSnapshot` was optional and **the service worker
never implemented it**. Both the pre- and post-action snapshots were therefore
synthesized inside `agentLoop.ts` **from the action that was requested**:

```ts
// the old post-snapshot synthesis
if (action.action === 'navigate') newUrl = action.url;            // always "changed"
else if (action.action === 'scroll') newScrollY += delta;         // always "moved"
else if (action.action === 'type')    newValLen = action.text.length;
else if (action.action === 'click' && domMutated) newDomCount += 1;
```

Consequence: in production `verifyActionEffect()` **could not fail for a
successful dispatch.** A click that did nothing still produced
`DOM_MUTATION_OBSERVED`. A navigate that never left the page still produced
`URL_NAVIGATION_OBSERVED`. The agent's only post-action truth check observed
nothing, while the dashboard displayed a hardcoded `VERIFIED`.

---

## 3. P0-1 — The fix

**No redesign.** The existing `PreActionSnapshot` / `PostActionSnapshot`
contract and `verifyActionEffect()` were already correct and are reused as-is.

### Content script — a dedicated snapshot message

`collectEffectSnapshot()` + `PRIVAGENT_GET_EFFECT_SNAPSHOT` /
`..._RESPONSE`. It reports only what the verifier already consumes: `url`,
`scrollX`, `scrollY`, `openModalsCount`, `activeElementSelector`,
`domElementCount`, and the target's value **length**. It reuses the existing
`findElementByTarget()` resolution and the same modal selector set the live
interactability check already uses.

Privacy properties, by construction:
- No field can hold a raw value. The target's `value` is read and only its
  **length** is returned.
- `activeElementSelector` is a **derived** structural identity
  (`tag:nth-child(n)`), not the site's raw `id`, which could carry page text.
- Unresolvable target → length `0` (a fail-safe, not a guess).

### Service worker — the observation channel

`getEffectSnapshot(target?)` sends the message to the pinned target tab, reads
the URL from **Chrome's own tab record** (which survives a mid-navigation
content-script teardown), validates the response shape, and **returns `null` on
any failure** — missing content script, closed tab, timeout, malformed
response, navigation race. 2 s tab-URL read timeout, 3 s content-script
timeout.

### Agent loop — fail closed

`observeEffectSnapshot(target, 'pre' | 'post')` centralises observation and
returns `null` when the host cannot observe.

- **PRE:** may still fall back to context-derived values — correct for a
  non-browser embedding that has no tab to observe.
- **POST:** **must not** fall back. An unobservable effect is recorded as
  `ACTION_NO_EFFECT` with an `EFFECT_UNVERIFIABLE` reason, counted against the
  existing retry budget and recovery path, and fails the task once retries are
  exhausted. The previous "derive post-state from the request" fallback is no
  longer reachable when a host has an observation channel.

---

## 4. P0-1 — Test results

### Focused: `tests/observedEffect/effectVerificationObserved.test.ts` — **17/17**

| Test | What it pins |
|---|---|
| 1 | A dispatch that changes nothing is `ACTION_NO_EFFECT` |
| 1b | **Regression pin:** reproduces the old synthesis and shows it reports `DOM_MUTATION_OBSERVED` for that same no-op, while the observed pair reports `ACTION_NO_EFFECT` |
| 2 | The navigate verdict is independent of the *requested* URL — two different requested destinations, same observed pair, same verdict |
| 2a | Loop level: a same-origin navigate that never moved is `ACTION_NO_EFFECT` |
| 2b | A navigate that lands on an error page still changed the URL, and says so (guards against over-correcting) |
| 2c | A real navigation to the observed destination is verified |
| 3 | Scroll verdict uses the observed offset, not the requested amount |
| 3b | An observed scroll is verified |
| 4 | A click whose target never receives focus is not inferred as success |
| 4a | A type that never reached the DOM is not inferred from dispatch success |
| 4b | An observed value-length change is verified, and the value never leaks |
| 5 | Snapshot failure fails **closed** |
| 5b | A snapshot provider that **throws** also fails closed |
| 6 | An observed snapshot cannot carry a raw secret (exact key set asserted) |
| 6b | The production message shape carries no raw value |
| 7 | The loop asks the host for a snapshot and passes the resolved target id |
| 8 | A host with **no** observation channel keeps the previous behaviour |

Tests 2a, 4, 4a, and 7 are at loop level; the rest assert the shipped verifier
directly. External navigation and `type` on a search field correctly halt at the
confirmation gate before dispatch, so those cases are proven at the verifier
layer instead — which is where the verdict is actually computed.

### Full regression: **1155 / 1155 across 99 files** (baseline 1138 / 98; +17 / +1)

No existing test was weakened or deleted.

### TypeScript: **5 errors, all pre-existing** in `extension/src/background/targetResolver.ts`
Unchanged from the `e41b8b9` baseline. Zero new.

### Builds: `build:extension` exit 0 · `build:frontend` exit 0

---

## 5. P0-1 — Real-Chrome acceptance: 9/9

`scratch/verify_observed_effect_no_effect.mjs` — Chromium `headless=new` over
CDP, the **built** `dist/` extension, a real served page, the real content
script, and `verifyActionEffect` **bundled from `extension/src`** (not
reimplemented).

| Case | Result |
|---|---|
| Production snapshot message responds | PASS |
| Snapshot carries no raw-value field | PASS |
| **Observed real scroll → `SCROLL_CHANGED`** | PASS |
| **NEGATIVE: scroll at the boundary → `ACTION_NO_EFFECT`** | PASS |
| **Dispatch success ≠ effect verified** | PASS |
| **Focus-only effect → `FOCUS_SHIFT_OBSERVED`** | PASS |
| **Observed type length change → `VALUE_STATE_CHANGED`** | PASS |
| Snapshot never contains the typed value | PASS |
| Unresolvable target reports 0, not a guess | PASS |

### Exact observed browser effect

**Negative case** (the required P0-1 proof). Action: `scroll down 600px` at the
document scroll boundary.

```
pre : url=http://localhost:4198/  scrollY=3181  domElementCount=23  modals=0
post: url=http://localhost:4198/  scrollY=3181  domElementCount=23  modals=0
dispatch: success=true   ("Scroll produced no viewport movement (boundary reached).")
verdict : hasEffect=false  status=ACTION_NO_EFFECT
          diagnostics { urlChanged:false, scrollDelta:0, valueLengthChanged:false,
                         modalsChanged:false, domMutated:false, focusChanged:false }
```

**This is the exact distinction the previous implementation could not make.**
The dispatch was acknowledged, the browser did not move, and the verdict says
so — from observation, not from the request.

**Positive control.** `scroll down 600px` from the top: observed
`scrollY 0 → 600`, verdict `SCROLL_CHANGED`. The observed delta produced the
verdict, not the requested 600.

**Subtle control.** A click on a button with no handler changed nothing except
focus (`body → button:nth-child(3)`), and was correctly reported as
`FOCUS_SHIFT_OBSERVED` — a real effect the old synthesis would have
mislabelled as a DOM mutation. This guards against over-correcting into
"everything is a no-op".

---

## 6. P0-2 — Real reasoner E2E: NOT ACHIEVED

**Status: blocked by environment. No workaround was invented and no substitute
was used.**

Verified blockers:

| Requirement | State |
|---|---|
| `GROQ_API_KEY` | **absent** — no `.env` or `.env.local` exists; `freebuff-env list` reports zero keys |
| `fastapi` | not installed |
| `uvicorn` | not installed |
| `pydantic` | not installed |
| `groq` | not installed |
| `pytest` | not installed |

The backend cannot start, and even if it could, the reasoner would fail closed
with no key. Per the brief's stop conditions, this is reported rather than
worked around.

**What this means precisely:** a complete
`START_TASK → … → observed effect → goal verification → terminal success` chain
driven by a live cloud model has **not** been demonstrated. Everything upstream
and downstream of the reasoner call has been verified independently:

- Upstream (perception, sanitization, containment, harness): real Chrome, 8/8.
- The reasoner request/rejection path: real Chrome, 8/8
  (`scratch/verify_reasoner_failure_path.mjs`).
- Downstream (dispatch → observed state → effect verdict): real Chrome, 9/9,
  including the negative case.
- The gap between them is the live model itself, which is a credential and
  environment dependency, not a code defect.

To complete P0-2: add `GROQ_API_KEY` in Settings → Environment, install
`backend/requirements.txt`, start the backend on `127.0.0.1:8010`, then run the
canonical task. No code change is expected to be required.

---

## 7. Security-authority diff

**No security authority was added, removed, moved, reordered, widened or
weakened.**

| Authority | Status |
|---|---|
| Target Grounding | unchanged, still first |
| M5 Validator | unchanged |
| Security Critic | unchanged, still after M5 |
| Privacy Policy | unchanged |
| Risk / Semantic / Confidence | unchanged |
| Confirmation | unchanged, still blocking |
| Containment | unchanged, still the last gate before dispatch |
| Harness | unchanged, still non-authoritative |
| Recovery | unchanged, still proposes only |

Effect verification is a **post-dispatch truth check**, not an authorization
layer, and remains one: it can only mark a dispatched action unverified. It
grants nothing and was not moved ahead of any gate.

Explicitly unchanged: Phase 15 semantics, OCR (still dormant — not activated),
watchdog thresholds and architecture, redaction, the privacy policy table,
`providerRetries` (still 0 — P1-3 was **not** changed, as no run justified it),
and the planner-context budget (P1-1 **not** changed — no run justified it).

**No fabricated LLM response. No scripted proposer used for any acceptance
result.** The only scripted provider is `MockAgentProvider` inside the unit
suite, as before.

---

## 8. UI honesty (minimal, no redesign)

| Element | Before | After |
|---|---|---|
| Step 7 Effect Verification | hardcoded `VERIFIED` badge + "Browser state progressed" | runtime-driven from the observed verdict: `VERIFIED` / **`NO EFFECT`** / `PENDING`, with the observed detail and the `EffectStatus` code |
| Step 6 Chrome Effect | "CDP command executed successfully; DOM mutated as expected" | "The action was dispatched to the target tab and acknowledged" (no DOM-mutation claim) |
| Reasoner label | `Groq / gpt-oss-20b` | `Groq / gpt-oss-20b (configured)` with a tooltip stating it is a configuration statement, not a per-run observation |

The provider label is marked "configured" because the extension does **not** yet
capture the provider telemetry the backend returns. The brief conditioned this
change on the runtime *already having* authoritative data; it does not, so the
honest minimal action was to stop asserting it as an observation rather than to
build a telemetry pipeline.

---

## 9. README corrections

Only demonstrably stale or misleading claims were changed; the README was not
rewritten.

1. **Real-Chrome E2E** — no longer claims verified end-to-end execution; states
   that no complete live-reasoner autonomous run exists in the repository's
   evidence and points at `stage2-real-browser` and `post-phase15-e2e`.
2. **M1–M12** — capability intro now distinguishes implemented/unit-tested from
   real-Chrome validated.
3. **OCR** — marked implemented and unit-tested but **dormant in the agent
   loop**, with the popup noted as the live caller.
4. **Action-Effect Verification** — rewritten to describe the observed
   snapshot path and the `ACTION_NO_EFFECT` outcome.
5. **Evaluation table** — added an explicit note that **every** metric is a
   test-set or fixture measurement, not a live production measurement; the
   effect-verification row is now qualified as fixture-supplied snapshots.
6. **Test counts** — `451 tests` → `1155 tests, 99 files`; the pytest count is
   no longer asserted (it is not runnable here).
7. **Reasoner** — "Groq / Fallback OpenRouter" → "Groq by default". Fallback is
   only active if `REASONER_FALLBACK_PROVIDER` is set, which it is not by
   default.

---

## 10. Known limitations

1. **P0-2 is not complete.** No live-reasoner autonomous run exists. This is the
   single most important open item.
2. **The negative acceptance case is a real-Chrome seam, not a full agent run.**
   It exercises the exact production observation + verification code the loop
   calls into, against a real browser, but the loop is not driven because that
   needs the reasoner.
3. **The observed scroll delta can coincidentally equal the requested amount.**
   In this run it did (600/600). The negative case deliberately avoids relying
   on that difference.
4. **The service worker hardcodes `dashboardOrigin: 'http://localhost:5173'`.**
   Pre-existing, untouched, and a latent mismatch when the dashboard runs on
   another port.
5. **Five pre-existing `tsc` errors** in `targetResolver.ts` remain by design.
6. **`assertNoSensitiveDataInState()`** still runs only on the loop's success
   path; other boundaries are covered by the existing scanners.
7. **OCR remains dormant** and PII rendered only into canvas/image regions is
   still not seen by the agent loop.

---

## 11. Final verdict

P0-1 is **fixed and verified**, in unit tests and in real Chrome, including the
negative case that was previously unreachable. Post-dispatch state is now
observed, an unobservable effect fails closed, and the dashboard can no longer
display `VERIFIED` for an action that changed nothing.

P0-2 is **not achieved**, and the honest boundary is environmental: no
`GROQ_API_KEY`, and the Python backend dependencies are not installed. No
scripted proposer or fabricated response was used to paper over this.
