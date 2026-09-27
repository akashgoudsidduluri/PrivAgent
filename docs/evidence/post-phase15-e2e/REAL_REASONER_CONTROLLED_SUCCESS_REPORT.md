# Real-Reasoner Controlled Success Report

**Scope:** one controlled real-reasoner run reaching `Goal Verification = SUCCESS` against a deterministic local fixture.
**Not in scope:** Phase 16, architecture changes, gate changes, provider policy changes. No security authority was modified, bypassed, or weakened in this run.

This report follows `REAL_REASONER_E2E_REPORT.md` (the live-Google run that did **not** reach success) and `ACCEPTANCE_REPORT.md` (the observed-effect work). It supersedes the sentence in the live-Google report that read *"No run has yet completed a task end-to-end with a goal-verification pass."* That sentence was accurate then; it is no longer accurate now.

---

## 1. Environment

| Item | Value |
|---|---|
| Repo / branch | `akashgoudsidduluri/PrivAgent` @ `main` |
| Base commit | `32c0cb4` |
| Harness | `scratch/verify_controlled_real_reasoner_success.mjs` |
| Browser | Real Google Chrome, launched headless with remote debugging, driven over CDP |
| Extension | Built `extension/dist/` loaded via `Extensions.loadUnpacked` |
| Extension ID | `ihbbhmifbgfcibhjhcafakdkcppkccaf` |
| Service worker | Attached (real production service worker) |
| Dashboard | Built `frontend/dist/`, served statically on `127.0.0.1:5174` (5173 held by preview) |
| Backend | Real FastAPI app from `backend/.venv`, uvicorn on `127.0.0.1:8010` |
| Fixture | `127.0.0.1`-bound local HTTP server on `http://localhost:4199` |
| CDP port | 9491 |
| Run timestamp | `2026-09-27T04:30:53.151Z` |

Machine-readable artifact: `real_reasoner_controlled_success_evidence.json`, which embeds the backend's reasoner access lines (two `200 OK` responses, no headers, no credentials). The raw uvicorn log from the run is left uncommitted because `.gitignore` excludes `*.log`; it contained no secrets (scanned: zero matches for key/authorization patterns).

---

## 2. Backend and reasoner

| Field | Observed |
|---|---|
| Backend reachable | `true` |
| Reasoner mode | `groq` |
| API key configured | `true` (value never printed, never written to any artifact) |
| Model | `openai/gpt-oss-20b` |
| Configured fallback | `openrouter` |
| Fallback used | **No** |
| Reasoner class instantiated | `GroqReasoner` |
| Reasoner HTTP calls on the wire | 2 × `POST /api/v1/agent/action` → `200 OK` |

The reasoner generated every action. There was no scripted proposer, no hardcoded action injection, no test-only reasoner response, and no deterministic action sequence anywhere in the run. The two actions in the trace below were read off the production telemetry after the run, not supplied to the loop.

`providerRetries` was left at `0` and was not changed. No evidence in this run establishes retries as necessary.

---

## 3. Task, fixture, and target resolution

**Task (verbatim from the dashboard input):**

```
open http://localhost:4199 and search cats
```

**Fixture behaviour:**

| Route | Content |
|---|---|
| `GET /` | Search page: `<form action="/results" method="get">`, `#q` text input (`type="search"`), `#go` submit button (`type="submit"`) |
| `GET /results?q=<q>` | Results page, title `Fixture Results`, renders `#result-marker` with the exact text `Search results for <q>` |

**Target identity and containment:**

| Field | Value |
|---|---|
| Origin | `http://localhost:4199` |
| Target tab ID | `9C40799D8AD72BE369380F3BCFBFA63D` |
| Containment root host | `localhost` |
| Initial URL | `http://localhost:4199/` |
| Final URL | `http://localhost:4199/results?q=cats` |

**Containment semantics were not modified.** The first attempt at this scenario failed with `DESTINATION_REQUIRED`, because the task text yields a port-qualified target and `targetResolver` deliberately refuses to provision or hijack a local port — the tab must already be open. That is correct fail-closed behaviour, not a defect. The harness now pre-opens the fixture tab through the normal browser path, and the resolver then adopts the existing tab. No resolver, containment, or provisioning code was touched.

---

## 4. Full production path exercised

