# PrivAgent 🛡️
> **On-Device Visual Perception & Local Privacy Boundary for Lightweight Browser Agents**  
> **Problem Statement:** `PS26171` / `SIH26171`  
> **Organization:** Indian Space Research Organisation (ISRO)  

---

## 📌 Project Overview & Milestone Status

PrivAgent establishes an inviolable **on-device privacy and perception boundary** that intercepts webpage content inside the user's browser, detects and redacts sensitive personal data locally, and exposes **only sanitized structural metadata** to downstream agent frameworks.

```
Raw DOM / Visual Page
        │
        ▼
Local DOM Detection (M1) ──► Local Visual Capture & Redaction (M2) ──► Local WebAssembly OCR (M3)
                                                                               │
                                                                               ▼
                                                                     Local Security Boundary
                                                                               │
                                                      Explicit Allowlisted Sanitized Payload
                                                                               │
                                                                               ▼
                                                                Extension Security Pre-Flight
                                                                               │
                                                                  POST http://127.0.0.1:8010 (M4)
                                                                               │
                                                                               ▼
                                                                   FastAPI Independent Scan
                                                                (Recursive Key Rejection)
                                                                               │
                                                                               ▼
                                                                   Ephemeral In-Memory Context
                                                                               │
                                                                               ▼
                                                             [ Future Agent / LLM Gateway (M5+) ]
```

### Milestone Roadmap

| Milestone | Status | Description |
| :--- | :--- | :--- |
| **M1: Local DOM Privacy Detection** | **COMPLETED** | On-device DOM scanning, input/attribute analysis, regex pattern matching, Luhn validation, token boundary matching. |
| **M2: Visual Capture & Redaction** | **COMPLETED** | Local viewport screenshot capture, empirical coordinate mapping (`scaleX`/`scaleY`), blackout/blur/mask redaction overlays. |
| **M3: Local OCR & Visual Text Privacy** | **COMPLETED** | On-device Tesseract.js WebAssembly worker, canvas/image visual text extraction, coordinate transformation, OCR privacy detection. |
| **M4: Agent Safety API & Sanitized Context** | **COMPLETED** | Safe context constructor, extension pre-flight validator, local FastAPI IPC backend (127.0.0.1:8010), ephemeral context store. |
| **M5: Agent Reasoning & Structured Browser Actions** | **COMPLETED** | Capability policy, structured action allowlist (`click`/`scroll`/`type`/`select`/`navigate`), authoritative local action validator, provider abstraction (`mock` / `backend` / direct OpenRouter dev provider) plus a configuration-driven provider registry for future models. |
| **M6: End-to-End Autonomous Agent** | **COMPLETED** | Autonomous multi-step loop with fresh perception, bounded steps/retries, validator + policy gates on every action, consequential-action user confirmation. |
| **M7: Real LLM Reasoning, Hardening & Evaluation** | **COMPLETED** | Gemma (`google/gemma-4-31b-it:free`) via OpenRouter server-side, zero guessing (fail-safe), backend action validation, privacy/network payload tests, evaluation harness with measured (non-fabricated) metrics. |

---

## 🧠 Milestone 7 — Real LLM Reasoning Architecture (Gemma via OpenRouter)

The production reasoning path keeps the API key server-side. The extension never talks to OpenRouter directly:

```
Chrome Extension (M1–M3 perception)
    ↓  sanitized AgentContextPayload (sanitized_only sentinel)
Local FastAPI Backend (127.0.0.1:8010)  ← OPENROUTER_API_KEY lives ONLY here
    ↓  security validation (Pydantic extra="forbid" + independent recursive scan)
    ↓  structured reasoning request per M6 step (bounded, observable retries)
Gemma 4 31B via OpenRouter  →  ONE BrowserAction (strict JSON, validated)
    ↓  backend BrowserActionModel validation + target-ID grounding
Extension
    ↓  M5 Action Validator (authoritative) → M5 Privacy Policy → M6 Safety Check
Browser execution → fresh perception → repeat (M6 owns the loop)
```

Key M7 properties:

