# Phase 17.3 — Security Invariants & Authority Boundary Report

**Date:** 2026-09-27  
**Substrate:** PrivAgent Local Security Pipeline + Real Chrome MV3 Extension  
**Authority Boundary Audit:** OCR as Observation Source vs Action Authorization  

---

## 1. Fundamental Principle: Observation is NOT Authorization

In PrivAgent, OCR is strictly an **observational perception source**. It provides supplementary visual evidence about what is displayed on the active viewport.

Under no circumstances can an OCR finding:
- Authorize a browser action.
- Downgrade an action's risk level.
- Bypass user confirmation requirements.
- Overrule the Security Critic or Grounding Validator.
- Circumvent Effect Verification or Goal Verification rules.

---

## 2. Security Authority Pipeline Audit

The table below documents how Phase 17.3 OCR interacts with each authoritative security gate in PrivAgent:

| Security Gate | Authoritative Role | Can OCR Bypass or Override? | Invariant Enforcement |
| :--- | :--- | :---: | :--- |
| **Grounding Validator** | Resolves action targets to live DOM/visual coordinates | **NO** | Action targets must exist in live state; an OCR text reading cannot create fake targets. |
| **M5 Privacy Firewall** | Blocks transmission of raw sensitive values | **NO** | Raw OCR text matching cards, phones, emails is purged locally before reaching the egress filter. |
| **Security Critic** | Pre-execution safety and prompt injection defense | **NO** | Prompt injection visually rendered inside a canvas is classified as text and cannot execute commands. |
| **Risk / Confirmation Engine** | Identifies high-risk destructive actions (transfers, delete, buy) | **NO** | OCR presence never reduces risk assessment score or skips confirmation prompts. |
| **Effect Verifier** | Post-dispatch state delta observation | **NO** | Observation contract strictly requires fresh state transitions; stale OCR is rejected. |
| **Goal Verifier** | Deterministic goal satisfaction determination | **NO** | Verifies goals only when genuine visual headings or non-sensitive affordances match. |
| **Containment Boundary** | Restricts execution to authorized origins | **NO** | Target tab origin checks strictly enforce containment; cross-origin canvas leaks fail closed. |
| **Dashboard Isolation** | Prevents agent self-inspection / infinite loops | **NO** | `isDashboardUrl` immediately aborts screenshot and OCR if dashboard tab is targeted. |

---

## 3. Negative Security Stress Invariants

1. **Unmappable Findings Fail Closed:** If an OCR bounding box cannot be transformed into valid viewport coordinates due to non-finite or degenerate geometry ($w \le 0$ or $h \le 0$), the region is immediately discarded rather than assigned arbitrary coordinates.
2. **Tab Spoofing Protection:** If a screenshot is captured from Tab $A$ while the agent moves to Tab $B$, `isOCRObservationFresh` marks the observation `STALE` and rejects it.
3. **Document Navigation Protection:** If the URL origin or path changes while OCR is running, the observation state transitions from `OBSERVED` to `STALE`.
4. **Dashboard Exclusion:** Any attempt to capture or OCR a PrivAgent dashboard tab returns `UNAVAILABLE` (`Screenshot capture rejected: target tab is the dashboard`).
