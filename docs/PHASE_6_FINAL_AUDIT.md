# Phase 6 Final Audit: Model Routing and Safety

## Implementation Summary

- **Model Router (`extension/src/agent/modelRouter.ts`)**: Implemented a decorator pattern to wrap the `AgentProvider`. It tracks escalation state and determines the optimal `model_role` (`FAST`, `STRONG`, `VISION`, `SAFETY`) based on contextual heuristics (e.g., node count, spatial highlights) and failure rates.
- **Agent Provider Interface (`extension/src/agent/agentProvider.ts`)**: Extended to include `registerFailure()`, `resetEscalation()`, and `reviewAction()` methods, allowing seamless integration with the `AgentLoop`.
- **Agent Loop Integration (`extension/src/agent/agentLoop.ts`)**: The execution loop now signals failures to the provider and delegates action validation to the model-based `SAFETY` review (step 6a) before enforcing the local Privacy Capability Policy.
- **Backend Router (`backend/app/routes/agent.py`)**: The `/api/v1/agent/action` endpoint now parses the `model_role` and delegates reasoning to the correctly sized model. It strictly allows only known roles. A new `/api/v1/agent/review` endpoint was added for safety reviews.
- **Telemetry Integrity (`backend/app/models.py`)**: Modified `ReasoningTelemetry` to emit the `role` rather than the specific `model` (e.g., `openai/gpt-oss-120b`). The exact model identity is logged securely in the backend, preventing unnecessary provider leakage to the extension.

## Security & Privacy Audit

- **Fail-Closed Principle**: The backend API rejects unknown `model_role` values with HTTP 400. If an escalation role is unsupported by configuration, it defaults to the robust fallback.
- **Sandbox Enforcement**: The local Privacy Sandbox (M5) is completely unaffected; it still executes deterministically.
- **Safety Independence**: The new `SAFETY` review executes independently of the reasoning phase. It cannot override the deterministic M5 sandbox; it only adds an additional semantic safety check.
- **No Provider Leakage**: The telemetry changes ensure the frontend only logs `STRONG`, `FAST`, etc., completely hiding the underlying cloud API implementation.

## Conclusion

Phase 6 is complete. The system now dynamically routes to smaller, faster models by default, escalating to stronger or vision-capable models only when context demands or failures occur, substantially optimizing latency and cost while improving overall task robustness.