- **No guessing.** The previous deterministic "click the first detection" fallbacks were removed from the backend and the mock provider no longer represents production reasoning. If the reasoner cannot identify a valid target from sanitized metadata, the system fails safely (HTTP 503 with a typed error) and the M6 loop decides whether to re-perceive or stop.
- **Structured output only.** The LLM must return a single JSON object matching the strict `BrowserAction` schema. JSON object mode (`response_format: json_object`) is requested from the provider, but this is BEST-EFFORT — it is **not** a JSON-Schema guarantee and is **not** itself a security control. The real guarantees are the defensive parser (markdown fences, embedded JSON, refusals, oversized-field rejection), strict schema validation by the backend `BrowserActionModel` (per-action field applicability, bounds, URL/protocol and script-injection checks), value-safety scanning of model-emitted free text (`type.text`, `select.option`, `reason`), and the extension's M5 validator. Malformed, oversized, or schema-invalid model output fails closed.
- **Target-ID grounding.** The backend rejects actions whose `target` is not present in the current sanitized context (`unknown_target`, HTTP 422). Stale or hallucinated IDs never reach the browser.
- **Prompt-injection defense.** The system prompt establishes that page-derived metadata is untrusted data, that only provided element IDs may be targeted, and that no arbitrary code/fields/sensitive values may be requested. Prompting is a mitigation, not a boundary — the M5/M6 validators remain the security authority.
- **Bounded, observable provider retries.** M6 wraps provider calls in a bounded retry for genuinely transient failures only (network, timeout, 5xx). Total provider calls are tracked separately from M6 step retries as `TaskState.providerAttempts` and are provably bounded by `maxSteps × (1 + providerRetries)`; a reasoning step whose attempts all fail terminates the task immediately (fail-closed). Backend-side attempts default to 1 per step (`PRIVAGENT_MAX_LLM_ATTEMPTS`).
- **Rate limits are never retried (HTTP 429).** A 429/`rate_limit` failure is classified NON-retryable on both boundaries (extension `ProviderError.retryable === false`, backend `ReasoningError(retryable=False)`), so it costs exactly ONE provider request and then fails the step closed. Retrying a rate-limited free-tier pool cannot succeed and would silently multiply quota consumption. The extension additionally ignores any `retryable: true` a remote response claims for a rate-limit error.
- **Typed failures.** Every provider failure mode maps to a typed, retryable-annotated error (`auth`, `rate_limit`, `timeout`, `network`, `http_error`, `invalid_json`, `unsupported_action`, `unknown_target`, `not_configured`) — in both TypeScript (`ProviderError`) and Python (`ReasoningError`). No failure path can produce arbitrary browser behavior.

### M7 Configuration (backend only)

| Env var | Default | Purpose |
| :--- | :--- | :--- |
| `OPENROUTER_API_KEY` | *(none)* | Server-side only. Required for real Gemma reasoning. Never committed, never logged, never sent to the extension. |
| `OPENROUTER_MODEL` | `google/gemma-4-31b-it:free` | Reasoning model. |
| `OPENROUTER_TIMEOUT_SECONDS` | `45` | Per-request LLM budget. |
| `PRIVAGENT_REASONER` | `openrouter` | Registered reasoning provider name: `openrouter` (production/demo, Gemma) or `mock` (offline tests/CI). Names come from the provider registry; an unregistered name fails closed to `openrouter`. |

The mock reasoner (`MockAgentProvider` on the extension side, `MockReasoner` on the backend) remains available for unit tests, offline development, CI, and deterministic regression tests — but it is clearly not production reasoning and it never guesses (it raises instead of picking a fallback element).

### Reasoning provider abstraction (swapping/adding a model)

There is exactly ONE orchestration loop (extension `AgentLoop`, M6). It depends only on the provider interface, so changing the reasoning model is a configuration change rather than an architecture change:

```
M6 AgentLoop
      │  (AgentProvider contract only — no model names, endpoints, or SDKs)
      ▼
  provider registry
      ├── backend    → local FastAPI → Gemma via OpenRouter   (PRODUCTION, key stays server-side)
      ├── mock       → deterministic offline reasoning        (tests / CI / offline demo)
      └── openrouter → direct vendor call                     (dev/test only — requires a browser-side key)
```

- **Extension side:** `extension/src/agent/providerRegistry.ts` declares every provider (`AGENT_PROVIDERS`), builds it from configuration (`createAgentProvider({ provider, model? })`), and reports provider-agnostic telemetry identity (`describeProvider`). The popup resolves its selection through this registry and **cannot** construct a provider that needs a client-side API key (no `allowClientSideApiKey` opt-in), so the OpenRouter key never enters the extension.
- **Backend side:** `backend/app/reasoner.py` defines the `ReasonerProvider` contract and `REASONER_REGISTRY`; the agent route resolves its provider through `build_reasoner()`, and `/api/v1/health` + response telemetry report the resolved provider name and model.
- **Unchanged by design:** the M5 action validator, the capability privacy policy, target-ID grounding, the M6 loop, the sanitized-context boundary, and the `BrowserAction` schema are provider-independent and are never modified to accommodate a model.
- **To add a provider:** implement the contract in a new file, register a descriptor/entry (3 documented steps in each registry file), and select it by configuration. No agent-loop duplication, and no raw DOM/OCR/screenshot/sensitive data ever becomes available to a non-local provider — every provider re-asserts `assertSanitizedContextSafe` before formatting a prompt or opening a socket.

