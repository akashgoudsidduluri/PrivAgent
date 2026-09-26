# Phase 11 Acceptance Evidence — Human-Like Browser Interaction

All numbers in this document come from commands that were actually executed in
this repository. Nothing here is a claim about intended behaviour.

| Item | Command | Result |
| --- | --- | --- |
| Phase 11 acceptance suite | `npx vitest run tests/phase11/` | **4 files / 109 tests passed** |
| Full regression suite | `npx vitest run` | **92 files / 907 tests passed** (110.84 s) |
| TypeScript | `npx tsc -b --noEmit` | **exit 0** |
| Extension build | `npm run build:extension` | **exit 0** — `dist/contentScript.js` 108.21 kB |
| Real Chrome acceptance | `node scratch/verify_phase11_human_interaction.mjs` | **completed** — evidence JSON + 3 screenshots |
| Backend (pytest) | `python3 -m pytest backend/tests` | **not runnable** — `No module named pytest` in this environment |

Baseline before this work: **88 files / 798 tests**. Delta: **+4 files / +109
tests**, all Phase 11, zero pre-existing tests modified or removed.

---

## 1. What Phase 11 added on top of the existing stack

Phase 11 introduces **no new authority**. `humanInteraction.ts` is a pure,
value-free quality layer; the authoritative pipeline is unchanged and still runs
in this order for every action:

```
perception → long-horizon bounds → planner context → goal check → reasoning
→ GATE 1 Target Grounding → GATE 2 M5 → GATE 2.5 Security Critic
→ GATE 3 Privacy Firewall → GATE 4 Risk/Confirmation → execution
→ effect verification → Phase 10 Recovery → goal verification
```

### Defects found and fixed in this phase

`pressKey` existed in the type union, the validator, the executor and the
privacy policy, but **five gates in the middle of the pipeline had never heard
of it**, so a targeted `pressKey` was rejected or mis-scored before it could
ever execute. Each fix is the smallest possible one and none of them loosens a
check:

| File | Defect | Fix |
| --- | --- | --- |
| `groundingEngine.ts` | `isActionCompatibleWithType` had no `pressKey` case, so GATE 1 returned `TARGET_MISMATCH` for every targeted key press | added `case 'pressKey': return formControlLike;` — structural only; the M5 allowlist and `FOCUS_MISMATCH` remain authoritative |
| `oneActionPlanner.ts` | atomic-shape switch had no `pressKey` case, so every key press was `Unrecognized action type` | added shape validation (string `key`, string `target` when present) |
| `securityCritic.ts` | mismatch switch had no `pressKey` case, so **every** key press was a `GOAL_MISMATCH` BLOCK | added `case 'pressKey': return false;` *after* the destructive/consequential cross-check, which still runs first |
| `riskEngine.ts` | base-risk switch had no `pressKey` case, so key presses scored the base LOW 0.05 | `MEDIUM`, `+0.20`, with an explicit reason string |
| `effectVerifier.ts` | effect switch had no `pressKey` case, so a key press hit `default: return { hasEffect: true, status: 'EFFECT_OBSERVED' }` — **unverified success** | full branch mirroring click/type; an inert key is now `ACTION_NO_EFFECT` with `shouldRecover: true` |
| `contentScript.ts` | `pressKey Enter` guarded on `active.requestSubmit`, but `requestSubmit` lives on the **form**, not on a control — so Enter never submitted anything | resolve the owning form from the already-focus-verified control, then `requestSubmit()` it. Still only ever submits the form the focused control is in. |

`assessLiveInteractability` and `executeBrowserAction` were exported so the real
executor can be driven under jsdom (no behaviour change).

---

## 2. Required behavioural coverage

`tests/phase11/` — 109 tests, organised by the acceptance matrix:

| Required behaviour | Where | Count |
| --- | --- | --- |
| Basic click | `domExecution.test.ts` P11-5 | 9 |
| Duplicate / ambiguous targets | `interactionPrimitives.test.ts` P11-4, `domExecution.test.ts` P11-7 | 7 |
| Hidden / disabled target | `domExecution.test.ts` P11-5 | 6 |
| Typing | `domExecution.test.ts` P11-8 | 7 |
| Replacement (not concatenation) | `domExecution.test.ts` P11-8.3 | 1 |
| Select / dropdown | `domExecution.test.ts` P11-9 | 6 |
| Focus mismatch | `domExecution.test.ts` P11-8.4, P11-9.5, P11-10.6/7 | 5 |
| Safe keyboard action | `interactionPrimitives.test.ts` P11-3, `domExecution.test.ts` P11-10 | 12 |
| Off-screen target | `domExecution.test.ts` P11-11 | 3 |
| Bounded scrolling | `interactionPrimitives.test.ts` P11-2 | 7 |
| Dynamic DOM | `domExecution.test.ts` P11-12 | 2 |
| Overlay / modal | `domExecution.test.ts` P11-6 | 3 |
| No-effect action + recovery | `pipelineGates.test.ts` P11-18, `agentLoopInteraction.test.ts` P11-20.2 | 9 |
| Sensitive input | `pipelineGates.test.ts` P11-15 | 6 |
| M5 enforcement | `pipelineGates.test.ts` P11-14 | 11 |
| Security Critic enforcement | `pipelineGates.test.ts` P11-16 | 6 |
| Grounding | `pipelineGates.test.ts` P11-13 | 5 |
| SPA behaviour | `agentLoopInteraction.test.ts` P11-20.5 | 1 |
| Long-horizon interaction | `agentLoopInteraction.test.ts` P11-20.4 | 1 |
| Page generation / navigation | `pipelineGates.test.ts` P11-13.4, P11-18.3 | 2 |
| Goal verification | `pipelineGates.test.ts` P11-19, `agentLoopInteraction.test.ts` P11-20.1 | 3 |
| Regression coverage | full suite (907 tests) | — |

