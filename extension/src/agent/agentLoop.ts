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
import { filterToHistoryContract } from './historyContract';
import {
  assertTruthfulHistory,
  buildActionHistoryEntry,
  toWireAction,
  type ActionHistoryEntry,
} from './actionHistory';
import {
  buildDecisionState,
  goalStatusFromTaskStatus,
  projectDecisionStateForModel,
  type DecisionDestinationStatus,
  type DecisionRecoveryState,
  type EvidenceReference,
  type PageObservationState,
  type ModelFacingDecisionState,
} from './decisionState';
import { validateAction } from './actionValidator';
import { groundProposedTarget } from './groundingEngine';
import { canPerformAction, assertSanitizedContextSafe } from './privacyPolicy';
import { AgentProvider } from './agentProvider';
import { ProviderError } from './openRouterProvider';
import {
  isObservationCurrent,
  observationIdentity,
  providerRetryBudget,
  providerTaskClassFor,
  terminalStateForProviderFailure,
} from './providerResponse';
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
import { sanitizeRetainedAction, sanitizeRetainedSelfHealing } from './agentState';
import { PrivacyBoundaryError } from '../privacy/rawValueScanner';
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
  FailureRecord,
  createAgentTaskState,
  advancePageGeneration,
  invalidatePageGenerationState,
  userFacingMessageForStatus,
  type ConversationSummary,
} from './agentState';
import {
  verifyActionEffect,
  PreActionSnapshot,
  PostActionSnapshot,
  ActionEffectResult,
  EffectStatus,
} from './effectVerifier';
import { parseUserGoal } from './goalParser';
import { reviewProposedAction, SecurityCriticResult } from './securityCritic';
// PHASE 17.4 D5. Reliability-state persistence. A RELIABILITY mechanism
// only: it holds no gate, restores no authority, and every restored value feeds
// loop/stall/bound checks whose only terminal output is a replan or FAILED.
import {
  clearTracker,
  createNoopStore,
  loadTrackerForTask,
  saveTracker,
  type LongHorizonStore,
} from './longHorizonPersistence';
import {
  LongHorizonTracker,
  DEFAULT_LONG_HORIZON_BOUNDS,
  observeFromContext,
  recordWorkingProgress,
  recordLongHorizonFailure,
  recordEpisodicOutcome,
  syncFromSubgoalGraph,
  type LongHorizonSnapshot,
} from './longHorizon';
import { verifyTaskGoal } from './goalVerifier';
import {
  evaluateContainment,
  containmentSummary,
  deriveRootHost,
  hostWithinScope,
  type ContainmentScope,
} from './containment';
import {
  RecoveryEngine,
  TypedRecoveryPlanner,
  recoveryCategoryFor,
  type RecoveryFailureCategory,
  type RecoveryRecord,
  type RecoveryStrategyClass,
  type TypedRecoveryOutcome,
  MAX_RECOVERY_RECORDS,
  DEFAULT_RECOVERY_BOUNDS,
  type RecoveryDecision,
  type RecoveryHistoryEntry,
} from './recoveryEngine';
import { AgentHarness, type HarnessDecision } from './harness';
import { BrowserWorldModel, ActiveWorldModelRef } from '../worldModel/types';
import type { EvidenceLedger } from '../evidence/evidenceLedger';
import { truncateClaim } from '../evidence/evidenceLedger';
import {
  verifyTerminalProposal,
  subjectTermsFromTask,
  MAX_SUPPORTED_ANSWER_CHARS,
  type ProposalLedgerView,
  type ProposalVerdict,
} from './proposal';
import type { ProviderStep } from './providerResponse';
import {
  appendTurn,
  closeTurn,
  eligibleCandidates,
  observeCandidates,
  stableHash,
  withClarification,
  withPage,
  withSelection,
  withTerminal,
  type ConversationContext,
  type ConversationTurn,
  type EntityCandidate,
  type EntityIdentity,
} from './conversationContext';
import {
  candidatesFromWorldModel,
  revalidateSelection,
} from './entityIdentity';
import {
  detectReference,
  resolveReference,
  type EntityReference,
} from './referenceResolver';

/**
 * PHASE 18.8 / B1 — bounded claim count for an answer composed from evidence.
 * The same 1500-char bound as the proposal path applies on top.
 */
export const MAX_EVIDENCE_ANSWER_CLAIMS = 8;

/**
 * PHASE 18.8 / B1 — compose a user-facing answer from LOCAL verified evidence.
 *
 * This is the SUCCESS-side sibling of `buildSupportedAnswer`: when the
 * GoalVerifier certifies an information task because the device holds verified,
 * current evidence about the question's subject (A5), the user must actually
 * SEE that answer. Before B1 the system reported SUCCESS beside "No result
 * yet."
 *
 * Same rules as every other answer surface, because it is the same ledger:
 *   * VERIFIED + CURRENT records only — never UNVERIFIED, stale, conflicted or
 *     quarantined ones;
 *   * on-subject records only, matched against the USER'S OWN task text via
 *     `subjectTermsFromTask` (the model cannot widen the subject);
 *   * claims are the ledger's sanitized text, joined and word-boundary
 *     truncated; the model's prose is never consulted.
 *
 * Pure and deterministic: no I/O, no clock, no model.
 */
export function composeEvidenceAnswerFromLedger(
  ledger: ProposalLedgerView | null | undefined,
  task: string,
  maxClaims: number = MAX_EVIDENCE_ANSWER_CLAIMS
): { answer: string; verifiedRecords: number } | undefined {
  if (!ledger) return undefined;
  const terms = subjectTermsFromTask(task);
  if (terms.length === 0) return undefined;

  const claims: string[] = [];
  for (const record of ledger.citable()) {
    if (record.verificationStatus !== 'VERIFIED') continue;
    if (record.freshness !== 'CURRENT') continue;
    if (record.privacyStatus !== 'SANITIZED') continue;
    const key = record.key.toLowerCase();
    const onSubject = terms.some((term) => key.includes(term) || term.includes(key));
    if (!onSubject) continue;
    if (claims.includes(record.claim)) continue;
    claims.push(record.claim);
    if (claims.length >= maxClaims) break;
  }

  if (claims.length === 0) return undefined;
  return {
    answer: truncateClaim(claims.join(' '), MAX_SUPPORTED_ANSWER_CHARS),
    verifiedRecords: claims.length,
  };
}

/** Hostname only — never a path, query or fragment. Fails closed to null. */
function hostFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).host;
    return host || null;
  } catch {
    return null;
  }
}

/**
 * PHASE 18.7 / A1 — raised when the model proposed a terminal state and the
 * local verifier produced a verdict.
 *
 * A SIGNAL, not a return value, and that is deliberate: the action dispatch
 * pipeline is typed on `BrowserAction`, so there is no way to hand this back
 * into it by accident. Nothing grounded, validated, risk-scored or executed
 * happens on the way out.
 */
class TerminalProposalSignal extends Error {
  constructor(readonly verdict: ProposalVerdict) {
    super('Terminal proposal received.');
    this.name = 'TerminalProposalSignal';
  }
}

