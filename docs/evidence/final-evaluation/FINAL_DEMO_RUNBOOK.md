# PrivAgent — Final Demo Runbook

**Commit:** `593fe72` · **Date:** 2026-09-27

**Purpose.** A fully reproducible demonstration of the complete production chain reaching goal-verification `SUCCESS`, using a real Groq reasoner, a real browser, real security gates, and observed effect verification.

**Rules this runbook enforces:**
- **No scripted proposer.** The reasoner generates every action.
- **Google is not the primary success demo.** It is presented separately as a limitation — see `NEGATIVE_DEMO_RUNBOOK.md`.
- No gate is bypassed, and no result is injected into agent state.
- The harness **never asserts the goal verdict**. It asserts the agent's terminal state *and* reads the DOM marker independently.

---

## 0. What the audience should see

| Step | Observable | Why it matters |
|---|---|---|
| 1 | Task typed into the real dashboard | Real UI, not a test driver |
| 2 | Target tab adopted, origin + containment root shown | Target resolution is real and scoped |
| 3 | Perception + minimization run | Privacy happens before reasoning |
| 4 | **Groq `openai/gpt-oss-20b` telemetry** | The actions are cloud-generated, not scripted |
| 5 | Two actions proposed, both passing M5 | The reasoner proposes; the runtime authorizes |
| 6 | `VALUE_STATE_CHANGED` (length: 4) | Effect observed, and only the *length* leaves the page |
| 7 | `FOCUS_SHIFT_OBSERVED` | Subtle effects are not over-corrected into failures |
| 8 | Browser at `/results?q=cats` | Real form GET navigation, not a simulated one |
| 9 | **Goal Verification: SUCCESS** | Derived from observed state by unmodified production code |
| 10 | Dashboard shows terminal `SUCCESS` | The user-visible result is honest |

---

## 1. Prerequisites

- Node.js ≥ 20, Google Chrome (the harness uses a Playwright Chromium build; override with `PRIVAGENT_CHROME_BIN`)
- Python venv at `backend/.venv` with `fastapi`, `pydantic`, `httpx`, `uvicorn`, `python-dotenv`
- `.env` containing a real `GROQ_API_KEY` (plus `REASONER_PROVIDER=groq`, `GROQ_MODEL=openai/gpt-oss-20b`, `REASONER_FALLBACK_PROVIDER=openrouter`)
- Built artifacts: `extension/dist/` and `frontend/dist/`

```bash
npm install
npm run build:extension
npm run build:frontend
cd backend && python -m venv .venv && .venv/bin/pip install -r requirements.txt && cd ..
```

> **Never print the key.** The harness reports `apiKeyConfigured: true` and never the value. All telemetry output is safe to screen-share.

## 2. Ports

| Service | Port | Override |
|---|---|---|
| Fixture site | 4199 | `PRIVAGENT_FIXTURE_PORT` |
| Dashboard (static) | 5174 | `PRIVAGENT_DASHBOARD_PORT` |
| Backend | 8010 | `BACKEND_PORT` |
| Chrome CDP | 9499 | `PRIVAGENT_CTRL_CDP_PORT` |

Port 5173 is used by the managed preview; the harness serves the dashboard build on 5174 deliberately.

## 3. Run it

```bash
cd /home/daytona/codebase
node scratch/verify_controlled_real_reasoner_success.mjs
```

The harness starts the backend itself (`backend/.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8010`), serves `frontend/dist`, launches Chrome, loads `extension/dist/` unpacked, pre-opens the fixture tab, types the task into the real dashboard, and presses the real RUN control.

## 4. Expected output

```
[CTRL] reasoner config: {"mode":"groq","apiKeyConfigured":true,"model":"openai/gpt-oss-20b",
                         "configuredFallback":"openrouter","reasonerClass":"GroqReasoner",
                         "keyValueNeverPrinted":true}
[CTRL] backend reachable: true
[CTRL] task submitted through the real UI: open http://localhost:4199 and search cats
[CTRL] goal verification: { ... "agentReportedStatus": "SUCCESS", "success": true }
[CTRL] observed final state: { "url": "http://localhost:4199/results?q=cats",
                               "resultMarker": "Search results for cats" }
[CTRL] → docs/evidence/post-phase15-e2e/real_reasoner_controlled_success_evidence.json
```

## 5. The fixture

Served by the harness at `http://localhost:4199`. It is a **real page** doing a **real form GET navigation** — the results URL is produced by the browser, not written by the script.

| Route | Content |
|---|---|
| `GET /` | `<form action="/results" method="get">` with `#q` (`type="search"`) and `#go` (`type="submit"`) |
| `GET /results?q=<q>` | Title `Fixture Results`, renders `#result-marker` = `Search results for <q>` |

**Why the tab is pre-opened:** the task text yields a port-qualified target, and `targetResolver` deliberately refuses to provision or hijack a local port. The first attempt failed with `DESTINATION_REQUIRED` — correct fail-closed behaviour. The harness therefore opens the tab through the normal browser path, and the resolver adopts it. **This is a documented containment property, not a workaround.**

