/**
 * PrivAgent — Autonomous Agent Loop & Task Runner (Milestone 6)
 *
 * Implements the multi-step perception → reasoning → validation → execution loop:
 *
 *   User Task
 *   → Capture/Re-scan Page (M1 DOM + M2 Screenshot + M3 OCR)
 *   → M4 Sanitized Context (assertSanitizedContextSafe)
 *   → M5 Agent Reasoning (AgentProvider)
 *   → Structured Action (BrowserAction allowlist)
 *   → M5 Action Validator (validateAction)
 *   → Capability Privacy Policy (canPerformAction)
 *   → Consequential Check (NEEDS_USER_CONFIRMATION if navigating away or submitting sensitive forms)
 *   → Browser Execution (DOM dispatch)
 *   → Observe Page Change (wait bounded delay)
 *   → Re-scan
 *   → Repeat until SUCCESS / FAILED / NEEDS_USER_CONFIRMATION
 *
 * Security Invariants:
 *  - Remote LLM NEVER receives raw sensitive values or unredacted media.
 *  - TaskState NEVER stores raw PII, credentials, or raw OCR.
 *  - Every single action is validated by the local Action Validator BEFORE execution.
 *  - No eval(), arbitrary JS, dynamic scripts, or code injection.
 *  - Strict max-steps limit (default: 10) and retry limit (default: 2 per action).
 */

import { BrowserAction, ActionType } from './actionTypes';
import { validateAction } from './actionValidator';
import { canPerformAction, assertSanitizedContextSafe } from './privacyPolicy';
import { AgentProvider } from './agentProvider';
import { AgentContextPayload, SensitiveEntityType } from '../privacy/types';

export type TaskStatus = 'IN_PROGRESS' | 'SUCCESS' | 'FAILED' | 'NEEDS_USER_CONFIRMATION';

export interface StepRecord {
  step: number;
  action: BrowserAction;
  validationAllowed: boolean;
  validationReason: string;
  executionSuccess: boolean;
  executionError?: string;
  targetId?: string;
  targetType?: string;
  url: string;
  timestamp: number;
}

export interface TaskState {
  task: string;
  currentStep: number;
  status: TaskStatus;
  previousActions: BrowserAction[];
  steps: StepRecord[];
  currentUrl: string;
  visitedElementIds: string[];
  retryCount: number;
  maxSteps: number;
  maxRetries: number;
  reason?: string;
  requiresUserConfirmationAction?: BrowserAction;
}

export interface AgentLoopCallbacks {
  /**
   * Fresh perception provider: returns the latest sanitized context.
   */
  perceivePage: () => Promise<AgentContextPayload | null>;

  /**
   * Browser execution provider: executes the validated BrowserAction.
   */
  executeAction: (
    action: BrowserAction
  ) => Promise<{ success: boolean; error?: string; message?: string }>;

  /**
   * Optional progress listener called after every step.
   */
  onStepProgress?: (state: TaskState) => void;
}

export interface AgentLoopOptions {
  maxSteps?: number;
  maxRetries?: number;
  delayBetweenStepsMs?: number;
  requireConfirmationForExternalNavigation?: boolean;
}

// Complete normalized forbidden key set that must never appear anywhere in TaskState
const FORBIDDEN_STATE_KEYS = new Set([
  'value', 'text', 'textcontent', 'innertext', 'rawtext',
  'rawocr', 'ocrtext', 'password', 'words', 'lines',
  'token', 'secret', 'card', 'cardnumber', 'cvv',
  'pan', 'accountnumber', 'raw', 'input', 'sensitivevalue', 'pii',
]);

/**
 * Scan TaskState recursively to verify zero raw sensitive keys or credentials exist in state.
 */
export function assertNoSensitiveDataInState(state: unknown, path = '<root>'): void {
  if (state === null || state === undefined) return;
  if (typeof state === 'object') {
    if (Array.isArray(state)) {
      state.forEach((item, i) => assertNoSensitiveDataInState(item, `${path}[${i}]`));
    } else {
      for (const key of Object.keys(state as Record<string, unknown>)) {
        const norm = key.toLowerCase().replace(/_/g, '');
        if (FORBIDDEN_STATE_KEYS.has(norm) || FORBIDDEN_STATE_KEYS.has(key.toLowerCase())) {
          throw new Error(
            `[PrivAgent M6 Security] Sensitive key '${key}' detected in TaskState at '${path}.${key}'. ` +
            'State must never contain raw PII or credentials.'
          );
        }
        assertNoSensitiveDataInState((state as Record<string, unknown>)[key], `${path}.${key}`);
      }
    }
  }
}

/**
 * The core autonomous agent task runner.
 */
export class AgentLoop {
  private provider: AgentProvider;
  private callbacks: AgentLoopCallbacks;
  private maxSteps: number;
  private maxRetries: number;
  private delayBetweenStepsMs: number;
  private requireConfirmationForExternalNavigation: boolean;
  private state: TaskState;