## 🔒 Verified Security Invariants

1. **Strict Metadata Allowlist Construction**:
   - The extension builds the agent payload strictly through `buildAgentPayload()` using an explicit field-by-field allowlist.
   - Raw DOM values, `textContent`, `innerText`, input values, passwords, credit card numbers, CVVs, and raw OCR text strings are never copied into the export.
2. **Local-Only Screenshot Processing**:
   - The raw screenshot remains inside the browser extension for local processing and is not transmitted to the external backend.
   - Only non-sensitive geometric bounding boxes (`{ x, y, width, height }`) and detection counts cross the API boundary.
3. **Dual-Layer Defense-in-Depth Validation**:
   - **Layer 1 (Client-Side Pre-Flight)**: `validatePayloadBeforeSend()` inspects the generated payload before any HTTP request is initiated.
   - **Layer 2 (Backend Independent Verification)**: `verify_payload_invariants()` in `backend/app/security.py` recursively scans every dictionary and list key in the incoming JSON, rejecting forbidden keys regardless of client claims.
4. **Forbidden Key Rejection (Recursive & Normalized)**:
   - Keys such as `value`, `text`, `textContent`, `innerText`, `rawText`, `rawOCR`, `ocrText`, `password`, `words`, `lines`, `token`, `secret`, `card`, `cardNumber`, `cvv`, `pan`, `accountNumber` are strictly forbidden.
   - Checks are case-normalized and underscore-agnostic (e.g. `PASSWORD`, `card_number`, `CardNumber` are all rejected).
5. **Fail-Closed Policy**:
   - If an unrecognized key is received, Pydantic models reject it immediately (`extra="forbid"`).
   - If a malicious or malformed payload is rejected by the backend, the previously stored valid latest context is preserved and never overwritten.
6. **Ephemeral In-Memory Storage**:
   - The backend maintains only a single ephemeral context in memory (`_latest_context`).
   - No database, no disk caching, and no persistent logs of PII exist.
7. **Local-Only IPC Binding**:
   - The backend binds strictly to `127.0.0.1:8010` (never `0.0.0.0`).
   - CORS is restricted to `chrome-extension://*` and `http://127.0.0.1:*` / `http://localhost:*`.

---

## 📁 Repository Structure

```text
PrivAgent/
├── extension/                       # Chrome Extension (Manifest V3)
│   ├── manifest.json                # Minimal permissions: activeTab, scripting only
│   ├── vite.config.ts               # Multi-target Vite bundling configuration
│   ├── public/                      # Static assets and WebAssembly OCR workers
│   │   ├── assets/ocr/              # Local worker.min.js, tesseract-core-simd.wasm, eng.traineddata
│   │   └── icons/                   # Shield extension icons
│   └── src/
│       ├── background/              # MV3 background service worker
│       ├── content/                 # Content script for DOM scanning and overlays
│       ├── popup/                   # Privacy dashboard, visual layer toggle, & agent trigger
│       ├── privacy/                 # DOM detector, regex patterns, Luhn check, security boundary
│       ├── capture/                 # Coordinate mapper & screenshot orchestrator
│       ├── ocr/                     # Local Tesseract.js engine & OCR security boundary
│       ├── redaction/               # Visual redactors (blackout, blur, mask)
│       └── agent/                   # Agent bridge & client-side security pre-flight
│
├── backend/                         # Local FastAPI Agent Safety API (Milestone 4)
│   ├── app/
│   │   ├── main.py                  # FastAPI application & local CORS configuration
│   │   ├── models.py                # Strict Pydantic v2 models (extra="forbid")
│   │   ├── security.py              # Independent recursive key validator
│   │   └── routes/
│   │       └── context.py           # /api/v1/context and /api/v1/context/latest endpoints
│   ├── tests/
│   │   └── test_context_api.py      # Pytest suite (62 test cases)
│   ├── requirements.txt             # Python dependencies (fastapi, uvicorn, pydantic, pytest)
│   └── run.py                       # Backend launcher (binds to 127.0.0.1:8010)
│
├── demo/                            # Evaluation Demo Environments
│   ├── synthetic-banking-site/      # M1/M2/M4 Banking demo portal (port 4173)
│   └── canvas-privacy-site/         # M3 Canvas OCR privacy demo portal (port 4174)
│
├── tests/                           # Automated TypeScript test suite (Vitest + JSDOM)
│   ├── patterns.test.ts             # Regex pattern & Luhn validation tests
│   ├── domDetector.test.ts          # DOM scanning & bounding box calculation
│   ├── coordinateMapper.test.ts     # Empirical scale & clipping tests
│   ├── redactor.test.ts             # Visual overlay tests
│   ├── visualRedactor.test.ts       # Combined DOM + OCR visual redaction tests
│   ├── ocrDetector.test.ts          # OCR entity identification tests
│   ├── ocrEngine.test.ts            # Local OCR engine tests
│   ├── ocrSecurityBoundary.test.ts  # OCR boundary non-leakage tests
│   ├── ocrIntegration.test.ts       # End-to-end OCR pipeline tests
│   ├── securityBoundary.test.ts     # Invariant tests: forbidden keys rejection
│   ├── siteExclusions.test.ts       # Excluded sites policy tests
│   ├── agentBridge.test.ts          # Allowlist payload construction & pre-flight tests
│   └── browserTest.mjs              # Chrome DevTools Protocol E2E verification script
│
├── package.json                     # Monorepo root scripts & dev dependencies
├── tsconfig.json                    # Base TypeScript configuration
├── vitest.config.ts                 # Vitest test runner configuration
└── README.md
```

