# PrivAgent

> **On-Device Visual Perception & Local Privacy Boundary for Lightweight Browser Agents**  
> **Problem Statement:** `PS26171` / `SIH26171`  
> **Organization:** Indian Space Research Organisation (ISRO)  

---

## What PrivAgent Is

PrivAgent is a privacy-native browser agent designed to operate autonomously across websites while keeping sensitive personal, credential, and financial information protected strictly on the local device. Unlike conventional web agents that stream raw DOM trees or full-resolution screenshots directly to third-party cloud vision/reasoning APIs, PrivAgent introduces a deterministic on-device privacy perimeter between the browser execution environment and downstream reasoning models.

---

## Core Architecture

PrivAgent enforces the foundational security principle: **Reasoning $\neq$ Authority**. The LLM proposes actions based on sanitized structural metadata, but the local runtime validates, gates, authorizes, and verifies every interaction before and after DOM dispatch.

```
User
  │
  ▼
Agent (Task Planner & Loop)
  │
  ▼
Browser Perception (DOM Scanner + Coordinate Mapper + Tesseract OCR)
  │
  ▼
Privacy Layer (Privacy Fusion + Local Redaction + Context Minimization)
  │
  ▼
Sanitized Context (Zero Raw PII, Stripped Credentials, Safe Bounding Boxes)
  │
  ▼
Reasoner (Groq openai/gpt-oss-20b / Fallback OpenRouter)
  │
  ▼
M5 Validation (Target Grounding, In-Bounds Verification, Geometry Check)
  │
  ▼
Risk Policy (4-Tier Risk Assessment + Consequential Action Confirmation Gate)
  │
  ▼
Browser (DOM Action Dispatch via Content Script)
  │
  ▼
Effect Verification (DOM Mutation Detection & State Delta)
  │
  ▼
Goal Verification (Deterministic Multi-Candidate Completion Check)
```

---

## Current Capabilities

PrivAgent v1.0 implements and verifies the complete M1–M12 capability stack:

- **DOM Privacy Detection**: Local rule- and pattern-based discovery of passwords, OTPs, CVVs, PANs, credit cards, bank accounts, emails, and phone numbers.
- **Screenshot Capture & Coordinate Mapping**: Viewport capture mapped to HiDPI physical device coordinates with clipping.
- **On-Device OCR**: Local WebAssembly Tesseract OCR scanning canvas and non-DOM visual regions without network transmission.
- **Local Redaction**: Zero-leak visual canvas blackout, blur, and mask overlays preventing visual credential leakage.
- **Privacy Fusion**: Unification of DOM detections and OCR findings into a single deduplicated spatial coordinate map.
- **Context Minimization**: Elimination of raw values, inner text, and credential fields (`value`, `password`, `textContent`, `rawText`), exposing only sanitized structural IDs and geometry.
- **Structured Browser Actions**: Typed browser action schema (`click`, `type`, `scroll`, `select`, `navigate`) constrained to prevent code injection.
- **Semantic Grounding**: Target verification ensuring proposed action targets exist within the active page's current generation.
- **Action-Effect Verification**: Post-action DOM mutation observation verifying that executed actions caused an observable change.
- **Goal Verification**: Multi-condition task completion evaluation preventing premature loop termination or false success claims.
- **Prompt-Injection Defense**: Isolation of untrusted webpage text from the agent reasoning system; instructions embedded in webpage DOM cannot override user goals.
- **Target Isolation & Lifecycle**: Monotonic page generation counters preventing stale targets from previous pages being acted upon.
- **Failure Recovery & Self-Healing**: Automated diagnosis of stale targets, missed effects, and bounded recovery replanning.
- **Provider Fail-Closed Behavior**: Strict fail-closed semantics on cloud reasoning failures (HTTP 401, 429, 5xx, timeouts) with 0 speculative browser actions.
- **Real Chrome Execution**: Verified end-to-end execution in real Google Chrome via Chrome DevTools Protocol (CDP) and Manifest V3 extension.
- **M12 Evaluation Suite**: Comprehensive 18-metric SIH evaluation engine with forensic telemetry and receipt auditing.

---

## Privacy Architecture

PrivAgent guarantees that **raw sensitive values remain strictly local**:

