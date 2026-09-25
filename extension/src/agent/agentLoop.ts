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
import { assessActionRisk, ActionRiskAssessment } from './riskEngine';
import { verifySemanticAction, SemanticVerificationResult } from './semanticVerifier';
import {
  createTaskPlan,
  updateTaskPlanProgress,
  diagnoseFailureAndReplan,
  TaskPlan,
} from './taskPlanner';
import { recoverStaleTarget, SelfHealingResult } from './selfHealing';
import {
  evaluateExecutionConfidence,
  ConfidenceEvaluation,
} from './confidenceScorer';
import { AgentDecisionTracer, DecisionTraceEntry } from './decisionTrace';
import {
  AgentTaskState,
  TaskState,
  StepRecord,
  TaskStatus,
  PageCategory,
  StructuredConstraints,
  SubGoalItem,
  CandidateProductItem,
  ExpectedStateChange,
  createAgentTaskState,
  advancePageGeneration,
} from './agentState';
import { parseUserGoal } from './goalParser';
import { verifyTaskGoal } from './goalVerifier';
import { BrowserWorldModel, ActiveWorldModelRef } from '../worldModel/types';
import {
  buildSemanticUnderstanding,
  SemanticUnderstandingOutput,
  SanitizedSemanticContext,
} from '../semanticUnderstanding';
import {
  decomposeTask,
  SubgoalGraph,
  SubgoalSelector,
  OneActionPlanner,
  PlanStateMachine,
  PlannerContextBuilder,
  HighLevelGoal,
  Subgoal,
  SubgoalGraphData,
  PlanningEngineState,
} from '../hierarchicalPlanning';
import {
  WorkingMemoryManager,
  EpisodicMemoryManager,
  SemanticMemoryManager,
  FailureMemoryManager,
  MemoryRetriever,
  MemoryHints,
  MemoryTrustLevel,
  SiteScope,
} from '../memory';

export type { TaskStatus, StepRecord, TaskState, AgentTaskState } from './agentState';

export interface WorldModelPerceptionResult {
  context: AgentContextPayload;
  worldModel?: BrowserWorldModel;
  activeWorldModelRef?: ActiveWorldModelRef | null;
  semanticUnderstanding?: SemanticUnderstandingOutput;
  semanticContext?: SanitizedSemanticContext;
}

export interface AgentLoopCallbacks {
  /**
   * Fresh perception provider: returns the latest sanitized context, optionally
   * paired with the canonical world model for the current page generation.
   */
  perceivePage: () => Promise<AgentContextPayload | WorldModelPerceptionResult | null>;

  /**
   * Browser execution provider: executes the validated BrowserAction.
   */
  executeAction: (
    action: BrowserAction
  ) => Promise<{ success: boolean; error?: string; message?: string }>;

  /**
   * Optional progress listener called after every step.
   */
  onStepProgress?: (state: AgentTaskState) => void;

  /**
   * Called immediately after a successful NAVIGATE action is executed.
   * The implementation must:
   *   1. Wait for the target tab to finish loading (bounded timeout).
   *   2. Re-inject the content script on the new page.
   * Returns true when the new page is ready for perception; false on timeout.
   *
   * This ensures the next perceivePage call sees the NEW page's DOM, not
   * stale content from the pre-navigation page.
   *
   * Privacy note: `destination` is the URL string from the already-validated
   * BrowserAction — it has passed M5 and the confirmation gate.
   */
  onNavigationComplete?: (destination: string) => Promise<boolean>;
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
        // Allow benign 'text' property in typed browser action objects if non-sensitive
        if (norm === 'text' && (path.endsWith('.action') || (state as any).action === 'type')) {
          const val = (state as Record<string, unknown>)[key];
          if (typeof val === 'string' && (val.toLowerCase().includes('password') || val.toLowerCase().includes('secret'))) {
            throw new Error(`[PrivAgent M6 Security] Sensitive value in text field at '${path}.${key}'.`);
          }
          continue;
        }
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
  private state: AgentTaskState;
  private isStopped = false;
  private hierarchicalGoal?: HighLevelGoal;
  private subgoalGraph?: SubgoalGraph;
  private planStateMachine?: PlanStateMachine;
  private memoryHints?: MemoryHints;

  private extractOrigin(url?: string): string {
    if (!url) return 'http://localhost';
    try {
      return new URL(url).origin;
    } catch {
      return 'http://localhost';
    }
  }

  private extractSiteKey(url?: string): string {
    if (!url) return 'localhost';
    try {
      return new URL(url).hostname;
    } catch {
      return 'localhost';
    }
  }

  private getRecentFailures(): Array<{ subgoalId: string; reason: string }> {
    const fails: Array<{ subgoalId: string; reason: string }> = [];
    for (const step of this.state.steps) {
      if (!step.executionSuccess && step.executionError) {
        fails.push({
          subgoalId: this.state.activeSubgoal?.id || 'unknown',
          reason: step.executionError,
        });
      }
    }
    return fails;
  }

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

