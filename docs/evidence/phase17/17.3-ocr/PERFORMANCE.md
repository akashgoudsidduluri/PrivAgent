# Phase 17.3 — Local OCR Performance Benchmarks

**Date:** 2026-09-27  
**Substrate:** Real Google Chrome 153.0.8010.53 + Chrome Offscreen Document  
**Sample Count:** 10 continuous perception cycles  
**Workload:** 5 OCR regions (canvas heading + 3 sensitive tokens + 1 mixed checksum)  
**Screenshot Dimensions:** 1280 × 800  
**Hardware:** Intel / AMD x64 Host System, Windows 11  

---

## 1. Measured Performance Metrics Breakdown

All metrics reported below were measured empirically via `scratch/verify_phase17_3_real_chrome.mjs` against real Chrome over CDP.

| Latency Component | Cold State | Warm State (Avg) | Warm State (p50 / p95 / Max) | Status |
| :--- | :---: | :---: | :---: | :---: |
| **Screenshot Capture** (`captureVisibleTab`) | 14 ms | 14 ms | 14 ms / 14 ms / 14 ms | **FAST** |
| **Offscreen OCR Worker Initialization** | 82 ms | 0 ms (reused) | 0 ms / 0 ms / 0 ms | **OPTIMAL** |
| **Local OCR Recognition Latency** | 61 ms | 61 ms | 62 ms / 64 ms / 64 ms | **OPTIMAL** |
| **Local Privacy Screening & Fusion** | 3 ms | 3 ms | 3 ms / 3 ms / 3 ms | **REAL-TIME** |
| **Total OCR Perception Latency** | **160 ms** | **78 ms** | **79 ms / 81 ms / 81 ms** | **SUB-100MS WARM** |

---

## 2. Overhead Comparison: OCR Disabled vs OCR Enabled

| Configuration | Full Perception Cycle Latency | Overhead Attributable to OCR |
| :--- | :---: | :---: |
| **OCR Disabled (DOM-Only Cycle)** | **18 ms** | Baseline ($0\text{ ms}$) |
| **OCR Enabled (Canvas / Non-DOM Cycle)** | **96 ms** | **+78 ms** |

**Agent-Cycle Impact:** On perception cycles where non-DOM evidence is required, on-device local OCR introduces an average of $78\text{ ms}$ total perception overhead (including capture, OCR worker messaging, and privacy fusion). On standard DOM-only cycles, conditional gating bypasses capture and OCR entirely, adding $0\text{ ms}$ overhead.

---

## 3. Memory & Resource Isolation

- **Offscreen Process Boundary:** OCR execution is isolated inside a dedicated Chrome offscreen document (`offscreen.html`), decoupling WASM memory from the extension service worker.
- **Buffer Hygiene:** Raw base64 image strings are dereferenced immediately after canvas transfer.
- **Memory Measurement Disclosure:** While the architectural isolation prevents service worker memory crashes, process-level RSS and heap snapshots were not empirically benchmarked.
- **Empirical Memory Impact:** `memory impact: NOT_MEASURED`