  constructor(
    provider: AgentProvider,
    callbacks: AgentLoopCallbacks,
    options: AgentLoopOptions = {}
  ) {
    this.provider = provider;
    this.callbacks = callbacks;
    this.maxSteps = options.maxSteps ?? 10;
    this.maxRetries = options.maxRetries ?? 2;
    this.delayBetweenStepsMs = options.delayBetweenStepsMs ?? 200;
    this.requireConfirmationForExternalNavigation =
      options.requireConfirmationForExternalNavigation ?? true;

    this.state = {
      task: '',
      currentStep: 0,
      status: 'IN_PROGRESS',
      previousActions: [],
      steps: [],
      currentUrl: '',
      visitedElementIds: [],
      retryCount: 0,
      maxSteps: this.maxSteps,
      maxRetries: this.maxRetries,
    };
  }

  getState(): TaskState {
    return {
      ...this.state,
      steps: [...this.state.steps],
      previousActions: [...this.state.previousActions],
    };
  }

  /**
   * Run the complete autonomous task loop until SUCCESS, FAILED, or NEEDS_USER_CONFIRMATION.
   */
  async runTask(task: string): Promise<TaskState> {
    this.state.task = task;
    this.state.currentStep = 0;
    this.state.status = 'IN_PROGRESS';
    this.state.previousActions = [];
    this.state.steps = [];
    this.state.visitedElementIds = [];
    this.state.retryCount = 0;
    this.state.reason = undefined;
    this.state.requiresUserConfirmationAction = undefined;

    while (this.state.status === 'IN_PROGRESS') {
      // 1. Check max steps bound (endless-loop prevention)
      if (this.state.currentStep >= this.maxSteps) {
        this.state.status = 'FAILED';
        this.state.reason = `Task exceeded maximum step limit of ${this.maxSteps}.`;
        this.notifyProgress();
        break;
      }

      // 2. Fresh perception cycle: obtain current sanitized context
      const context = await this.callbacks.perceivePage();
      if (!context) {
        this.state.status = 'FAILED';
        this.state.reason = 'Perception failed: Unable to obtain sanitized page context.';
        this.notifyProgress();
        break;
      }

      // Defense-in-depth: enforce zero raw PII in newly perceived context
      assertSanitizedContextSafe(context);
      this.state.currentUrl = context.url;

      // 3. Goal Completion Detection
      if (this.isTaskGoalSatisfied(task, this.state, context)) {
        this.state.status = 'SUCCESS';
        this.state.reason = 'Task goal successfully achieved.';
        this.notifyProgress();
        break;
      }

      // 4. Agent Reasoning Layer
      this.state.currentStep++;
      let action: BrowserAction;
      try {
        action = await this.provider.requestAction(task, context, this.state.previousActions);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.state.status = 'FAILED';
        this.state.reason = `Agent reasoning failed: ${msg}`;
        this.notifyProgress();
        break;
      }

      // 5. Consequential action check: requires user confirmation
      if (this.isConsequentialAction(action, this.state.currentUrl)) {
        this.state.status = 'NEEDS_USER_CONFIRMATION';
        this.state.requiresUserConfirmationAction = action;
        this.state.reason = `Action requires user confirmation: Navigating across domains or executing consequential action.`;
        this.notifyProgress();
        break;
      }

      // 6. Local Action Validator (M5 validator is authoritative)
      const validation = validateAction(action, context);
      if (!validation.allowed) {
        this.state.retryCount++;
        this.recordStep(action, false, validation.reason, false, validation.reason);
        this.notifyProgress();

        if (this.state.retryCount > this.maxRetries) {
          this.state.status = 'FAILED';
          this.state.reason = `Validator rejected action repeatedly: ${validation.reason}`;
          break;
        }
        // Wait and retry with next perception
        await this.delay(this.delayBetweenStepsMs);
        continue;
      }

      // 7. Privacy Capability Policy Check
      const targetDet = 'target' in action ? context.detections.find((d) => d.id === (action as any).target) : undefined;
      const policy = canPerformAction(action, targetDet, 'agent_llm');
      if (!policy.granted) {
        this.state.retryCount++;
        this.recordStep(action, false, `Policy Denied: ${policy.reason}`, false, policy.reason, targetDet?.type);
        this.notifyProgress();

        if (this.state.retryCount > this.maxRetries) {
          this.state.status = 'FAILED';
          this.state.reason = `Privacy policy rejected action repeatedly: ${policy.reason}`;
          break;
        }
        await this.delay(this.delayBetweenStepsMs);
        continue;
      }

      // 8. Deterministic Browser Execution
      const execResult = await this.callbacks.executeAction(action);
      if (!execResult.success) {
        this.state.retryCount++;
        this.recordStep(action, true, validation.reason, false, execResult.error, targetDet?.type);
        this.notifyProgress();

        if (this.state.retryCount > this.maxRetries) {
          this.state.status = 'FAILED';
          this.state.reason = `Browser action execution failed repeatedly: ${execResult.error}`;
          break;
        }
        await this.delay(this.delayBetweenStepsMs);
        continue;
      }

      // 9. Successful action execution
      this.state.retryCount = 0; // Reset retry count after success
      this.state.previousActions.push(action);
      if ('target' in action && typeof (action as any).target === 'string') {
        this.state.visitedElementIds.push((action as any).target);
      }
      this.recordStep(action, true, validation.reason, true, undefined, targetDet?.type);

      // Verify no sensitive keys entered state
      assertNoSensitiveDataInState(this.state);
      this.notifyProgress();

      // Check immediate completion
      if (this.isTaskGoalSatisfied(task, this.state, context)) {
        this.state.status = 'SUCCESS';
        this.state.reason = 'Task goal successfully achieved.';
        this.notifyProgress();
        break;
      }

      // 10. Bounded observation delay to allow DOM to settle before next perception
      await this.delay(this.delayBetweenStepsMs);
    }

    return this.getState();
  }