    this.state = createAgentTaskState('', {
      maxSteps: this.maxSteps,
      maxRetries: this.maxRetries,
    });
  }

  /**
   * Safely halt the running task loop.
   */
  stop(): void {
    this.isStopped = true;
    if (this.state.status === 'IN_PROGRESS') {
      this.state.status = 'STOPPED';
      this.state.goalStatus = 'STOPPED';
      this.state.reason = 'Task stopped by user.';
      this.notifyProgress();
    }
  }

  getState(): AgentTaskState {
    return {
      ...this.state,
      steps: [...this.state.steps],
      previousActions: [...this.state.previousActions],
    };
  }

  /**
   * Run the complete autonomous task loop until SUCCESS, FAILED, or NEEDS_USER_CONFIRMATION.
   */
  async runTask(task: string): Promise<AgentTaskState> {
    const parsed = parseUserGoal(task);
    this.isStopped = false;
    this.state.task = task;
    this.state.taskGoal = task;
    this.state.normalizedGoal = parsed.normalizedGoal;
    this.state.taskConstraints = parsed.constraints;
    this.state.pendingSubgoals = parsed.subgoals;
    this.state.currentStep = 0;
    this.state.status = 'IN_PROGRESS';
    this.state.goalStatus = 'IN_PROGRESS';
    this.state.previousActions = [];
    this.state.recentActions = [];
    this.state.steps = [];
    this.state.visitedElementIds = [];
    this.state.retryCount = 0;
    this.state.failureCount = 0;
    this.state.providerAttempts = 0;
    this.state.currentFindings = [];
    this.state.candidateItems = [];
    this.state.lastAction = null;
    this.state.lastActionResult = null;
    this.state.expectedStateChange = null;
    this.state.confirmationState = 'NONE';
    // perceptionGeneration is NOT reset on resume (runTask called from
    // resumeWithConfirmation): the counter stays monotonic across navigation
    // so the dashboard can distinguish pre- and post-navigation perceptions.
    // It IS reset to 0 for a brand-new task (status was not IN_PROGRESS).
    if (this.state.status !== 'IN_PROGRESS') {
      this.state.perceptionGeneration = 0;
      this.state.currentPageGeneration = 0;
    }
    this.state.reason = undefined;
    this.state.requiresUserConfirmationAction = undefined;

    // Clear working memory for task isolation
    WorkingMemoryManager.clearAll();

    // Feature 3 & 7: Multi-Step Task Planner and Explainable Decision Tracer
    const tracer = new AgentDecisionTracer(`task-${Date.now().toString(36)}`);
    const plan = createTaskPlan(task);
    this.state.plan = plan;

    // Phase 4: Hierarchical Task Planning & Subgoal DAG Initialization
    const decompResult = decomposeTask(task);
    this.hierarchicalGoal = decompResult.goal;
    this.subgoalGraph = new SubgoalGraph(decompResult.goal.goalId, decompResult.subgoals);
    this.planStateMachine = new PlanStateMachine();
    this.planStateMachine.initialize(this.hierarchicalGoal);
    this.planStateMachine.registerDecompositionComplete();

    this.state.highLevelGoal = this.hierarchicalGoal;
    this.state.subgoalGraphData = this.subgoalGraph.toData();
    this.state.planningEngineState = this.planStateMachine.getState();

    // Initialize Working Memory for the task
    try {
      WorkingMemoryManager.write({
        id: `wm-${this.hierarchicalGoal.goalId}-init`,
        class: 'WORKING',
        goalId: this.hierarchicalGoal.goalId,
        key: 'INITIAL_GOAL',
        memoryContent: this.hierarchicalGoal.sanitizedGoalDescription,
        scope: { origin: this.extractOrigin(this.state.currentUrl), siteKey: this.extractSiteKey(this.state.currentUrl) },
        trustLevel: MemoryTrustLevel.HIGH_CONFIDENCE_MEMORY,
        provenance: { source: 'USER', timestamp: Date.now() },
        confidence: 1.0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    } catch (e) {
      console.warn('[AgentLoop] WorkingMemoryManager init skipped:', e);
    }

    this.notifyProgress();

    while (this.state.status === 'IN_PROGRESS') {
      if (this.isStopped) {
        this.state.status = 'STOPPED';
        this.state.goalStatus = 'STOPPED';
        this.state.reason = this.state.reason || 'Task stopped by user.';
        this.notifyProgress();
        break;
      }

      // 1. Check max steps bound (endless-loop prevention)
      if (this.state.currentStep >= this.maxSteps) {
        this.state.status = 'FAILED';
        this.state.goalStatus = 'FAILED';
        this.state.reason = `Task exceeded maximum step limit of ${this.maxSteps}.`;
        this.notifyProgress();
        break;
      }

      // 2. Fresh perception cycle: obtain current sanitized context
      this.state.perceptionGeneration++;
      this.state.currentPageGeneration = this.state.perceptionGeneration;
      const perceptionGen = this.state.perceptionGeneration;
      console.info('[AgentTrace] perception started', { perceptionGeneration: perceptionGen, url: this.state.currentUrl });
      const perceptionResult = await this.callbacks.perceivePage();
      const normalized = this.normalizePerceptionResult(perceptionResult);
      if (!normalized) {
        this.state.status = 'FAILED';
        this.state.goalStatus = 'FAILED';
        this.state.reason = 'Perception failed: Unable to obtain sanitized page context.';
        this.notifyProgress();
        console.info('[AgentTrace] M6 failed', { reason: this.state.reason });
        break;
      }
      let { context, worldModel, activeWorldModelRef, semanticUnderstanding, semanticContext } = normalized;
      console.info('[AgentLoop] perception completed');
      console.info('[AgentTrace] perception complete', { perceptionGeneration: perceptionGen, contextUrl: context.url, worldModelId: worldModel?.id ?? null });
      if (context.screenshot_dimensions || (worldModel && (worldModel.ocrRegions.length > 0 || worldModel.visualRegions.length > 0 || worldModel.privacyFindings.length > 0))) {
        console.info('[AgentTrace] multimodal perception complete', {
          screenshotDimensions: context.screenshot_dimensions ?? null,
          ocrRegionsCount: worldModel?.ocrRegions?.length ?? (context.ocr_metrics?.regions_scanned ?? 0),
          visualRegionsCount: worldModel?.visualRegions?.length ?? 0,
          privacyFindingsCount: worldModel?.privacyFindings?.length ?? 0,
        });
      }

      // Defense-in-depth: enforce zero raw PII in newly perceived context
      assertSanitizedContextSafe(context);
      this.state.currentUrl = context.url || worldModel?.page.url || this.state.currentUrl;

      if (worldModel) {
        this.state.currentPageGeneration = worldModel.page.pageGeneration;
        this.state.perceptionGeneration = worldModel.page.pageGeneration;
        this.state.activeWorldModelRef = activeWorldModelRef ?? {
          pageGeneration: worldModel.page.pageGeneration,
          worldModelId: worldModel.id,
        };

        // Fallback / calibration: derive semantic understanding directly from live world model if missing
        if (!semanticUnderstanding) {
          try {
            semanticUnderstanding = buildSemanticUnderstanding({
              worldModel,
              pageGeneration: worldModel.page.pageGeneration,
              userGoal: task,
            });
            semanticContext = semanticUnderstanding.sanitizedContext;
          } catch (semErr) {
            console.warn('[AgentLoop] fallback semantic understanding build failed:', semErr);
          }
        }

        if (semanticContext) {
          const worldModelPageType = semanticContext.pageType.toLowerCase() as PageCategory;
          if (worldModelPageType && ['search','login','article','listing','form','checkout','settings','dashboard','error','unknown','landing','results','product_detail','banking'].includes(worldModelPageType)) {
            this.state.pageType = worldModelPageType;
          }
          this.state.candidateEntities = semanticUnderstanding?.entities ?? [];
          this.state.semanticContext = semanticContext;
          context.semantic_context = semanticContext;
          context.page_type = context.page_type || semanticContext.pageType;

          console.info('[AgentTrace] semantic understanding complete', {
            pageType: semanticContext.pageType,
            pageState: semanticContext.pageState,
            pageGeneration: semanticContext.pageGeneration,
            entityCount: semanticContext.entities.length,
            affordanceCount: semanticContext.affordances.length,
          });
        } else {
          const worldModelPageType = worldModel.page.pageType as PageCategory;
          if (worldModelPageType && ['search','login','article','listing','form','checkout','settings','dashboard','error','unknown','landing','results','product_detail','banking'].includes(worldModelPageType)) {
            this.state.pageType = worldModelPageType;
          }
        }
      } else {
        this.state.currentPageGeneration = this.state.perceptionGeneration;
      }

      // Fallback observable page type heuristic only when semantic classification was not established
      if (!this.state.pageType || this.state.pageType === 'unknown') {
        const uLower = this.state.currentUrl.toLowerCase();
        if (uLower.includes('login') || uLower.includes('signin') || uLower.includes('auth')) {
          this.state.pageType = 'login';
        } else if (uLower.includes('result') || uLower.includes('search?')) {
          this.state.pageType = 'results';
        } else if (uLower.includes('search')) {
          this.state.pageType = 'search';
        } else if (uLower.includes('product') || uLower.includes('item') || uLower.includes('detail')) {
          this.state.pageType = 'product_detail';
        } else if (uLower.includes('bank') || uLower.includes('portal') || uLower.includes('account')) {
          this.state.pageType = 'banking';
        } else if (uLower.endsWith('/') || uLower.includes('index')) {
          this.state.pageType = 'landing';
        } else {
          this.state.pageType = 'unknown';
        }
      }

      // 2b. Phase 4 Memory Retrieval & Subgoal Selection
      // SECURITY INVARIANT: Fresh live perception ALWAYS has authority over stale memory.
      const currentOrigin = this.extractOrigin(this.state.currentUrl || context.url);
      const siteScope: SiteScope = {
        origin: currentOrigin,
        siteKey: this.extractSiteKey(this.state.currentUrl || context.url),
        pageTaxonomy: this.state.pageType,
      };

      // Retrieve sanitized memory hints (bounded & M8 sanitized)
      let memoryHints: MemoryHints | undefined;
      try {
        memoryHints = await MemoryRetriever.getHintsForContext(
          siteScope,
          this.hierarchicalGoal?.goalId || `goal-${Date.now().toString(36)}`
        );
        this.state.memoryHints = memoryHints;
        context.memory_hints = memoryHints;
      } catch (e) {
        console.warn('[AgentLoop] MemoryRetriever hints fetch failed:', e);
      }

      // Subgoal selection from dependency DAG
      let activeSubgoal: Subgoal | undefined;
      if (this.subgoalGraph) {
        const selection = SubgoalSelector.selectNextSubgoal({
          graph: this.subgoalGraph,
          worldModel,
          affordances: (semanticContext?.affordances as any) ?? [],
          recentFailures: this.getRecentFailures(),
        });

        if (selection.status === 'SELECTED' && selection.selectedSubgoal) {
          activeSubgoal = selection.selectedSubgoal;
          this.subgoalGraph.startSubgoal(activeSubgoal.id);
          this.state.activeSubgoal = activeSubgoal;
          this.state.subgoalGraphData = this.subgoalGraph.toData();
          if (
            this.planStateMachine &&
            (this.planStateMachine.getState() === 'SUBGOAL_SELECTION' ||
              this.planStateMachine.getState() === 'DYNAMIC_REPLANNING')
          ) {
            if (this.planStateMachine.getState() === 'DYNAMIC_REPLANNING') {
              this.planStateMachine.transitionTo(
                'SUBGOAL_SELECTION',
                'Re-entering subgoal selection after replanning'
              );
            }
            this.planStateMachine.registerSubgoalSelected(activeSubgoal);
            this.state.planningEngineState = this.planStateMachine.getState();
          }
          console.info('[AgentTrace] subgoal selected', {
            subgoalId: activeSubgoal.id,
            category: activeSubgoal.category,
            description: activeSubgoal.description,
          });
        } else if (selection.status === 'ALL_COMPLETED') {
          console.info('[AgentTrace] all subgoals completed');
        }
      }

      // Build minimized planner context incorporating activeSubgoal and memoryHints
      if (this.hierarchicalGoal) {
        const builtPlannerCtx = PlannerContextBuilder.buildContext(
          context,
          this.hierarchicalGoal,
          activeSubgoal,
          memoryHints
        );
        context = builtPlannerCtx.contextPayload;
      }

      // 3. Goal Completion Detection
      if (this.isTaskGoalSatisfied(task, this.state, context)) {
        if (this.state.plan) {
          this.state.plan = updateTaskPlanProgress(
            this.state.plan,
            this.state.plan.currentStepIndex,
            'COMPLETED'
          );
        }
        if (this.planStateMachine && this.planStateMachine.getState() !== 'COMPLETED') {
          this.planStateMachine.registerGoalVerification(true, true);
          this.state.planningEngineState = this.planStateMachine.getState();
        }
        this.state.status = 'SUCCESS';
        this.state.goalStatus = 'SUCCESS';
        this.state.reason = this.state.reason || 'Task goal successfully achieved.';
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

        // Enforce the One-Action Proposal constraint: exactly ONE atomic action from allowlist
        const singleActionCheck = OneActionPlanner.validateSingleActionProposal(action);
        if (!singleActionCheck.valid) {
          this.state.status = 'FAILED';
          this.state.reason = `OneActionPlanner rejected action: ${singleActionCheck.error}`;
          this.notifyProgress();
          console.info('[AgentTrace] M6 failed', { reason: this.state.reason });
          break;
        }
        action = singleActionCheck.action!;

        // State Machine: Register Grounding
        if (this.planStateMachine && this.planStateMachine.getState() === 'TARGET_GROUNDING') {
          if ('target' in action && typeof (action as any).target === 'string') {
            this.planStateMachine.registerTargetGrounded((action as any).target, action);
          } else {
            this.planStateMachine.registerNonTargetedAction(action);
          }
          this.state.planningEngineState = this.planStateMachine.getState();
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.state.status = 'FAILED';
        this.state.reason = `Agent reasoning failed: ${msg}`;
        this.notifyProgress();
        console.info('[AgentTrace] M6 failed', { reason: this.state.reason });
        break;
      }

      // 5. Next-Gen Pre-Execution Verification & Risk Assessment (Features 1, 2 & 5)
      const risk = assessActionRisk(action, context, this.state.currentUrl);
      const semantic = verifySemanticAction(action, task, context, risk);
      const previousSuccessCount = this.state.steps.filter((s) => s.executionSuccess).length;
      const confidence = evaluateExecutionConfidence(semantic, risk, previousSuccessCount);

      // 5a. Deterministic Injection / Contradiction Block
      if (confidence.directive === 'BLOCK' || semantic.targetAlignment === 'CONTRADICTORY') {
        const blockReason = confidence.explanation || semantic.reason || 'Action blocked by security verification.';
        this.recordStep(
          action,
          false,
          'Security Verification Blocked',
          false,
          blockReason,
          undefined,
          risk,
          semantic,
          confidence
        );
        tracer.recordStep({
          step: this.state.currentStep,
          goal: task,
          proposedAction: action,
          riskAssessment: {
            riskLevel: risk.level,
            score: risk.score,
            requiresConfirmation: risk.requiresUserConfirmation,
          },
          structuralValidation: {
            passed: false,
            reason: 'Confidence / Semantic Verification Blocked',
          },
          semanticVerification: {
            verified: semantic.verified,
            confidence: semantic.confidence,
            alignment: semantic.targetAlignment,
            reason: semantic.reason,
          },
          confidenceEvaluation: {
            confidenceScore: confidence.confidenceScore,
            directive: confidence.directive,
            explanation: confidence.explanation,
          },
          finalOutcome: 'BLOCKED',
        });
        this.state.decisionTraceSummary = tracer.getSummary();
        this.state.status = 'FAILED';
        this.state.reason = blockReason;
        this.notifyProgress();
        console.info('[AgentTrace] M6 blocked by security verifier', { reason: this.state.reason });
        break;
      }

      // 6. Local Action Validator (M5 validator is authoritative) + Feature 4 Self-Healing
      let validation = validateAction(action, context);
      let healingResult: SelfHealingResult | undefined;

      if (!validation.allowed && 'target' in action && typeof (action as any).target === 'string') {
        // Attempt target self-healing for stale or mutated targets
        const staleTargetId = (action as any).target;
        healingResult = recoverStaleTarget(staleTargetId, action, context);
        if (healingResult.recovered && healingResult.recoveredAction) {
          const healedVal = validateAction(healingResult.recoveredAction, context);
          if (healedVal.allowed) {
            action = healingResult.recoveredAction;
            validation = healedVal;
          }
        }
      }

      if (this.planStateMachine && this.planStateMachine.getState() === 'M5_VALIDATION') {
        this.planStateMachine.registerM5Approval(validation.allowed, validation.reason);
        this.state.planningEngineState = this.planStateMachine.getState();
      }

      if (!validation.allowed) {
        this.state.retryCount++;
        this.provider.registerFailure?.();
        try {
          await FailureMemoryManager.write({
            id: `fail-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            class: 'FAILURE',
            scope: siteScope,
            trustLevel: MemoryTrustLevel.HIGH_CONFIDENCE_MEMORY,
            provenance: { source: 'ACTION_RESULT', timestamp: Date.now(), subgoalId: activeSubgoal?.id, actionType: action.action },
            confidence: 1.0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            failureType: 'POLICY_REJECTION',
            contextCategory: (this.state.pageType as any) || 'unknown',
            recoveryAttempted: healingResult?.recovered ? 'HEALING' : 'NONE',
            recoveryResult: 'FAILURE',
          });
        } catch (e) {}
        if (this.state.plan) {
          const diag = diagnoseFailureAndReplan(this.state.plan, action, validation.reason, context);
          if (diag.canRecover) {
            this.state.plan.recoveryAttempts++;
          }
        }
        this.recordStep(
          action,
          false,
          validation.reason,
          false,
          validation.reason,
          undefined,
          risk,
          semantic,
          confidence,
          healingResult
        );
        tracer.recordStep({
          step: this.state.currentStep,
          goal: task,
          proposedAction: action,
          riskAssessment: {
            riskLevel: risk.level,
            score: risk.score,
            requiresConfirmation: risk.requiresUserConfirmation,
          },
          structuralValidation: {
            passed: false,
            reason: validation.reason,
          },
          semanticVerification: {
            verified: semantic.verified,
            confidence: semantic.confidence,
            alignment: semantic.targetAlignment,
            reason: semantic.reason || 'Validator rejected action',
          },
          confidenceEvaluation: {
            confidenceScore: confidence.confidenceScore,
            directive: confidence.directive,
            explanation: confidence.explanation,
          },
          finalOutcome: 'FAILED',
        });
        this.state.decisionTraceSummary = tracer.getSummary();
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
      if (this.planStateMachine && this.planStateMachine.getState() === 'RISK_POLICY_CHECK') {
        this.planStateMachine.registerRiskAssessment(risk);
        this.state.planningEngineState = this.planStateMachine.getState();
      }

      // 6a. SAFETY Review (Model-based)
      if (this.provider.reviewAction) {
        console.info('[AgentTrace] requesting safety review');
        const review = await this.provider.reviewAction(action, task, context);
        if (!review.safe) {
          this.state.retryCount++;
          this.recordStep(action, false, `SAFETY Rejected: ${review.reason}`, false, review.reason, undefined, risk, semantic, confidence);
          this.notifyProgress();
          if (this.state.retryCount > this.maxRetries) {
            this.state.status = 'FAILED';
            this.state.reason = `Safety model rejected action repeatedly: ${review.reason}`;
            break;
          }
          await this.delay(this.delayBetweenStepsMs);
          continue;
        }
        console.info('[AgentTrace] action passed safety review');
      }

      // 7. Privacy Capability Policy Check
      const targetDet = 'target' in action ? context.detections.find((d) => d.id === (action as any).target) : undefined;
      const policy = canPerformAction(action, targetDet, 'agent_llm');
      if (!policy.granted) {
        this.state.retryCount++;
        this.recordStep(
          action,
          false,
          `Policy Denied: ${policy.reason}`,
          false,
          policy.reason,
          targetDet?.type,
          risk,
          semantic,
          confidence
        );
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

      // 8. Consequential action check: requires user confirmation
      if (
        this.isConsequentialAction(action, this.state.currentUrl) ||
        risk.requiresUserConfirmation ||
        confidence.directive === 'REQUIRE_CONFIRMATION'
      ) {
        this.state.status = 'NEEDS_USER_CONFIRMATION';
        this.state.goalStatus = 'NEEDS_USER_CONFIRMATION';
        this.state.confirmationState = 'PENDING';
        this.state.requiresUserConfirmationAction = action;
        this.state.reason = risk.rationale || 'Action requires user confirmation: Consequential or high-risk operation.';
        this.recordStep(
          action,
          true,
          'Requires user confirmation',
          false,
          undefined,
          targetDet?.type,
          risk,
          semantic,
          confidence
        );
        tracer.recordStep({
          step: this.state.currentStep,
          goal: task,
          proposedAction: action,
          riskAssessment: {
            riskLevel: risk.level,
            score: risk.score,
            requiresConfirmation: risk.requiresUserConfirmation,
          },
          structuralValidation: {
            passed: true,
            reason: 'Pending user confirmation',
          },
          semanticVerification: {
            verified: semantic.verified,
            confidence: semantic.confidence,
            alignment: semantic.targetAlignment,
            reason: semantic.reason || 'Aligned with goal',
          },
          confidenceEvaluation: {
            confidenceScore: confidence.confidenceScore,
            directive: confidence.directive,
            explanation: confidence.explanation,
          },
          finalOutcome: 'CONFIRMED',
        });
        this.state.decisionTraceSummary = tracer.getSummary();
        this.notifyProgress();
        break;
      }

      // 8. Deterministic Browser Execution + Post-Execution Self-Healing
      let expectedTransition: 'URL_CHANGE' | 'DOM_UPDATE' | 'MODAL_OPEN' | 'PAGE_SETTLED' = 'DOM_UPDATE';
      let transitionDesc = '';
      switch (action.action) {
        case 'navigate':
          expectedTransition = 'URL_CHANGE';
          transitionDesc = `Navigate to ${action.url}`;
          break;
        case 'click':
          expectedTransition = 'DOM_UPDATE';
          transitionDesc = `Click element ${action.target}`;
          break;
        case 'type':
          expectedTransition = 'DOM_UPDATE';
          transitionDesc = `Type text into element ${action.target}`;
          break;
        case 'scroll':
          expectedTransition = 'PAGE_SETTLED';
          transitionDesc = `Scroll ${action.direction} by ${action.amount}px`;
          break;
        case 'select':
          expectedTransition = 'DOM_UPDATE';
          transitionDesc = `Select option on ${action.target}`;
          break;
      }
      this.state.expectedStateChange = {
        actionType: action.action,
        expectedTransition,
        description: transitionDesc,
        targetHint: 'target' in action ? (action as any).target : undefined,
      };

      console.info('[AgentTrace] executeAction started');
      // 5. Execute
      this.provider.resetEscalation?.();
      let execResult = await this.callbacks.executeAction(action);
      console.info('[AgentTrace] executeAction response received');
      this.state.lastAction = action;
      this.state.lastActionResult = { success: execResult.success, error: execResult.error };

      if (this.planStateMachine && this.planStateMachine.getState() === 'CHROME_EXECUTION') {
        this.planStateMachine.registerExecutionResult(execResult.success, 'PRIVAGENT_ACTION', execResult.error);
        this.state.planningEngineState = this.planStateMachine.getState();
      }

      if (this.planStateMachine && this.planStateMachine.getState() === 'EFFECT_VERIFICATION') {
        this.planStateMachine.registerEffectVerification(execResult.success, execResult.error);
        this.state.planningEngineState = this.planStateMachine.getState();
      }

      if (!execResult.success && 'target' in action && typeof (action as any).target === 'string' && !healingResult?.recovered) {
        const staleTargetId = (action as any).target;
        healingResult = recoverStaleTarget(staleTargetId, action, context);
        if (healingResult.recovered && healingResult.recoveredAction) {
          const healedVal = validateAction(healingResult.recoveredAction, context);
          if (healedVal.allowed) {
            const healedExec = await this.callbacks.executeAction(healingResult.recoveredAction);
            if (healedExec.success) {
              execResult = healedExec;
              action = healingResult.recoveredAction;
              this.state.lastAction = action;
              this.state.lastActionResult = { success: true };
            }
          }
        }
      }

      if (!execResult.success) {
        this.state.retryCount++;
        this.state.failureCount++;
        try {
          await FailureMemoryManager.write({
            id: `fail-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            class: 'FAILURE',
            scope: siteScope,
            trustLevel: MemoryTrustLevel.HIGH_CONFIDENCE_MEMORY,
            provenance: { source: 'ACTION_RESULT', timestamp: Date.now(), subgoalId: activeSubgoal?.id, actionType: action.action },
            confidence: 1.0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            failureType: 'EXECUTION_ERROR',
            contextCategory: (this.state.pageType as any) || 'unknown',
            recoveryAttempted: healingResult?.recovered ? 'HEALING' : 'NONE',
            recoveryResult: 'FAILURE',
          });
        } catch (e) {}
        if (this.state.plan) {
          const diag = diagnoseFailureAndReplan(this.state.plan, action, execResult.error || 'Execution error', context);
          if (diag.canRecover) {
            this.state.plan.recoveryAttempts++;
          }
        }
        this.recordStep(
          action,
          true,
          validation.reason,
          false,
          execResult.error,
          targetDet?.type,
          risk,
          semantic,
          confidence,
          healingResult
        );
        tracer.recordStep({
          step: this.state.currentStep,
          goal: task,
          proposedAction: action,
          riskAssessment: {
            riskLevel: risk.level,
            score: risk.score,
            requiresConfirmation: risk.requiresUserConfirmation,
          },
          structuralValidation: {
            passed: true,
            reason: validation.reason,
          },
          semanticVerification: {
            verified: semantic.verified,
            confidence: semantic.confidence,
            alignment: semantic.targetAlignment,
            reason: semantic.reason || 'Execution error',
          },
          confidenceEvaluation: {
            confidenceScore: confidence.confidenceScore,
            directive: confidence.directive,
            explanation: confidence.explanation,
          },
          executionResult: {
            success: false,
            error: execResult.error,
          },
          recoveryAttempt: healingResult
            ? {
                attemptNumber: 1,
                diagnosis: healingResult.recovered ? 'Recovered' : 'Failed',
                originalTarget: healingResult.originalTargetId,
                recoveredTarget: healingResult.recoveredTargetId,
                success: healingResult.recovered,
              }
            : undefined,
          finalOutcome: 'FAILED',
        });
        this.state.decisionTraceSummary = tracer.getSummary();
        this.notifyProgress();

        if (this.state.retryCount > this.maxRetries) {
          this.state.status = 'FAILED';
          this.state.goalStatus = 'FAILED';
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
      this.state.recentActions.push(action);
      this.state.completedSteps.push(`${action.action}: ${transitionDesc}`);
      if ('target' in action && typeof (action as any).target === 'string') {
        this.state.visitedElementIds.push((action as any).target);
      }

      // Update Working Memory after observation
      try {
        WorkingMemoryManager.write({
          id: `wm-${this.hierarchicalGoal?.goalId || 'task'}-s${this.state.currentStep}`,
          class: 'WORKING',
          goalId: this.hierarchicalGoal?.goalId || 'task',
          key: `STEP_${this.state.currentStep}_RESULT`,
          memoryContent: {
            action: action.action,
            success: execResult.success,
            subgoalId: activeSubgoal?.id,
            target: 'target' in action ? (action as any).target : undefined,
          },
          scope: siteScope,
          trustLevel: MemoryTrustLevel.CURRENT_VERIFIED_OBSERVATION,
          provenance: { source: 'ACTION_RESULT', timestamp: Date.now(), subgoalId: activeSubgoal?.id, actionType: action.action },
          confidence: 1.0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      } catch (memErr) {
        console.warn('[AgentLoop] WorkingMemoryManager write skipped:', memErr);
      }

      // Update Episodic Memory with sanitized historical event
      try {
        await EpisodicMemoryManager.write({
          id: `ep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          class: 'EPISODIC',
          scope: siteScope,
          trustLevel: MemoryTrustLevel.VERIFIED_MEMORY,
          provenance: { source: 'VERIFIED_OUTCOME', timestamp: Date.now(), subgoalId: activeSubgoal?.id, actionType: action.action },
          confidence: 0.95,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          taskType: this.hierarchicalGoal?.taskCategory || 'GENERIC_INTERACTION',
          outcome: execResult.success ? 'SUCCESS' : 'FAILURE',
          sanitizedSummary: `Step ${this.state.currentStep}: ${action.action} outcome ${execResult.success ? 'SUCCESS' : 'FAILED'}`,
          metrics: {
            durationMs: 0,
            actionsTaken: 1,
          },
        });
      } catch (memErr) {
        console.warn('[AgentLoop] EpisodicMemoryManager write skipped:', memErr);
      }

      // Progress active subgoal in DAG
      if (execResult.success && activeSubgoal && this.subgoalGraph) {
        this.subgoalGraph.completeSubgoal(activeSubgoal.id);
        this.state.subgoalGraphData = this.subgoalGraph.toData();
        console.info('[AgentTrace] subgoal completed', {
          subgoalId: activeSubgoal.id,
          category: activeSubgoal.category,
        });
      } else if (!execResult.success && activeSubgoal && this.subgoalGraph) {
        this.subgoalGraph.failSubgoal(activeSubgoal.id, execResult.error || 'Execution failed');
        this.state.subgoalGraphData = this.subgoalGraph.toData();
      }

      // Transition state machine to SUBGOAL_SELECTION for next iteration if not in terminal state
      if (this.planStateMachine && (this.planStateMachine.getState() === 'GOAL_VERIFICATION' || this.planStateMachine.getState() === 'DYNAMIC_REPLANNING')) {
        const allDone = this.subgoalGraph?.isAllCompleted() ?? false;
        if (allDone || this.isTaskGoalSatisfied(task, this.state, context)) {
          this.planStateMachine.registerGoalVerification(true, true);
          this.state.planningEngineState = this.planStateMachine.getState();
        } else {
          this.planStateMachine.transitionTo('SUBGOAL_SELECTION', 'Preparing next subgoal selection');
          this.state.planningEngineState = this.planStateMachine.getState();
        }
      }

      if (this.state.plan) {
        this.state.plan = updateTaskPlanProgress(
          this.state.plan,
          this.state.plan.currentStepIndex,
          'COMPLETED',
          action
        );
      }
      this.recordStep(
        action,
        true,
        validation.reason,
        true,
        undefined,
        targetDet?.type,
        risk,
        semantic,
        confidence,
        healingResult
      );
      tracer.recordStep({
        step: this.state.currentStep,
        goal: task,
        proposedAction: action,
        riskAssessment: {
          riskLevel: risk.level,
          score: risk.score,
          requiresConfirmation: risk.requiresUserConfirmation,
        },
        structuralValidation: {
          passed: true,
          reason: validation.reason,
        },
        semanticVerification: {
          verified: semantic.verified,
          confidence: semantic.confidence,
          alignment: semantic.targetAlignment,
          reason: semantic.reason || 'Aligned with goal',
        },
        confidenceEvaluation: {
          confidenceScore: confidence.confidenceScore,
          directive: confidence.directive,
          explanation: confidence.explanation,
        },
        executionResult: {
          success: true,
        },
        recoveryAttempt: healingResult
          ? {
              attemptNumber: 1,
              diagnosis: healingResult.recovered ? 'Recovered' : 'Failed',
              originalTarget: healingResult.originalTargetId,
              recoveredTarget: healingResult.recoveredTargetId,
              success: healingResult.recovered,
            }
          : undefined,
        finalOutcome: healingResult?.recovered ? 'RECOVERED' : 'EXECUTED',
      });
      this.state.decisionTraceSummary = tracer.getSummary();

      // Verify no sensitive keys entered state
      assertNoSensitiveDataInState(this.state);
      this.notifyProgress();

      // Post-navigation page setup if navigate action succeeded
      if (action.action === 'navigate' && typeof action.url === 'string' && this.callbacks.onNavigationComplete) {
        console.info('[AgentTrace] POST_NAVIGATION_SETTLE_START', { destination: action.url });
        const settled = await this.callbacks.onNavigationComplete(action.url);
        console.info('[AgentTrace] POST_NAVIGATION_SETTLE_RESULT', {
          destination: action.url,
          postNavigationSettled: settled,
        });
        if (settled) {
          advancePageGeneration(this.state, action.url);
        }
      }

      // Check immediate completion
      if (this.isTaskGoalSatisfied(task, this.state, context)) {
        this.state.status = 'SUCCESS';
        this.state.goalStatus = 'SUCCESS';
        this.state.reason = this.state.reason || 'Task goal successfully achieved.';
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
   *
   * If the confirmed action is a NAVIGATE, this method:
   *   1. Executes the navigation.
   *   2. Calls onNavigationComplete() to wait for page load and re-inject
   *      the content script on the new page.
   *   3. Only then re-enters runTask for fresh perception on the new page.
   *
   * Element IDs and perception context from before the navigation are NOT
   * forwarded — runTask starts a fresh perception cycle automatically.
   */
  async resumeWithConfirmation(): Promise<AgentTaskState> {
    if (this.state.status !== 'NEEDS_USER_CONFIRMATION' || !this.state.requiresUserConfirmationAction) {
      throw new Error('Cannot resume: Task is not waiting for user confirmation.');
    }

    const action = this.state.requiresUserConfirmationAction;
    this.state.requiresUserConfirmationAction = undefined;
    this.state.status = 'IN_PROGRESS';

    const isNavigate = action.action === 'navigate' && typeof action.url === 'string';
    const destination = isNavigate ? action.url! : undefined;

    console.info('[AgentTrace] resumeWithConfirmation', {
      action: action.action,
      destination: destination ?? 'N/A',
      confirmationState: 'AUTHORIZED',
    });

    // Execute the confirmed action
    console.info('[AgentTrace] executeAction started');
    const execResult = await this.callbacks.executeAction(action);
    console.info('[AgentTrace] executeAction response received', {
      success: execResult.success,
      action: action.action,
      destination: destination ?? 'N/A',
      navigationDestination: destination ?? undefined,
    });

    if (!execResult.success) {
      this.state.status = 'FAILED';
      this.state.reason = `Confirmed action execution failed: ${execResult.error}`;
      this.notifyProgress();
      console.info('[AgentTrace] M6 failed', { reason: this.state.reason });
      return this.getState();
    }

    // Record the confirmed step with navigation trace fields
    const stepRecord: StepRecord = {
      step: this.state.currentStep,
      action,
      validationAllowed: true,
      validationReason: 'User explicitly confirmed consequential action',
      executionSuccess: true,
      url: this.state.currentUrl,
      timestamp: Date.now(),
      navigationDestination: destination,
      perceptionGeneration: this.state.perceptionGeneration,
    };
    this.state.steps.push(stepRecord);
    this.state.previousActions.push(action);
    this.notifyProgress();

    // Post-navigation page setup: wait for new page to load and re-inject
    // content script before re-entering the perception loop.
    if (isNavigate && destination && this.callbacks.onNavigationComplete) {
      console.info('[AgentTrace] POST_NAVIGATION_SETTLE_START', { destination });
      const settled = await this.callbacks.onNavigationComplete(destination);
      console.info('[AgentTrace] POST_NAVIGATION_SETTLE_RESULT', {
        destination,
        postNavigationSettled: settled,
      });

      // Update the step record with the settle result
      stepRecord.postNavigationSettled = settled;

      if (!settled) {
        this.state.status = 'FAILED';
        this.state.reason =
          `Navigation to ${destination} succeeded but the new page did not become ready ` +
          '(content script injection timed out). Please try the task again on the new page.';
        this.notifyProgress();
        console.info('[AgentTrace] M6 failed', { reason: this.state.reason });
        return this.getState();
      }

      // Invalidate old element IDs — they belong to the pre-navigation DOM
      this.state.visitedElementIds = [];
      console.info('[AgentTrace] STALE_ELEMENT_IDS_CLEARED', {
        reason: 'Navigation changed the page; old element IDs are invalid.',
      });
    }

    // Re-enter autonomous loop with fresh perception on the new page
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
                new ProviderError('Reasoning provider request timed out after 55s.', 'timeout', {
                  retryable: true,
                })
              ),
            55000
          )
        );
        return await Promise.race([
          this.provider.requestAction(task, context, this.state.previousActions),
          timeoutPromise,
        ]);
      } catch (err: unknown) {
        lastError = err;
        this.provider.registerFailure?.();
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

  private isTaskGoalSatisfied(task: string, state: AgentTaskState, context: AgentContextPayload): boolean {
    const res = verifyTaskGoal(task, state, context);
    if (res.satisfied) {
      state.goalStatus = 'SUCCESS';
      if (res.reason) {
        state.reason = res.reason;
      }
      return true;
    }
    return false;
  }

  private recordStep(
    action: BrowserAction,
    validationAllowed: boolean,
    validationReason: string,
    executionSuccess: boolean,
    executionError?: string,
    targetType?: string,
    riskAssessment?: ActionRiskAssessment,
    semanticVerification?: SemanticVerificationResult,
    confidenceEvaluation?: ConfidenceEvaluation,
    selfHealing?: SelfHealingResult
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
      riskAssessment,
      semanticVerification,
      confidenceEvaluation,
      selfHealing,
      expectedStateChange: this.state.expectedStateChange,
      currentPageGeneration: this.state.currentPageGeneration,
      pageType: this.state.pageType,
      semanticContext: this.state.semanticContext,
    };
    this.state.steps.push(record);
  }

  private normalizePerceptionResult(
    result: AgentContextPayload | WorldModelPerceptionResult | null
  ): {
    context: AgentContextPayload;
    worldModel?: BrowserWorldModel;
    activeWorldModelRef?: ActiveWorldModelRef | null;
    semanticUnderstanding?: SemanticUnderstandingOutput;
    semanticContext?: SanitizedSemanticContext;
  } | null {
    if (!result) {
      return null;
    }

    if ('context' in result && result.context) {
      const context = result.context as AgentContextPayload;
      const worldModel = result.worldModel;
      const activeWorldModelRef = result.activeWorldModelRef ?? (worldModel ? {
        pageGeneration: worldModel.page.pageGeneration,
        worldModelId: worldModel.id,
      } : undefined);
      const semanticUnderstanding = ('semanticUnderstanding' in result ? result.semanticUnderstanding : undefined);
      const semanticContext = ('semanticContext' in result ? result.semanticContext : undefined) ?? context.semantic_context ?? semanticUnderstanding?.sanitizedContext;

      if (worldModel && activeWorldModelRef) {
        const liveGeneration = worldModel.page.pageGeneration;
        const refGeneration = activeWorldModelRef.pageGeneration;
        const localGeneration = this.state.currentPageGeneration || this.state.perceptionGeneration;

        // The BrowserWorldModel is the canonical page snapshot generated on the
        // live page. The local loop must not invent its own generation baseline
        // and reject a fresh model merely because the counter is behind the page's
        // authoritatively advancing generation.
        if (liveGeneration !== refGeneration) {
          console.warn('[AgentLoop] rejecting mismatched world model generations', {
            localGeneration,
            worldModelGeneration: liveGeneration,
            refGeneration,
            worldModelId: worldModel.id,
          });
          return null;
        }

        // Reject stale models that reflect a previous page generation even when
        // the local AgentLoop has already advanced its own counter during a new
        // perception cycle.
        if (localGeneration > 0 && liveGeneration < localGeneration) {
          console.warn('[AgentLoop] rejecting stale world model before attachment', {
            localGeneration,
            worldModelGeneration: liveGeneration,
            refGeneration,
            worldModelId: worldModel.id,
          });
          return null;
        }

        // Reject mismatched or stale semantic context
        if (semanticContext && semanticContext.pageGeneration !== liveGeneration) {
          console.warn('[AgentLoop] rejecting stale semantic context generation', {
            semanticGeneration: semanticContext.pageGeneration,
            worldModelGeneration: liveGeneration,
            worldModelId: worldModel.id,
          });
          return null;
        }
      }

      return { context, worldModel, activeWorldModelRef, semanticUnderstanding, semanticContext };
    }

    return { context: result as AgentContextPayload };
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