The run was driven from the real dashboard UI: task input → **RUN** (`#agent-run-btn`) → production service worker → `AgentLoop` → real perception → `buildAgentPayload` → privacy / sanitization → planner → `BackendAgentProvider` → Groq → action normalization → grounding → M5 → Security Critic → Privacy Policy → Risk / Semantic / Confidence → Confirmation (not required for either action) → Containment → dispatch → observed effect verification → goal verification.

The reasoner payload was captured off the wire via CDP `Network.requestWillBeSent` on the service worker. Both requests carried `detectionCount: 2` — the two real interactive affordances on the fixture page:

```json
{ "id": "q",  "type": "search", "selector": "#q"  }
{ "id": "go", "type": "button", "selector": "#go" }
```

History length progressed `0 → 1`, confirming a genuine second planning round rather than a replayed first response.

---

## 5. Action trace

### Action 1 — `type "cats"` into `#q`

| Field | Value |
|---|---|
| Reasoner proposal | `type` → target `q`, text `cats` |
| Reasoner reason | *"The search input field 'q' is visible and ready to accept the search query 'cats' as per the user task."* |
| Target ID | `q` (`type="search"`) |
| M5 / validation | `true` — *"Validated type action on known element 'q'."* |
| Dispatch | `executionSuccess: true` |
| Pre / post snapshot | Read from the live tab via the content script (P0-1 observed path) |
| **Effect verdict** | **`VALUE_STATE_CHANGED`** — *"Type action registered value change in target 'q' (length: 4)."* |
| Goal state after step | `IN_PROGRESS` |

Note that the observed effect reports the target's value **length** (4). The raw value is never exported, consistent with the context-minimization invariant.

### Action 2 — `click` on `#go` (submit)

| Field | Value |
|---|---|
| Reasoner proposal | `click` → target `go` |
| Reasoner reason | *"Submit the search query 'cats' by clicking the search button."* |
| Target ID | `go` (`type="button"`) |
| M5 / validation | `true` — *"Validated click action on known element 'go'."* |
| Dispatch | `executionSuccess: true` |
| **Effect verdict** | **`FOCUS_SHIFT_OBSERVED`** — *"Click on 'go' shifted focus to 'button:nth-child(3)'."* |
| Goal state after step | `IN_PROGRESS` (goal not yet re-evaluated at this tick) |

Focus identity is derived as `tag:nth-child(n)`, never as a site identifier, and no sensitive value is introduced into the artifact.

### Agent phase timeline

```
RUNNING   step 0  "Target tab discovered and ready. Starting visual privacy perception..."
RUNNING   PERCEPTION  step 0  url http://localhost:4199/
IN_PROGRESS PLANNING step 0
IN_PROGRESS PLANNING step 1
IN_PROGRESS PLANNING step 2
SUCCESS   TERMINAL  step 2  url http://localhost:4199/results?q=cats
          reason: "Search goal verified against observed results URL: query 'cats' present at 'localhost'."
```

---

## 6. Goal verification — SUCCESS

Goal verification was produced by the **unmodified production verifier**, `verifyTaskGoal` in `extension/src/agent/goalVerifier.ts`. It was not called directly by the harness, and its verdict was not injected into agent state.

| Field | Value |
|---|---|
| Verifier | `verifyTaskGoal` — unmodified |
| Agent terminal status | `SUCCESS` |
| Agent goal status | `SUCCESS` |
| Agent reason | *"Search goal verified against observed results URL: query 'cats' present at 'localhost'."* |
| Harness assertion — agent terminal SUCCESS | asserted |
| Harness assertion — observed `#result-marker` | asserted |
| Observed query present in URL | `true` |
| **Outcome** | **`GOAL_VERIFICATION_SUCCESS`** |

`verifyTaskGoal` satisfies a search goal only from an **observed** `?q=<intent>` on a non-root pathname. A typed-but-unsubmitted value is never success. The observed final state independently confirms this:

| Observed field | Value |
|---|---|
| Tab found | `true` |
| URL | `http://localhost:4199/results?q=cats` |
| Title | `Fixture Results` |
| `#result-marker` | `Search results for cats` |

The success criterion required **both** the agent's own terminal `SUCCESS` **and** the deterministic DOM marker read independently from the live tab. Success is not claimed on the strength of an HTTP 200, a gate pass, a dispatch success, or a URL change alone.

---

## 7. Security invariants

No gate was bypassed, relaxed, reordered, or stubbed for this run. Confirmation was not required for either action because neither met the high-risk threshold — it was not skipped.