The DOM-level cases run the **real** `executeBrowserAction` from
`extension/src/content/contentScript.ts` under jsdom — there is no mock action
runner. The only shims are `chrome.runtime` (the content script registers a
listener at import) and `Element.prototype.scrollIntoView` (jsdom does not
implement it).

---

## 3. Real Chrome acceptance run

Harness: `scratch/verify_phase11_human_interaction.mjs`
Machine-readable evidence: `phase11_human_interaction_evidence.json`
Screenshots: `phase11_scenarioA_google.png`, `phase11_scenarioC_fixture_task_success.png`, `phase11_scenarioB_fixture.png`

Provenance of the run:

* browser: real Chromium (`--headless=new`) driven over CDP;
* perception: the real content script running in a real tab;
* execution: the real content-script dispatcher acting on the live page;
* security pipeline: real PrivAgent source bundled from `extension/src`;
* target-tab provisioning: the **real service worker**
  (`PRIVAGENT_DASHBOARD_START_TASK`);
* reasoner: a deterministic goal-driven local policy that only *proposes*.
  It never executes, never recovers and never decides success.

### 3.1 Scenario A — real Google: "open google and search for black cats"

| # | Acceptance point | Recorded result |
| --- | --- | --- |
| 1 | Dashboard remains isolated | dashboard tab `1871161667` at `chrome-extension://…/popup.html`; URL **identical before and after** the task |
| 2 | Correct target tab provisioned | real service worker created tab `1871161668` at `https://www.google.com/` — id differs from the dashboard |
| 3 | Target content script attaches | first sanitized scan returned 14 detections |
| 4 | Page perceived / grounded | GATE 1 `grounded: true` for the search field |
| 5 | M5 + security gates execute | M5 `allowed: true`; Critic `ALLOW / NO_OBJECTION`; Privacy `granted: true`; Risk `MEDIUM` — recorded per action in `gateTrace` |
| 6 | Multiple human-like interactions | 6 executed steps: `type` → `pressKey(Enter)` → 4 × `scroll` |
| 7 | Safe-key allowlist only | `onlyAllowlistedKeysUsed: true`; allowlist is `["Enter","Escape","Tab","ArrowUp","ArrowDown"]` |
| 8 | Focus verified before delivery | `pressKey Enter` on `ti6dpd` returned `Delivered 'Enter' to the focused control.` — the executor fails closed with `FOCUS_MISMATCH` otherwise |
| 9 | Bounded scrolling / re-perception | every scroll was a validated `scroll down by 300px` action; each re-perception logged |
| 10 | Effect verification per action | `type` → `VALUE_STATE_CHANGED`; `pressKey(Enter)` → `URL_NAVIGATION_OBSERVED`; each `scroll` → `ACTION_NO_EFFECT` (zero viewport movement at the page boundary) |
| 11 | Recovery invoked on no-effect | `totalRecoveryAttempts: 3`, Phase 10 engine chose `REPERCEIVE` then escalated to `REPLAN_SUBGOAL` |
| 12 | Final goal verification | **did not succeed on Google** — see below |

**Why Google did not complete.** The key press was delivered and the search was
genuinely submitted: Google redirected to
`https://www.google.com/sorry/index?continue=…search%3Fq%3Dblack%2Bcats…`,
i.e. an automated-browser interstitial. `googleServedInterstitial: true`.

Goal verification correctly refused to call this a success — the observed URL
contained no `q=` on a results path, so a goal state driven purely by Google
would have been a **false positive**. No security or verification rule was
weakened to accommodate Google. The user-permitted deterministic fallback was
used instead, and the identical real stack was run against it.

### 3.2 Scenario C — deterministic fixture, identical real stack

Because Google is unsuitable for a repeatable run, the same run was repeated
against a local deterministic page (`http://localhost:4191/`). Nothing about the
stack changes; only the page does.

| Field | Recorded value |
| --- | --- |
| final status | **SUCCESS** |
| goal status | **SUCCESS** |
| goal reason | `Search goal verified against observed results URL: query 'black cats' present at 'localhost'.` |
| final URL | `http://localhost:4191/results?q=black+cats` |
| step 1 | `type` into `#q` → `VALUE_STATE_CHANGED` (length 10) |
| step 2 | `pressKey('Enter')` on `#q` → `URL_NAVIGATION_OBSERVED` |
| safe keys only | `true` |