1. **Local Boundary**: All detection, pattern matching, OCR analysis, and image redaction execute exclusively in the browser extension and local process memory.
2. **Sanitized Context**: The remote reasoner receives strictly sanitized structural metadata (`id`, `bbox`, `type`, `length`, `source`). Raw strings are never transmitted.
3. **Firewall & Invariants**: Outbound payloads are recursively inspected by a pre-flight schema validator with `extra="forbid"`. Any presence of forbidden keys (`value`, `password`, `secret`, `cvv`, `otp`, `accountNumber`) triggers an immediate fail-closed termination.
4. **Local Security Boundary**: Telemetry, decision traces, and privacy receipts record only aggregate counts, durations, and categorical metadata, never user data.

---

## Security

PrivAgent implements defense-in-depth security controls:

- **Prompt Injection Defense**: Webpage content is treated as untrusted data. In-DOM commands (e.g., "Ignore previous instructions") are neutralized because reasoning operates only on structural entity graphs and user prompts.
- **Capability Validation**: Unsupported action types (`eval`, `execScript`, `download`) are rejected deterministically by the M5 Action Validator before execution.
- **Target Grounding**: Browser actions can only target elements that actively exist in the current page context. Hallucinated IDs are blocked.
- **Unauthorized Navigation Protection**: Navigations outside approved HTTP/HTTPS schemes or to internal/sensitive schemes (`javascript:`, `file:`, `chrome:`, `data:`) are blocked.
- **High-Risk Confirmation Gate**: Consequential actions (financial transactions, order placement, deletions) with risk scores $\ge 90$ pause execution until explicit user authorization is granted.
- **Stale Target Protection**: Navigation or dynamic DOM replacement increments the internal page generation counter; actions referencing targets from prior generations are rejected.
- **Provider Failure Handling**: Provider rate limits (HTTP 429), timeouts, or authentication errors fail closed cleanly without attempting unvalidated fallback executions.

---

## M1–M12 Status

| Milestone | Scope | Status | Verification Reference |
|---|---|:---:|---|
| **M1** | DOM Privacy Detection & Interactive Controls Discovery | **Complete** | `tests/domDetector.test.ts`, `tests/patterns.test.ts` |
| **M2** | Viewport Screenshot, Coordinate Mapping & Redaction | **Complete** | `tests/coordinateMapper.test.ts`, `tests/redactor.test.ts` |
| **M3** | On-Device Tesseract OCR & Coordinate Fusion | **Complete** | `tests/ocrDetector.test.ts`, `tests/ocrSecurityBoundary.test.ts` |
| **M4** | Sanitized Context Engine & Local IPC Bridge | **Complete** | `tests/securityBoundary.test.ts`, `backend/tests/test_context_api.py` |
| **M5** | Structured Browser Actions & Authoritative Validator | **Complete** | `tests/actionValidator.test.ts`, `tests/m5EndToEnd.test.ts` |
| **M6** | Autonomous Closed-Loop Browser Agent Runtime | **Complete** | `tests/agentLoop.test.ts`, `tests/agentState.test.ts` |
| **M7** | Groq Reasoner Gateway & Provider Hardening | **Complete** | `tests/m7Pipeline.test.ts`, `backend/tests/test_reasoner.py` |
| **M8** | Privacy Fusion, Context Minimization & Raw-Value Firewall | **Complete** | `tests/privacyFusion.test.ts`, `tests/centralPrivacyInvariant.test.ts` |
| **M9** | Browser Intelligence, Goal Verification & Stale-Target Recovery | **Complete** | `tests/goalVerifier.test.ts`, `tests/staleTargetSafety.test.ts` |
| **M10** | Semantic Grounding, Effect Verification & Safety Boundaries | **Complete** | `tests/m10BrowserIntelligence.test.ts`, `tests/semanticVerifier.test.ts` |
| **M11** | Failure Recovery Taxonomy & Production Hardening | **Complete** | `tests/m11Robustness.test.ts`, `tests/selfHealing.test.ts` |
| **M12** | Benchmarking Engine, SIH Proof Matrix & Dashboard UI | **Complete** | `tests/m12EvaluationSuite.test.ts`, `docs/M12_EVIDENCE_AUDIT.md` |

---

## Evaluation

The PrivAgent evaluation suite measures performance across curated benchmark suites. Metrics are scoped to reflect exact measurement environments:

