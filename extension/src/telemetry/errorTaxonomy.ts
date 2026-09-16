/**
 * PrivAgent — Standardized Error Taxonomy (Phase 14)
 *
 * Provides a unified classification of errors across the entire
 * Dashboard -> Extension -> ServiceWorker -> AgentLoop -> Backend pipeline.
 *
 * Invariants:
 *  - Fail-closed: all fatal errors translate into safe terminal states.
 *  - Zero sensitive leakage: stack traces, internal URIs, and raw data are never in user messages.
 *  - Clear retryability semantics: 429 rate limits, context invalidations, and safety rejections are strictly non-retryable.
 */

export type ErrorCode =
  | 'EXTENSION_DISCONNECTED'
  | 'EXTENSION_CONTEXT_INVALIDATED'
  | 'TARGET_TAB_NOT_FOUND'
  | 'TARGET_TAB_UNRESPONSIVE'
  | 'PERCEPTION_TIMEOUT'
  | 'BACKEND_TIMEOUT'
  | 'LLM_RATE_LIMIT'
  | 'LLM_PROVIDER_ERROR'
  | 'INVALID_MODEL_RESPONSE'
  | 'INVALID_BROWSER_ACTION'
  | 'STALE_TARGET'
  | 'ACTION_TIMEOUT'
  | 'USER_STOPPED'
  | 'CONFIRMATION_REQUIRED';

export interface ErrorDefinition {
  code: ErrorCode;
  retryable: boolean;
  userFacingMessage: string;
  telemetryCategory: string;
  defaultTerminalStatus: 'FAILED' | 'STOPPED' | 'NEEDS_USER_CONFIRMATION';
}

export const ERROR_TAXONOMY: Record<ErrorCode, ErrorDefinition> = {
  EXTENSION_DISCONNECTED: {
    code: 'EXTENSION_DISCONNECTED',
    retryable: false,
    userFacingMessage: 'Browser extension is disconnected. Please check that the PrivAgent extension is loaded and active.',
    telemetryCategory: 'EXTENSION_CONNECTION',
    defaultTerminalStatus: 'FAILED',
  },
  EXTENSION_CONTEXT_INVALIDATED: {
    code: 'EXTENSION_CONTEXT_INVALIDATED',
    retryable: false,
    userFacingMessage: 'Extension context was invalidated due to a reload or update. Please refresh the web page to continue.',
    telemetryCategory: 'EXTENSION_LIFECYCLE',
    defaultTerminalStatus: 'FAILED',
  },
  TARGET_TAB_NOT_FOUND: {
    code: 'TARGET_TAB_NOT_FOUND',
    retryable: false,
    userFacingMessage: 'No target web tab found. Please open the requested website in another tab and try again.',
    telemetryCategory: 'TAB_RESOLUTION',
    defaultTerminalStatus: 'FAILED',
  },
  TARGET_TAB_UNRESPONSIVE: {
    code: 'TARGET_TAB_UNRESPONSIVE',
    retryable: false,
    userFacingMessage: 'Target web tab is not responsive or cannot be scripted. Please refresh the target tab and try again.',
    telemetryCategory: 'TAB_COMMUNICATION',
    defaultTerminalStatus: 'FAILED',
  },
  PERCEPTION_TIMEOUT: {
    code: 'PERCEPTION_TIMEOUT',
    retryable: false,
    userFacingMessage: 'Browser tab did not respond to local privacy perception scan in time.',
    telemetryCategory: 'PERCEPTION_FAILURE',
    defaultTerminalStatus: 'FAILED',
  },
  BACKEND_TIMEOUT: {
    code: 'BACKEND_TIMEOUT',
    retryable: true,
    userFacingMessage: 'PrivAgent backend reasoning service timed out.',
    telemetryCategory: 'BACKEND_NETWORK',
    defaultTerminalStatus: 'FAILED',
  },
  LLM_RATE_LIMIT: {
    code: 'LLM_RATE_LIMIT',
    retryable: false,
    userFacingMessage: 'AI reasoning provider rate limit reached (HTTP 429). Please wait before trying again.',
    telemetryCategory: 'AI_RATE_LIMIT',
    defaultTerminalStatus: 'FAILED',
  },
  LLM_PROVIDER_ERROR: {
    code: 'LLM_PROVIDER_ERROR',
    retryable: false,
    userFacingMessage: 'AI reasoning provider returned an unrecoverable error.',
    telemetryCategory: 'AI_PROVIDER_FAILURE',
    defaultTerminalStatus: 'FAILED',
  },
  INVALID_MODEL_RESPONSE: {
    code: 'INVALID_MODEL_RESPONSE',
    retryable: true,
    userFacingMessage: 'Model produced an unparseable or malformed action plan.',
    telemetryCategory: 'AI_PARSING_FAILURE',
    defaultTerminalStatus: 'FAILED',
  },
  INVALID_BROWSER_ACTION: {
    code: 'INVALID_BROWSER_ACTION',
    retryable: false,
    userFacingMessage: 'Planned action was rejected by on-device safety validation.',
    telemetryCategory: 'ACTION_VALIDATION_REJECT',
    defaultTerminalStatus: 'FAILED',
  },
  STALE_TARGET: {
    code: 'STALE_TARGET',
    retryable: true,
    userFacingMessage: 'Target element no longer exists in current page DOM. Re-perceiving page.',
    telemetryCategory: 'GROUNDING_FAILURE',
    defaultTerminalStatus: 'FAILED',
  },
  ACTION_TIMEOUT: {
    code: 'ACTION_TIMEOUT',
    retryable: false,
    userFacingMessage: 'Browser action execution acknowledgement timed out.',
    telemetryCategory: 'ACTION_TIMEOUT',
    defaultTerminalStatus: 'FAILED',
  },
  USER_STOPPED: {
    code: 'USER_STOPPED',
    retryable: false,
    userFacingMessage: 'Task was stopped by user request.',
    telemetryCategory: 'USER_ABORT',
    defaultTerminalStatus: 'STOPPED',
  },
  CONFIRMATION_REQUIRED: {
    code: 'CONFIRMATION_REQUIRED',
    retryable: false,
    userFacingMessage: 'Consequential action requires explicit user confirmation.',
    telemetryCategory: 'SAFETY_GATING',
    defaultTerminalStatus: 'NEEDS_USER_CONFIRMATION',
  },
};