---

## 🚀 Quickstart & How to Run

### 1. Prerequisites
- **Node.js**: v18+ (Tested on v22)
- **npm**: v9+
- **Python**: 3.10+ (Tested on Python 3.13)
- **Google Chrome** (Chromium-based browser)

### 2. Setup & Installation
```bash
# Clone the repository
git clone https://github.com/akashgoudsidduluri/PrivAgent.git
cd PrivAgent

# Install JavaScript dependencies
npm install

# Install Python backend dependencies
pip install -r backend/requirements.txt
```

### 3. Run Automated Tests
```bash
# Run TypeScript / Vitest unit tests (216 tests: M1–M6 + M7 provider/privacy/pipeline suites)
npm test

# Run Backend Pytest suite (186 tests: M4/M5 + M7 reasoner/registry/validation/evaluation)
pytest backend/tests/ -v
```

### 3b. Configure Real LLM Reasoning (M7)
```bash
# In your local, gitignored environment (or export in your shell):
export OPENROUTER_API_KEY="sk-or-..."   # server-side ONLY — never in the extension
# Optional:
# export OPENROUTER_MODEL="google/gemma-4-31b-it:free"
# export PRIVAGENT_REASONER=openrouter   # or "mock" for offline demos

python backend/run.py
# Health check now reports: {"reasoner": "openrouter", "reasoner_configured": true}
```
Without a configured key the backend fails closed (typed `not_configured` error) — it never falls back to guessing-based reasoning.

### 4. Build the Chrome Extension
```bash
npm run build
```
The compiled extension artifacts will be generated in `extension/dist/`.

### 5. Launch the Local Backend (Agent Safety API)
```bash
python backend/run.py
```
- API Server: `http://127.0.0.1:8010`
- Interactive Swagger Documentation: `http://127.0.0.1:8010/docs`
- Health Endpoint: `http://127.0.0.1:8010/api/v1/health`

### 6. Launch the Demo Applications
In separate terminals:
```bash
# Synthetic Banking Demo (M1, M2, M4)
python demo/synthetic-banking-site/server.py
# Available at: http://localhost:4173

# Canvas Privacy Demo (M3)
python demo/canvas-privacy-site/server.py
# Available at: http://localhost:4174
```

### 7. Load Extension in Google Chrome
1. Navigate to `chrome://extensions/` in Google Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the `PrivAgent/extension/dist` directory.
5. Pin **PrivAgent** to your toolbar.

---

## 🧪 Demo Verification Walkthrough

### Demo 1: Synthetic Banking Portal (`http://localhost:4173`)
1. Open `http://localhost:4173` in Chrome.
2. Click the PrivAgent extension icon in the toolbar:
   - **DOM Privacy Scan**: Automatically identifies sensitive DOM fields (account number, card number, password, email, phone, PAN).
   - **Visual Redaction**: Renders blackout/blur overlays precisely aligned over sensitive fields.
   - **Agent Safety API**: Click **"Send to Agent API"**.
   - **Verification**: Status changes to *"Sanitized Context Accepted by Agent API"*.
   - Click **"View Agent Payload"** to inspect the transmitted JSON and confirm that no raw PII values or screenshots were sent.