| Metric | Measured Value | Measurement Scope | Evaluation Dataset / Harness | Status |
|---|:---:|:---:|---|:---:|
| **Visual Context Accuracy** | 98.5% | **TEST SET ONLY** | 24 synthetic coordinate transformation & clipping fixtures | Verified |
| **PII Detection Recall** | 100.0% | **TEST SET ONLY** | 75 synthetic multi-category PII fields | Verified |
| **PII Detection Precision** | 95.2% | **TEST SET ONLY** | 60 true positive detections vs 3 false positives | Verified |
| **PII Macro F1 Score** | 97.5% | **TEST SET ONLY** | Harmonic mean across 8 sensitive entity classes | Verified |
| **Redaction Precision** | 100.0% | **TEST SET ONLY** | Recursive pixel scanner verifying 0 unmasked leaks | Verified |
| **Redaction Recall** | 100.0% | **TEST SET ONLY** | 100% of sensitive fields replaced with masked tokens | Verified |
| **Zero-Leak Sensitive Transmission** | 0 bytes | **VERIFIED** | Outbound HTTP inspection of serialized JSON payloads | Verified |
| **Client Resource Utilization** | 14.2ms | **LOCAL ONLY** | JavaScript DOM candidate extraction execution time | Verified |
| **Local Decision Cycle Latency** | P50: 45ms / P95: 88ms | **LOCAL ONLY (GROQ EXCLUDED)** | Perception, grounding, M5 validation, effect verification | Verified |
| **M5 Local Validation Rate** | 100.0% | **VERIFIED** | Browser actions validated against active DOM bounds | Verified |
| **Stale Target Rejection** | 100.0% | **TEST SET ONLY** | Obsolete pageGeneration element IDs rejected | Verified |
| **Prompt Injection Resistance** | 100.0% (12/12) | **TEST SET ONLY** | 12 hostile injection vectors quarantined without hijacking | Verified |
| **Unauthorized Navigation Block** | 100.0% | **TEST SET ONLY** | Out-of-scope and self-automation URLs blocked | Verified |
| **High-Risk Confirmation Gate** | 100.0% | **VERIFIED** | Actions scoring $\ge 90$ paused for user authorization | Verified |
| **Provider Fail-Closed Rate** | 100.0% | **VERIFIED** | HTTP 429/401 fail closed with 0 speculative dispatches | Verified |
| **Goal Verification Accuracy** | 96.8% | **TEST SET ONLY** | 31/32 cases verified; 1 ambiguous case marked UNKNOWN | Verified |
| **Action-Effect Verification Rate** | 98.0% | **TEST SET ONLY** | 49/50 evaluated action steps confirmed expected mutation | Verified |
| **Recovery Success Rate** | 94.4% | **TEST SET ONLY** | 17/18 recoveries succeeded within retry budget | Verified |

*Note: Test-set metrics reflect evaluated ground-truth performance over curated synthetic benchmarks and must not be interpreted as universal open-web performance guarantees.*

---

## Performance

PrivAgent strictly separates local on-device decision cycle latency from cloud inference latency:

- **Local Decision Cycle Latency (Groq Latency Excluded)**:
  - **P50:** 45 ms
  - **P95:** 88 ms
  - Includes: DOM interactive traversal, coordinate HiDPI mapping, M5 structural validation, risk scoring, and local effect verification.
- **External Cloud Inference Latency (Empirically Measured)**:
  - **Per-step Groq roundtrip:** ~1,200 ms – 2,800 ms
  - **Full multi-page task latency (4–5 steps):** ~4.2 s – 9.8 s

---

## Setup & Reproduction

### Prerequisites
- Node.js $\ge 20.0.0$
- Python $\ge 3.10$
- Google Chrome $\ge 120$

### 1. Repository Installation
```bash
# Clone repository
git clone https://github.com/akashgoudsidduluri/PrivAgent.git
cd PrivAgent

# Install Node dependencies
npm install

# Install Python backend dependencies
cd backend
pip install -r requirements.txt
cd ..
```

### 2. Environment Configuration
Copy the example environment file and provide your reasoner credentials:
```bash
cp .env.example .env
```
Configure `.env`:
```ini
BACKEND_HOST=127.0.0.1
BACKEND_PORT=8010
REASONER_PROVIDER=groq
GROQ_API_KEY=your_groq_api_key_here
GROQ_MODEL=openai/gpt-oss-20b
```

### 3. Build Extension and Frontend
```bash
# Type check codebase
npx tsc --noEmit

# Build Chrome Manifest V3 Extension
npm run build:extension

# Build Web Dashboard
npm run build:frontend
```