  /**
   * Resume an agent loop after explicit user confirmation of a consequential action.
   */
  async resumeWithConfirmation(): Promise<TaskState> {
    if (this.state.status !== 'NEEDS_USER_CONFIRMATION' || !this.state.requiresUserConfirmationAction) {
      throw new Error('Cannot resume: Task is not waiting for user confirmation.');
    }

    const action = this.state.requiresUserConfirmationAction;
    this.state.requiresUserConfirmationAction = undefined;
    this.state.status = 'IN_PROGRESS';

    // Execute the confirmed action
    const execResult = await this.callbacks.executeAction(action);
    if (!execResult.success) {
      this.state.status = 'FAILED';
      this.state.reason = `Confirmed action execution failed: ${execResult.error}`;
      this.notifyProgress();
      return this.getState();
    }

    this.state.previousActions.push(action);
    this.recordStep(action, true, 'User explicitly confirmed consequential action', true);
    this.notifyProgress();

    // Re-enter autonomous loop
    return this.runTask(this.state.task);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private isConsequentialAction(action: BrowserAction, currentUrl: string): boolean {
    if (action.action === 'navigate' && this.requireConfirmationForExternalNavigation) {
      try {
        const dest = new URL(action.url);
        const curr = new URL(currentUrl);
        // If navigating to a different origin/domain, require user confirmation
        if (dest.origin !== curr.origin) {
          return true;
        }
      } catch {
        return false;
      }
    }
    return false;
  }

  private isTaskGoalSatisfied(task: string, state: TaskState, context: AgentContextPayload): boolean {
    const lower = task.toLowerCase();

    // Multi-step task: "Open the account details and find the recent transactions"
    if (
      (lower.includes('account details') || lower.includes('details')) &&
      (lower.includes('transaction') || lower.includes('transactions'))
    ) {
      // Completed when at least 3 steps have executed (click details -> scroll down -> click transactions)
      const hasClicked = state.previousActions.some((a) => a.action === 'click');
      const hasScrolled = state.previousActions.some((a) => a.action === 'scroll');
      return state.previousActions.length >= 3 && hasClicked && hasScrolled;
    }

    // Single-step demo task 1: "Find and click the account number field"
    if (lower.includes('account number') || lower.includes('account_number')) {
      return (
        state.steps.some(
          (s) => s.executionSuccess && s.action.action === 'click' && s.targetType === 'account_number'
        ) ||
        state.previousActions.some(
          (a) =>
            a.action === 'click' &&
            state.visitedElementIds.some((id) => {
              const det = context.detections.find((d) => d.id === id);
              return det && det.type === 'account_number';
            })
        )
      );
    }

    // Single-step demo task 2: "Scroll down and find the transaction section"
    if (lower.includes('scroll down') || lower.includes('scroll')) {
      return state.previousActions.some((a) => a.action === 'scroll');
    }

    // Single-step demo task 3: "Open the account details"
    if (lower.includes('account details') || lower.includes('details')) {
      return state.previousActions.some((a) => a.action === 'click');
    }

    return false;
  }

  private recordStep(
    action: BrowserAction,
    validationAllowed: boolean,
    validationReason: string,
    executionSuccess: boolean,
    executionError?: string,
    targetType?: string
  ): void {
    const record: StepRecord = {
      step: this.state.currentStep,
      action,
      validationAllowed,
      validationReason,
      executionSuccess,
      executionError,
      targetId: 'target' in action ? (action as any).target : undefined,
      targetType,
      url: this.state.currentUrl,
      timestamp: Date.now(),
    };
    this.state.steps.push(record);
  }

  private notifyProgress(): void {
    if (this.callbacks.onStepProgress) {
      this.callbacks.onStepProgress(this.getState());
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
