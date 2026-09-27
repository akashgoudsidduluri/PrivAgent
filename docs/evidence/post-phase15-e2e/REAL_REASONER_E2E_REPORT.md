# P0-2 — Real Reasoner End-to-End Run: Final Report

**Not Phase 16.** Bounded validation of the autonomous pipeline against a real
backend and a real configured reasoner.

Base: `b4bc3f5` · Task: `open google and search cats`

---

## 1. Verdict

**A real reasoner drove a real browser, and the pipeline genuinely worked — but
the task did not reach a verified goal, and no amount of application change
should have made it report success.**

The chain executed for real: real Groq, real actions, real gates, real
dispatch, and real *observed* browser effects. The browser genuinely received
`cats` in Google's search box and genuinely navigated to a `q=cats` search URL.

The task ended `FAILED` for two reasons that are **not application defects**:

1. **M5 correctly refused an action.** The reasoner put the literal word
   `cats` into the click action's `reason` field; the text-safety scanner
   classified it as a possible `person_name` and failed closed. That is the
   security gate working. It was not bypassed, weakened, or reordered.
2. **Google served its anti-bot interstitial.** The browser was redirected to
   `google.com/sorry/index?continue=…q%3Dcats…`. PrivAgent does not attempt to
   bypass CAPTCHAs or bot challenges; that is a documented product boundary.

A transient Groq `rate_limit` then produced the terminal `REASONER_FAILED`.

---

## 2. The one concrete defect the run found, and the fix

### Symptom
Every reasoner request carried **`detectionCount: 0`** — captured off the wire
via CDP `Network.requestWillBeSent` on the real service worker, with no
application code modified. The reasoner literally said
*"No search box element detected; scrolling to reveal it"* and proposed
`scroll` three times, which on Google is inert.

### Isolation
Sending the **same real Google context** to the **same real backend** in a
standalone probe returned the correct action —
`{"action":"type","target":"ti6dpd","text":"cats"}` — so neither the reasoner
nor the context budget was at fault.

- `scratch/verify_planner_context_google.mjs` proved **P1-1 is NOT the cause**:
  the search box `#ti6dpd` and the real search button `input[name="btnK"]` both
  survive into the planner context. (P1-1 was real in the older Stage 7 run;
  the search-intent priors added since now keep those affordances.)
- `scratch/probe_reasoner_response.mjs` proved the reasoner is capable.

### Root cause
`buildAgentPayload()` in `extension/src/privacy/types.ts` **replaced** the DOM
detection list with `visualReport.visualDetections` whenever a visual report
was present. But the multimodal coordinator builds `visualDetections` by
skipping every detection that is not a sensitive entity:

```ts
for (const det of scanReport.detections) {
  if (!isSensitiveEntityType(det.type)) continue;   // every affordance dropped
  ...
}
```

The agent loop *always* has a visual report, so the reasoner was routinely
handed **only sensitive elements and zero interactive controls**. This was
introduced when multimodal perception was wired into the loop; it was not a
Phase 15 change and Phase 15 was not involved.

### Fix
`extension/src/privacy/types.ts` — the DOM detections are now the base
(preserving their `length` and `label`), and visual detections are **merged in**
for any element the DOM scan did not already cover. Viewport, screenshot
dimensions and OCR metrics still come from the visual report. The no-visual
path is unchanged.

Nothing else was touched: the reasoner, the gates, the watchdog, OCR, Phase 15,
containment and the harness are all untouched.

### Result
`detectionCount` went **0 → 7**, and the reasoner immediately proposed
`type "cats"` into the real search box.

---

## 3. The eight distinctions (Part C)

| # | Claim | Result | Evidence |
|---|---|:---:|---|
| 1 | Backend was reachable | ✅ | `/openapi.json` 200; 8 real `POST /api/v1/agent/action` |
| 2 | Backend called the real provider | ✅ | telemetry `provider: "groq"`, `model: openai/gpt-oss-20b`, `fallback_used: false`, 813 ms |
| 3 | Reasoner returned a valid action | ✅ | `type "cats"` → `ti6dpd` |
| 4 | Action passed backend validation/normalization | ✅ | HTTP 200, schema-validated |
| 5 | Action passed extension gates | ✅ | Grounding + M5: *"Validated type action on known element 'ti6dpd'."* |
| 6 | Action was dispatched | ✅ | `executionSuccess: true` |
| 7 | **Browser state actually changed** | ✅ | **observed** `VALUE_STATE_CHANGED`, *"length: 4"* — the real input received 4 chars |
| 8 | **Goal actually achieved** | ❌ | final URL is Google's anti-bot interstitial, not a results page |

Backend startup, HTTP 200, the action proposal, gate passage and dispatch
success are each recorded — **none of them is treated as goal achievement.**

---

## 4. Observed effects (Part E) — from real browser state, never the request