This is a complete human-like path: focus the field, type, press Enter on the
focused control, observe the navigation, verify the effect, then verify the goal
against the **observed** URL — with every security gate in between.

### 3.3 Scenario B — interactions Google cannot demonstrate

| Behaviour | Recorded result |
| --- | --- |
| Off-screen target | target top at `1722.9px` vs `757px` viewport; `scroll down 600px` → `Scrolled down by 600px.`, `scrollY 0 → 600`; M5 allowed; delta ≤ the validated 600px and ≤ `VIEWPORT_BOUNDS.maxAutoScrollPx` (2400) |
| Duplicate click | first click `Clicked element 'behind-modal'.`; second `DUPLICATE_CLICK_SUPPRESSED: identical target clicked within the duplicate window; use recovery.` — **no second dispatch** |
| Modal overlay | `offscreen-cta` opened a real `<dialog open>`; `openModalsInPage: 1`; clicking the control behind it → `INTERACTABILITY_BLOCKED: An active modal overlay does not contain the target.` — **no click-through** |
| Off-allowlist key | proposed `pressKey 'Delete'` → M5 `Action 'pressKey' key 'Delete' is not on the safe-key allowlist.` **and** the executor independently refused with `UNSAFE_KEY` (defence in depth) |
| Focus mismatch | `pressKey Enter` aimed at `behind-modal` while focus was elsewhere → `FOCUS_MISMATCH: expected focus on 'behind-modal' but focus is elsewhere.` — **no key delivered** |

### 3.4 Run summary

```json
{
  "dashboardIsolated": true,
  "targetTabProvisioned": true,
  "contentScriptAttached": true,
  "pagePerceivedAndGrounded": true,
  "m5AndSecurityGatesRan": true,
  "multipleHumanLikeInteractions": true,
  "safeKeysOnly": true,
  "effectVerificationRan": true,
  "recoveryInvoked": true,
  "goalVerified": false,
  "googleServedInterstitial": true,
  "deterministicEndToEndGoalVerified": true,
  "scenarioBAllBehavioursConfirmed": true
}
```

`goalVerified: false` is the **Google** run only. It is recorded rather than
hidden: the deterministic end-to-end run of the identical stack
(`deterministicEndToEndGoalVerified: true`) is the passing evidence for goal
verification.

---

## 4. Invariants re-asserted by the suite

Each of these is asserted directly, not inferred:

* **Grounding** — ungrounded, type-incompatible, zero-geometry and
  stale-generation targets are still rejected, including for `pressKey`
  (P11-13).
* **M5** — owns the safe-key allowlist; rejects non-string keys, over-long key
  strings, unknown fields, sensitive fields on a `pressKey`, and
  `bypass_confirmation` with `M5_UNMODIFIABLE` (P11-14).
* **Security Critic** — still fails closed on malformed input and on an
  unsanitized context for a key press, and the destructive-intent cross-check
  still runs *before* the `pressKey` case (P11-16.2–16.4).
* **Privacy Firewall** — `pressKey` maps to `CLICK` capability only; it can
  never obtain `TYPE` or `READ_SENSITIVE_VALUE` (P11-15.6).
* **Risk / confirmation** — `pressKey` is `MEDIUM` and scores above a plain
  scroll (P11-16.5–16.6).
* **Effect Verification** — a `pressKey` is never assumed successful; there is a
  regression guard asserting the bare `EFFECT_OBSERVED` status can no longer be
  produced for any snapshot pair (P11-18.2).
* **Goal Verification** — a typed-but-unsubmitted query is not success
  (P11-19.2); a SPA-style URL change alone is not success (P11-20.5).
* **Phase 10 Recovery** — an inert key press produces `ACTION_NO_EFFECT` and is
  handed to the existing `RecoveryEngine`; Phase 11 adds no second recovery
  system (P11-20.2).
* **No raw values in agent-facing payloads** — the interactability report and the
  type result carry only booleans, indices and lengths; `assertNoSensitiveDataInState`
  passes on a live multi-step run (P11-1.8, P11-8.2, P11-20.6).
* **The harness does not decide browser actions** — it proposes through the
  reasoner and reads back what the real stack did
  (`harnessExecutesActions: false`, `harnessPerformsRecovery: false`,
  `harnessDecidesSuccess: false`).

---

## 5. Environment limitations (not product gaps)

1. **Google blocks automated browsers.** Redirected to `/sorry/index` after the
   real `pressKey Enter` submission. Handled with the user-sanctioned
   deterministic fixture; no rule was relaxed.
2. **Backend (pytest) suite cannot run here** — `No module named pytest`. The
   Phase 11 acceptance surface is entirely in the extension; no backend module
   was changed, so the backend suite is unaffected by this work.
3. **Headless Chrome is used** (`--headless=new`), matching the established
   Phase 9/10 harnesses in this repository. There is no display in this
   environment.
