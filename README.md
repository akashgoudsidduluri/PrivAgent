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
| **M5: Agent Reasoning & Structured Browser Actions** | ❌ *NOT YET IMPLEMENTED* | Future milestone: LLM/VLM planning, capability policy, structured action proposals. |
| **M6: End-to-End Autonomous Agent** | ❌ *NOT YET IMPLEMENTED* | Future milestone: Full execution loop, multi-step browser tasks, confirmation safeguards. |
| **M7: Evaluation & Optimization** | ❌ *NOT YET IMPLEMENTED* | Future milestone: Formal precision/recall benchmark dataset, model quantization, latency profiling. |

---

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
# Run TypeScript / Vitest unit tests (104 tests)
npm test

# Run Backend Pytest suite (62 tests)
pytest backend/tests/ -v
```

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

---

## ⚠️ Known Limitations (Milestones M1–M4)

1. **English OCR Model**:
   - Current local OCR uses `eng.traineddata`. Multi-lingual or specialized script recognition is not configured in this milestone.
2. **Stylized / Low-Contrast Canvas Text**:
   - Extreme fonts, heavy anti-aliasing, or very low contrast between text and background can degrade OCR confidence.
3. **OCR Initial Startup Cost**:
   - Spawning the WebAssembly worker thread incurs an initial 1-second initialization overhead upon first capture. Subsequent captures reuse the warm worker.
4. **No Agent Reasoning Loop (M5 Scope)**:
   - Milestones M1–M4 establish the visual perception, redaction, and safe context boundary. PrivAgent does not make autonomous browsing decisions or call LLM reasoning APIs.
5. **No Autonomous Browser Actions (M6 Scope)**:
   - PrivAgent does not click, type, or navigate autonomously on behalf of the user.
6. **No Formal Precision/Recall Benchmark (M7 Scope)**:
   - While tested on representative synthetic banking and canvas portals, formal benchmark scoring across varied datasets belongs to Milestone 7.

---

## 📄 License & Compliance

- **License**: Apache-2.0
- **Synthetic Data Compliance**: All test credentials (`Rahul Sharma`, `DemoPassword123`, `4111 1111 1111 1111`, `123456789012`, `ABCDE1234F`) used across tests, demos, and documentation are entirely fictional.
