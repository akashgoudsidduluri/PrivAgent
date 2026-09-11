# PrivAgent 🛡️
> **On-Device Visual Perception & Local Privacy Boundary for Lightweight Browser Agents**  
> **SIH 2026 Problem Statement:** `SIH26171`  
> **Organization:** Indian Space Research Organisation (ISRO)  

---

## 📌 Milestone 1 Architecture

PrivAgent establishes an inviolable **local privacy boundary** on the user's client machine before any DOM or visual webpage context can ever reach an external LLM/VLM or backend server.

```
       [ Webpage / DOM ]
              │
              ▼
   ┌─────────────────────────────────────────────────────────────┐
   │             PRIVAGENT LOCAL PRIVACY BOUNDARY                │
   │                                                             │
   │  1. DOM Sensitive Detector                                  │
   │     • Scans types, autocompletes, labels, & regex patterns │
   │     • Calculates viewport bounding boxes [x, y, w, h]       │
   │                                                             │
   │  2. Strict Security Boundary                                │
   │     • Zero-PII-Leakage Invariant                            │
   │     • Metadata ONLY (type, confidence, selector, bbox)      │
   │     • value, textContent, innerText are STRICTLY EXCLUDED   │
   │                                                             │
   │  3. Local Visual Redaction                                  │
   │     • Blackout ◼ | Blur 💧 | [REDACTED] Mask 🔲             │
   │     • Renders over viewport; original inputs functional     │
   │                                                             │
   │  4. Privacy Dashboard                                       │
   │     • Real-time scan & redaction latency (ms)               │
   │     • Entity breakdown & live transmission clearance        │
   └──────────────────────────────┬──────────────────────────────┘
                                  │
                     Sanitized Context Payload
                     (Local Privacy Check Passed)
                                  │
                                  ▼
                   [ Future Backend / LLM / VLM ]
```

---

## 📁 Repository Structure

```text
PrivAgent/
│
├── extension/                       # Chrome Extension (Manifest V3)
│   ├── manifest.json                # MV3 manifest with isolated permissions
│   ├── package.json                 # Extension scripts
│   ├── tsconfig.json                # TypeScript configuration
│   ├── vite.config.ts               # Multi-target Vite bundling configuration
│   ├── public/icons/                # 16x16, 48x48, 128x128 shield icons
│   └── src/
│       ├── background/              # Background service worker & badge manager
│       ├── content/                 # Content script & floating demo stage bar
│       ├── popup/                   # Privacy dashboard UI & benchmark metrics
│       ├── privacy/                 # DOM detector, patterns, & security boundary
│       └── redaction/               # Multi-mode visual redactor (blackout/blur/mask)
│
├── demo/
│   └── synthetic-banking-site/      # Realistic financial portal with 100% fake data
│       ├── index.html               # Account balance, cards, transfer modal, credentials
│       ├── style.css                # Polished glassmorphic banking aesthetic
│       ├── app.js                   # Interactive client logic
│       ├── server.py                # Python zero-dependency dev server
│       └── server.js                # Node.js dev server alternative
│
├── backend/                         # Backend foundation (prepared for Milestone 7+)
│   ├── app/
│   └── requirements.txt
│
├── tests/                           # Automated test suite (Vitest + JSDOM)
│   ├── patterns.test.ts             # Luhn credit card check & regex validations
│   ├── domDetector.test.ts          # DOM scanning, bbox calculation, & PII exclusion
│   ├── securityBoundary.test.ts     # Invariant tests: blocks forbidden value/text keys
│   └── redactor.test.ts             # Blackout, blur, & mask overlay tests
│
├── .env.example
├── .gitignore
├── package.json                     # Monorepo root scripts & dev dependencies
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

---

## 🚀 Quickstart Guide

### 1. Prerequisites
- **Node.js**: v18+ (Tested on v22.18.0)
- **npm**: v9+ (Tested on 11.7.0)
- **Python**: 3.10+ (for demo server and future backend)
- **Google Chrome** or any Chromium-based browser

### 2. Install Dependencies
```bash
npm install
```

### 3. Run Automated Tests
```bash
npm test
```
All tests should pass, validating:
- Luhn credit card validation (e.g. `4111 1111 1111 1111`)
- Phone, email, account number, and password identification
- **Zero-PII leakage**: Proves `DetectionResult` never contains raw passwords, values, or text content
- Redaction overlay creation and clearing

### 4. Build the Chrome Extension
```bash
npm run build
```
This generates the ready-to-load unpacked extension inside:
```
extension/dist/
```

### 5. Launch the Synthetic Banking Demo
In a separate terminal:
```bash
npm run demo
# or: python demo/synthetic-banking-site/server.py
```
Open your browser to: **`http://localhost:4173`**

---

## 🧩 Loading the Extension in Chrome

1. Open Google Chrome and navigate to:
   ```text
   chrome://extensions/
   ```
2. Enable **Developer mode** toggle in the top-right corner.
3. Click **Load unpacked**.
4. Browse to and select the `PrivAgent/extension/dist` folder.
5. PrivAgent will appear in your Chrome toolbar. Pin the extension for easy access.

---

## 🧪 Verifying Milestone 1

1. Open **`http://localhost:4173`** in Chrome.
2. Notice the floating **PrivAgent Boundary** bar at the bottom:
   - Click **`1. Original`** to view the raw synthetic banking page.
   - Click **`2. Detected`** to view bounding box overlays showing detected entities (`password`, `credit_card`, `account_number`, `email`, `phone`, `person_name`) with their confidence ratings.
   - Click **`3. Sanitized`** to view active local redaction masks.
3. Click the **PrivAgent Extension Icon** in the toolbar to open the **Privacy Dashboard**:
   - **Status Badge**: `Sanitized Context — Local Privacy Check Passed`
   - **Metrics**: Displays genuine counts of detected elements, protected regions, and 0 leakage.
   - **Benchmarks**: Displays real `DOM Scan Latency` (e.g. ~8-15 ms) and `Redaction Latency` (e.g. ~2-4 ms).
   - **Mode Switching**: Switch between `◼ Blackout`, `💧 Blur`, and `🔲 [REDACTED]`.
   - **View JSON Payload**: Click to inspect the exact serialized report to verify that **no sensitive values exist** in the exported data structure.

---

## 🔒 Security & Privacy Guarantees

- **No Value Retention**: Values from `<input>`, `<textarea>`, `<select>`, and text nodes are never saved to the `DetectionResult` interface.
- **Local Boundary**: Redaction is calculated and rendered directly in the client DOM.
- **Zero Hallucinated Metrics**: All dashboard timings are measured using `performance.now()`.
- **Synthetic Data Compliance**: All test credentials (`Rahul Sharma`, `DemoPassword123`, `4111 1111 1111 1111`, `123456789012`) are 100% fictional.
