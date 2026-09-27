# PrivAgent — Negative / Fail-Closed Demo Runbook

**Commit:** `593fe72` · **Date:** 2026-09-27

**Purpose.** A success run proves nothing on its own. This runbook demonstrates that the system **refuses when it should** — that gates actually block, that a successful dispatch is not treated as success, and that the privacy scanner is not tuned to let the happy path through.

**Two demos:**
- **Demo N1 — no-effect falsifier.** Dispatch succeeds, the browser does not move, verdict is `ACTION_NO_EFFECT`. *(Real Chrome, 9/9, re-verified this pass.)*
- **Demo N2 — M5 / PII block.** The reasoner proposes a valid action whose *reason text* trips the privacy scanner, and the action is blocked. *(Real browser, real reasoner, live Google.)*

**Rule:** the scanner is **not** weakened, retuned, or bypassed to make any demo succeed. A block is a successful demo.

---

## Demo N1 — Dispatch succeeded, nothing happened

### What it proves

That `verifyActionEffect` decides from **observed** browser state, not from the requested action. This is the falsifier for the success demo: if this seam could not fail, the `SUCCESS` in `FINAL_DEMO_RUNBOOK.md` would mean nothing.

### Run it

```bash
cd /home/daytona/codebase
node scratch/verify_observed_effect_no_effect.mjs
```

No reasoner required. Uses real Chrome, the real content script loaded from `extension/dist/`, the real `PRIVAGENT_GET_EFFECT_SNAPSHOT` message, and the real `verifyActionEffect()` bundled from source (not reimplemented). Fixture on port 4198.

### Expected output

```
[EFFECT] REAL CHROME — observed snapshot + effect verification
  [PASS] productionSnapshotMessageResponds
  [PASS] snapshotCarriesNoRawValueField
  [PASS] observedRealEffectIsVerified
  [PASS] negativeNoOpIsActionNoEffect
  [PASS] dispatchSuccessDoesNotImplyEffect
  [PASS] focusOnlyEffectIsDetectedAsRealEffect
  [PASS] observedTypeLengthChangeIsVerified
  [PASS] snapshotNeverContainsTheTypedValue
  [PASS] unresolvableTargetReportsZeroNotAGuess

[EFFECT] 9 passed, 0 failed
```

### The money shot

Scroll to the bottom of a long page, then request another 600 px scroll down.

| | |
|---|---|
| `preScrollY` | 5356 |
| `postScrollY` | **5356** |
| Requested | 600 px |
| **Observed delta** | **0 px** |
| **Verdict** | **`ACTION_NO_EFFECT`** |
| Details | *"Scroll down produced zero viewport movement (scrollDelta: 0px). Viewport likely hit scroll boundary."* |

Diagnostics recorded: `urlChanged false`, `scrollDelta 0`, `valueLengthChanged false`, `modalsChanged false`, `domMutated false`, `focusChanged false`.

**And the explicit decoupling check:**

```json
{ "dispatchSucceeded": true, "effectVerified": false }
```

> **Say this explicitly during the demo:** *"The action dispatched successfully. The browser did not move. The system reported failure. That is the whole point — before this was fixed, post-action state was synthesized from the requested action, which meant effect verification **could not fail**."*

### The other eight checks (do not skip these)

| Check | Demonstrates |
|---|---|
| `productionSnapshotMessageResponds` | The real content script answers on the real message channel, with real fields |
| `snapshotCarriesNoRawValueField` | The snapshot carries `targetValueLength`, never a value — `forbiddenKeysPresent: []` |
| `observedRealEffectIsVerified` | A real 600 px scroll → `SCROLL_CHANGED`, decided on the **observed** 600, not the requested 600 |
| `focusOnlyEffectIsDetectedAsRealEffect` | Guards against over-correcting: `FOCUS_SHIFT_OBSERVED` is a *real* effect, not a failure |
| `observedTypeLengthChangeIsVerified` | A real typing event → `VALUE_STATE_CHANGED` |
| `snapshotNeverContainsTheTypedValue` | After typing into a real field, the typed text never appears on the wire |
| `unresolvableTargetReportsZeroNotAGuess` | An unresolvable target reports length **0**, not a fabricated value |

> **Honest scope note.** This harness does **not** drive the full agent loop — it needs a live reasoner, which is out of scope for this seam. It exercises the exact production observation and verification code the loop calls into, against a real browser. The evidence artifact records `synthetic: false` and `securityGatesTouched: false` explicitly.

---

## Demo N2 — M5 blocks on a privacy finding

### What it proves

That the privacy scanner is **not** tuned to accommodate the happy path. A perfectly reasonable action was blocked because the *reason text* the reasoner generated contained a string the scanner classified as possible PII.

### Run it