/** The view used when a loop runs with no ledger: locally observable as empty. */
const EMPTY_LEDGER_VIEW: ProposalLedgerView = Object.freeze({
  byIdSafe: () => undefined,
  citable: () => [],
});
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
  DynamicReplanner,
  GoalProgressTracker,
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
  ) => Promise<{
    success: boolean;
    error?: string;
    message?: string;
    postSnapshot?: PostActionSnapshot;
    effect?: ActionEffectResult;
    noEffect?: boolean;
    inert?: boolean;
    domMutated?: boolean;
    urlChanged?: string;
    focusChanged?: boolean;
    scrollDelta?: number;
  }>;

  /**
   * Optional snapshot provider for pre/post action state.
   *
   * When supplied, the loop uses ONLY these observations for effect
   * verification. `target` is the action's resolved element id so the provider
   * can report that element's current value LENGTH (never the value).
   *
   * Returning null means "could not observe". A host that provides this
   * callback and cannot observe must return null so the loop fails closed; the
   * loop only synthesizes a snapshot when NO provider exists at all (a
   * non-browser embedding with no tab to observe).
   */
  getEffectSnapshot?: (target?: string) => Promise<PreActionSnapshot | PostActionSnapshot | null>;

  /**
   * Optional progress listener called after every step.
   */
  onStepProgress?: (state: AgentTaskState) => void;

  /**
   * PHASE 18.8 / B2 — the bounded, privacy-safe conversation context after an
   * update. The service worker owns persistence; the loop only reports.
   *
   * The context is INFORMATIONAL. It cannot authorize an action and is never an
   * input to grounding, M5, the security critic, risk/confirmation, containment,
   * effect verification or goal verification.
   */
  onConversationUpdate?: (context: ConversationContext) => void;

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
  /** Phase 18.1: Task run correlation identifier for single active task ownership */
  runId?: number | string;
  /**
   * PHASE 18.7 (I-1/A3) — the deterministic intent decision for this run.
   *
   * Minted ONCE at the intent boundary and passed through, never re-derived.
   * It is `Object.freeze`d there, so nothing downstream — including the model —
   * can change it. Absent for callers that predate I-1; the decision state then
   * reports `requiresEvidence: false` and the run behaves exactly as before.
   */
  intentDecision?: import('./intentBoundary').IntentDecision;
  maxSteps?: number;
  /**
   * PHASE 18.8 / B2 — an existing conversation to continue, or null for a
   * one-shot task. The service worker decides which (see
   * `conversationPersistence.ts`); the loop never re-derives that decision and
   * never accepts a context whose conversation id or generation it did not
   * receive.
   */
  conversationContext?: ConversationContext | null;
  /**
   * PHASE 17.4 D5. Where long-horizon RELIABILITY state is persisted so a
   * service-worker restart cannot silently reset the bounds. Defaults to an
   * in-memory store (persistence AVAILABLE = false) so every existing caller,
   * fixture and test is unchanged; the service worker opts into
   * `chrome.storage.session`.
   */
  longHorizonStore?: LongHorizonStore;
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
  /** Authoritative target web tab ID for the task lifecycle. */
  targetTabId?: number | null;
  /** Initial known URL of the target web tab. */
  initialUrl?: string;
  /**
   * Phase 12 Containment: the environmental boundary for this task.
   *
   * Owned by the host that owns the target tab. The service worker always
   * establishes one and refuses to start a task when it cannot, so the real
   * browser path is fail-closed. A host with no tab of its own omits it and
   * claims no environmental boundary.
   */
  containmentScope?: ContainmentScope | null;
  /**
   * Phase 13 Harness: cycle coordination and runtime-state observation.
   *
   * OPTIONAL and NON-AUTHORITATIVE. The Harness decides whether another
   * perception cycle MAY RUN; it never decides whether an action may execute.
   * A `CONTINUE` verdict is NOT permission to dispatch: on every cycle the
   * Harness allows, Target Grounding → M5 → Security Critic → Privacy Firewall
   * → Risk/Confirmation → Containment → Dispatch → Effect Verification →
   * Goal Verification all run, unchanged, in exactly the same order with
   * exactly the same authority they had before the Harness existed.
   *
   * Omitting it (the default) leaves the loop behaving exactly as before: no
   * environmental claim is made and no boundary is asserted.
   */
  harness?: AgentHarness | null;

  /**
   * PHASE 18.7 / A2 — the task's evidence ledger.
   *
   * Owned by the service worker (one per task) and passed in, so the decision
   * state and information completion read the SAME store rather than keeping a
   * private copy. It grants no authority: it records what was observed and
   * nothing more.
   */
  evidenceLedger?: EvidenceLedger;
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
  /** PHASE 18.7 / A8. True when `providerRetries` was set by the caller. */
  private readonly providerRetriesExplicit: boolean;
  private providerRetryDelayMs: number;
  private targetTabId: number | null = null;
  private state: AgentTaskState;
  private isStopped = false;
  /**
   * PHASE 18.8 / B2 + A13 + A15 — conversation context for THIS turn.
   *
   * `null` means there is no conversation (a one-shot task), which keeps the
   * existing single-turn behaviour exactly as it was.
   */
  private conversation: ConversationContext | null = null;
  /** Index of the current turn inside the conversation, or -1. */
  private conversationTurnIndex = -1;
  /** Bounded identities recorded this conversation, for revalidation. */
  private conversationIdentities = new Map<string, EntityIdentity>();
  /** Last page URL observed in the conversation, for the navigation signal. */
  private lastConversationUrl: string | null = null;
  private hierarchicalGoal?: HighLevelGoal;
  private subgoalGraph?: SubgoalGraph;
  private planStateMachine?: PlanStateMachine;
  /**
   * Phase 9: deterministic long-horizon task state — progress, loops, stalls,
   * subgoal lifecycle, hard bounds and state-aware replanning. Read-only with
   * respect to authority: it can stop or de-scope work, never authorize it.
   */
  private longHorizon = new LongHorizonTracker(DEFAULT_LONG_HORIZON_BOUNDS);
  /**
   * PHASE 17.4 D5. Identity of THIS run, minted in runTask. Deliberately NOT
   * derived from the task text: two runs of the same task must not share a
   * reliability record. This is an identity token, not a credential — it grants
   * nothing and authorizes nothing.
   */
  private runId: string = '';
  private readonly longHorizonStore: LongHorizonStore;
  /** PHASE 17.4 D5. Why the tracker looks the way it does. Diagnostics only. */
  public longHorizonRestoreStatus: string = 'FRESH_NO_RECORD';
  /**
   * Phase 10: bounded deterministic Recovery Engine. It CLASSIFIES failures and
   * SELECTS a strategy; it never executes anything. Every recovered action is
   * re-proposed through the complete authoritative pipeline (Grounding → M5 →
   * Security Critic → Privacy → Risk/Confirmation → Execution → Verification).
   */
  private readonly recoveryEngine = new RecoveryEngine(DEFAULT_RECOVERY_BOUNDS);
  /**
   * PHASE 18.7 / A7. The bounded typed recovery planner. It selects a strategy
   * CLASS and writes a `RecoveryRecord`; it never selects an action, never
   * executes one, and never approves one.
   */
  private readonly typedRecovery = new TypedRecoveryPlanner();
  /**
   * PHASE 18.7 / I-8. Ledger size at the end of the previous cycle, so the next
   * one can compute a truthful EVIDENCE DELTA. A COUNT only.
   */
  private lastObservedLedgerSize = 0;
  /**
   * PHASE 18.7 / I-8. Task-scoped, one-way strategy constraint.
   *
   * Set when the bounded scroll budget drains or the agent is detected
   * oscillating. It is a STRATEGY restriction, not an authority: it can only
   * prevent a proposed scroll from being DISPATCHED. It can never grant a
   * dispatch, and every other gate still runs in full on everything else.
   */
  private scrollStrategyExhausted = false;
  /**
   * PHASE 18.7 / A7. Set when a STALE_PERCEPTION recovery turn is taken, and
   * consumed by the next perception failure so the reported reason names the
   * upstream cause rather than only its symptom.
   */
  private pendingStaleReason: string | undefined;
  private readonly taskRunId?: number | string;

  /**
   * PHASE 17.8 D-01. Number of decision-trace steps whose DETAILED trace could
   * not be written because the proposal carried a raw sensitive value.
   *
   * The value itself is never counted, stored or logged — only the fact that a
   * trace was withheld. See `recordDecisionStep` for why this is not a
   * security event.
   */
  private decisionTraceWithheldCount = 0;

  /**
   * How many decision-trace steps were withheld because their proposal
   * contained a raw sensitive value.
   *
   * Non-zero means the explainability trace is INCOMPLETE for that task. The
   * security decision is unaffected and remains fail-closed; only the audit
   * trail is partial. Exposed so a host can surface the gap rather than present
   * a silently truncated trace as a complete one.
   */
  get withheldDecisionTraceSteps(): number {
    return this.decisionTraceWithheldCount;
  }

  /**
   * PHASE 17.8 D-01 — make refusal tracing non-fatal.
   *
   * THE DEFECT. `AgentDecisionTracer.recordStep` runs the raw-value firewall
   * over the whole entry, and every entry includes `proposedAction: action`.
   * So when the model proposes an action carrying a raw value — an email in a
   * `type` action's text, a card number in a reason — the trace that is
   * supposed to RECORD THE REFUSAL is itself rejected for carrying that value.
   * `PrivacyBoundaryError` then escapes `runTask`, and the task ends with no
   * state, no reason and no trace.
   *
   * WHY THIS IS NOT A SECURITY DEFECT. Nothing is dispatched, nothing is
   * authorized and nothing leaks. M5 already refused; the throw happens after
   * that decision, on the audit path. The security outcome was fail-closed
   * before the exception was thrown and is unchanged by catching it. What was
   * broken is RELIABILITY: a correct, safe refusal became an unhandled error.
   *
   * WHY ONLY THIS EXCEPTION. `PrivacyBoundaryError` is the specific, expected
   * signal that the tracer could not safely serialize an entry. Every other
   * error is a real bug and is re-thrown unchanged, so this cannot become a
   * general "ignore tracing errors" handler.
   *
   * WHY NO FALLBACK ENTRY. `DecisionTraceEntry.proposedAction` is required, so
   * a "safe" entry would have to invent a placeholder action. Writing a
   * fabricated proposal into an explainability trace is exactly the class of
   * fabrication this project exists to refuse, so the detailed entry is
   * WITHHELD rather than replaced. The refusal itself is unaffected: it is
   * already recorded by `this.recordStep(...)` into `state.steps`, which does
   * not run the wire firewall, and by `state.reason`.
   *
   * The tracer itself is deliberately NOT modified. Weakening it at the source
   * would suppress this signal for every other consumer of the trace, and this
   * fix is about the CALLER handling an expected refusal, not about relaxing
   * what the firewall refuses.
   */
  private recordDecisionStep(
    tracer: AgentDecisionTracer,
    entry: Omit<DecisionTraceEntry, 'timestamp'>
  ): void {
    try {
      tracer.recordStep(entry);
    } catch (err) {
      if (!(err instanceof PrivacyBoundaryError)) throw err;
      this.decisionTraceWithheldCount++;
      // Value-free by construction: a step number and a fixed constant. No
      // action, no page text, no model output, no reason string.
      console.info('[AgentTrace] decision trace withheld', {
        step: entry.step,
        reason: 'RAW_VALUE_IN_PROPOSAL',
      });
    }
  }
  /**
   * Phase 12 Containment scope. Defaults to null, which containment treats as
   * UNINITIALIZED and therefore denies — the fail-closed default.
   */
  private readonly containmentScope: ContainmentScope | null;
  /**
   * PHASE 17.6 (C). The most recent sanitized perception, one slot only.
   * Local, never persisted, never transmitted; it exists so a
   * `STATE_CHANGED` subgoal condition has a real prior state to compare
   * against rather than being unprovable.
   */
  private previousObservation: AgentContextPayload | undefined = undefined;
  private readonly harness: AgentHarness | null;
  /** PHASE 18.7 (A3) — the frozen intent decision for this run, if present. */
  private readonly intentDecision: import('./intentBoundary').IntentDecision | null;
  /**
   * PHASE 18.7 (A2) — the task's evidence ledger, owned by the service worker and
   * passed in. Read-only here: the loop never authors a record, it only reports
   * what the ledger already holds.
   */
  private readonly evidenceLedger: EvidenceLedger | null;

  /**
   * PHASE 18.7 (A3) — assemble this cycle's model-facing decision state.
   *
   * Reads the SAME stores the authorities use: `state` for page/goal/recovery,
   * `evidenceLedger` for evidence, `state.steps` for the last action. It adds
   * no new truth — it only reports what those already hold.
   *
   * `destination` is reported as `UNVERIFIED` rather than guessed: this module
   * does not run DestinationVerifier, and inferring it from a URL would
   * manufacture a verdict. DestinationVerifier remains the only source of a
   * destination verdict, and it stays authoritative.
   */
  private buildDecisionStateForCycle(context: AgentContextPayload): ModelFacingDecisionState {
    const lastStep = this.state.steps.length > 0 ? this.state.steps[this.state.steps.length - 1] : undefined;
    const lastAction: ActionHistoryEntry | null = lastStep
      ? buildActionHistoryEntry(lastStep, { currentPageGeneration: this.state.currentPageGeneration })
      : null;

    const evidence: EvidenceReference[] = this.evidenceLedger
      ? this.evidenceLedger.toModelFacing().map((r) => ({
          id: r.id,
          verificationStatus: r.verification === 'CONFLICTED' ? 'CONFLICTED' : r.verification,
          freshness: r.verification === 'INVALIDATED' ? 'STALE' : 'CURRENT',
        }))
      : [];

    const observationState: PageObservationState = context ? 'OBSERVED' : 'UNAVAILABLE';

    return buildDecisionState({
      task: this.state.taskGoal || this.state.normalizedGoal || '',
      intent: this.intentDecision?.intent ?? 'UNSUPPORTED',
      requiresEvidence: this.intentDecision?.requiresEvidence ?? false,
      activeSubgoal: this.state.activeSubgoal?.description ?? null,
      pendingCriteria: this.state.pendingSubgoals.map((s) => s.description),
      completedCriteria: this.state.completedSteps,
      url: context?.url ?? this.state.currentUrl,
      pageType: (context?.page_type as PageCategory | undefined) ?? this.state.pageType,
      pageObservationState: observationState,
      pageGeneration: this.state.currentPageGeneration,
      lastAction,
      destinationStatus: 'UNVERIFIED' satisfies DecisionDestinationStatus,
      goalStatus: goalStatusFromTaskStatus(this.state.status),
      evidence,
      recoveryState: (this.state.recoveryStrategy ?? 'NONE') as DecisionRecoveryState,
      recoveryAttempts: this.state.totalRecoveryAttempts ?? 0,
      retryCount: this.state.retryCount ?? 0,
    });
  }
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
    // PHASE 18.7 / A8. An explicit operator setting is a deliberate ceiling and
    // is honoured exactly; only the DEFAULT is replaced by the task-class-aware
    // budget.
    this.providerRetriesExplicit = options.providerRetries !== undefined;
    this.providerRetryDelayMs = options.providerRetryDelayMs ?? 250;
    this.targetTabId = options.targetTabId ?? null;
    // PHASE 17.4 D5. Default is an in-memory store: persistence is opt-in and
    // degrades explicitly rather than silently.
    this.longHorizonStore = options.longHorizonStore ?? createNoopStore();
    this.containmentScope = options.containmentScope ?? null;
    this.harness = options.harness ?? null;
    this.taskRunId = options.runId;
    //
    // PHASE 18.7 (A3). Carried, never re-derived. Frozen at the boundary, so
    // nothing here can rewrite it. Absent for pre-I-1 callers.
    //
    this.intentDecision = options.intentDecision ?? null;
    this.evidenceLedger = options.evidenceLedger ?? null;
    // PHASE 18.8 / B2. The conversation context is injected by the service
    // worker, which owns its lifetime and its persistence. Absent means a
    // one-shot task: every reference check below then fails closed to
    // "not a reference" and nothing changes.
    this.conversation = options.conversationContext ?? null;

    this.state = createAgentTaskState('', {
      maxSteps: this.maxSteps,
      maxRetries: this.maxRetries,
      targetTabId: this.targetTabId,
    });
    if (options.initialUrl) {
      this.state.currentUrl = options.initialUrl;
    }
  }

  getRunId(): number | string | undefined {
    return this.taskRunId;
  }

  isHalted(): boolean {
    return this.isStopped;
  }

  /**
   * Safely halt the running task loop.
   * If silent is true, suppresses event emission (used when superseding an old loop).
   */
  stop(silent = false): void {
    this.isStopped = true;
    if (!silent && this.state.status === 'IN_PROGRESS') {
      this.state.status = 'STOPPED';
      this.state.goalStatus = 'STOPPED';
      this.state.reason = 'Task stopped by user.';
      if (this.callbacks.onStepProgress) {
        this.callbacks.onStepProgress(this.getState());
      }
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
    this.state.targetTabId = this.targetTabId;
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
    this.state.clarification = null;

    // Clear working memory for task isolation
    WorkingMemoryManager.clearAll();

    // PHASE 18.8 / B2 — open this turn inside the conversation, if any. A
    // one-shot task has no conversation and this is a no-op.
    this.beginConversationTurn(task);

    // Feature 3 & 7: Multi-Step Task Planner and Explainable Decision Tracer
    const tracer = new AgentDecisionTracer(`task-${Date.now().toString(36)}`);
    const plan = createTaskPlan(task);
    this.state.plan = plan;

    // Phase 4: Hierarchical Task Planning & Subgoal DAG Initialization
    const decompResult = decomposeTask(task, { currentUrl: this.state.currentUrl });
    this.hierarchicalGoal = decompResult.goal;
    this.subgoalGraph = new SubgoalGraph(decompResult.goal.goalId, decompResult.subgoals);
    this.planStateMachine = new PlanStateMachine();
    this.planStateMachine.initialize(this.hierarchicalGoal);
    this.planStateMachine.registerDecompositionComplete();

    this.state.highLevelGoal = this.hierarchicalGoal;
    this.state.subgoalGraphData = this.subgoalGraph.toData();
    this.state.planningEngineState = this.planStateMachine.getState();

    // Phase 9: initialize long-horizon task state for the whole task. The
    // tracker owns NO authority: it only remembers what has been accomplished,
    // bounds the task, and refuses to repeat finished or failed work. M5, the
    // Security Critic, privacy/risk/confirmation and goal verification remain
    // the authoritative gates and are untouched.
    // ── PHASE 17.4 D5: establish run identity, then restore if this is the
    // SAME task after a service-worker restart. A different runId, a malformed
    // record, or a schema mismatch all yield a FRESH, FULLY BOUNDED tracker.
    this.runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const d5Load = await loadTrackerForTask(
      this.longHorizonStore,
      this.runId,
      task,
      DEFAULT_LONG_HORIZON_BOUNDS
    );
    this.longHorizon = d5Load.tracker;
    this.longHorizonRestoreStatus = d5Load.persistenceAvailable ? d5Load.status : 'UNAVAILABLE';
    console.info('[AgentTrace] long-horizon state', {
      restoreStatus: this.longHorizonRestoreStatus,
      detail: d5Load.detail ?? null,
      actionCount: this.longHorizon.actionCount,
      recoveryCount: this.longHorizon.recoveryCount,
      consecutiveNoProgress: this.longHorizon.consecutiveNoProgress,
      totalNoProgress: this.longHorizon.totalNoProgress,
    });
    this.longHorizon.initialize(
      task,
      Object.entries(parsed.constraints as Record<string, unknown>)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${String(v)}`),
      decompResult.subgoals
    );
    this.state.longHorizon = this.longHorizon.snapshot();

    // Phase 10: a fresh task starts with a fresh recovery budget. History from
    // a previous task must never bleed into this one's bounds.
    this.recoveryEngine.reset();
    // PHASE 18.7 / A7. A new task gets a full recovery budget; a restart must
    // never inherit a drained one.
    this.typedRecovery.reset();
    this.scrollStrategyExhausted = false;
    this.lastObservedLedgerSize = 0;
    this.pendingStaleReason = undefined;
    this.state.recoveryHistory = [];
    this.state.totalRecoveryAttempts = 0;

    // Phase 13: a fresh task starts with a fresh harness run. The Harness
    // coordinates cycles and observes runtime state; it holds no security
    // authority, grants nothing, and authorizes no action.
    if (this.harness) {
      this.harness.initialize(task);
      this.state.harnessRun = this.harness.summary();
    }

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

      // ── PHASE 13 HARNESS ─────────────────────────────────────────────────
      // CYCLE COORDINATION AND RUNTIME-STATE OBSERVATION ONLY.
      //
      // This is the first and only point at which the loop is asked "may
      // another perception cycle run?", which until now it could only answer
      // by simply running one. The Harness observes the environment the agent
      // is actually in — the Phase 12 containment scope, the pinned tab, the
      // last known URL — and the loop's OWN bounds, and returns a verdict.
      //
      // IT IS NOT AN ARBITER OF SECURITY. Its vocabulary is deliberately
      // CONTINUE / HALT_ENVIRONMENT / BUDGET_EXHAUSTED / TERMINAL — never
      // ALLOW, DENY or AUTHORIZE. A CONTINUE verdict means only "the next
      // cycle may run the pipeline"; it is NOT permission to dispatch. Every
      // gate below still runs, unchanged and in the same order, on every cycle
      // the Harness allows:
      //
      //   HARNESS=CONTINUE → M5=REFUSED          → NO DISPATCH
      //   HARNESS=CONTINUE → CRITIC=BLOCK        → NO DISPATCH
      //   HARNESS=CONTINUE → CONTAINMENT=DENIED  → NO DISPATCH
      //
      // The Harness holds no bounds of its own: the ones checked here are the
      // loop's own values with the loop's own operators, so the two can never
      // drift into competing limits. The stop check and max-steps check above
      // remain authoritative; this mirrors them as a backstop.
      //
      // Containment remains Phase 12's: the Harness consumes that scope and
      // never creates, widens, narrows or reinterprets it.
      if (this.harness) {
        const harnessDecision: HarnessDecision = this.harness.runCycle({
          status: this.state.status,
          stopRequested: this.isStopped,
          containmentScope: this.containmentScope,
          targetTabId: this.targetTabId,
          liveUrl: this.state.currentUrl || null,
          bounds: {
            maxSteps: this.maxSteps,
            maxRetries: this.maxRetries,
            maxTotalRecoveries: DEFAULT_RECOVERY_BOUNDS.maxTotalRecoveries,
          },
          step: this.state.currentStep,
          retryCount: this.state.retryCount,
          recoveryAttempts: this.state.totalRecoveryAttempts ?? 0,
          perceptionGeneration: this.state.perceptionGeneration,
        });
        this.state.harnessRun = this.harness.summary();
        console.info('[AgentTrace] harness cycle', {
          cycle: harnessDecision.record.cycle,
          verdict: harnessDecision.verdict,
          haltCode: harnessDecision.haltCode,
          scope: harnessDecision.record.containmentScopeSummary,
          withinScope: harnessDecision.record.environment.withinScope,
        });

        if (harnessDecision.verdict !== 'CONTINUE') {
          // An environment halt is TERMINAL in the same sense a containment
          // denial is: the harness does not hand a refused environment to the
          // Recovery Engine, because retrying into it is the drift this phase
          // exists to stop.
          this.state.status = harnessDecision.verdict === 'TERMINAL' ? 'STOPPED' : 'FAILED';
          this.state.goalStatus = this.state.status;
          this.state.reason = harnessDecision.reason;
          console.warn('[AgentTrace] HARNESS_CYCLE_HALTED', {
            verdict: harnessDecision.verdict,
            haltCode: harnessDecision.haltCode,
            cycle: harnessDecision.record.cycle,
          });
          this.notifyProgress();
          break;
        }
      }

      // 2. Fresh perception cycle: obtain current sanitized context
      //
      // PHASE 17.6 (C). The previous cycle's sanitized context: the baseline a
      // STATE_CHANGED subgoal condition is judged against. Declared at the TOP of
      // the iteration so the perception block can publish it and the dispatch
      // block can read it.
      let previousObservation: AgentContextPayload | undefined = this.previousObservation ?? undefined;
      this.state.perceptionGeneration++;
      this.state.currentPageGeneration = this.state.perceptionGeneration;
      const perceptionGen = this.state.perceptionGeneration;
      console.info('[AgentTrace] perception started', { perceptionGeneration: perceptionGen, url: this.state.currentUrl });
      const perceptionResult = await this.callbacks.perceivePage();
      const normalized = this.normalizePerceptionResult(perceptionResult);
      if (!normalized) {
        this.state.status = 'FAILED';
        this.state.goalStatus = 'FAILED';
        //
        // PHASE 18.7 / A7. When the failure came after a STALE_PERCEPTION
        // recovery turn, the stale observation is the upstream cause: the
        // reasoner refused a proposal computed against a page that had since
        // moved, and the page then could not be re-read. Reporting only the
        // second event would hide the first, which is the one that matters.
        if (this.pendingStaleReason) {
          this.state.reason = this.pendingStaleReason;
          this.pendingStaleReason = undefined;
        } else {
          this.state.reason = 'Perception failed: Unable to obtain sanitized page context.';
        }
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
      //
      // PHASE 17.6 (C). Keep the PREVIOUS cycle's sanitized context so a
      // `STATE_CHANGED` subgoal condition has a genuine baseline to compare
      // against. Without it that condition is unprovable, and
      // `verifySubgoalCondition` fails closed by design — so the loop would
      // silently never complete a STATE_CHANGED subgoal.
      //
      // It is the immediately preceding perception only: one slot, overwritten
      // each cycle, so it cannot accumulate. It is the SAME already-sanitized
      // object (assertSanitizedContextSafe just passed over it), so this adds
      // no new PII surface and is never persisted or transmitted.
      previousObservation = this.previousObservation ?? undefined;
      this.previousObservation = context;
      this.state.currentUrl = context.url || worldModel?.page.url || this.state.currentUrl;

      // Phase 16 P0 remediation: record where the viewport OBSERVABLY is, so
      // that a scroll goal is decided from live browser state rather than from
      // the fact that a scroll was once requested. The baseline is captured
      // once, on the first perception of the task.
      const observedScrollY =
        typeof context.viewport?.scroll_y === 'number' ? context.viewport.scroll_y : null;
      if (observedScrollY !== null) {
        if (this.state.initialScrollY === undefined || this.state.initialScrollY === null) {
          this.state.initialScrollY = observedScrollY;
        }
        this.state.observedScrollY = observedScrollY;
      }

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

      // PHASE 18.8 / B2 + A15 — record the entities OBSERVED on this page and
      // REVALIDATE any selection against it. Runs before goal verification and
      // before the reasoner, and grants nothing.
      this.observeConversation(worldModel, context);

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

      // G7 REPAIR 1 — DESTINATION SUBGOAL RE-EVALUATION.
      //
      // A destination subgoal is selected ONCE, while the browser is still on
      // the entry page, and `startSubgoal` moves it to IN_PROGRESS.
      // `getReadySubgoals` only ever returns READY/PENDING subgoals, so from
      // the next cycle onward the selector above reports NEEDS_REPLAN and
      // `activeSubgoal` is undefined — which means the verification guard at
      // the end of this iteration can never run again. The destination was
      // therefore proven once, BEFORE arrival, and never re-checked once the
      // browser actually reached it. That is the G7 blocker.
      //
      // This restores ONLY the missing re-check. It grants no new completion
      // authority:
      //
      //  - The subgoal found here is still decided by the SAME
      //    `GoalProgressTracker.verifySubgoalCondition` → `verifyDestination`
      //    chain, reading the CURRENT sanitized observation. This is not
      //    evidence of arrival; it is only a reason to ask again.
      //  - Nothing here reads `execResult`, the action, `action.url`, a
      //    navigation destination, previous actions, affordances or model
      //    output. A successful dispatch cannot make a destination subgoal
      //    complete.
      //  - `completeSubgoal` is still called only when that chain returns
      //    MATCH. MISMATCH and UNKNOWN both leave it IN_PROGRESS.
      //  - Freshness is untouched — it is still the verifier's existing
      //    page-generation semantics.
      let destinationRevisitSubgoal: Subgoal | undefined;
      if (this.subgoalGraph) {
        const revisit = SubgoalSelector.selectDestinationSubgoalForRevisit({
          graph: this.subgoalGraph,
          currentUrl: context.url || this.state.currentUrl || '',
          currentGeneration: semanticContext?.pageGeneration,
          previousUrl: previousObservation?.url,
          previousGeneration: previousObservation?.semantic_context?.pageGeneration,
        });
        if (revisit.status === 'REVISIT' && revisit.selectedSubgoal) {
          destinationRevisitSubgoal = revisit.selectedSubgoal;
          console.info('[AgentTrace] destination subgoal eligible for re-verification', {
            subgoalId: destinationRevisitSubgoal.id,
            reason: revisit.reason,
          });
        }
      }

      // G7 REPAIR 1 (continued) — RE-VERIFY FROM THE OBSERVATION, HERE.
      //
      // The verdict is requested at this point, immediately after the fresh
      // perception and BEFORE any action is proposed or dispatched, rather than
      // in the end-of-cycle verification block.
      //
      // Why the placement matters. The end-of-cycle block is gated on
      // `execResult.success`, which is DISPATCH state about the action that
      // happened to run this cycle. Deciding the destination from that gate
      // would make arrival provable only by whatever the agent happened to do
      // afterwards — the exact inversion of "actions cause state changes;
      // observations prove the state". In the real fixture the browser is at
      // the destination, the page is correctly classified LISTING, and every
      // subsequent scroll returns ACTION_NO_EFFECT at a scroll boundary; that
      // recovery path skips the end-of-cycle block, so the destination was
      // never actually put to the verifier. Deciding here removes that
      // dependence entirely.
      //
      // This grants NO new authority. `GoalProgressTracker.verifySubgoalCondition`
      // still reads only `context`, `previousObservation` and the observed page
      // generation; it still refuses UNKNOWN, MISMATCH, a stale classification
      // and a missing declaration; and `completeSubgoal` is still called only
      // when it returns MATCH. The action for THIS cycle has not been chosen
      // yet, so nothing here can be influenced by one.
      if (destinationRevisitSubgoal && this.subgoalGraph) {
        const revisitVerification = GoalProgressTracker.verifySubgoalCondition(
          destinationRevisitSubgoal,
          {
            context,
            previous: previousObservation,
            pageGeneration: this.state.currentPageGeneration ?? 0,
            userConfirmedActionIds: this.state.confirmedActionIds ?? [],
          }
        );
        if (revisitVerification.satisfied) {
          this.subgoalGraph.completeSubgoal(destinationRevisitSubgoal.id);
          this.state.subgoalGraphData = this.subgoalGraph.toData();
          console.info('[AgentTrace] subgoal completed', {
            subgoalId: destinationRevisitSubgoal.id,
            category: destinationRevisitSubgoal.category,
            evidence: revisitVerification.reason,
          });
        } else {
          console.info('[AgentTrace] subgoal NOT completed — no observed evidence', {
            subgoalId: destinationRevisitSubgoal.id,
            category: destinationRevisitSubgoal.category,
            reason: revisitVerification.reason,
          });
          this.state.subgoalVerificationHistory = [
            ...(this.state.subgoalVerificationHistory ?? []),
            {
              subgoalId: destinationRevisitSubgoal.id,
              step: this.state.currentStep,
              satisfied: false,
              reason: revisitVerification.reason,
              timestamp: Date.now(),
            },
          ].slice(-64);
        }
        // Only one subgoal may be proven per cycle. A destination that completes
        // here releases the next subgoal, which ordinary selection picks up on
        // the NEXT cycle.
        destinationRevisitSubgoal = undefined;
      }

      // ── Phase 9: long-horizon task state ─────────────────────────────────
      // Observes THIS task between successive perceptions: what has been
      // accomplished, whether the agent is still making progress, and whether
      // it is looping or stalled. It can only remember, bound and de-scope —
      // it never authorizes an action, never executes one, and never replaces
      // M5, the Security Critic, privacy/risk/confirmation or goal
      // verification, all of which remain authoritative below.
      syncFromSubgoalGraph(this.longHorizon, this.subgoalGraph?.toData());

      // Completed work must not be needlessly re-executed.
      if (activeSubgoal && this.longHorizon.isAlreadyCompleted(activeSubgoal.id)) {
        this.state.longHorizonRepeatCount = (this.state.longHorizonRepeatCount ?? 0) + 1;
        console.info('[AgentTrace] long-horizon: completed subgoal re-selected, skipping repeat', {
          subgoalId: activeSubgoal.id,
        });
      }

      // Record useful, sanitized discoveries (labels/types only, no values).
      for (const entity of semanticContext?.entities ?? []) {
        this.longHorizon.addDiscovery({
          id: `ent-${entity.id}`,
          label: entity.type,
          source: 'ENTITY',
          subgoalId: activeSubgoal?.id,
          url: this.state.currentUrl,
        });
      }

      const lhObservation = observeFromContext(context, {
        scrollY: context.viewport?.scroll_y ?? 0,
        //
        // PHASE 17.4. This previously read `(context as any).typed_value_length`.
        // `AgentContextPayload` declares no such field, so the `as any` cast
        // suppressed the type error and the expression was permanently 0 — which
        // made assessProgress's "targeted value length changed" signal
        // unreachable, silently, for as long as it existed.
        //
        // No sanitized context field carries the targeted value's LENGTH, so the
        // signal is declared unavailable rather than faked. Reading a DOM/text
        // goal type is Phase 17.2 proper's work; inventing a field here would
        // fabricate the observation this phase exists to keep honest.
        targetValueLength: 0,
      });
      //
      // PHASE 17.4. The action actually ATTEMPTED in the previous cycle.
      // `fingerprintObservation` is documented as a fingerprint of "same page
      // state + same action" and takes this argument, but the call site passed
      // `undefined`, so the action component was permanently the literal
      // 'observe'. A repeated identical failing action was therefore detected
      // only because the OBSERVATION repeated, and a different action that also
      // changed nothing was indistinguishable from it.
      const lhLastAction =
        this.state.steps.length > 0 ? this.state.steps[this.state.steps.length - 1]!.action : undefined;
      //
      // PHASE 18.7 / I-8 — EVIDENCE DELTA.
      //
      // This is the number that actually decides whether a scroll bought
      // anything. The loop read the ledger's own size at the end of the previous
      // cycle; the growth since is what the new facts this cycle discovered are
      // worth. It is a COUNT — no claim, no id, no text — and it is read from
      // the ledger this device holds, never from anything the model said.
      const lhEvidenceDelta = (this.evidenceLedger?.size ?? 0) - this.lastObservedLedgerSize;
      this.lastObservedLedgerSize = this.evidenceLedger?.size ?? 0;
      const lhProgress = this.longHorizon.observe(lhObservation, lhLastAction, {
        //
        // PHASE 17.4. `subgoalJustCompleted` is no longer passed at all.
        //
        // It used to be `lastActionResult.success ? activeSubgoalId : undefined`
        // — DISPATCH state presented to the long-horizon layer as task progress.
        // Because assessProgress counted any signal as meaningful, every
        // successfully dispatched action reported progress, so
        // `consecutiveNoProgress` never advanced and `detectStall` could never
        // fire. Stagnation detection was unreachable.
        //
        // assessProgress no longer treats a completion as sufficient on its own
        // either, so the rule holds for every caller, and removing the value here
        // keeps dispatch-derived bookkeeping out of long-horizon state entirely.
        //
        // Only count an observation as an action once a step has actually run.
        countsAsAction: this.state.lastActionResult !== null,
        //
        // PHASE 18.7 / I-8. The ledger growth since the previous cycle. Without
        // it a scroll that reveals nothing is indistinguishable from a scroll
        // that reveals the answer, and geometry alone would keep reporting
        // progress.
        evidenceDelta: lhEvidenceDelta,
      });
      const lhLoop = this.longHorizon.detectLoop();
      const lhStall = this.longHorizon.detectStall();
      this.state.longHorizon = this.longHorizon.snapshot();
      //
      // PHASE 17.4 D5. Persist the reliability state EVERY cycle, not only at
      // task end: the task may never reach task end, and a service worker can be
      // evicted between any two cycles. This is what stops a restart from
      // handing the agent a second full budget.
      //
      // Best-effort and non-blocking: persistence failure must never abort a run.
      void saveTracker(
        this.longHorizonStore,
        this.longHorizon,
        this.runId,
        task,
        DEFAULT_LONG_HORIZON_BOUNDS
      );

      console.info('[AgentTrace] long-horizon update', {
        meaningfulProgress: lhProgress.meaningful,
        signals: lhProgress.signals,
        completedSubgoals: this.longHorizon.completedSubgoalIds.length,
        pendingSubgoals: this.longHorizon.pendingSubgoalIds.length,
        discoveries: this.longHorizon.discoveries.length,
        actions: this.longHorizon.actionCount,
        loop: lhLoop.loop ? lhLoop.kind : false,
        stalled: lhStall.stalled,
        // PHASE 18.7 / I-8. What the SEMANTIC view says, as opposed to what the
        // geometry did. Content-free: codes, counts and booleans only.
        semanticProgress: lhProgress.meaningful,
        semanticSignals: this.longHorizon.semanticProgressVerdict().signals,
        geometry: lhProgress.geometry,
        sameDirectionRun: lhProgress.sameDirectionRun,
        stagnation: lhProgress.stagnation,
        evidenceDelta: lhEvidenceDelta,
      });

      // Loop / stall: stop blindly repeating, remember it, and replan ONLY the
      // remaining work. Completed subgoals and discoveries are preserved.
      if (lhLoop.loop || lhStall.stalled) {
        const why = lhLoop.loop ? lhLoop.reason : lhStall.reason;
        await recordLongHorizonFailure(siteScope, this.hierarchicalGoal?.goalId ?? 'unknown-goal', {
          failureType: lhLoop.loop ? 'REPEATED_STATE' : 'ACTION_NO_EFFECT',
          reason: why,
          subgoalId: activeSubgoal?.id,
        });
        const replan = this.longHorizon.replanRemaining(
          activeSubgoal?.id,
          lhLoop.loop ? 'loop detected' : 'stall detected'
        );
        this.state.longHorizon = this.longHorizon.snapshot();
        console.info('[AgentTrace] long-horizon replan', {
          reason: why,
          reopened: replan.reopened,
          preservedCompleted: replan.preservedCompleted,
          preservedDiscoveries: replan.preservedDiscoveries,
        });
      }

      // ── PHASE 18.7 / I-8: SEMANTIC STAGNATION IS A STRATEGY VERDICT ───────
      //
      // A replan above re-opens the remaining work, but a replan alone cannot
      // stop the observed failure mode: the reasoner re-proposes the scroll it
      // was just shown does nothing, and the run continues until `maxSteps`.
      //
      // What is added here is a bounded, task-scoped STRATEGY constraint derived
      // from the ONE semantic-progress authority:
      //
      //   • the same-direction scroll budget drained without a single evidence
      //     or semantic signal      → NO_EFFECT
      //   • up/down alternating with no signal between → OSCILLATION
      //
      // It grants NOTHING. Its single power is negative: once set, a proposed
      // `scroll` is not dispatched, because scrolling demonstrably no longer
      // changes what the task knows. Every other action type is untouched, and
      // on every action that IS dispatched the complete gate chain runs in its
      // original order — Grounding → M5 → Security Critic → M5/Privacy →
      // Risk/Confirmation → Containment → Execution → EffectVerifier →
      // DestinationVerifier → GoalVerifier. It is one-way for the life of the
      // task: a productive cycle can never re-arm scrolling, because a
      // productive cycle means the budget was never drained.
      if (lhProgress.budgetExhausted && !this.scrollStrategyExhausted) {
        this.scrollStrategyExhausted = true;
        // PHASE 18.7 / A7. The stagnation verdict becomes a typed recovery
        // record with the category it actually is — OSCILLATION is not
        // relabelled as generic no-effect, because the two need different
        // strategies.
        this.planRecoveryForLastStep(lhProgress.stagnation === 'OSCILLATION' ? 'OSCILLATION' : 'NO_EFFECT');
        console.warn('[AgentTrace] I-8 scroll strategy exhausted — no further scrolls will be dispatched', {
          stagnation: lhProgress.stagnation,
          sameDirectionRun: lhProgress.sameDirectionRun,
          geometry: lhProgress.geometry,
          evidenceDelta: lhEvidenceDelta,
          consecutiveNoProgress: this.longHorizon.consecutiveNoProgress,
        });
        await recordLongHorizonFailure(siteScope, this.hierarchicalGoal?.goalId ?? 'unknown-goal', {
          failureType: 'ACTION_NO_EFFECT',
          reason: lhProgress.stagnation,
          subgoalId: activeSubgoal?.id,
        });
      }

      // Hard task-level bounds. On exhaustion the task fails closed.
      const lhBounds = this.longHorizon.checkBounds();
      if (lhBounds.exhausted) {
        this.state.reason = `Long-horizon bounds exhausted: ${lhBounds.detail ?? lhBounds.reason}`;
        this.state.status = 'FAILED';
        this.state.goalStatus = 'FAILED';
        await recordLongHorizonFailure(siteScope, this.hierarchicalGoal?.goalId ?? 'unknown-goal', {
          failureType: 'RECOVERY_EXHAUSTED',
          reason: this.state.reason,
          subgoalId: activeSubgoal?.id,
        });
        this.state.longHorizon = this.longHorizon.snapshot();
        console.info('[AgentTrace] M6 failed', { reason: this.state.reason });
        break;
      }

      // Persist progress through the EXISTING memory subsystem. Only sanitized,
      // value-free counts are written, and the firewall still applies.
      recordWorkingProgress(this.longHorizon, siteScope, this.hierarchicalGoal?.goalId ?? 'unknown-goal');

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
      //
      // PHASE 18.7 / A5. The evidence inputs are refreshed HERE, immediately
      // before the verdict, not in the reasoning path below. The bug this fixes
      // was a SUCCESS decided at exactly this point while the state still
      // carried no verified evidence — the reasoning path had never run, so
      // anything set there would have been too late.
      this.refreshEvidenceCompletionInputs();
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
      //
      // PHASE 18.8 / A13 — deterministic reference resolution happens HERE:
      // after perception (so "the third one" means the third row of the page in
      // front of us) and BEFORE the reasoner is consulted. An unresolvable
      // reference ends the turn with a typed clarification and zero provider
      // calls, rather than asking the model to guess what "it" meant.
      const referenceBlocked = this.resolveConversationReference(task);
      if (referenceBlocked) {
        break;
      }

      this.state.currentStep++;
      let action: BrowserAction;
      //
      // POST-17.10 Step 9 — DETERMINISTIC DESTINATION NAVIGATION.
      //
      // Step 9's audit found that a destination subgoal had no deterministic
      // action path at all: every action came from the reasoner, which is never
      // told the destination (its egress payload is `{task, context,
      // previousActions}` — the typed declaration and the subgoal never cross
      // that boundary). So the browser went wherever the model guessed.
      //
      // When the user named the destination as a URL, that URL is not a guess.
      // It is proposed here verbatim, and the provider is not consulted for it.
      // This is a NAVIGATION CONSTRAINT, not an arrival claim: the action still
      // passes M5, the security critic, the privacy policy, risk/confirmation,
      // containment and effect verification below, and the subgoal completes
      // only if `verifyDestination` confirms it on a FRESH observation.
      //
      // A ROLE-ONLY declaration returns null and falls through to the model
      // exactly as before. A semantic destination has no URL, and inventing one
      // — or guessing the site's internal paths — would be both a fabrication
      // and a fixture special-case.
      if (this.isStopped) break;
      const deterministicDestination = OneActionPlanner.proposeDestinationNavigation(activeSubgoal);
      try {
        if (deterministicDestination) {
          action = deterministicDestination;
          console.info('[AgentTrace] destination navigation proposed deterministically', {
            subgoalId: activeSubgoal?.id,
            url: (deterministicDestination as { url?: string }).url,
          });
        } else {
          console.info('[AgentTrace] requesting reasoning');
          action = await this.requestActionWithBoundedRetry(task, context);
          console.info('[AgentTrace] reasoning response received');
        }
        if (this.isStopped) break;

        // Enforce the One-Action Proposal constraint: exactly ONE atomic action from allowlist
        const singleActionCheck = OneActionPlanner.validateSingleActionProposal(action);
        if (!singleActionCheck.valid) {
          this.state.status = 'FAILED';
          this.state.goalStatus = 'FAILED';
          this.state.reason = `OneActionPlanner rejected action: ${singleActionCheck.error}`;
          this.notifyProgress();
          console.info('[AgentTrace] M6 failed', { reason: this.state.reason });
          break;
        }
        action = singleActionCheck.action!;

        //
        // PHASE 18.7 / I-8 — AN EXHAUSTED STRATEGY IS NOT RE-DISPATCHED.
        //
        // The reasoner can be shown, truthfully, that three downward scrolls
        // produced no new evidence, and still propose a fourth. Without this
        // check the run continues to `maxSteps` and ends "exceeded maximum step
        // limit", which is exactly the untruthful-by-omission outcome I-8
        // exists to close.
        //
        // WHAT THIS IS NOT: it is not a gate, it is not a permission and it
        // cannot approve anything. It can only NOT dispatch a scroll whose
        // strategy is already exhausted, and it records that truthfully as a
        // non-dispatched step so the reasoner sees what happened. `totalNoProgress`
        // keeps advancing, so the pre-existing stall budget terminates the run
        // within a bounded number of further cycles.
        if (this.scrollStrategyExhausted && action.action === 'scroll') {
          // `currentStep` was already advanced for this cycle above; advancing it
          // again here would hand the loop a second budget.
          const kind = this.longHorizon.semanticProgressVerdict().stagnation;
          const refusal = `SCROLL_STRATEGY_EXHAUSTED:${kind}`;
          this.recordStep(action, false, refusal, false, refusal);
          console.info('[AgentTrace] refused an exhausted-strategy scroll', {
            direction: action.direction,
            stagnation: kind,
            reason: refusal,
          });
          await this.delay(this.delayBetweenStepsMs);
          continue;
        }
      } catch (err: unknown) {
        //
        // PHASE 18.7 / A1 + A9. A terminal proposal is NOT a failure and NOT a
        // success. It is the agent reporting what the LOCAL verifier could
        // support, and the status it produces is one of the typed information
        // states. `goalStatus` is left at the verifier's own verdict: only the
        // GoalVerifier may report SUCCESS, and it has not run here.
        //
        if (err instanceof TerminalProposalSignal) {
          const { verdict } = err;
          const status = verdict.status;
          if (status) {
            this.state.status = status;
            this.state.reason = userFacingMessageForStatus(status);
            this.state.answer = verdict.supportedRecordIds.length
              ? this.buildSupportedAnswer(verdict)
              : undefined;
            // PHASE 18.8 / B1 — value-free provenance for the result layer.
            // Count and host only; record ids never leave the device.
            if (this.state.answer) {
              this.state.answerProvenance = {
                verifiedRecords: verdict.supportedRecordIds.length,
                sourceHost: hostFromUrl(this.state.currentUrl),
              };
            }
            this.notifyProgress();
            console.info('[AgentTrace] task terminated', {
              status,
              supportedRecords: verdict.supportedRecordIds.length,
              downgraded: verdict.downgraded,
              // PHASE 18.8 / B1 — a LENGTH, never the text: it proves a
              // user-facing answer was composed from local verified claims
              // without putting any claim into a log line.
              answerChars: this.state.answer?.length ?? 0,
            });
            break;
          }
          // Nothing could be supported locally. The model proposed stopping
          // without a basis we can reproduce, so the loop keeps acting rather
          // than reporting a terminal state it cannot justify.
          console.info('[AgentTrace] terminal proposal rejected; continuing', {
            rejections: verdict.rejections,
          });
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);

        //
        // PHASE 18.7 / A7 — STALE PERCEPTION IS A RECOVERY CASE, NOT A CRASH.
        //
        // A proposal computed against a page that has since moved is refused,
        // which is correct. Reporting that as a terminal task failure is not:
        // the loop re-perceives at the top of every cycle, so the honest
        // response is one bounded turn with a FRESH perception. The typed
        // record makes the reason visible, and its budget of 1 guarantees this
        // cannot loop.
        if (err instanceof ProviderError && err.category === 'STALE_RESPONSE') {
          const stale = this.planRecoveryForLastStep('STALE_PERCEPTION');
          if (stale && !stale.exhausted) {
            //
            // STALE_PERCEPTION's strategy is RE_PERCEIVE, and it is performed
            // HERE rather than deferred: a proposal computed against a page that
            // has since moved must never be carried into the next decision, and
            // the next cycle's perception is the only thing that can fix it. If
            // the fresh perception is unavailable there is nothing truthful to
            // do but say so.
            const fresh = await this.callbacks.perceivePage();
            // Normalised through exactly the same path the next cycle uses, so
            // "a fresh perception is available" means the same thing in both
            // places and cannot disagree with itself.
            if (fresh && this.normalizePerceptionResult(fresh)) {
              this.state.reason = 'Observation was superseded; a fresh perception was taken.';
              this.pendingStaleReason =
                'Provider response was stale and the page could not be re-perceived.';
              this.notifyProgress();
              continue;
            }
            this.state.status = 'FAILED';
            this.state.goalStatus = 'FAILED';
            this.state.reason =
              'Provider response was stale and the page could not be re-perceived.';
            this.notifyProgress();
            console.info('[AgentTrace] M6 failed', { reason: this.state.reason });
            break;
          }
        }

        //
        // PHASE 18.7 / A8 — A PROVIDER FAILURE IS ITS OWN TRUTHFUL STATE.
        //
        // It used to end as `FAILED` with "Agent reasoning failed: …", which
        // reads as a browser or goal failure. It is neither: the browser was
        // never asked to do anything, and nothing about the page was decided.
        // Reporting it as `PROVIDER_UNAVAILABLE` is what makes a rate limit, a
        // timeout, a malformed HTTP 200 and a schema violation all
        // distinguishable from "the agent tried and could not".
        //
        // It can never be SUCCESS: `goalStatus` is left untouched, so only the
        // GoalVerifier may still report it, and it never ran.
        if (err instanceof ProviderError) {
          const first = this.planRecoveryForLastStep('PROVIDER_UNAVAILABLE');
          const category = err.category;
          //
          // The bounded retry for a provider failure is the IN-STEP budget in
          // `requestStepFromProvider`, and it has already been spent by the time
          // control returns here. Issuing another cycle would spend a SECOND
          // budget for the same failure — which is exactly what the M7 guarantee
          // ("a rate limit costs exactly ONE request") forbids. So the cycle
          // always ends, and the second plan() records that decision honestly.
          const terminal = first?.exhausted ? first : this.planRecoveryForLastStep('PROVIDER_UNAVAILABLE');
          this.state.status = terminalStateForProviderFailure(category);
          this.state.reason = userFacingMessageForStatus(this.state.status);
          this.notifyProgress();
          console.warn('[AgentTrace] reasoning provider unavailable', {
            category,
            attempts: this.state.providerAttempts,
            retryCount: terminal?.record.retryCount,
            reasonCode: terminal?.record.reasonCode,
          });
          break;
        }

        this.state.status = 'FAILED';
        this.state.goalStatus = 'FAILED';
        this.state.reason = `Agent reasoning failed: ${msg}`;
        this.notifyProgress();
        console.info('[AgentTrace] M6 failed', { reason: this.state.reason });
        break;
      }

      // =========================================================================
      // AUTHORITATIVE FAIL-CLOSED SECURITY ACTION PIPELINE (Stage 5)
      // Reasoner -> Proposed Action -> Target Grounding -> M5 Validator ->
      // Privacy Policy -> Risk Assessment -> Confirmation if required -> Browser Execution
      // =========================================================================

      // GATE 1: Target Grounding (Authoritative local gatekeeper for target element)
      const grounding = groundProposedTarget(action, context.detections, {
        currentPageGeneration: this.state.currentPageGeneration ?? 0,
        actionPageGeneration:
          (action as any).pageGeneration ??
          (action as any).actionPageGeneration ??
          this.state.currentPageGeneration ??
          0,
        currentOrigin,
      });

      if (!grounding.grounded) {
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
            failureType: 'GROUNDING_FAILURE',
            contextCategory: (this.state.pageType as any) || 'unknown',
            recoveryAttempted: 'NONE',
            recoveryResult: 'FAILURE',
          });
        } catch (e) {}

        const failReason = `Target Grounding Failed (${grounding.failureReason || 'ELEMENT_NOT_FOUND'}): ${grounding.details}`;
        this.recordStep(action, false, failReason, false, failReason);
        // PHASE 18.7 / A7. Grounding is a GATE: nothing executed. Recovery must
        // not retry the same prohibited proposal — its POLICY_BLOCKED budget is
        // 1, after which the strategy chain terminates truthfully.
        this.planRecoveryForLastStep('POLICY_BLOCKED');
        this.recordDecisionStep(tracer, {
          step: this.state.currentStep,
          goal: task,
          proposedAction: action,
          riskAssessment: { riskLevel: 'LOW', score: 0, requiresConfirmation: false },
          structuralValidation: { passed: false, reason: failReason },
          semanticVerification: { verified: false, confidence: 0, alignment: 'UNKNOWN', reason: failReason },
          confidenceEvaluation: { confidenceScore: 0, directive: 'BLOCK', explanation: failReason },
          finalOutcome: 'FAILED',
        });
        this.state.decisionTraceSummary = tracer.getSummary();
        this.notifyProgress();

        if (this.state.retryCount > this.maxRetries) {
          this.state.status = 'FAILED';
          this.state.goalStatus = 'FAILED';
          this.state.reason = failReason;
          console.info('[AgentTrace] Target grounding failed repeatedly', { reason: this.state.reason });
          break;
        }
        await this.delay(this.delayBetweenStepsMs);
        continue;
      }

      // Grounding successful: update action target if resolved
      if (grounding.targetId && 'target' in action) {
        (action as any).target = grounding.targetId;
      }

      // Plan State Machine: Register Grounding
      if (this.planStateMachine && this.planStateMachine.getState() === 'TARGET_GROUNDING') {
        if ('target' in action && typeof (action as any).target === 'string') {
          this.planStateMachine.registerTargetGrounded((action as any).target, action);
        } else {
          this.planStateMachine.registerNonTargetedAction(action);
        }
        this.state.planningEngineState = this.planStateMachine.getState();
      }

      // GATE 2: M5 Validator (Authoritative Gatekeeper)
      let validation = validateAction(action, context);
      let healingResult: SelfHealingResult | undefined;

      if (!validation.allowed && 'target' in action && typeof (action as any).target === 'string') {
        // Attempt target self-healing for stale or mutated targets
        const staleTargetId = (action as any).target;
        // PHASE 17.9 D-02. Pass the task goal so goal-alignment recovery is
        // actually reachable. `this.state.taskGoal` is set to the runTask goal at
        // the top of this method, so this is the intended goal and nothing else.
        // Recovery still only PROPOSES: the healed target below is re-grounded
        // and re-validated by GATE 1 and M5 before anything else can happen.
        healingResult = recoverStaleTarget(staleTargetId, action, context, this.state.taskGoal);
        if (healingResult.recovered && healingResult.recoveredAction) {
          // A healed target is UNTRUSTED until it passes the SAME gates as any
          // other proposal: Target Grounding (generation + origin) then M5.
          const healedGrounding = groundProposedTarget(healingResult.recoveredAction, context.detections, {
            currentPageGeneration: this.state.currentPageGeneration ?? 0,
            actionPageGeneration: this.state.currentPageGeneration ?? 0,
            currentOrigin,
          });
          const healedVal: ReturnType<typeof validateAction> = healedGrounding.grounded
            ? validateAction(healingResult.recoveredAction, context)
            : { allowed: false, reason: `Healed target rejected by Target Grounding: ${healedGrounding.details}` };
          if (healedVal.allowed) {
            action = healingResult.recoveredAction;
            validation = healedVal;
            console.info('[AgentTrace] self-healed target passed grounding + M5', {
              originalTarget: healingResult.originalTargetId,
              healedTarget: healingResult.recoveredTargetId,
            });
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
          undefined,
          undefined,
          undefined,
          healingResult
        );
        this.recordDecisionStep(tracer, {
          step: this.state.currentStep,
          goal: task,
          proposedAction: action,
          riskAssessment: {
            riskLevel: 'LOW',
            score: 0,
            requiresConfirmation: false,
          },
          structuralValidation: {
            passed: false,
            reason: validation.reason,
          },
          semanticVerification: {
            verified: false,
            confidence: 0,
            alignment: 'UNKNOWN',
            reason: validation.reason || 'Validator rejected action',
          },
          confidenceEvaluation: {
            confidenceScore: 0,
            directive: 'BLOCK',
            explanation: validation.reason,
          },
          finalOutcome: 'FAILED',
        });
        this.state.decisionTraceSummary = tracer.getSummary();
        this.notifyProgress();

        // PHASE 18.7 / A7. M5 is the authoritative structural gate; a refusal is
        // recorded as POLICY_BLOCKED with a budget of 1, so the identical
        // proposal cannot be retried blindly.
        this.planRecoveryForLastStep('POLICY_BLOCKED');

        if (this.state.retryCount > this.maxRetries) {
          this.state.status = 'FAILED';
          this.state.goalStatus = 'FAILED';
          this.state.reason = `Validator rejected action repeatedly: ${validation.reason}`;
          console.info('[AgentTrace] M5 failed', { reason: this.state.reason });
          break;
        }
        // Wait and retry with next perception
        await this.delay(this.delayBetweenStepsMs);
        continue;
      }
      console.info('[AgentTrace] action validated by M5');

      // GATE 2.5: SECURITY CRITIC (Phase 8)
      // An independent, deterministic, LOCAL review of the proposed action.
      // It runs AFTER M5 and BEFORE the privacy/risk gates, and it can only
      // tighten the pipeline: BLOCK stops the action here, REVIEW only
      // annotates and lets the existing authoritative gates decide, and ALLOW
      // means "no objection" — never permission. M5, privacy policy, risk
      // assessment, user confirmation, grounding and goal verification all keep
      // their existing authority and are unaffected by this review.
      const critic: SecurityCriticResult = reviewProposedAction({
        action,
        task,
        context,
        subgoal: activeSubgoal
          ? { id: activeSubgoal.id, description: activeSubgoal.description, category: activeSubgoal.category }
          : undefined,
        history: this.state.previousActions,
        currentUrl: this.state.currentUrl,
      });
      this.state.lastSecurityCritic = critic;
      console.info('[AgentTrace] security critic', {
        verdict: critic.verdict,
        code: critic.code,
        findings: critic.findings,
      });

      if (critic.verdict === 'BLOCK') {
        // Fail closed: the action never reaches the privacy, risk, confirmation
        // or execution stages. Bounded exactly like the other gates.
        this.state.retryCount++;
        this.provider.registerFailure?.();
        try {
          await FailureMemoryManager.write({
            id: `fail-critic-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            class: 'FAILURE',
            scope: siteScope,
            trustLevel: MemoryTrustLevel.HIGH_CONFIDENCE_MEMORY,
            provenance: { source: 'ACTION_RESULT', timestamp: Date.now(), subgoalId: activeSubgoal?.id, actionType: action.action },
            confidence: 1.0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            failureType: 'POLICY_REJECTION',
            contextCategory: (this.state.pageType as any) || 'unknown',
            recoveryAttempted: 'NONE',
            recoveryResult: 'FAILURE',
          });
        } catch (e) {}

        const criticReason = `Security Critic BLOCKED (${critic.code}): ${critic.reason}`;
        this.recordStep(action, false, criticReason, false, criticReason);
        // PHASE 18.7 / A7. The Security Critic's refusal is authoritative and is
        // recorded as such. Recovery gets a bounded strategy class; it cannot
        // override, defer or re-run the critic.
        this.planRecoveryForLastStep('POLICY_BLOCKED');
        this.recordDecisionStep(tracer, {
          step: this.state.currentStep,
          goal: task,
          proposedAction: action,
          riskAssessment: { riskLevel: 'LOW', score: 0, requiresConfirmation: false },
          structuralValidation: { passed: true, reason: validation.reason },
          semanticVerification: { verified: false, confidence: 0, alignment: 'UNKNOWN', reason: critic.reason },
          confidenceEvaluation: { confidenceScore: 0, directive: 'BLOCK', explanation: critic.reason },
          finalOutcome: 'BLOCKED',
        });
        this.state.decisionTraceSummary = tracer.getSummary();
        this.notifyProgress();

        if (this.state.retryCount > this.maxRetries) {
          this.state.status = 'FAILED';
          this.state.goalStatus = 'FAILED';
          this.state.reason = `Security critic blocked actions repeatedly: ${criticReason}`;
          console.info('[AgentTrace] M6 failed', { reason: this.state.reason });
          break;
        }
        await this.delay(this.delayBetweenStepsMs);
        continue;
      }

      // GATE 3: Privacy Policy (Capability-based access control)
      const targetDet = 'target' in action ? context.detections.find((d) => d.id === (action as any).target) : undefined;
      const policy = canPerformAction(action, targetDet, 'agent_llm');
      if (!policy.granted) {
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
            recoveryAttempted: 'NONE',
            recoveryResult: 'FAILURE',
          });
        } catch (e) {}

        const policyReason = `Privacy Policy Denied: ${policy.reason}`;
        this.recordStep(
          action,
          false,
          policyReason,
          false,
          policy.reason,
          targetDet?.type
        );
        this.recordDecisionStep(tracer, {
          step: this.state.currentStep,
          goal: task,
          proposedAction: action,
          riskAssessment: {
            riskLevel: 'HIGH',
            score: 0.8,
            requiresConfirmation: false,
          },
          structuralValidation: {
            passed: true,
            reason: 'Passed M5 validation',
          },
          semanticVerification: {
            verified: false,
            confidence: 0,
            alignment: 'CONTRADICTORY',
            reason: policyReason,
          },
          confidenceEvaluation: {
            confidenceScore: 0,
            directive: 'BLOCK',
            explanation: policyReason,
          },
          finalOutcome: 'FAILED',
        });
        this.state.decisionTraceSummary = tracer.getSummary();
        this.notifyProgress();

        if (this.state.retryCount > this.maxRetries) {
          this.state.status = 'FAILED';
          this.state.goalStatus = 'FAILED';
          this.state.reason = `Privacy policy rejected action repeatedly: ${policy.reason}`;
          console.info('[AgentTrace] Privacy policy rejected action', { reason: this.state.reason });
          break;
        }
        await this.delay(this.delayBetweenStepsMs);
        continue;
      }
      console.info('[AgentTrace] action passed privacy policy');

      // GATE 4: Risk Assessment & Semantic Verification
      const risk = assessActionRisk(action, context, this.state.currentUrl);
      const semantic = verifySemanticAction(action, task, context, risk);
      const previousSuccessCount = this.state.steps.filter((s) => s.executionSuccess).length;
      const confidence = evaluateExecutionConfidence(semantic, risk, previousSuccessCount);

      if (this.planStateMachine && this.planStateMachine.getState() === 'RISK_POLICY_CHECK') {
        this.planStateMachine.registerRiskAssessment(risk);
        this.state.planningEngineState = this.planStateMachine.getState();
      }

      // Deterministic Block: Risk engine disallowed, confidence BLOCK, or contradiction
      if (!risk.allowed || confidence.directive === 'BLOCK' || semantic.targetAlignment === 'CONTRADICTORY') {
        const blockReason = !risk.allowed
          ? (risk.rationale || 'Action blocked by risk engine: critical risk or unauthorized navigation protocol.')
          : (confidence.explanation || semantic.reason || 'Action blocked by security verification.');
        this.recordStep(
          action,
          false,
          'Security Verification Blocked',
          false,
          blockReason,
          targetDet?.type,
          risk,
          semantic,
          confidence
        );
        this.recordDecisionStep(tracer, {
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
            reason: 'Confidence / Semantic Verification / Risk Blocked',
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
        this.state.goalStatus = 'FAILED';
        this.state.reason = blockReason;
        this.notifyProgress();
        console.info('[AgentTrace] M6 blocked by security verifier', { reason: this.state.reason });
        break;
      }

      // Safety Review (Model-based optional hook)
      if (this.provider.reviewAction) {
        console.info('[AgentTrace] requesting safety review');
        const review = await this.provider.reviewAction(action, task, context);
        if (!review.safe) {
          this.state.retryCount++;
          this.recordStep(action, false, `SAFETY Rejected: ${review.reason}`, false, review.reason, targetDet?.type, risk, semantic, confidence);
          // PHASE 18.7 / A7. A SAFETY refusal is a gate refusal, not a browser
          // failure. Recovery is bounded and cannot propose the same action.
          this.planRecoveryForLastStep('POLICY_BLOCKED');
          this.notifyProgress();
          if (this.state.retryCount > this.maxRetries) {
            this.state.status = 'FAILED';
            this.state.goalStatus = 'FAILED';
            this.state.reason = `Safety model rejected action repeatedly: ${review.reason}`;
            break;
          }
          await this.delay(this.delayBetweenStepsMs);
          continue;
        }
        console.info('[AgentTrace] action passed safety review');
      }

      // GATE 5: Confirmation Check (High-risk, consequential, or sensitive operations)
      const isHighRisk = risk.level === 'HIGH' || risk.level === 'CRITICAL';
      const requiresConfirmation =
        this.isConsequentialAction(action, this.state.currentUrl) ||
        risk.requiresUserConfirmation ||
        isHighRisk ||
        confidence.directive === 'REQUIRE_CONFIRMATION';

      if (requiresConfirmation) {
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
        this.recordDecisionStep(tracer, {
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
      // 5. Pre-Action Snapshot for Effect Verification
      //
      // OBSERVED, never synthesized. The `actionTarget` is what lets the host
      // report that element's current value LENGTH (never the value).
      //
      // PHASE 17.1 (audit finding F1). This used to fall back to a fabricated
      // object whenever the host could not observe:
      //
      //   scrollX: 0, scrollY: 0,                        <- placeholders
      //   domElementCount: context.totalElementsScanned  <- a SCAN count
      //   targetValueLength: detection.length             <- a LABEL length
      //   activeElementSelector: detection.selector       <- a guess
      //
      // and then compared that fiction against a REAL post-action reading, so a
      // page that scrolled 500px from a fabricated baseline of 0 was reported
      // as SCROLL_CHANGED. That is exactly the "unobservable != zero" failure
      // the Phase 16 remediation established, reintroduced on the pre side.
      //
      // There is no fallback. If the pre-state cannot be read it is null, and
      // the effect of this action is unverifiable - a claim the loop can make
      // honestly.
      const actionTarget =
        'target' in action && typeof (action as any).target === 'string'
          ? ((action as any).target as string)
          : undefined;
      const preSnapshot: PreActionSnapshot | null =
        await this.observeEffectSnapshot(actionTarget, 'pre');

      // 5.5 PHASE 12 CONTAINMENT — final ENVIRONMENTAL check, immediately
      // before dispatch and AFTER every security gate has already run.
      //
      // This deliberately sits at the dispatch boundary and nowhere else. It
      // does not authorize anything: Grounding, M5, the Security Critic, the
      // Privacy Firewall and Risk/Confirmation have all already approved this
      // action by this point. Containment can only ever REFUSE MORE. It bounds
      // WHERE the agent acts (the origin scope of the resolved target), not
      // WHETHER the action is well-formed or safe.
      //
      // A containment denial is TERMINAL: retrying the same environment is the
      // blast radius this phase exists to remove, so the task fails closed here
      // instead of handing a refused action to the Recovery Engine.
      //
      // The scope is owned by the HOST that owns the tab. The service worker
      // (the real browser host) always establishes one and refuses to start a
      // task when it cannot — so the product path is fail-closed. A host that
      // drives the loop without a tab of its own (an in-process harness, a
      // non-browser embedding) has no environment to contain, so no scope is
      // configured and no environmental boundary is claimed.
      if (this.containmentScope) {
        const containment = evaluateContainment({
          action,
          scope: this.containmentScope,
          targetTabId: this.targetTabId,
          // PHASE 17.1: preSnapshot may be null when the effect-observation
          // channel could not read the page. The fallback is the PERCEPTION
          // url - a real observation from a different channel - never a
          // placeholder. Semantics are identical to the pre-17.1 fabricated
          // branch, which used this same value.
          liveUrl: preSnapshot?.url || context.url || this.state.currentUrl || null,
        });
        this.state.containmentDecision = {
          code: containment.code,
          contained: containment.contained,
          reason: containment.reason,
          scope: containmentSummary(this.containmentScope),
        };
        console.info('[AgentTrace] containment decision', {
          code: containment.code,
          contained: containment.contained,
          scope: containmentSummary(this.containmentScope),
        });

        if (!containment.contained) {
          const denialRecord: FailureRecord = {
            category: 'CONTAINMENT_DENIED',
            reason: `Containment refused the action: ${containment.reason}`,
            pageGeneration: this.state.currentPageGeneration,
            attemptedAction: action,
            recoveryAttempted: false,
            finalState: 'FAILED',
            timestamp: Date.now(),
          };
          if (!this.state.failureHistory) this.state.failureHistory = [];
          this.state.failureHistory.push(denialRecord);
          this.state.lastFailure = denialRecord;
          this.state.lastAction = action;
          this.state.lastActionResult = { success: false, error: denialRecord.reason };
          this.state.retryCount++;
          this.state.failureCount++;
          this.state.status = 'FAILED';
          this.state.goalStatus = 'FAILED';
          this.state.reason = denialRecord.reason;
          console.warn('[AgentTrace] ACTION_EXECUTED_BLOCKED_BY_CONTAINMENT', {
            code: containment.code,
            actionType: action.action,
          });
          this.notifyProgress();
          break;
        }
      } else {
        // No scope is not an open sandbox claim; it is simply no configured
        // environment. Recorded so the absence is visible in task state.
        this.state.containmentDecision = null;
      }

      if (this.isStopped) break;
      // 6. Execute
      this.provider.resetEscalation?.();
      let execResult = await this.callbacks.executeAction(action);
      if (this.isStopped) break;
      console.info('[AgentTrace] executeAction response received');
      this.state.lastAction = action;
      this.state.lastActionResult = { success: execResult.success, error: execResult.error };

      if (this.planStateMachine && this.planStateMachine.getState() === 'CHROME_EXECUTION') {
        this.planStateMachine.registerExecutionResult(execResult.success, 'PRIVAGENT_ACTION', execResult.error);
        this.state.planningEngineState = this.planStateMachine.getState();
      }

      if (!execResult.success && 'target' in action && typeof (action as any).target === 'string' && !healingResult?.recovered) {
        // SECURITY INVARIANT (Stage 6): self-healing may only PROPOSE an alternative
        // target. The recovered action is NEVER dispatched directly from this branch.
        // It must re-enter the loop and pass the complete Stage 5 pipeline again:
        //   Target Grounding -> M5 Validator -> Privacy Policy -> Risk/Semantic ->
        //   User Confirmation -> Browser Execution.
        //
        // PHASE 17.9 D-02. Pass the task goal here too, so a target that fails
        // after execution gets the same goal-alignment recovery as one that
        // fails before it. The SECURITY INVARIANT above is unchanged: this
        // branch records a proposal and never dispatches it.
        healingResult = recoverStaleTarget((action as any).target, action, context, this.state.taskGoal);
        if (healingResult.recovered) {
          console.info('[AgentTrace] self-healing proposal recorded (not dispatched)', {
            originalTarget: healingResult.originalTargetId,
            proposedTarget: healingResult.recoveredTargetId,
            strategy: healingResult.strategy,
            confidence: healingResult.confidence,
            nextStep: 'RE_ENTER_SECURITY_PIPELINE',
          });
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
        this.recordDecisionStep(tracer, {
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

      // 7. Authoritative Effect Verification
      let postSnapshot: PostActionSnapshot | undefined = (execResult as any).postSnapshot;
      if (!postSnapshot && this.callbacks.getEffectSnapshot) {
        postSnapshot = (await this.observeEffectSnapshot(actionTarget, 'post')) ?? undefined;
        if (!postSnapshot || !preSnapshot) {
          // The host HAS an observation channel but could not observe. Do NOT
          // fall back to deriving the post-state from the requested action: that
          // is exactly what made a no-op action indistinguishable from a real
          // one. An effect that cannot be observed is not a verified effect.
          //
          // FAIL CLOSED, bounded exactly like any other post-dispatch failure.
          console.warn('[AgentTrace] browser state could not be observed on both sides of the action; failing closed');
          const unobservableRecord: FailureRecord = {
            category: 'ACTION_NO_EFFECT',
            reason: `${preSnapshot ? 'Post-action' : 'Pre-action'} browser state could not be observed for '${action.action}'; effect treated as unverified.`,
            pageGeneration: this.state.currentPageGeneration,
            attemptedAction: action,
            recoveryAttempted: false,
            finalState: 'IN_PROGRESS',
            timestamp: Date.now(),
          };
          if (!this.state.failureHistory) this.state.failureHistory = [];
          this.state.failureHistory.push(unobservableRecord);
          this.state.lastFailure = unobservableRecord;
          this.state.lastActionResult = {
            success: false,
            error: `EFFECT_UNVERIFIABLE: ${preSnapshot ? 'post-action' : 'pre-action'} browser state could not be observed.`,
          };
          this.state.retryCount++;
          this.state.failureCount++;
          this.recordStep(
            action, true, validation.reason, false, unobservableRecord.reason,
            targetDet?.type, risk, semantic, confidence, healingResult,
            false, 'ACTION_NO_EFFECT', unobservableRecord.reason
          );
          this.recordDecisionStep(tracer, {
            step: this.state.currentStep,
            goal: task,
            proposedAction: action,
            riskAssessment: {
              riskLevel: risk.level,
              score: risk.score,
              requiresConfirmation: risk.requiresUserConfirmation,
            },
            structuralValidation: { passed: true, reason: validation.reason },
            semanticVerification: {
              verified: semantic.verified,
              confidence: semantic.confidence,
              alignment: semantic.targetAlignment,
              reason: unobservableRecord.reason,
            },
            confidenceEvaluation: {
              confidenceScore: confidence.confidenceScore,
              directive: confidence.directive,
              explanation: unobservableRecord.reason,
            },
            executionResult: { success: false, error: unobservableRecord.reason },
            finalOutcome: 'FAILED',
          });
          this.state.decisionTraceSummary = tracer.getSummary();
          this.notifyProgress();
          //
          // PHASE 18.8 / A10-F2. Same rule as the sibling path below: an
          // unreadable effect is bounded by the TYPED budget of one fresh
          // perception, never by `maxRetries`, and it never re-dispatches.
          const bothSidesRecovery = this.planRecoveryForLastStep('EFFECT_UNVERIFIABLE');
          if (bothSidesRecovery?.exhausted) {
            unobservableRecord.finalState = 'FAILED';
            this.state.status = 'FAILED';
            this.state.goalStatus = 'FAILED';
            this.state.reason =
              "I couldn't verify whether the action took effect, so I stopped without repeating it.";
            console.info('[AgentTrace] M6 failed', {
              reason: this.state.reason,
              recoveryCategory: 'EFFECT_UNVERIFIABLE',
            });
            break;
          }
          await this.delay(this.delayBetweenStepsMs);
          continue;
        }
      }
      //
      // PHASE 17.1 (audit finding C3). Everything below used to exist:
      //
      //   navigate -> post.url          = action.url             <- URL ASKED FOR
      //   scroll   -> post.scrollY     += action.amount          <- delta ASKED FOR
      //   type     -> post.valueLength  = action.text.length     <- REQUESTED text
      //   click    -> post.domElementCount += 1                  <- fabricated DOM
      //
      // That is the agent's own plan restated as if the browser had performed
      // it, which made an action that changed nothing indistinguishable from
      // one that did. It is deleted.
      //
      // The ONLY thing carried through is a host that explicitly declared the
      // action inert, and only when the pre-state was genuinely observed. Even
      // then it is a claim by the host, not a reading, and it can only ever
      // produce ACTION_NO_EFFECT - never a positive effect.
      if (!postSnapshot && preSnapshot) {
        const isNoEffectDeclared = (execResult as any).noEffect === true || (execResult as any).inert === true;
        if (isNoEffectDeclared) {
          postSnapshot = { ...preSnapshot, timestamp: Date.now() };
        }
      }

      // Fail closed on whichever side is missing, reusing the refusal path
      // above. There is no third outcome and no synthesized state.
      if (!preSnapshot || !postSnapshot) {
        const missing = !preSnapshot ? 'Pre-action' : 'Post-action';
        const unobservableRecord: FailureRecord = {
          category: 'ACTION_NO_EFFECT',
          reason: `${missing} browser state could not be observed for '${action.action}'; effect treated as unverified.`,
          pageGeneration: this.state.currentPageGeneration,
          attemptedAction: action,
          recoveryAttempted: false,
          finalState: 'IN_PROGRESS',
          timestamp: Date.now(),
        };
        if (!this.state.failureHistory) this.state.failureHistory = [];
        this.state.failureHistory.push(unobservableRecord);
        this.state.lastFailure = unobservableRecord;
        this.state.lastActionResult = {
          success: false,
          error: `EFFECT_UNVERIFIABLE: ${missing.toLowerCase()} browser state could not be observed.`,
        };
        this.state.retryCount++;
        this.state.failureCount++;
        this.recordStep(
          action, true, validation.reason, false, unobservableRecord.reason,
          targetDet?.type, risk, semantic, confidence, healingResult,
          false, 'EFFECT_UNVERIFIABLE', unobservableRecord.reason
        );
        this.state.decisionTraceSummary = tracer.getSummary();
        this.notifyProgress();
        //
        // PHASE 18.8 / A10-F2. An UNOBSERVABLE effect is not a retryable one.
        //
        // This used to be bounded by `retryCount > maxRetries`, which is a
        // blind repeat: it re-enters the loop and may re-dispatch the SAME
        // action. For a navigation that is merely wasteful; for any future
        // side-effecting action it is a duplicate of something whose effect we
        // already cannot establish. "I don't know whether it worked" must never
        // mean "do it again".
        //
        // The typed planner expresses that directly: EFFECT_UNVERIFIABLE has a
        // budget of ONE and a chain of exactly [RE_PERCEIVE], so the single
        // allowed retry takes a FRESH observation, and a second unobservable
        // effect terminates truthfully instead of dispatching anything.
        //
        const unobservableRecovery = this.planRecoveryForLastStep('EFFECT_UNVERIFIABLE');
        if (unobservableRecovery?.exhausted) {
          unobservableRecord.finalState = 'FAILED';
          this.state.status = 'FAILED';
          this.state.goalStatus = 'FAILED';
          // A user-facing sentence, not the device's internal explanation. The
          // typed reason code carries the detail for the audit trail.
          this.state.reason =
            "I couldn't verify whether the action took effect, so I stopped without repeating it.";
          console.info('[AgentTrace] M6 failed', {
            reason: this.state.reason,
            recoveryCategory: 'EFFECT_UNVERIFIABLE',
          });
          break;
        }
        await this.delay(this.delayBetweenStepsMs);
        continue;
      }

      const effectResult: ActionEffectResult = (execResult as any).effect ?? verifyActionEffect(action, preSnapshot, postSnapshot);

      if (this.planStateMachine && this.planStateMachine.getState() === 'EFFECT_VERIFICATION') {
        this.planStateMachine.registerEffectVerification(effectResult.hasEffect, effectResult.details);
        this.state.planningEngineState = this.planStateMachine.getState();
      }

      if (!effectResult.hasEffect) {
        console.warn('[AgentTrace] ACTION_EXECUTED + ACTION_NO_EFFECT', {
          status: effectResult.status,
          details: effectResult.details,
        });

        //
        // POST-17.10 Step 10 — ALREADY-AT-DESTINATION.
        //
        // `ACTION_NO_EFFECT` means the ACTION changed nothing. It is not a
        // claim about whether the task's destination is already satisfied, and
        // it is certainly not a success.
        //
        // The Step 9 real run hit exactly this: the target resolver had already
        // provisioned the destination URL, the deterministic navigator then
        // navigated to that same URL, no transition occurred, and the run was
        // failed into recovery — even though the browser was sitting on the
        // declared destination the whole time.
        //
        // So: when the active subgoal is a DESTINATION subgoal, take a FRESH
        // perception and ask the destination verifier. Only an observed MATCH
        // completes it, and the completion is credited to the observation, not
        // to the action. Any other verdict falls through to the unchanged
        // ACTION_NO_EFFECT failure and recovery path below.
        //
        // This does not weaken Effect Verification. Its verdict stays exactly
        // as reported, its failure record is still written when the destination
        // is NOT satisfied, and it can never itself complete a subgoal.
        if (activeSubgoal?.destination && this.subgoalGraph) {
          let freshContext: AgentContextPayload | undefined;
          try {
            const fresh = this.normalizePerceptionResult(await this.callbacks.perceivePage());
            if (fresh) {
              freshContext = fresh.context;
              if (fresh.worldModel) {
                this.state.currentPageGeneration = fresh.worldModel.page.pageGeneration;
              }
            }
          } catch (perceiveErr) {
            console.warn('[AgentTrace] already-at-destination re-perception failed', {
              reason: String(perceiveErr).slice(0, 160),
            });
          }

          if (freshContext) {
            const destinationCheck = GoalProgressTracker.verifySubgoalCondition(activeSubgoal, {
              context: freshContext,
              pageGeneration: this.state.currentPageGeneration ?? 0,
            });
            if (destinationCheck.satisfied) {
              console.info('[AgentTrace] destination already satisfied — no transition needed', {
                subgoalId: activeSubgoal.id,
                evidence: destinationCheck.reason,
              });
              this.subgoalGraph.completeSubgoal(activeSubgoal.id);
              this.state.subgoalGraphData = this.subgoalGraph.toData();
              // The no-effect verdict is recorded truthfully; the recovery
              // escalation is simply not warranted once the destination itself
              // is independently proven.
              this.state.lastActionResult = {
                success: false,
                error: 'ACTION_NO_EFFECT (destination already satisfied per verifier)',
              };
              continue;
            }
            console.info('[AgentTrace] no transition and destination NOT satisfied', {
              subgoalId: activeSubgoal.id,
              reason: destinationCheck.reason,
            });
          }
        }

        this.state.lastActionResult = { success: false, error: effectResult.details || 'ACTION_NO_EFFECT' };
        this.state.retryCount++;
        this.state.failureCount++;

        const recordedFailedAction: BrowserAction = {
          ...action,
          effect: effectResult.status,
          ...(effectResult.diagnostics?.scrollDelta !== undefined
            ? { scrollDelta: effectResult.diagnostics.scrollDelta }
            : {}),
        };
        // Failed actions are NOT recorded in state.previousActions (which holds only verified
        // successful actions per Phase 6 contract). Safe effect metadata is supplied to the
        // reasoner via historyForReasoner at requestActionWithBoundedRetry.
        this.state.recentActions.push(recordedFailedAction);

        const failureRecord: FailureRecord = {
          category: 'ACTION_NO_EFFECT',
          reason: effectResult.details || `Action '${action.action}' produced no observable effect.`,
          pageGeneration: this.state.currentPageGeneration,
          attemptedAction: action,
          recoveryAttempted: true,
          finalState: 'IN_PROGRESS',
          timestamp: Date.now(),
        };
        this.state.lastFailure = failureRecord;
        if (!this.state.failureHistory) this.state.failureHistory = [];
        this.state.failureHistory.push(failureRecord);

        try {
          await FailureMemoryManager.write({
            id: `fail-noeffect-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            class: 'FAILURE',
            scope: siteScope,
            trustLevel: MemoryTrustLevel.HIGH_CONFIDENCE_MEMORY,
            provenance: { source: 'ACTION_RESULT', timestamp: Date.now(), subgoalId: activeSubgoal?.id, actionType: action.action },
            confidence: 1.0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            failureType: 'NO_EFFECT',
            contextCategory: (this.state.pageType as any) || 'unknown',
            recoveryAttempted: 'DYNAMIC_REPLANNING',
            recoveryResult: 'FAILURE',
          });
        } catch (e) {}

        if (activeSubgoal && this.subgoalGraph) {
          this.subgoalGraph.failSubgoal(activeSubgoal.id, effectResult.details);
          this.state.subgoalGraphData = this.subgoalGraph.toData();
        }

        this.recordStep(
          action,
          true,
          validation.reason,
          false,
          effectResult.details,
          targetDet?.type,
          risk,
          semantic,
          confidence,
          healingResult,
          false,
          effectResult.status,
          effectResult.details
        );

        //
        // PHASE 18.7 / A7 — TRUTHFUL TYPED RECOVERY FOR A NO-EFFECT STEP.
        //
        // The category is DERIVED, never asserted by the caller: the
        // EffectVerifier's own verdict when it could not establish an effect at
        // all (EFFECT_UNVERIFIABLE), then OSCILLATION when the I-8
        // semantic-progress authority has detected an alternating run,
        // otherwise NO_EFFECT. `madeProgress` inside the record comes from
        // `assessProgress`, so it can never be confused with the fact that this
        // action did dispatch.
        const noEffectRecovery = this.planRecoveryForLastStep(
          effectResult.status === 'EFFECT_UNVERIFIABLE'
            ? 'EFFECT_UNVERIFIABLE'
            : this.longHorizon.semanticProgressVerdict().stagnation === 'OSCILLATION'
              ? 'OSCILLATION'
              : 'NO_EFFECT'
        );
        if (noEffectRecovery?.exhausted) {
          // Bounded recovery is spent for this category. Terminate TRUTHFULLY
          // rather than cycling: this is the path that stops "keep scrolling,
          // keep hoping" from running to the step ceiling. The failure record
          // keeps the repository's EXISTING vocabulary, so every existing
          // consumer of it reads this exactly as it reads the older paths.
          const record = this.lastRecoveryRecord();
          const exhaustedCategory = record?.failureCategory;
          const exhaustedRecord: FailureRecord = {
            category: 'RECOVERY_EXHAUSTED',
            reason: `Recovery limit exceeded for ${exhaustedCategory ?? 'NO_EFFECT'} after ${record?.retryCount ?? 0} bounded attempts.`,
            pageGeneration: this.state.currentPageGeneration,
            attemptedAction: action,
            recoveryAttempted: true,
            finalState: 'FAILED',
            timestamp: Date.now(),
          };
          this.state.lastFailure = exhaustedRecord;
          this.state.failureHistory.push(exhaustedRecord);
          this.state.status = 'FAILED';
          this.state.goalStatus = 'FAILED';
          // Same rule as the two unobservable-effect sites: the device's
          // internal explanation stays in the failure record for the audit
          // trail, while the user-facing reason carries the truthful sentence.
          // NO_EFFECT / OSCILLATION keep their existing vocabulary here.
          this.state.reason =
            exhaustedCategory === 'EFFECT_UNVERIFIABLE'
              ? "I couldn't verify whether the action took effect, so I stopped without repeating it."
              : exhaustedRecord.reason;
          this.notifyProgress();
          console.info('[AgentTrace] M6 failed', { reason: this.state.reason });
          break;
        }

        this.recordDecisionStep(tracer, {
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
            reason: semantic.reason || 'Effect verification failed',
          },
          confidenceEvaluation: {
            confidenceScore: confidence.confidenceScore,
            directive: confidence.directive,
            explanation: confidence.explanation,
          },
          executionResult: {
            success: false,
            error: effectResult.details,
          },
          finalOutcome: 'FAILED',
        });
        this.state.decisionTraceSummary = tracer.getSummary();
        this.notifyProgress();

        if (this.state.retryCount > this.maxRetries) {
          failureRecord.finalState = 'FAILED';
          const exhaustedRecord: FailureRecord = {
            category: 'RECOVERY_EXHAUSTED',
            reason: `Recovery limit exceeded (${this.maxRetries} retries). Action produced no observable effect: ${effectResult.details}`,
            pageGeneration: this.state.currentPageGeneration,
            attemptedAction: action,
            recoveryAttempted: true,
            finalState: 'FAILED',
            timestamp: Date.now(),
          };
          this.state.lastFailure = exhaustedRecord;
          this.state.failureHistory.push(exhaustedRecord);
          this.state.status = 'FAILED';
          this.state.goalStatus = 'FAILED';
          this.state.reason = exhaustedRecord.reason;
          console.info('[AgentTrace] M6 failed', { reason: this.state.reason });
          break;
        }

        // ── Phase 10: Recovery Engine classifies the failure and selects a
        // bounded strategy. The engine PROPOSES ONLY: it never executes. The
        // strategies map onto what the existing loop already does — REPERCEIVE
        // to the fresh-perception retry below, REPLAN_SUBGOAL to the
        // DynamicReplanner call, ABORT to the exhaustion failure. Any retry
        // re-enters the complete pipeline from the top of the loop: Grounding
        // → M5 → Security Critic → Privacy → Risk/Confirmation → Execution →
        // Effect/Goal verification.
        const recoveryDecision: RecoveryDecision = this.recoveryEngine.decide({
          code: effectResult.status,
          pageGeneration: this.state.currentPageGeneration,
          targetId: 'target' in action ? (action as any).target : undefined,
          subgoalId: activeSubgoal?.id,
          noEffect: true,
          scrollDirection: action.action === 'scroll' ? action.direction : undefined,
          scrollBoundaryReached: action.action === 'scroll' && effectResult.diagnostics?.scrollDelta === 0,
        });
        this.state.recoveryHistory = [...this.recoveryEngine.history];
        this.state.totalRecoveryAttempts = this.recoveryEngine.totalRecoveries;
        console.info('[AgentTrace] recovery decision', {
          code: recoveryDecision.code,
          strategy: recoveryDecision.strategy,
          attempt: recoveryDecision.attempt,
          reason: recoveryDecision.reason,
        });

        if (recoveryDecision.strategy === 'ABORT') {
          failureRecord.finalState = 'FAILED';
          const abortRecord: FailureRecord = {
            category: 'RECOVERY_EXHAUSTED',
            reason: `Recovery engine aborted: ${recoveryDecision.reason}`,
            pageGeneration: this.state.currentPageGeneration,
            attemptedAction: action,
            recoveryAttempted: true,
            finalState: 'FAILED',
            timestamp: Date.now(),
          };
          this.state.lastFailure = abortRecord;
          this.state.failureHistory.push(abortRecord);
          this.state.status = 'FAILED';
          this.state.goalStatus = 'FAILED';
          this.state.reason = abortRecord.reason;
          this.notifyProgress();
          console.info('[AgentTrace] M6 failed', { reason: this.state.reason });
          break;
        }

        // Bounded Recovery Trigger (Phase 6, strategy named by Phase 10):
        this.state.recoveryCount++;
        this.state.recoveryStrategy = recoveryDecision.strategy;
        //
        // Stale-target protection: the failed action's generation is invalidated
        // so its targets can never be reused. The generation counter is
        // deliberately NOT advanced here. It is anchored to the generation the
        // content script actually reported, and an increment with no matching
        // world-model build drifts it ahead of the page - which makes the next
        // FRESH world model look stale to normalizePerceptionResult.
        invalidatePageGenerationState(this.state);

        if (this.subgoalGraph && this.hierarchicalGoal) {
          DynamicReplanner.replan({
            graph: this.subgoalGraph,
            goal: this.hierarchicalGoal,
            failedSubgoal: activeSubgoal,
            trigger: 'ACTION_NO_EFFECT',
            triggerReason: effectResult.details,
            replanCount: this.state.recoveryCount,
          });
          this.state.subgoalGraphData = this.subgoalGraph.toData();
        }

        if (this.state.plan) {
          const diag = diagnoseFailureAndReplan(this.state.plan, action, effectResult.details, context);
          if (diag.canRecover) {
            this.state.plan.recoveryAttempts++;
          }
        }

        // Re-perceive the page before retry. REQUIRED by every non-abort
        // recovery strategy: a recovered action must never be grounded in a
        // stale page generation.
        console.info('[AgentTrace] re-perceiving page after no-effect (recovery: ' + recoveryDecision.strategy + ')');
        const freshPerception = await this.callbacks.perceivePage();
        if (freshPerception) {
          const normalized = this.normalizePerceptionResult(freshPerception);
          if (normalized) {
            context = normalized.context;
            worldModel = normalized.worldModel;
            semanticContext = normalized.semanticContext;
            //
            // Re-anchor the generation counter to the generation the fresh
            // perception actually OBSERVED, exactly as the perception cycle
            // does. This is what lets the recovered action ground against the
            // FRESH page (stale-target protection) and what keeps the next
            // perception cycle comparing like with like. Advancing it a second
            // time instead - with no further world-model build behind it - is
            // precisely what desynchronised the loop from the page.
            const observedGeneration = normalized.worldModel?.page?.pageGeneration;
            if (typeof observedGeneration === 'number' && observedGeneration > 0) {
              this.state.currentPageGeneration = observedGeneration;
              this.state.perceptionGeneration = observedGeneration;
            }
          }
        }

        await this.delay(this.delayBetweenStepsMs);
        continue;
      }

      // 8. Successful Action Execution + Verified Effect
      console.info('[AgentTrace] ACTION_EXECUTED + EFFECT_VERIFIED', {
        status: effectResult.status,
        details: effectResult.details,
      });
      this.state.lastActionResult = { success: true };
      this.state.retryCount = 0; // Reset retry count after success
      const recordedAction: BrowserAction = {
        ...action,
        effect: effectResult.status,
        ...(effectResult.diagnostics?.scrollDelta !== undefined
          ? { scrollDelta: effectResult.diagnostics.scrollDelta }
          : {}),
      };
      this.state.previousActions.push(recordedAction);
      this.state.recentActions.push(recordedAction);
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
      //
      // PHASE 17.6 (C). SUBGOAL COMPLETION MUST BE PROVEN FROM OBSERVATION.
      //
      // This was `if (execResult.success) completeSubgoal(...)`. `execResult`
      // is DISPATCH state — it reports that the callback returned without
      // throwing. It says the agent ASKED, not that the page reached the state
      // the subgoal describes. A one-pixel scroll satisfied an "add the item to
      // the cart" subgoal, and because `syncFromSubgoalGraph` then mirrors
      // COMPLETED into the long-horizon tracker, `isAlreadyCompleted` made the
      // loop SKIP that subgoal from then on — so the real work was never
      // attempted and the task burned its whole budget.
      //
      // Completion now requires `GoalProgressTracker.verifySubgoalCondition` to
      // answer yes from the OBSERVED sanitized context of this cycle. That
      // verifier fails closed: no declared condition, an unimplemented
      // condition type, an empty expected value, or a marker that is not in the
      // observed state all leave the subgoal IN_PROGRESS.
      //
      // SCOPE. This is planning bookkeeping, not authorization. The action has
      // already been authorized by Grounding, M5, the Security Critic,
      // Risk/Confirmation and Containment, and its effect has already been
      // observed by Effect Verification. Making the subgoal bar HIGHER can only
      // make the agent do more work, never less, and it can never authorize an
      // action or assert task success. Goal Verification still owns that.
      // The subgoal whose completion is PROVEN at the end of this cycle.
      //
      // This block is deliberately still keyed on `activeSubgoal` and still
      // gated on `execResult.success`, exactly as it was before G7 Repair 1.
      // The destination re-verification is NOT done here: it runs from the
      // fresh observation above, before any action is dispatched, so that
      // arrival is never decided by the effect of an action.
      if (execResult.success && activeSubgoal && this.subgoalGraph) {
        const subgoalVerification = GoalProgressTracker.verifySubgoalCondition(activeSubgoal, {
          context,
          previous: previousObservation,
          pageGeneration: this.state.currentPageGeneration ?? 0,
          userConfirmedActionIds: this.state.confirmedActionIds ?? [],
        });
        if (subgoalVerification.satisfied) {
          this.subgoalGraph.completeSubgoal(activeSubgoal.id);
          this.state.subgoalGraphData = this.subgoalGraph.toData();
          console.info('[AgentTrace] subgoal completed', {
            subgoalId: activeSubgoal.id,
            category: activeSubgoal.category,
            evidence: subgoalVerification.reason,
          });
        } else {
          // Not proven. The subgoal stays ACTIVE and remains eligible for
          // selection; the observed change is still real progress for the
          // long-horizon layer, which counts observation independently.
          console.info('[AgentTrace] subgoal NOT completed — no observed evidence', {
            subgoalId: activeSubgoal.id,
            category: activeSubgoal.category,
            reason: subgoalVerification.reason,
          });
          this.state.subgoalVerificationHistory = [
            ...(this.state.subgoalVerificationHistory ?? []),
            {
              subgoalId: activeSubgoal.id,
              step: this.state.currentStep,
              satisfied: false,
              reason: subgoalVerification.reason,
              timestamp: Date.now(),
            },
          ].slice(-64);
        }
      } else if (!execResult.success && activeSubgoal && this.subgoalGraph) {
        this.subgoalGraph.failSubgoal(activeSubgoal.id, execResult.error || 'Execution failed');
        this.state.subgoalGraphData = this.subgoalGraph.toData();
      }

      // Transition state machine to SUBGOAL_SELECTION for next iteration if not in terminal state
      if (this.planStateMachine && (this.planStateMachine.getState() === 'GOAL_VERIFICATION' || this.planStateMachine.getState() === 'DYNAMIC_REPLANNING')) {
        const allDone = this.subgoalGraph?.isAllCompleted() ?? false;
        //
        // PHASE 17.2A. `allDone` was OR'd in as an ALTERNATIVE to goal
        // verification. A subgoal is marked complete by
        // `subgoalGraph.completeSubgoal` on `execResult.success` - DISPATCH
        // state - so "every planned subgoal was dispatched" was enough to drive
        // the plan state machine to COMPLETED with the reason 'Goal verified
        // and satisfied'. No observation ever established that, and the claim
        // was published as `state.planningEngineState`. This is the
        // DISPATCH SUCCESS != GOAL SUCCESS invariant, in a second location the
        // goalVerifier audit did not reach.
        //
        // Only the goal verifier may assert goal satisfaction. Subgoal dispatch
        // completion is still recorded, as planning progress
        // (`allSubgoalsDone`), never as `goalSatisfied`.
        const goalVerified = this.isTaskGoalSatisfied(task, this.state, context);
        if (goalVerified) {
          this.planStateMachine.registerGoalVerification(true, true);
          this.state.planningEngineState = this.planStateMachine.getState();
        } else if (allDone) {
          this.planStateMachine.registerGoalVerification(false, true);
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
        healingResult,
        true,
        effectResult.status,
        effectResult.details
      );
      this.recordDecisionStep(tracer, {
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
          //
          // PHASE 17.2A. This used to pass `action.url`, which made
          // advancePageGeneration write the REQUESTED destination straight into
          // `state.currentUrl` - a field goal verification reads as the OBSERVED
          // tab URL (`context.url || state.currentUrl`). A navigation that was
          // dispatched and settled but never committed to that URL therefore
          // supplied goal evidence for a page the browser was never on.
          //
          // `onNavigationComplete` settling proves the injection/load handshake
          // completed - transport state, not the tab's location. The observed
          // URL is picked up from the next real perception cycle instead.
          advancePageGeneration(this.state);
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

    //
    // PHASE 17.4 D5. Every terminal outcome — SUCCESS, FAILED and STOPPED —
    // clears the reliability record. A finished task must not donate its
    // counters or its fingerprint ring to the next run, even if a runId were
    // somehow reused. The record is only ever meaningful for a task that is
    // still in progress.
    await clearTracker(this.longHorizonStore);

    if (this.isStopped) {
      this.state.status = 'STOPPED';
      this.state.goalStatus = 'STOPPED';
      this.state.reason = this.state.reason || 'Task stopped by user.';
    }

    if (this.state.status === 'SUCCESS') {
      console.info('[AgentTrace] M6 completed');
    } else if (this.state.status === 'FAILED') {
      console.info('[AgentTrace] M6 failed', { reason: this.state.reason });
    } else if (this.state.status === 'STOPPED') {
      console.info('[AgentTrace] M6 stopped', { reason: this.state.reason });
    }
    this.closeConversationTurn();
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

    //
    // ── PHASE 17.6 (H) · CONTAINMENT RE-EVALUATED BEFORE A CONFIRMED DISPATCH ──
    //
    // This path dispatched straight to `executeAction`. Every other dispatch in
    // the loop passes `evaluateContainment` immediately before execution — it
    // is the Phase 12 "final ENVIRONMENTAL check" and it is the ONLY place the
    // origin scope is enforced.
    //
    // The gap was a real window, not a formality. The action was gated when it
    // was PROPOSED; the user then had to answer a prompt, and in that time the
    // tab can move — the user clicks a link, the page redirects, or the service
    // worker is evicted and the loop restored. `containmentScope` was captured
    // in the constructor and never re-read. A `navigate` whose destination was
    // cross-origin-checked against the OLD current URL, or a `click` on a
    // target id from a document that has since been replaced, would dispatch
    // with no environmental check at all.
    //
    // Containment can only ever REFUSE MORE. It does not authorize: Grounding,
    // M5, the Security Critic, Risk/Confirmation and Goal Verification have
    // already run for this exact action, and re-running them here would change
    // behaviour. A denial is TERMINAL for the same reason it is inside the
    // loop: retrying into a refused environment is the drift containment
    // exists to stop.
    if (this.containmentScope) {
      const confirmedLiveUrl =
        (await this.observeEffectSnapshot(undefined, 'pre'))?.url ||
        this.state.currentUrl ||
        null;
      const confirmedContainment = evaluateContainment({
        action,
        scope: this.containmentScope,
        targetTabId: this.targetTabId,
        liveUrl: confirmedLiveUrl,
      });
      this.state.containmentDecision = {
        code: confirmedContainment.code,
        contained: confirmedContainment.contained,
        reason: confirmedContainment.reason,
        scope: containmentSummary(this.containmentScope),
      };
      console.info('[AgentTrace] containment decision (confirmed resume)', {
        code: confirmedContainment.code,
        contained: confirmedContainment.contained,
        scope: containmentSummary(this.containmentScope),
      });

      if (!confirmedContainment.contained) {
        const denialRecord: FailureRecord = {
          category: 'CONTAINMENT_DENIED',
          reason: `Containment refused the confirmed action: ${confirmedContainment.reason}`,
          pageGeneration: this.state.currentPageGeneration,
          attemptedAction: action,
          recoveryAttempted: false,
          finalState: 'FAILED',
          timestamp: Date.now(),
        };
        if (!this.state.failureHistory) this.state.failureHistory = [];
        this.state.failureHistory.push(denialRecord);
        this.state.lastFailure = denialRecord;
        this.state.lastActionResult = { success: false, error: denialRecord.reason };
        this.state.status = 'FAILED';
        this.state.goalStatus = 'FAILED';
        this.state.reason = denialRecord.reason;
        console.warn('[AgentTrace] CONFIRMED_ACTION_BLOCKED_BY_CONTAINMENT', {
          code: confirmedContainment.code,
          actionType: action.action,
        });
        this.notifyProgress();
        return this.getState();
      }
    }

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
      // Same projection as `recordStep`. A user-CONFIRMED action is still an
      // action, and confirmation is not a licence to retain its raw value.
      action: sanitizeRetainedAction(action),
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
    //
    // PHASE 17.6 (C). Record the CONFIRMED dispatch so a USER_CONFIRMED
    // subgoal can be proven from an action the user actually authorized and
    // that actually ran. The proposal that merely *asked* for confirmation is
    // never recorded here, so this list can never manufacture consent.
    this.state.confirmedActionIds = [
      ...(this.state.confirmedActionIds ?? []),
      `${action.action}:${'target' in action ? String((action as any).target ?? '') : (action as any).url ?? ''}`,
    ].slice(-64);
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
  /**
   * PHASE 17.5 (F3). Bind a provider proposal to the observation it was computed
   * from.
   *
   * A provider round trip is 500ms-55s. The page can navigate, the DOM can be
   * replaced and the target can disappear underneath it. Acting on such a
   * response is acting on a belief about a browser state that no longer exists.
   *
   * The identity is a digest of Phase 17.1 provenance only — page generation,
   * URL and the detection-ID set. It carries no page text and is never
   * persisted; it lives for one cycle.
   */
  private observationIdentityFor(context: AgentContextPayload): string {
    return observationIdentity({
      pageGeneration: this.state.currentPageGeneration ?? 0,
      url: context.url ?? '',
      detectionIds: (context.detections ?? []).map((d) => d.id),
    });
  }

  /**
   * PHASE 18.7 / A1 — compose the reported answer from LOCAL evidence only.
   *
   * The model's `answer` prose is deliberately NOT used. It was a claim, the
   * claim was checked, and the check is expressed by WHICH records survived it
   * — so the text the user sees is assembled from the surviving records
   * themselves. A model therefore cannot place a sentence in the answer that
   * the device never observed, and the reported answer can never outrun the
   * evidence that backs it.
   */
  private buildSupportedAnswer(verdict: ProposalVerdict): string | undefined {
    if (!this.evidenceLedger) return undefined;
    const claims: string[] = [];
    for (const id of verdict.supportedRecordIds) {
      const record = this.evidenceLedger.byIdSafe(id);
      if (!record) continue;
      // Only records that are still verified, current and sanitized may be
      // shown. Re-checking here means a record invalidated between the verdict
      // and the report is not printed.
      if (record.verificationStatus !== 'VERIFIED') continue;
      if (record.freshness !== 'CURRENT') continue;
      if (record.privacyStatus !== 'SANITIZED') continue;
      claims.push(record.claim);
    }
    if (claims.length === 0) return undefined;
    return truncateClaim(claims.join(' '), MAX_SUPPORTED_ANSWER_CHARS);
  }

  /**
   * PHASE 18.7 / A1 — ask the provider for one STEP.
   *
   * A provider that implements `requestStep` may answer with an action or an
   * inert terminal proposal. One that does not (mock, OpenRouter) goes through
   * the historical `requestAction` and can only ever produce an action, so
   * adding the proposal path changed nothing for them.
   */
  private async requestStepFromProvider(
    task: string,
    context: AgentContextPayload,
    history: BrowserAction[]
  ): Promise<ProviderStep> {
    const requestStep = this.provider.requestStep?.bind(this.provider);
    if (!requestStep) {
      return { kind: 'ACTION', action: await this.provider.requestAction(task, context, history) };
    }
    return requestStep(task, context, history);
  }

  private async requestActionWithBoundedRetry(
    task: string,
    context: AgentContextPayload
  ): Promise<BrowserAction> {
    //
    // PHASE 17.5 (F3). Capture the identity of the observation this request is
    // made FROM, before the round trip. Re-checked after the call returns.
    //
    const expectedIdentity = this.observationIdentityFor(context);

    let lastError: unknown;
    let attempt = 0;
    for (;;) {
      if (this.isStopped) {
        throw new ProviderError('Task stopped.', 'timeout', { retryable: false });
      }
      this.state.providerAttempts++;
      //
      // PHASE 18.5 (F1) — REASONING LIVENESS.
      //
      // THE DEFECT. `notifyProgress()` was never called anywhere between
      // entering reasoning and the provider resolving, so the dashboard's
      // watchdog was anchored to the LAST message emitted BEFORE the reasoner
      // was consulted. Nothing the loop did afterwards could re-arm it.
      //
      // The reasoning window is not one provider call. It is the WHOLE bounded
      // retry budget: up to `providerRetries + 1` attempts, each able to run to
      // the provider AbortController's 55s, separated by retry delays. With
      // `providerRetries: 2` that is up to ~165s of legitimate, in-budget
      // reasoning — against a 60s reasoning watchdog. The watchdog therefore
      // fired while the loop was still working normally, marking a healthy
      // slow reasoning run FAILED (WATCHDOG_TIMEOUT) before any action could
      // execute and long before GoalVerifier was reachable.
      //
      // Measured on the real loop: a 5s provider await produced ZERO progress
      // emissions (probe `p185_progress_during_reasoning.probe.test.ts`).
      //
      // THE FIX — one emission per ATTEMPT, immediately before the round trip,
      // and only when another attempt will actually follow. A single bounded
      // attempt is <=55s and is therefore already covered by the 60s reasoning
      // window; the failure mode only exists when attempts ACCUMULATE. So
      // emitting between attempts is the exact minimum needed, and it is what
      // keeps the watchdog tracking the loop's real progress instead of a
      // stale pre-reasoning timestamp.
      //
      // This is a LIVENESS signal only. It is the same `onStepProgress`
      // projection the loop already sends, emitted no earlier than the attempt
      // it describes. It grants no permission, reorders no gate, and cannot
      // make a stalled reasoner look healthy: if an attempt never returns, its
      // own 55s abort still fires and the next attempt's emission does not
      // happen. Bounded execution and fail-closed behaviour are unchanged.
      //
      if (attempt > 0) {
        this.notifyProgress();
        console.info('[AgentTrace] reasoning retry attempt starting', {
          attempt,
          // PHASE 18.7 / A8. The ceiling is still the operator's
          // `providerRetries`; A8 only ever narrows it, per attempt, to the
          // task-class/category budget computed after the previous failure.
          maxAttempts: this.providerRetries + 1,
        });
      }
      //
      // PHASE 17.5 (F6): the watchdog timer is now CLEARED. It used to be
      // created per attempt and never cleared, leaving up to providerRetries+1
      // live 55s timers holding their closures after the step finished.
      //
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new ProviderError('Reasoning provider request timed out after 55s.', 'timeout', {
                  retryable: true,
                })
              ),
            55000
          );
        });
        //
        // PHASE 18.7 (A6) — TRUTHFUL TYPED HISTORY.
        //
        // The previous code pushed `state.previousActions` and, for an
        // unverified last step, appended a hand-built copy carrying
        // `effect: lastStep.effectStatus || 'ACTION_NO_EFFECT'`. That conflated
        // three independent facts — refused by a gate, ran and threw, ran and
        // changed the page — into one `effect` string, so the reasoner could not
        // tell "nothing happened because I was blocked" from "the page did not
        // move", and would re-propose the blocked action.
        //
        // The projection below derives DISPATCH status and EFFECT status from
        // separate, typed signals. A policy-blocked action reports
        // `POLICY_BLOCKED` + `NOT_APPLICABLE`; it can never look executed.
        //
        // This is strictly more conservative than what it replaces: the
        // invariant assertion refuses to emit a history claiming an effect
        // nobody verified. It grants no permission and reorders no gate.
        //
        const stepEntries = this.state.steps.map((step) =>
          buildActionHistoryEntry(step, {
            currentPageGeneration: this.state.currentPageGeneration,
          }),
        );
        assertTruthfulHistory(stepEntries);
        const rawHistory: BrowserAction[] = stepEntries.map(toWireAction);
        // An action with no step record was never recorded, so its outcome is
        // genuinely unknown. It is NOT promoted into the typed history; the
        // typed projection above is the single source of truth for this run.
        //
        // PHASE 18.5 (I-2). The effect/scrollDelta enrichment above is
        // preserved exactly — it is what lets the model distinguish a scroll
        // that moved the page from one that did not.
        //
        // What is added is a CONTRACT FILTER. The backend validates history
        // with `BrowserActionModel`, which is strict and enforces per-action-
        // type field applicability (`type` needs `text`, `click` needs
        // `target`, ...). Actions that violate that shape could reach history
        // and the backend would then reject the ENTIRE request with a 422 —
        // losing a turn over one malformed HISTORICAL entry, observed live as
        // `Action 'type' requires a non-empty 'text' field` against
        // `body.history[1]`.
        //
        // The backend's strictness is untouched. This only stops the sender
        // emitting entries its own contract forbids. Dropping an entry cannot
        // grant permission, alter an action, or bypass a gate; the dropped
        // COUNT is logged so the condition stays visible, and never the
        // content.
        //
        const { history: historyForReasoner, dropped: droppedHistoryEntries } =
          filterToHistoryContract(rawHistory);
        if (droppedHistoryEntries > 0) {
          console.warn('[AgentTrace] dropped non-conforming reasoner history entries', {
            dropped: droppedHistoryEntries,
            kept: historyForReasoner.length,
          });
        }
        //
        // PHASE 18.7 (A3) — STRUCTURED DECISION STATE ON THE WIRE.
        //
        // The reasoner previously had to guess whether its last proposal ran,
        // was refused by a gate, or moved the page. That information existed
        // locally and never crossed the boundary. It is now projected through an
        // explicit allowlist and attached to THIS cycle's context.
        //
        // It is informational only: it grants no permission, reorders no gate,
        // and cannot move any verifier's verdict. The destination and goal
        // statuses are the verifiers' OWN verdicts being reported, never
        // replaced.
        //
        const contextWithDecisionState: AgentContextPayload = {
          ...context,
          decision_state: projectDecisionStateForModel(this.buildDecisionStateForCycle(context)),
        };
        // PHASE 18.8 / B2 — the reasoner sees a bounded, sanitized anchor for the
        // reference the LOCAL resolver already settled. It is a hint, not an
        // instruction, and it never replaces the resolved identity locally.
        const providerTask = this.providerTaskLine() ? `${task}\n${this.providerTaskLine()}` : task;
        const action = await Promise.race([
          this.requestStepFromProvider(providerTask, contextWithDecisionState, historyForReasoner),
          timeoutPromise,
        ]);

        if (this.isStopped) {
          throw new ProviderError('Task stopped.', 'timeout', { retryable: false });
        }

        //
        // PHASE 17.5 (F3). STALE RESPONSE REJECTION. The proposal was computed
        // from `expectedIdentity`; if the browser moved since, it is REFUSED.
        // Fail closed: no dispatch, no goal evidence.
        //
        //
        // PHASE 17.5 (F3) — STALE RESPONSE REJECTION, re-checked AFTER the call.
        //
        // The identity is read from `contextWithDecisionState` — the object that
        // was ACTUALLY handed to the provider — not from `context`. When A3
        // started passing an enriched copy, reading the original instead made
        // this check blind: a provider that mutated the context it was given
        // (the exact thing this check exists to catch) no longer changed what
        // the loop compared against, and a proposal computed from a superseded
        // observation was DISPATCHED. Caught by the post-17.9 generation test.
        //
        if (!isObservationCurrent(expectedIdentity, this.observationIdentityFor(contextWithDecisionState))) {
          throw new ProviderError(
            'Provider response is stale: the observed page changed while the request was in flight.',
            'timeout',
            { retryable: false, category: 'STALE_RESPONSE' }
          );
        }

        //
        // PHASE 18.7 / A1 — TERMINAL PROPOSAL.
        //
        // A proposal is checked against the evidence ledger THIS device holds,
        // not against anything the model said about it. The stale-observation
        // check above runs first, so a proposal computed from a superseded page
        // is refused before it can be verified against the current one.
        //
        // The verdict is raised as a signal rather than returned as an action,
        // so there is NO code path from a proposal to the dispatch pipeline
        // below it. Nothing is grounded, validated, risk-scored or executed.
        //
        if (action.kind === 'TERMINAL_PROPOSAL') {
          const verdict = verifyTerminalProposal(
            action.proposal,
            this.evidenceLedger ?? EMPTY_LEDGER_VIEW,
            task
          );
          console.info('[AgentTrace] terminal proposal received', {
            proposed: action.proposal.kind,
            status: verdict.status,
            supportedRecords: verdict.supportedRecordIds.length,
            downgraded: verdict.downgraded,
          });
          throw new TerminalProposalSignal(verdict);
        }

        return action.action;
      } catch (err: unknown) {
        lastError = err;
        this.provider.registerFailure?.();
        //
        // PHASE 18.7 / A8 — THE BUDGET IS DECIDED BY THE FAILURE, NOT BEFORE IT.
        //
        // The category is only knowable once the attempt has failed, so the
        // budget is computed HERE rather than once up front. A non-ProviderError
        // (a `TerminalProposalSignal`, a host fault) was never a transport
        // problem at all, so it is never retried — it propagates immediately.
        if (!(err instanceof ProviderError)) break;
        //
        // The hard ceiling is unchanged: `providerRetries` still caps the run,
        // exactly as Phase 17.5 (F8) required.
        //
        // When the operator set that ceiling EXPLICITLY it is honoured as-is: it
        // is a deliberate configuration, not a default, and silently lowering it
        // would make the documented bound unprovable. When it was left at the
        // default, A8 supplies the task-class-aware budget instead — an
        // information task spends 1, an interactive one 2, and a deterministic
        // failure 0 or 1 depending on whether anything could change.
        const budget = this.providerRetriesExplicit
          ? this.providerRetries
          : Math.min(
              this.providerRetries,
              providerRetryBudget(
                providerTaskClassFor({
                  requiresEvidence: this.intentDecision?.requiresEvidence,
                  requiresDestination: this.intentDecision?.requiresDestination,
                }),
                err.category,
                err.retryAfterMs,
                err.retryable === true
              )
            );
        if (err.retryable !== true || attempt >= budget) break;
        //
        // PHASE 17.5 (F8). A server Retry-After is honoured only when parsed and
        // trustworthy, is clamped to 30s, and stays INSIDE the configured bounded
        // provider retry count. It can never become an infinite loop, and it never
        // applies to a rate limit, which stays non-retryable by design.
        //
        const hint = err.retryAfterMs;
        const delay = typeof hint === 'number' ? Math.min(hint, 30_000) : this.providerRetryDelayMs;
        attempt++;
        await this.delay(delay);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    throw lastError;
  }

  private isConsequentialAction(action: BrowserAction, currentUrl: string): boolean {
    if (action.action === 'navigate' && this.requireConfirmationForExternalNavigation) {
      try {
        const dest = new URL(action.url);
        const curr = new URL(currentUrl);
        // Phase 18.4: Subdomains within the rootHost scope (or containment scope)
        // are authorized navigation paths that do not require external confirmation.
        const currentRootHost = this.containmentScope?.rootHost || deriveRootHost(curr.hostname);
        if (hostWithinScope(dest.hostname, currentRootHost)) {
          return false;
        }
        // If navigating to an external origin/domain outside rootHost scope, require user confirmation
        if (dest.origin !== curr.origin) {
          return true;
        }
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * PHASE 18.7 / A5 — refresh the two inputs the GoalVerifier uses to decide
   * whether an information task may be reported successful.
   *
   * Both are derived on the device from the local ledger and the intent
   * boundary's frozen decision. Nothing here reads a model claim, an answer
   * text or an action outcome.
   *
   * Called immediately BEFORE every goal verdict, so a record that went stale
   * on a later page generation stops counting, and a record verified during
   * this cycle starts counting.
   */
  private refreshEvidenceCompletionInputs(): void {
    this.state.intentRequiresEvidence = this.intentDecision?.requiresEvidence ?? false;
    // `citable()` is the ledger's own single gate: it already excludes STALE,
    // CONFLICTED, INVALIDATED and non-SANITIZED records. Only the VERIFIED
    // promotion is left to add here — re-checking freshness here too would be a
    // second copy of a rule that already lives in one place, and two copies of
    // a rule is exactly how they drift.
    this.state.verifiedEvidenceKeys = this.evidenceLedger
      ? this.evidenceLedger
          .citable()
          .filter((r) => r.verificationStatus === 'VERIFIED')
          .map((r) => r.key)
      : [];
  }

  // ───────────────────────────────────────────────────────────────────────
  // PHASE 18.8 / B2 + A13 + A15 — CONVERSATION CONTEXT AND REFERENCES.
  //
  // Everything below is INFORMATIONAL. It decides what the agent BELIEVES the
  // user referred to, and nothing else: a resolved reference is not an
  // authorization, and an unresolved one can only end the turn with a question.
  // Grounding, M5, the privacy firewall, the security critic, risk/confirmation,
  // containment, effect verification and goal verification are untouched and
  // still run on whatever the reasoner proposes.
  // ───────────────────────────────────────────────────────────────────────

  /** Open a turn inside the conversation. No conversation ⇒ nothing happens. */
  private beginConversationTurn(task: string): void {
    if (!this.conversation) return;
    const now = Date.now();
    const opened = appendTurn(this.conversation, {
      intentClass: this.intentDecision?.intent ?? 'UNKNOWN',
      // A digest, never the text: the user's words may contain PII.
      intentDigest: stableHash(task),
      taskLength: task.length,
      now,
    });
    this.conversation = opened.context;
    this.conversationTurnIndex = opened.index;
    this.publishConversation('TURN_OPENED');
  }

  private publishConversation(event: string): void {
    if (!this.conversation) return;
    this.state.conversation = this.conversationSummary();
    this.callbacks.onConversationUpdate?.(this.conversation);
    const selection = this.conversation.selection;
    console.info('[AgentTrace] conversation updated', {
      event,
      conversationId: this.conversation.conversationId,
      contextGeneration: this.conversation.contextGeneration,
      turnIndex: this.conversationTurnIndex,
      candidates: eligibleCandidates(this.conversation).length,
      selectedOrdinal: selection?.ordinal ?? null,
      selectedIdentity: selection?.identityKey ?? null,
      revalidation: selection?.revalidation ?? null,
      clarificationCode: this.conversation.clarification?.code ?? null,
    });
  }

  /** The bounded projection that leaves the loop (dashboard, logs, evidence). */
  private conversationSummary(): ConversationSummary | null {
    if (!this.conversation) return null;
    const selection = this.conversation.selection;
    return {
      conversationId: this.conversation.conversationId,
      contextGeneration: this.conversation.contextGeneration,
      turnIndex: this.conversationTurnIndex,
      turnCount: this.conversation.turns.length,
      candidateCount: eligibleCandidates(this.conversation).length,
      selectedOrdinal: selection?.ordinal ?? null,
      selectedIdentityKey: selection?.identityKey ?? null,
      selectedProductId: selection?.identity.productId ?? null,
      selectedEntityType: selection?.identity.entityType ?? null,
      revalidation: selection?.revalidation ?? null,
      referenceOutcome: this.state.conversation?.referenceOutcome ?? 'NOT_A_REFERENCE',
      clarificationCode: this.conversation.clarification?.code ?? null,
    };
  }

  /**
   * Refresh the observed candidates after every perception, and REVALIDATE any
   * existing selection against the page now on screen (A15).
   */
  private observeConversation(
    worldModel: BrowserWorldModel | null | undefined,
    context: AgentContextPayload | null | undefined
  ): void {
    if (!this.conversation) return;
    const now = Date.now();
    const pageGeneration = worldModel?.page?.pageGeneration ?? this.state.currentPageGeneration ?? 0;
    const url = context?.url ?? worldModel?.page?.url ?? this.state.currentUrl ?? null;
    const candidates: EntityCandidate[] = candidatesFromWorldModel(worldModel, now, { url });
    for (const candidate of candidates) {
      this.conversationIdentities.set(candidate.identity.identityKey, candidate.identity);
    }
    let next = withPage(
      this.conversation,
      {
        url,
        role: this.state.pageType ?? null,
        pageGeneration,
        navigated: this.lastConversationUrl !== null && this.lastConversationUrl !== url,
      },
      now
    );
    next = observeCandidates(next, candidates, now, pageGeneration);
    const selection = next.selection;
    if (selection) {
      const revalidated = revalidateSelection(
        { identityKey: selection.identityKey, ordinal: selection.ordinal, identity: selection.identity },
        eligibleCandidates(next),
        url
      );
      const identity = revalidated.identity ?? selection.identity;
      next = withSelection(
        next,
        {
          identityKey:
            revalidated.verdict === 'REVALIDATED' ? identity.identityKey : selection.identityKey,
          ordinal: revalidated.ordinal ?? selection.ordinal,
          identity,
          resolvedAt: selection.resolvedAt,
          revalidatedAt: revalidated.verdict === 'REVALIDATED' ? now : selection.revalidatedAt,
          revalidation: revalidated.verdict,
        },
        now
      );
    }
    this.lastConversationUrl = url;
    this.conversation = next;
    this.publishConversation('OBSERVED');
  }

  /**
   * Deterministic reference resolution (A13), run ONCE per cycle BEFORE the
   * reasoner is consulted and before anything can be dispatched.
   */
  private resolveConversationReference(task: string): boolean {
    if (!this.conversation) return false;
    const reference: EntityReference | null = detectReference(task);
    const now = Date.now();
    if (!reference) {
      this.publishConversation('NO_REFERENCE');
      return false;
    }

    const result = resolveReference(reference, this.conversation);
    if (result.outcome === 'RESOLVED' && result.identity) {
      const identity = result.identity;
      this.conversationIdentities.set(identity.identityKey, identity);
      this.conversation = withSelection(
        this.conversation,
        {
          identityKey: identity.identityKey,
          ordinal: result.candidate?.ordinal ?? this.conversation.selection?.ordinal ?? 1,
          identity,
          resolvedAt: now,
          revalidatedAt: result.candidate ? now : this.conversation.selection?.revalidatedAt ?? null,
          revalidation: 'REVALIDATED',
        },
        now
      );
      this.state.conversation = {
        ...(this.conversationSummary() as ConversationSummary),
        referenceOutcome: 'RESOLVED',
        referencePhrase: reference.phrase,
        referenceBasis: result.basis,
      };
      this.publishConversation(`REFERENCE_RESOLVED_${result.basis}`);
      return false;
    }

    if (result.outcome === 'NEEDS_CLARIFICATION' || result.outcome === 'NEEDS_INFORMATION') {
      this.conversation = withClarification(
        this.conversation,
        result.clarificationCode ?? 'AMBIGUOUS_REFERENCE',
        result.question ?? 'Tell me which item you mean.',
        reference.phrase,
        now
      );
      this.state.conversation = {
        ...(this.conversationSummary() as ConversationSummary),
        referenceOutcome: result.outcome,
        referencePhrase: reference.phrase,
        referenceBasis: 'NONE',
      };
      this.publishConversation(`REFERENCE_${result.outcome}`);
      // Fail closed. No provider call, no dispatch, no gate is bypassed: the
      // turn simply stops and the user is asked.
      this.state.status = result.outcome;
      this.state.goalStatus = result.outcome;
      this.state.reason = result.question ?? undefined;
      this.state.clarification = {
        code: result.clarificationCode ?? 'AMBIGUOUS_REFERENCE',
        question: result.question ?? 'Tell me which item you mean.',
        reference: reference.phrase,
      };
      this.notifyProgress();
      console.info('[AgentTrace] reference not resolvable', {
        outcome: result.outcome,
        code: result.clarificationCode,
        phrase: reference.phrase,
      });
      return true;
    }
    return false;
  }

  /** Bounded, sanitized anchor line handed to the REASONER only. */
  private providerTaskLine(): string | null {
    if (!this.conversation) return null;
    const selection = this.conversation.selection;
    if (!selection) return null;
    if (selection.revalidation !== 'REVALIDATED' && selection.revalidation !== 'SELECTED') return null;
    const identity = selection.identity;
    const parts = [identity.normalizedTitle];
    if (identity.productId) parts.push(`id: ${identity.productId}`);
    if (identity.origin) parts.push(`on: ${identity.origin}`);
    return `[RESOLVED REFERENCE] ${parts.join(' | ')}`;
  }

  /** Close the turn with the terminal state, bounded and typed. */
  private closeConversationTurn(): void {
    if (!this.conversation) return;
    const now = Date.now();
    const status = this.state.status;
    this.conversation = closeTurn(
      this.conversation,
      this.conversationTurnIndex,
      status === 'IN_PROGRESS' || status === 'NEEDS_USER_CONFIRMATION' ? 'FAILED' : (status as ConversationTurn['status']),
      now,
      eligibleCandidates(this.conversation).length
    );
    this.conversation = withTerminal(this.conversation, status, null, now);
    this.publishConversation('TURN_CLOSED');
  }

  private isTaskGoalSatisfied(task: string, state: AgentTaskState, context: AgentContextPayload): boolean {
    if (state.lastActionResult && !state.lastActionResult.success) {
      return false;
    }
    const res = verifyTaskGoal(task, state, context);
    if (res.satisfied) {
      state.goalStatus = 'SUCCESS';
      if (res.reason) {
        state.reason = res.reason;
      }
      //
      // PHASE 18.8 / B1 — an evidence-based SUCCESS must also carry the ANSWER.
      //
      // A5 certifies this task because the device holds verified, current
      // evidence about the subject. Until B1 the dashboard then showed
      // "Goal achieved" beside "No result yet." — the completion was truthful
      // and the user was told nothing. The answer is composed from the SAME
      // ledger the completion rule reads, with the same subject match, and the
      // model's prose is not consulted. When no answer can be composed the
      // field simply stays absent; nothing is fabricated.
      //
      if (!this.state.answer) {
        const composed = composeEvidenceAnswerFromLedger(
          this.evidenceLedger,
          this.state.taskGoal || this.state.normalizedGoal || ''
        );
        if (composed) {
          this.state.answer = composed.answer;
          this.state.answerProvenance = {
            verifiedRecords: composed.verifiedRecords,
            sourceHost: hostFromUrl(this.state.currentUrl),
          };
        }
      }
      // PHASE 18.7 / A5. The rule id only — `res.reason` quotes the observed
      // fact and its value, so it must never reach a log line. Without this,
      // a SUCCESS is undiagnosable in a real browser and a false one is
      // impossible to attribute.
      console.info('[AgentTrace] goal verification satisfied', { rule: res.rule ?? 'UNATTRIBUTED' });
      return true;
    }
    return false;
  }

  /**
   * PHASE 18.7 / A7 — BUILD A TRUTHFUL RECOVERY RECORD.
   *
   * Every typed failure site in the loop funnels through here so there is
   * exactly ONE place a `RecoveryRecord` is produced, and none of the sites can
   * invent one. The inputs are the facts the device already established:
   *
   *   • the typed dispatch/effect pair from `buildActionHistoryEntry` (A6),
   *   • the semantic-progress verdict from the ONE progress authority (I-8),
   *   • and the failure category, which is DERIVED deterministically.
   *
   * `madeProgress` is read from `this.longHorizon.semanticProgressVerdict()`
   * and therefore can only ever come from `assessProgress`. It is never read
   * from dispatch success, which is the conflation that made Phase 17.4's
   * stagnation detection unreachable in the first place.
   *
   * Nothing here executes, approves or dispatches anything. The returned
   * outcome is a strategy CLASS plus a bound.
   */
  private planRecovery(input: {
    failureCategory: RecoveryFailureCategory;
    previousActionResult: ActionHistoryEntry | null;
    substep?: string;
  }): TypedRecoveryOutcome {
    const outcome = this.typedRecovery.plan({
      failureCategory: input.failureCategory,
      previousActionResult: input.previousActionResult,
      madeProgress: this.longHorizon.semanticProgressVerdict().meaningful,
    });
    this.state.recoveryRecords = [...this.typedRecovery.records].slice(-MAX_RECOVERY_RECORDS);
    console.info('[AgentTrace] recovery record', {
      category: outcome.record.failureCategory,
      from: outcome.record.strategyFrom,
      to: outcome.record.strategyTo,
      retryCount: outcome.record.retryCount,
      reasonCode: outcome.record.reasonCode,
      madeProgress: outcome.record.madeProgress,
      observationState: outcome.record.observationState,
      exhausted: outcome.exhausted,
    });
    return outcome;
  }

  /**
   * Build the typed history entry for the step just recorded and plan recovery
   * from it. Callers pass only the CATEGORY, which is derived from typed state;
   * they never construct an `ActionHistoryEntry` themselves.
   */
  private planRecoveryForLastStep(
    failureCategory: RecoveryFailureCategory
  ): TypedRecoveryOutcome | undefined {
    const last = this.state.steps[this.state.steps.length - 1];
    return this.planRecovery({
      failureCategory,
      // No step means no action was ever proposed — a provider outage, or a
      // host fault. `null` says exactly that; a placeholder entry would invent
      // an action nobody proposed.
      previousActionResult: last
        ? buildActionHistoryEntry(last, {
            currentPageGeneration: this.state.currentPageGeneration,
          })
        : null,
    });
  }

  /**
   * The most recent recovery record, read by the terminal paths so a truthful
   * reason reaches the user without any free text being synthesised.
   */
  private lastRecoveryRecord(): RecoveryRecord | undefined {
    return this.state.recoveryRecords?.[this.state.recoveryRecords.length - 1];
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
    selfHealing?: SelfHealingResult,
    effectVerified?: boolean,
    effectStatus?: EffectStatus,
    effectDetails?: string
  ): void {
    const record: StepRecord = {
      step: this.state.currentStep,
      // RETAINED, value-free. The live `action` continues through the pipeline
      // untouched; only what is kept is projected.
      action: sanitizeRetainedAction(action),
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
      selfHealing: sanitizeRetainedSelfHealing(selfHealing),
      expectedStateChange: this.state.expectedStateChange,
      currentPageGeneration: this.state.currentPageGeneration,
      pageType: this.state.pageType,
      semanticContext: this.state.semanticContext,
      effectVerified,
      effectStatus,
      effectDetails,
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

  /**
   * Observe REAL browser state for effect verification.
   *
   * Returns null when no observation channel exists, and also when the host's
   * observation failed or threw. Callers decide what that means: the PRE
   * snapshot may fall back to context-derived values for a host with no tab at
   * all, while the POST snapshot must fail closed — because deriving the
   * post-state from the requested action is precisely the defect this replaces.
   */
  private async observeEffectSnapshot(
    target: string | undefined,
    phase: 'pre' | 'post'
  ): Promise<PreActionSnapshot | PostActionSnapshot | null> {
    if (!this.callbacks.getEffectSnapshot) return null;
    try {
      return await this.callbacks.getEffectSnapshot(target);
    } catch (err) {
      console.warn(`[AgentTrace] ${phase}-action snapshot unavailable:`, err);
      return null;
    }
  }

  private notifyProgress(): void {
    if (this.isStopped) return;
    if (this.callbacks.onStepProgress) {
      this.callbacks.onStepProgress(this.getState());
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