| Step | Action | Gate | Observed effect verdict | Observed detail |
|---|---|---|---|---|
| 1 | `type "cats"` → `ti6dpd` | M5 ALLOWED | `VALUE_STATE_CHANGED` | target value length 0 → **4** |
| 2 | `click` → `gbqfbb` | **M5 BLOCKED** | — | *"Action reason appears to contain sensitive values (PII)"* |
| 3 | `pressKey Enter` → `ti6dpd` | M5 ALLOWED | **`ACTION_NO_EFFECT`** | no observed URL / value / modal / focus / DOM change |
| 4 | `click` → `inter-link-1` | M5 ALLOWED | `URL_NAVIGATION_OBSERVED` | navigated to the `q=cats` Google interstitial |

Step 3 is the P0-1 fix working in production: the action was dispatched
successfully and the loop still refused to call it an effect, because the
**observed** state had not changed. Step 4 shows an effect verdict derived from
the real tab URL.

---

## 5. Negative control (Part F) — retained

`scratch/verify_observed_effect_no_effect.mjs` — **9/9 PASS** in real Chrome,
unchanged by this work:

- `scroll down 600px` at the document boundary: dispatch **succeeded**,
  `scrollY 3181 → 3181`, verdict **`ACTION_NO_EFFECT`**.
- `dispatchSuccessDoesNotImplyEffect` — the exact distinction the old
  synthesized post-snapshot could not make.
- A focus-only click is still correctly reported as `FOCUS_SHIFT_OBSERVED`
  (guards against over-correcting into "everything is a no-op").

---

## 6. Security invariants (Part G)

Verified byte-identical to `b4bc3f5` — `git status` over
`actionValidator.ts`, `securityCritic.ts`, `containment.ts`, `harness.ts`,
`groundingEngine.ts`, `privacyPolicy.ts`, `riskEngine.ts`, `recoveryEngine.ts`,
`agentLoop.ts`, `fusion.ts`, `contextualPii.ts`, `privacyDecision.ts`, all of
`extension/src/ocr/`, all of `backend/`, `extensionAdapter.ts` and
`agentView.ts` returned empty.

| Invariant | Status |
|---|---|
| Grounding authoritative | unchanged |
| M5 authoritative | unchanged — **and it demonstrably blocked a real action** |
| Security Critic authoritative | unchanged (`/agent/review` called 3×) |
| Privacy Policy authoritative | unchanged |
| Risk/Semantic/Confidence | unchanged |
| Confirmation authoritative | unchanged |
| Containment authoritative | unchanged — established, and re-checked at dispatch |
| Harness authorizes nothing | unchanged |
| Effect verification grants nothing | unchanged — post-dispatch truth check only |
| Recovery cannot bypass gates | unchanged |
| Reasoner cannot bypass gates | unchanged |
| UI cannot execute actions | unchanged |
| Dashboard messages cannot bypass the SW | unchanged |
| No raw values in exported context/output | unchanged; the P0-1 snapshot reports a value **length** only |

**M5 refusing the action is the system working as designed.** It was not
bypassed to make the demo succeed.

---

## 7. Verification summary

| Gate | Result |
|---|---|
| Focused — planner affordances | **8/8** |
| Focused — observed effect verification | **17/17** |
| Full regression | **1163/1163 across 100 files** (was 1155/99) |
| `npx tsc -b --noEmit` | **5 errors, all pre-existing** in `targetResolver.ts`; 0 new |
| `build:extension` | exit 0 |
| `build:frontend` | exit 0 |
| Real Chrome — observed effect + negative | **9/9** |
| Real Chrome — real-reasoner E2E | pipeline executed; **goal not achieved** |
| Phase 15 seam | ALL CHECKS PASS |
| Phase 12 containment seam | 7/7 |
| Reasoner failure-path seam | 8/8 |

---

## 8. Evidence files

| File | Contents |
|---|---|
| `real_reasoner_e2e_evidence.json` | Full run: reasoner config, per-step gates, observed effect verdicts, wire-captured reasoner requests, terminal result |
| `planner_context_diagnostic.json` | Real Google planner context; **proves P1-1 is not the cause** |
| `reasoner_response_probe.json` | Real context → real backend → real Groq response, verbatim |
| `observed_effect_no_effect_evidence.json` | Negative control, 9/9 |
| `backend_run.log` | Backend access log (no secrets) |
| `ACCEPTANCE_REPORT.md` | P0-1 closure report |

No secret, token, raw PII, password or card number appears in any evidence
file. The API key value was never printed — only `apiKeyConfigured: true` and
its length.

---

## 9. What is still not proven

1. **A run that ends in a verified `SUCCESS`.** The chain demonstrably works,
   but no run has yet completed the task with a goal-verification pass.
2. **Multi-step real-world autonomy.** Four steps occurred here, but the run
   ended on an external anti-bot page.
3. **Provider reliability.** Groq `rate_limit` ended this run. A transient
   provider condition, not an application defect; retry semantics were
   deliberately **not** changed, because no evidence justified it.

## 10. Known product boundary, not a defect

Google's anti-automation interstitial. PrivAgent does not bypass CAPTCHAs or
bot challenges. Any canonical task against Google will hit this from a
headless, freshly-profiled browser. A local fixture with a real search flow is
the appropriate target for a completion-verified run.