- Grounding, M5, Security Critic, Privacy Policy, Risk Engine, Semantic/Confidence, Confirmation, Containment, Effect Verification, and Recovery all remain authoritative and unchanged.
- The reasoner still cannot execute browser actions; it proposes, and the local runtime authorizes.
- The dashboard still cannot execute browser actions; it is a control surface only.
- Effect verification grants no authorization — it is an observation step that can only fail an action closed (`ACTION_NO_EFFECT` / `EFFECT_UNVERIFIABLE`).
- No raw PII was exported. Target values crossed the boundary as lengths only; focus identity as `tag:nth-child(n)`.
- No privacy finding was downgraded by fusion.
- No sensitive value appears in any artifact in this directory.

Byte-level verification that the security-authority sources are unchanged was performed for `extension/src/{agent,privacy,ocr,background,content}/`, `backend/`, and `frontend/src/`: `git status` over those paths is **empty**. This round changed **zero** source lines.

---

## 8. Negative control (Part F)

The real Chrome no-effect seam, `scratch/verify_observed_effect_no_effect.mjs`, was re-run after all fixture work: **9/9 checks pass**, and a dispatched-but-unchanged action still produces `ACTION_NO_EFFECT`.

The successful fixture run does not relax effect verification. The two are independent, and the failure path remains live.

---

## 9. Tests and builds

| Check | Result |
|---|---|
| Focused observed-effect tests (`tests/observedEffect/`) | **25/25 pass** |
| Real Chrome negative control | **9/9 pass** |
| Full Vitest regression | **1163/1163 pass, 100 files** |
| TypeScript (`npx tsc -b --noEmit`) | **5 errors**, all pre-existing in `extension/src/background/targetResolver.ts` (lines 285, 287, 287, 290, 488) — unchanged count |
| Extension build (`npm run build:extension`) | exit 0 |
| Frontend build (`npm run build:frontend`) | exit 0 |

No new tests were added. The controlled fixture exposed no defect in any tested component, so per the "focused tests only where a real gap appears" constraint, none were written and no unrelated test was modified.

---

## 10. Limitations

These limitations are load-bearing. Read them before quoting any result from this report.

1. **One controlled fixture, one task, one run.** This proves the production path can carry a real reasoner to observed goal success. It is a single data point.
2. **This is not a claim of general autonomous capability.** "Real-reasoner controlled browser task reached verified goal success." It is *not* "autonomous browser tasks are fully solved." Nothing here demonstrates robustness across sites, layouts, or task classes.
3. **The fixture is local and deterministic.** Its DOM, routes, and markers are stable and enumerable. Open-web pages are not. Success here is easier to reach than on the open web, and the report does not extrapolate.
4. **A live-Google run still cannot end in `SUCCESS`.** A headless Chrome with a fresh profile receives Google's anti-bot interstitial. This is an environmental and product boundary. PrivAgent does not attempt to bypass CAPTCHAs, Cloudflare turnstiles, or bot challenges, and no engineering effort was spent trying. The live-Google run in `REAL_REASONER_E2E_REPORT.md` therefore remains honestly unsuccessful.
5. **M5 blocked a real action in the live-Google run** because the reason text contained the word "cats", which the PII scanner interpreted as a possible `person_name`. That is correct fail-closed behaviour. M5 and the scanner were **not** weakened, and the fixture deliberately does not depend on such a block being lifted.
6. **Groq is a live external service.** A rate-limit or outage will fail this run closed. That is the intended behaviour and was not worked around.
7. **Test counts are exact for this commit only.** They are not a quality metric.

---

## 11. Provenance

Prior work referenced by this report:

- `REAL_REASONER_E2E_REPORT.md` — first real-reasoner run (live Google); goal not achieved. Also records the `buildAgentPayload` detection-replacement defect and its fix, and the disproof of the P1-1 planner-context hypothesis.
- `ACCEPTANCE_REPORT.md` — observed-effect verification replacing synthesized post-state.
- `planner_context_diagnostic.json`, `reasoner_response_probe.json` — P1-1 disproof diagnostics.

The single genuine production defect found by live real-reasoner work remains the `buildAgentPayload` fix in `extension/src/privacy/types.ts` (DOM detections are now the base, with visual detections merged in for uncovered elements; `detectionCount` went `0 → 7` on Google, `2` on this fixture). **This round introduced no code change.**
