# Phase 5: Privacy-Preserving Agent Memory

Phase 5 introduces a robust, privacy-first memory subsystem for PrivAgent. The goal is to provide the reasoning engine with historical context, user preferences, and failure recovery knowledge without ever bypassing the M5 action guards or the M8 privacy firewall.

## Core Design Principles

1. **Assistive, Not Authoritative**: Memory only suggests actions. The `BrowserWorldModel` and local perception remain the ultimate source of truth.
2. **Zero-Leakage**: All memory writes pass through the M8 Privacy Firewall. No raw PII, passwords, OTPs, or credential tokens will ever be persisted.
3. **Prompt Injection Defense**: Content originating from the web (`WEBPAGE` source) is structurally prevented from creating high-trust semantic memory or user preferences.
4. **Deterministic Bounds**: Persistent storage (`chrome.storage.local`) is strictly bounded by item count and byte size to prevent runaway resource usage.

## Architecture

The memory subsystem is located in `extension/src/memory/` and consists of the following components:

- **MemoryTypes**: Defines the 4 memory classes (`Working`, `Episodic`, `Semantic`, `Failure`), the `SiteScope` (origin + taxonomy), and the **Explicit Trust Hierarchy** (e.g., Local Policy > Verified Observation > Semantic Memory > Remote Model).
- **MemoryStore**: Abstracted persistence layer using `chrome.storage.local`. Implements deterministic eviction (oldest first) and global byte limits (~2MB).
- **MemoryFirewall**: A dedicated write boundary that integrates `rawValueScanner.ts` (M8) to ensure zero leakage and enforces structural source trust.
- **MemoryManagers**: Dedicated lifecycle managers for Working, Episodic, Semantic, and Failure memory types. Working memory remains strictly in-memory.
- **MemoryRetriever**: Deterministically fetches and ranks relevant memory hints based on `SiteScope` and goal.
- **PlannerContextBuilder Integration**: Injects memory hints into the planner payload while ensuring the 2KB budget is respected. Hints are the first elements to be trimmed if the budget is exceeded.

## Telemetry Observability

Memory influence is explicitly observable. The `PlannerTelemetryLogger` records:
- `memoryInfluencedPlanning`: boolean
- `memoryInfluencedRecovery`: boolean
- `memoryConflictDetected`: boolean
- `memoryOverriddenByCurrentWorld`: boolean
- `memoryMetadata`: Array detailing ID, type, trust level, scope, and confidence of the memories used.

## User Preferences

User preferences are treated as a distinct `SEMANTIC` memory type (`USER_PREFERENCE`). They must originate explicitly from the `USER` source. They are never inferred from webpage interactions to prevent injection attacks.

## Acceptance Testing

A dedicated acceptance script (`scratch/run_phase5_real_chrome_acceptance.ts`) verifies:
- Ephemeral lifecycle of working memory.
- Safe persistence of semantic and episodic memory.
- M8 prompt injection and zero-leakage defenses.
- Context budget minimization logic.
- Telemetry logging of memory influence.