/**
 * Classifies an unknown error string or exception into a standardized ErrorDefinition.
 */
export function classifyError(error: unknown): ErrorDefinition {
  const message = error instanceof Error ? error.message : String(error || '');

  if (message.includes('invalidated') || message.includes('Extension context')) {
    return ERROR_TAXONOMY.EXTENSION_CONTEXT_INVALIDATED;
  }
  if (message.includes('429') || message.toLowerCase().includes('rate limit')) {
    return ERROR_TAXONOMY.LLM_RATE_LIMIT;
  }
  if (message.includes('No target web tab found') || message.includes('not found among open tabs')) {
    return ERROR_TAXONOMY.TARGET_TAB_NOT_FOUND;
  }
  if (message.includes('not responsive') || message.includes('cannot be scripted')) {
    return ERROR_TAXONOMY.TARGET_TAB_UNRESPONSIVE;
  }
  if (message.includes('stopped') || message.includes('ABORT') || message.includes('cancelled')) {
    return ERROR_TAXONOMY.USER_STOPPED;
  }
  if (message.includes('confirmation') || message.includes('CONFIRM')) {
    return ERROR_TAXONOMY.CONFIRMATION_REQUIRED;
  }
  if (message.includes('Validator rejected') || message.includes('disallowed')) {
    return ERROR_TAXONOMY.INVALID_BROWSER_ACTION;
  }
  if (message.includes('timed out') && message.toLowerCase().includes('reasoning')) {
    return ERROR_TAXONOMY.BACKEND_TIMEOUT;
  }
  if (message.includes('timed out') && message.toLowerCase().includes('scan')) {
    return ERROR_TAXONOMY.PERCEPTION_TIMEOUT;
  }
  if (message.includes('timed out')) {
    return ERROR_TAXONOMY.ACTION_TIMEOUT;
  }

  // Fallback safe error
  return {
    code: 'LLM_PROVIDER_ERROR',
    retryable: false,
    userFacingMessage: message && !message.includes('{') ? message : 'An unexpected task execution error occurred.',
    telemetryCategory: 'GENERAL_ERROR',
    defaultTerminalStatus: 'FAILED',
  };
}