```bash
cd /home/daytona/codebase
node scratch/verify_real_reasoner_e2e.mjs
```

Real Google, real Groq. **Note:** this run does not end in `SUCCESS` and is not supposed to. See "Expected outcome" below.

### The sequence

1. Task: `open https://www.google.com and search cats`
2. The real reasoner types `cats` into the Google search box → `VALUE_STATE_CHANGED`, observed length 4. **This part works.**
3. The reasoner then proposes clicking the search button. Its reason text is: *"Submit the search query 'cats' by clicking the search button."*
4. The **reason text** contains `cats`, which the local PII scanner interprets as a possible `person_name`.
5. **M5 fails closed and blocks the action.**

| | |
|---|---|
| Proposed action | `click` → `gbqfbb` (the Google search button) |
| M5 result | **BLOCKED** |
| Cause | Reason text read as possible `person_name` |
| Is this a defect? | **No.** It is correct fail-closed behaviour. |

> **Say this explicitly during the demo:** *"The reasoner proposed a correct action. Our privacy scanner rejected it because of the words in its explanation, not because the action was wrong. We are not going to weaken the scanner to make the demo look better — a system that lets a false positive through to make a demo succeed is not a privacy system."*

### Expected outcome (and why it is honest)

This run ends in terminal `FAILED` / `REASONER_FAILED`, for two documented reasons:

| Cause | Detail |
|---|---|
| Google's anti-bot interstitial | Headless Chrome with a fresh profile lands on `https://www.google.com/sorry/index?...` instead of results. **A product boundary — PrivAgent does not attempt to bypass bot challenges.** |
| Provider failure at the end | Groq returned `rate_limit`; the fallback returned `unexpected_format` → HTTP 503 → `FAILED` with **0 speculative dispatches** |

`providerRetries` was left at `0`. No evidence establishes retries as the correct fix, so it was not changed.

### A defect this run *did* find

Worth showing, because it demonstrates the harness works: every reasoner request originally carried `detectionCount: 0`. `buildAgentPayload` was **replacing** DOM detections with a visual report that contains only sensitive entities — so every interactive affordance was dropped before reasoning. Fixed in `extension/src/privacy/types.ts` (DOM detections are now the base, visual detections merged in for uncovered elements). `0 → 7` on Google, `2` on the fixture.

---

## Additional fail-closed demonstrations (test-backed, no live run required)

Present these verbally. Do **not** claim them as live-browser observations — none was triggered by a live reasoner.

| Scenario | Behaviour | Evidence |
|---|---|---|
| Agent tries to open a local port itself | `DESTINATION_REQUIRED` — the resolver refuses to provision or hijack a local port | **Live** (first controlled-run attempt) |
| Hallucinated target | Grounding rejects; M5 re-runs on any healed variant | `candidateVerification.test.ts`, `m5EndToEnd.test.ts` |
| Out-of-scope navigation | Containment refuses | `containment.test.ts` (43) |
| High-risk action | Pauses for explicit confirmation at `#agent-confirm-allow` | `riskEngine.test.ts` |
| Unmappable PII finding | Escalated, not dropped: `unmappable: true`, `exportable: false` | `phase15/privacyFusionContextual.test.ts` (59) |
| Unknown PII category | `FAIL_CLOSED`, never exported | `privacyDecision.test.ts` (16) |
| Raw value in payload | `PrivacyBoundaryError`; export terminated | `rawValueScanner.test.ts` (17) |
| Slow/hung reasoner | Loop terminates rather than hanging | `reasoner_failure_path_evidence.json` |

---

## Presenting N1 and N2 together

The pairing is the argument. Run the success demo, then immediately run the no-effect demo and say:

> *"That run ended in `SUCCESS`, and the goal verifier read the state from a real browser rather than being told what to conclude. Here is the proof that those states are actually being observed: the same seam, given an action that dispatches successfully and does nothing, reports `ACTION_NO_EFFECT`. If it couldn't fail there, it couldn't be trusted here."*

That is the difference between a demo and a claim.

---

## Limitations

1. **N1 does not drive the full agent loop.** It exercises the production observation + verification seam, not the loop that calls it. Recorded as such in the evidence artifact.
2. **N2's block is a false positive** on a perfectly valid action. That is the correct trade for a fail-closed privacy scanner, but it *is* a false positive, and the team should say so rather than present it as a catch in the wild.
3. **N2 ends in provider failure**, so it cannot cleanly isolate the M5 block as the *sole* terminal cause.
4. **The confirmation gate has never been triggered by a live reasoner.** Its only evidence is test coverage. Do not demo it as if it has been seen live.
5. **Google's anti-bot behaviour is not a PrivAgent defect** and no engineering effort should be spent bypassing it. It is presented as a boundary, which is what it is.