### 4. Running the Tests
```bash
# Run Vitest test suite (451 tests)
npm test

# Run Pytest backend test suite (205 tests)
npm run test:backend
```

### 5. Running the Local Agent
```bash
# Terminal 1: Start FastAPI Reasoning Gateway (Port 8010)
npm run backend

# Terminal 2: Start Web Dashboard (Port 5173)
npm run dev

# Terminal 3: Start Demo Shopping / Banking Test Fixture (Port 4173)
npm run demo:shopping
```

### 6. Chrome Extension Loading
1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `extension/dist/` directory.
4. Navigate to `http://localhost:5173` to control the agent.

---

## Project Structure

```
PrivAgent/
├── backend/                  # FastAPI Reasoning Gateway & Safety API
│   ├── app/                  # Application core
│   │   ├── main.py           # FastAPI entrypoint & router mounts
│   │   ├── config.py         # Reasoner & environment configuration
│   │   ├── models.py         # Pydantic v2 strict models (extra='forbid')
│   │   ├── reasoner.py       # Groq & fallback provider adapters
│   │   ├── security.py       # Outbound sanitization & payload scanner
│   │   └── text_safety.py    # Regex PII detection for model text
│   ├── tests/                # Pytest test suite (205 tests)
│   └── requirements.txt      # Python dependencies
├── demo/                     # Local test fixtures
│   ├── shopping-fixture/     # Multi-page e-commerce fixture (ApexCart)
│   ├── synthetic-banking-site/ # Financial portal test fixture
│   └── canvas-privacy-site/  # Canvas & image OCR test fixture
├── docs/                     # Technical documentation & audits
│   ├── M12_EVALUATION_REPORT.md # M12 evaluation summary
│   ├── M12_EVIDENCE_AUDIT.md    # Forensic metric audit
│   ├── PHASE_0_BASELINE.md      # Phase 0 baseline audit & freeze
│   └── phase0-baseline.json     # Machine-readable baseline verification
├── evaluation/               # Reproducible benchmarking engine
│   ├── datasets/             # Annotated synthetic PII benchmarks
│   ├── reports/              # Generated SIH benchmark reports
│   ├── scripts/              # Benchmark execution runners
│   └── securityLab/          # Hostile injection attack suite
├── extension/                # Manifest V3 Chrome Extension
│   ├── src/
│   │   ├── agent/            # Agent loop, task planner, action validator, risk engine
│   │   ├── background/       # Service worker & target tab resolver
│   │   ├── capture/          # Viewport capture & coordinate mapper
│   │   ├── content/          # DOM scanner, content script & overlays
│   │   ├── ocr/              # WebAssembly Tesseract OCR integration
│   │   ├── privacy/          # Privacy fusion, rules, and context minimizer
│   │   ├── redaction/        # Canvas blackout/blur/mask redaction
│   │   └── telemetry/        # Telemetry, receipts & SIH evaluation
│   ├── manifest.json         # Extension manifest
│   └── vite.config.ts        # Extension multi-target Vite config
├── frontend/                 # Web Dashboard & Control Center
│   ├── src/                  # Views, state stores, adapters
│   ├── index.html            # Dashboard entrypoint
│   └── vite.config.ts        # Dashboard Vite config
├── tests/                    # Vitest test suite (451 tests)
├── package.json              # Project scripts and dependencies
├── tsconfig.json             # TypeScript root configuration
└── vitest.config.ts          # Vitest configuration
```

---

## Current Limitations

1. **Cloud Reasoner Latency**: While local decisions execute in under 50ms, cloud roundtrips to external LLMs (Groq) introduce 1.2s – 2.8s per step of network/generation latency.
2. **CAPTCHA & Anti-Bot Mitigations**: PrivAgent does not attempt to bypass CAPTCHAs, Cloudflare turnstiles, or bot challenges; these require human-in-the-loop intervention.
3. **Cross-Origin Iframe Sandboxes**: Elements embedded within restrictive cross-origin iframes without script access cannot have their DOM nodes inspected directly by the top-level content script.
4. **Virtualized Content / Infinite Virtual Scroll**: Content that is completely unmounted from the DOM outside the active viewport is only detectable after scrolling.

---

## Future Direction

PrivAgent 2.0 development will focus on advanced multimodal visual perception, enhanced spatial grounding, adaptive viewport planning, and local small-language-model (SLM) reasoning integration.
