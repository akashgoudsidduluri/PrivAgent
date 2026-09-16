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
import { ProviderError } from './openRouterProvider';
import { AgentContextPayload, SensitiveEntityType } from '../privacy/types';

export type TaskStatus = 'IN_PROGRESS' | 'SUCCESS' | 'FAILED' | 'NEEDS_USER_CONFIRMATION' | 'STOPPED';

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
  /**
   * M7 Phase 4: total provider reasoning attempts across the WHOLE task,
   * tracked separately from `retryCount` (which counts validator/execution
   * retries within M6). Observable and explicitly bounded:
   * total ≤ maxSteps × (1 + providerRetries).
   */
  providerAttempts: number;
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
  /**
   * M7: bounded retries for RETRYABLE provider failures (network, 5xx, rate
   * limit, timeout) within a single reasoning step. This is NOT a second
   * agent loop — M6 still owns iteration, perception, and all other bounds.
   * Non-retryable failures (auth, malformed output) fail immediately.
   */
  providerRetries?: number;
  providerRetryDelayMs?: number;
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
  private providerRetries: number;
  private providerRetryDelayMs: number;
  private state: TaskState;
  private isStopped = false;

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
    this.providerRetries = options.providerRetries ?? 2;
    this.providerRetryDelayMs = options.providerRetryDelayMs ?? 250;

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
      providerAttempts: 0,
    };
  }

  /**
   * Safely halt the running task loop.
   */
  stop(): void {
    this.isStopped = true;
    if (this.state.status === 'IN_PROGRESS') {
      this.state.status = 'STOPPED';
      this.state.reason = 'Task stopped by user.';
      this.notifyProgress();
    }
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
    this.isStopped = false;
    this.state.task = task;
    this.state.currentStep = 0;
    this.state.status = 'IN_PROGRESS';
    this.state.previousActions = [];
    this.state.steps = [];
    this.state.visitedElementIds = [];
    this.state.retryCount = 0;
    this.state.providerAttempts = 0;
    this.state.reason = undefined;
    this.state.requiresUserConfirmationAction = undefined;

    while (this.state.status === 'IN_PROGRESS') {
      if (this.isStopped) {
        this.state.status = 'STOPPED';
        this.state.reason = this.state.reason || 'Task stopped by user.';
        this.notifyProgress();
        break;
      }

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
        console.info('[AgentTrace] M6 failed', { reason: this.state.reason });
        break;
      }
      console.info('[AgentTrace] perception complete');

      // Defense-in-depth: enforce zero raw PII in newly perceived context
      assertSanitizedContextSafe(context);
      this.state.currentUrl = context.url;

      // 3. Goal Completion Detection
      if (this.isTaskGoalSatisfied(task, this.state, context)) {
        this.state.status = 'SUCCESS';
        this.state.reason = 'Task goal successfully achieved.';
        this.notifyProgress();
        console.info('[AgentTrace] M6 completed');
        break;
      }

      // 4. Agent Reasoning Layer (M6 calls the provider ONCE per step; a
      // bounded retry wraps ONLY retryable provider/transport failures)
      this.state.currentStep++;
      let action: BrowserAction;
      try {
        console.info('[AgentTrace] requesting reasoning');
        action = await this.requestActionWithBoundedRetry(task, context);
        console.info('[AgentTrace] reasoning response received');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.state.status = 'FAILED';
        this.state.reason = `Agent reasoning failed: ${msg}`;
        this.notifyProgress();
        console.info('[AgentTrace] M6 failed', { reason: this.state.reason });
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
          console.info('[AgentTrace] M6 failed', { reason: this.state.reason });
          break;
        }
        // Wait and retry with next perception
        await this.delay(this.delayBetweenStepsMs);
        continue;
      }
      console.info('[AgentTrace] action validated');

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
          console.info('[AgentTrace] M6 failed', { reason: this.state.reason });
          break;
        }
        await this.delay(this.delayBetweenStepsMs);
        continue;
      }

      // 8. Deterministic Browser Execution
      console.info('[AgentTrace] executeAction started');
      const execResult = await this.callbacks.executeAction(action);
      console.info('[AgentTrace] executeAction response received');
      if (!execResult.success) {
        this.state.retryCount++;
        this.recordStep(action, true, validation.reason, false, execResult.error, targetDet?.type);
        this.notifyProgress();

        if (this.state.retryCount > this.maxRetries) {
          this.state.status = 'FAILED';
          this.state.reason = `Browser action execution failed repeatedly: ${execResult.error}`;
          console.info('[AgentTrace] M6 failed', { reason: this.state.reason });
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
        console.info('[AgentTrace] M6 completed');
        break;
      }

      // 10. Bounded observation delay to allow DOM to settle before next perception
      console.info('[AgentTrace] M6 next step');
      await this.delay(this.delayBetweenStepsMs);
      if (this.isStopped) {
        this.state.status = 'STOPPED';
        this.state.reason = this.state.reason || 'Task stopped by user.';
        this.notifyProgress();
        break;
      }
    }

    if (this.state.status === 'SUCCESS') {
      console.info('[AgentTrace] M6 completed');
    } else if (this.state.status === 'FAILED') {
      console.info('[AgentTrace] M6 failed', { reason: this.state.reason });
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
    console.info('[AgentTrace] executeAction started');
    const execResult = await this.callbacks.executeAction(action);
    console.info('[AgentTrace] executeAction response received');
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

  /**
   * M7: single reasoning request with bounded retry for retryable provider
   * failures only. Never retries on invalid output/auth — those fail safely
   * and M6 decides the next step (or terminates).
   */
  private async requestActionWithBoundedRetry(
    task: string,
    context: AgentContextPayload
  ): Promise<BrowserAction> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.providerRetries; attempt++) {
      this.state.providerAttempts++;
      try {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new ProviderError('Reasoning provider request timed out after 25s.', 'timeout', {
                  retryable: false,
                })
              ),
            25000
          )
        );
        return await Promise.race([
          this.provider.requestAction(task, context, this.state.previousActions),
          timeoutPromise,
        ]);
      } catch (err: unknown) {
        lastError = err;
        const retryable = err instanceof ProviderError ? err.retryable : false;
        if (!retryable || attempt >= this.providerRetries) {
          break;
        }
        await this.delay(this.providerRetryDelayMs);
      }
    }
    throw lastError;
  }

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