---

## 6. The two actions (as observed)

### Action 1 — `type "cats"` → `q`

| | |
|---|---|
| Reasoner reason | *"The search input field 'q' is visible and ready to accept the search query 'cats' as per the user task."* |
| M5 | `true` — *"Validated type action on known element 'q'."* |
| Dispatch | `executionSuccess: true` |
| **Effect** | **`VALUE_STATE_CHANGED`** — *"Type action registered value change in target 'q' (length: 4)."* |
| Goal after step | `IN_PROGRESS` (correctly not yet success) |

**Point to make out loud:** the effect reports a **length**, never the value. The privacy boundary is visible in the demo output.

### Action 2 — `click` → `go`

| | |
|---|---|
| Reasoner reason | *"Submit the search query 'cats' by clicking the search button."* |
| M5 | `true` — *"Validated click action on known element 'go'."* |
| Dispatch | `executionSuccess: true` |
| **Effect** | **`FOCUS_SHIFT_OBSERVED`** — *"Click on 'go' shifted focus to 'button:nth-child(3)'."* |
| Goal after step | `SUCCESS` |

**Point to make out loud:** focus identity is `tag:nth-child(n)`, never a site-specific identifier.

---

## 7. The proof

| Field | Observed |
|---|---|
| Terminal status | `SUCCESS` |
| Goal status | `SUCCESS` |
| Agent reason | *"Search goal verified against observed results URL: query 'cats' present at 'localhost'."* |
| Final URL | `http://localhost:4199/results?q=cats` |
| Title | `Fixture Results` |
| `#result-marker` | `Search results for cats` |
| Reasoner requests on the wire | 2 × `POST /api/v1/agent/action` → 200 |
| Detections sent | 2 (`q`, `go`) |
| History length | 0 → 1 (a genuine second planning round) |

**Goal verification was produced by the unmodified production `verifyTaskGoal`** (`extension/src/agent/goalVerifier.ts`). It is satisfied only by an **observed** `?q=<intent>` on a non-root pathname — a typed-but-unsubmitted value is never success, which is precisely why step 2 was necessary.

**The strongest available talking point:** the wire capture shows `historyLength: 0` then `1`. A scripted proposer could not produce that. And across two independent runs the reasoner emitted *different* natural-language reason strings for step 2 while producing the same correct action — see `REPRODUCTION.md`.

---

## 8. Live presentation (driving the UI by hand)

For a screen-share rather than a harness run:

```bash
# Terminal 1 — backend
cd backend && .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8010

# Terminal 2 — fixture (see harness for the minimal server; ~40 lines, no deps)
node -e "…serve SEARCH_PAGE and /results?q=… on 4199…"

# Terminal 3 — dashboard build
npx serve -l 5174 frontend/dist

# Terminal 4 — Chrome with the extension
google-chrome --load-extension=extension/dist --remote-debugging-port=9499
```

1. Open `http://localhost:4199` in Chrome (the resolver will not open it for you — that is containment).
2. Open `http://localhost:5174` and type the task into the agent input.
3. Press the **RUN** button (`#agent-run-btn`) — *not* the topbar button, which only focuses the input.
4. Narrate the gate sequence as steps appear.
5. If a confirmation prompt ever appears, the real control is `#agent-confirm-allow` (it will not for this task).

---

## 9. Reproducibility

The run has been executed **twice**, both times reaching `SUCCESS`:

| Run | Timestamp | Step 2 reasoner reason | Result |
|---|---|---|---|
| 1 | 2026-09-27T04:30:53Z | *"Submit the search query 'cats' by clicking the search button."* | `GOAL_VERIFICATION_SUCCESS` |
| 2 | 2026-09-27T04:46:13Z | *"The search query 'cats' has been typed into the input field 'q'. The next logical step is to click the 'go' button…"* | `GOAL_VERIFICATION_SUCCESS` |

The differing reason strings are the evidence that generation is live.

**If Groq is unavailable or rate-limited, stop.** Do not switch providers, add retries, or fall back to a scripted proposer. Record the failure honestly — which is exactly what the live-Google run did.

---

## 10. Limitations to state when presenting

1. **One fixture, one task, one page shape.** Two actions on a page the team wrote.
2. **It is not a general capability claim.** Say: *"A real-reasoner controlled browser task reached verified goal success."* Never: *"Autonomous browser tasks are solved."*
3. **Determinism is doing work here.** The fixture's DOM, routes, and markers are stable and enumerable. The open web is not.
4. **The OCR branch is dormant in the autonomous loop.** Do not claim visual-OCR perception on this path.
5. **The confirmation gate was never triggered.** Do not claim a live confirmation prompt.
6. **Show the negative demo.** A success run without its own falsifier is not a demonstration — see `NEGATIVE_DEMO_RUNBOOK.md`.
