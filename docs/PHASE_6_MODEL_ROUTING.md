# Phase 6: Model Routing

## Overview

Phase 6 introduces intelligent model routing for PrivAgent, dynamically selecting the most appropriate reasoning model based on task complexity, required capabilities (e.g., visual analysis), and historical performance (escalation).

## Architecture

The routing logic is cleanly separated between the Extension (Frontend) and the Backend.

### Extension (`ModelRouter`)
- Acts as a decorator over `AgentProvider`.
- Tracks `currentEscalation` (consecutive failures).
- Determines the required `model_role` (`FAST`, `STRONG`, `VISION`, `SAFETY`) based on context.
- `FAST`: Default for simple tasks.
- `STRONG`: Chosen for complex tasks or if `FAST` failed (escalation).
- `VISION`: Chosen if spatial highlights or visual metrics demand it, or on extreme escalation.
- `SAFETY`: A dedicated role for reviewing proposed actions before execution.

### Backend (`routes/agent.py`)
- Maps the requested `model_role` to specific deployment configurations (e.g., `openai/gpt-oss-120b`).
- Enforces allowed roles to prevent arbitrary model requests.
- Provides a `/review` endpoint for action safety analysis (currently deterministically returning SAFE in mock mode).
- Logs the actual `model_id` used for auditing but does not return it in telemetry, preventing extension-side leakage of provider details.

## Escalation Flow

1. `AgentLoop` begins execution and calls `provider.requestAction`.
2. `ModelRouter` intercepts, evaluates context, and selects a role (e.g., `FAST`).
3. Backend receives `FAST`, uses the configured fast model, and returns a proposed action.
4. If `AgentLoop` fails validation (e.g., M5 security error), it calls `provider.registerFailure()`.
5. `ModelRouter` increments the escalation counter.
6. On retry, `ModelRouter` observes the escalation and upgrades the role to `STRONG`.
7. Upon successful execution, `provider.resetEscalation()` is called.

## Safety Gating

After a proposed action is validated by the local sandbox but before the Risk Policy check, the action undergoes a Model-based Safety Review using the `SAFETY` role (`provider.reviewAction`). If rejected, the execution loops/fails.
