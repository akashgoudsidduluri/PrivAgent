/**
 * PrivAgent — Contextual Intent Resolver
 *
 * Resolves natural follow-up instructions, continuations, retries,
 * modifications, and inspection queries against conversation context
 * and previous task execution state.
 */

export interface TaskExecutionState {
  conversationId: string;
  runId: number;
  originalTask: string;
  effectiveTask: string;
  targetTabId: number | null;
  targetUrl?: string;
  status: 'IN_PROGRESS' | 'SUCCESS' | 'FAILED' | 'STOPPED' | 'ANSWER' | 'NEEDS_CLARIFICATION' | 'PROVIDER_UNAVAILABLE';
  failureReason?: string;
  stepsCount: number;
  completedActions: Array<{ actionType: string; target?: string; success: boolean }>;
  lastVerifiedUrl?: string;
  cancelled?: boolean;
  superseded?: boolean;
  timestamp: number;
}

export type ContextualCategory =
  | 'NEW_TASK'
  | 'CONTINUATION'
  | 'RETRY'
  | 'INSPECTION'
  | 'MODIFICATION'
  | 'CANCELLED_REFUSAL'
  | 'AMBIGUOUS';

export interface ContextualIntentResult {
  category: ContextualCategory;
  effectiveTask: string;
  reason: string;
  shouldReuseTargetTab: boolean;
  explanation?: string;
}

const MODIFICATION_REGEX = /\b(?:instead|rather than|switch to|change to)\b/i;
const MODIFICATION_PREFIX_REGEX = /^(?:no[, ]+|actually[, ]+|wait[, ]+)(.+)$/i;

const INSPECTION_REGEX =
  /\b(?:what happened|what occurred|did you finish|have you finished|is it done|check now|check it again|check the result|verify the result|verify now|what is the status|tell me what happened|check again)\b/i;

const CONTINUATION_KEYWORDS_REGEX =
  /\b(?:continue|resume|pick up where you stopped|pick up|keep going|finish (?:it|what you were doing|this)|complete (?:it|what you were doing|this)|proceed (?:with the previous task)?|try again|retry|do it|go ahead|just do it)\b/i;

/**
 * Resolves a natural follow-up message using conversation context and previous task execution state.
 */
export function resolveContextualIntent(
  rawTask: string,
  previousState: TaskExecutionState | null,
  activeConversationId?: string | null
): ContextualIntentResult {
  const task = (rawTask || '').trim();
  const lower = task.toLowerCase();

  // 1. If no previous task exists in the current conversation, treat as standard task
  if (!previousState || !previousState.originalTask) {
    return {
      category: 'NEW_TASK',
      effectiveTask: task,
      reason: 'No previous task execution state found in conversation.',
      shouldReuseTargetTab: false,
    };
  }

  // Cross-conversation check: if conversation IDs are provided and differ, do not conflate
  if (
    activeConversationId &&
    previousState.conversationId &&
    activeConversationId !== previousState.conversationId
  ) {
    return {
      category: 'NEW_TASK',
      effectiveTask: task,
      reason: 'Belongs to a different conversation session.',
      shouldReuseTargetTab: false,
    };
  }

  // 2. Cancellation protection: if previous task was explicitly cancelled, refuse automatic resumption
  if (previousState.cancelled) {
    if (CONTINUATION_KEYWORDS_REGEX.test(lower)) {
      return {
        category: 'CANCELLED_REFUSAL',
        effectiveTask: task,
        reason: 'The previous task was cancelled by the user and cannot be resumed automatically.',
        shouldReuseTargetTab: false,
        explanation: 'The previous task was cancelled. Please provide a new instruction or specify what you would like to do.',
      };
    }
  }

  // 3. Modification: user explicitly gives an alternative destination or action
  // e.g. "open leetcode.com instead", "go to duckduckgo instead", "no, open leetcode.com"
  if (MODIFICATION_REGEX.test(lower)) {
    const cleaned = task
      .replace(/\binstead\b/gi, '')
      .replace(/\brather than\s+.*$/gi, '')
      .trim();
    return {
      category: 'MODIFICATION',
      effectiveTask: cleaned || task,
      reason: 'User explicitly modified the previous task objective.',
      shouldReuseTargetTab: false,
    };
  }
  const prefixMatch = task.match(MODIFICATION_PREFIX_REGEX);
  if (prefixMatch && prefixMatch[1]) {
    return {
      category: 'MODIFICATION',
      effectiveTask: prefixMatch[1].trim(),
      reason: 'User modified task with corrective prefix.',
      shouldReuseTargetTab: false,
    };
  }

  // 4. Inspection / Verification: user asks to verify or check without re-executing
  // e.g. "check now", "did you finish?", "what happened?"
  if (INSPECTION_REGEX.test(lower)) {
    return {
      category: 'INSPECTION',
      effectiveTask: previousState.originalTask,
      reason: 'User requested status inspection / verification of previous task result.',
      shouldReuseTargetTab: true,
    };
  }

  // 5. Continuation / Retry: natural follow-up phrases asking to continue, retry, or complete
  const isContinuationPhrase = CONTINUATION_KEYWORDS_REGEX.test(lower);
  const isShortAffirmative = /^(?:yes|yep|sure|ok|okay|please|go on)[\s!.]*$/i.test(lower);

  if (isContinuationPhrase || isShortAffirmative) {
    const isRetry = /\b(?:try again|retry)\b/i.test(lower);
    return {
      category: isRetry ? 'RETRY' : 'CONTINUATION',
      effectiveTask: previousState.originalTask,
      reason: isRetry
        ? `User requested retry of previous task: "${previousState.originalTask}".`
        : `User requested continuation of previous task: "${previousState.originalTask}".`,
      shouldReuseTargetTab: true,
    };
  }

  // 6. If the request has its own clear instructions (has nav verb or explicit destination), it is a new task
  const hasNavOrDest =
    /\b(open|opens|go|visit|navigate|launch|search|browse|http|https|\.com|\.org|\.net)\b/i.test(lower);
  if (hasNavOrDest) {
    return {
      category: 'NEW_TASK',
      effectiveTask: task,
      reason: 'Task contains explicit navigation or destination signals.',
      shouldReuseTargetTab: false,
    };
  }

  // 7. Fallback for short ambiguous follow-ups when previous task is unfinished or failed
  // e.g. "what now?", "next", "proceed"
  if (
    task.split(/\s+/).length <= 4 &&
    (previousState.status === 'PROVIDER_UNAVAILABLE' ||
      previousState.status === 'FAILED' ||
      previousState.status === 'IN_PROGRESS' ||
      previousState.status === 'NEEDS_CLARIFICATION')
  ) {
    return {
      category: 'CONTINUATION',
      effectiveTask: previousState.originalTask,
      reason: `Contextually resolved ambiguous turn against unfinished task: "${previousState.originalTask}".`,
      shouldReuseTargetTab: true,
    };
  }

  return {
    category: 'NEW_TASK',
    effectiveTask: task,
    reason: 'Standard task processing.',
    shouldReuseTargetTab: false,
  };
}