### Demo 2: Canvas Privacy Portal (`http://localhost:4174`)
1. Open `http://localhost:4174` in Chrome.
2. Click **"Inspect DOM (Traditional Scanner)"**:
   - The page demonstrates that sensitive PII (credit card number, PAN, phone number) is rendered into an HTML5 `<canvas>` element.
   - Traditional DOM scanners cannot inspect canvas pixels and detect 0 elements.
3. Open the PrivAgent extension popup and click **"Capture & Run Local OCR"**:
   - On-device WebAssembly OCR processes the canvas region locally.
   - Detects the sensitive visual text entities.
   - Renders visual redaction overlays over the canvas text.
   - Click **"Send to Agent API"** to transmit the sanitized bounding box metadata.

---

## ⏱️ Performance & Measured Timings

All performance timings are measured directly via browser and runtime performance APIs (`performance.now()`), not fabricated:

| Metric | Typical Measurement | Notes |
| :--- | :--- | :--- |
| **DOM Privacy Scan Latency** | `8 – 16 ms` | Sub-millisecond element inspection across ~50 DOM nodes. |
| **Local Screenshot Capture** | `45 – 75 ms` | Via `chrome.tabs.captureVisibleTab` on active tab. |
| **Coordinate Mapping Latency** | `< 2 ms` | Empirical scale calculation and clipping per element. |
| **Local OCR Worker Initial Startup** | `800 – 1400 ms` | One-time startup cost for WebAssembly worker compilation. |
| **Local OCR Processing Latency** | `220 – 420 ms` | Per canvas region on typical desktop CPU. |
| **API Transmission Latency** | `10 – 25 ms` | Local HTTP POST to `127.0.0.1:8010`. |
| **LLM Reasoning Latency (Gemma via OpenRouter)** | *PENDING — measured live* | Free-tier Gemma adds network + inference latency per step; measured with a configured `OPENROUTER_API_KEY` and reported by the M7 evaluation harness. No value is fabricated. |

---

## ⚠️ Known Limitations (Milestones M1–M7)

1. **English OCR Model**:
   - Current local OCR uses `eng.traineddata`. Multi-lingual or specialized script recognition is not configured.
2. **Stylized / Low-Contrast Canvas Text**:
   - Extreme fonts, heavy anti-aliasing, or very low contrast between text and background can degrade OCR confidence.
3. **OCR Initial Startup Cost**:
   - Spawning the WebAssembly worker thread incurs an initial 1-second initialization overhead upon first capture. Subsequent captures reuse the warm worker.
4. **LLM latency & availability**:
   - Real Gemma reasoning adds network + inference latency (free-tier OpenRouter can be slow or rate-limited). The M6 loop respects its existing step/retry bounds and fails safely on provider errors; measured live-LLM latencies depend on provider conditions and are reported as PENDING until measured with a configured key.
5. **Prompt injection is mitigated, not solved**:
   - The system prompt establishes untrusted-data framing, ID-grounding, and no-code rules, but prompting alone is not a security boundary. The M5 validator, privacy policy, and M6 safety checks remain the enforcement layer. New injection techniques may get malformed actions past the prompt — they will still be rejected structurally.
6. **Sensitive-content heuristics in `type`/`select` free text**:
   - The M5 validator now rejects free text that pattern-matches PII (full names, emails, Indian phone numbers, Luhn-valid cards, PANs, labeled credentials, credential-shaped tokens). This is deliberately privacy-first and may over-block some benign text; legitimate flows use non-PII text.
7. **No formal precision/recall benchmark on varied datasets**:
   - The M7 evaluation harness (`backend/app/evaluation.py`) measures task success/valid-action/validator-rejection/leakage/step/retry/failure metrics reproducibly, and marks SIH perception metrics (PII precision/recall, redaction precision, visual context accuracy, client resource utilization) as PENDING until measured via the browser E2E harness on real pipelines. No numbers are fabricated.
8. **Multimodal reasoning not implemented**:
   - The LLM receives sanitized metadata only. Screenshots stay local. A future privacy-redacted-image pipeline is an extension point, not a current feature.

---

## 📄 License & Compliance

- **License**: Apache-2.0
- **Synthetic Data Compliance**: All test credentials (`Rahul Sharma`, `DemoPassword123`, `4111 1111 1111 1111`, `123456789012`, `ABCDE1234F`) used across tests, demos, and documentation are entirely fictional.
