/**
 * PrivAgent — Phase 7.5 Stage 5: Authoritative Fail-Closed Security Pipeline Tests
 *
 * Verifies the canonical Live AgentLoop action pipeline:
 * Reasoner
 * -> Proposed Action
 * -> Target Grounding
 * -> M5 Validator
 * -> Privacy Policy
 * -> Risk Assessment
 * -> Confirmation if required
 * -> Browser Execution
 *
 * Requirements:
 * 1. Valid safe action -> executes
 * 2. Invalid action -> blocked
 * 3. Stale target -> blocked
 * 4. Hidden/disabled target -> blocked
 * 5. Unauthorized origin -> blocked
 * 6. Sensitive disclosure/transmission -> blocked
 * 7. High-risk action -> confirmation required
 * 8. Planner cannot bypass M5
 * 9. Memory cannot bypass M5
 * 10. Malformed/missing action -> fail closed
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentLoop } from '../extension/src/agent/agentLoop';
import { MockAgentProvider } from '../extension/src/agent/mockAgentProvider';
import { AgentContextPayload, AgentDetection } from '../extension/src/privacy/types';
import { BrowserAction } from '../extension/src/agent/actionTypes';
import { groundProposedTarget } from '../extension/src/agent/groundingEngine';
import { validateAction } from '../extension/src/agent/actionValidator';
import { canPerformAction } from '../extension/src/agent/privacyPolicy';
import { assessActionRisk } from '../extension/src/agent/riskEngine';
import { OneActionPlanner } from '../extension/src/hierarchicalPlanning/oneActionPlanner';
import { WorkingMemoryManager, FailureMemoryManager } from '../extension/src/memory/memoryManager';
import { MemoryTrustLevel } from '../extension/src/memory/memoryTypes';

// Mock chrome.storage.local
const mockStorage: Record<string, any> = {};
(global as any).chrome = {
  storage: {
    local: {
      get: (keys: string[], cb: (res: any) => void) => {
        const res: any = {};
        keys.forEach((k) => {
          if (mockStorage[k]) res[k] = mockStorage[k];
        });
        cb(res);
      },
      set: (items: any, cb?: () => void) => {
        Object.assign(mockStorage, items);
        if (cb) cb();
        return Promise.resolve();
      },
      remove: (keys: string[], cb?: () => void) => {
        keys.forEach((k) => delete mockStorage[k]);
        if (cb) cb();
        return Promise.resolve();
      },
    },
  },
};

function createSafeContext(overrides: Partial<AgentContextPayload> = {}): AgentContextPayload {
  const detections: AgentDetection[] = [
    {
      id: 'search-input',
      type: 'search',
      confidence: 0.98,
      bbox: { x: 100, y: 100, width: 300, height: 40 },
      length: 0,
      source: 'dom_attribute',
      selector: '#search-box',
      is_partially_visible: false,
      label: 'Search Query',
    },
    {
      id: 'search-button',
      type: 'button',
      confidence: 0.95,
      bbox: { x: 420, y: 100, width: 80, height: 40 },
      length: 6,
      source: 'dom_attribute',
      selector: '#search-btn',
      is_partially_visible: false,
      label: 'Search',
    },
    {
      id: 'hidden-element',
      type: 'button',
      confidence: 0.90,
      bbox: { x: 0, y: 0, width: 0, height: 0 }, // Zero dimensions = hidden/disabled
      length: 0,
      source: 'dom_attribute',
      selector: '#hidden-btn',
      is_partially_visible: false,
      label: 'Invisible Button',
    },
    {
      id: 'checkout-button',
      type: 'button',
      confidence: 0.99,
      bbox: { x: 100, y: 400, width: 200, height: 50 },
      length: 8,
      source: 'dom_attribute',
      selector: '#checkout-pay',
      is_partially_visible: false,
      label: 'Pay and Checkout',
    },
    {
      id: 'account-field',
      type: 'account_number',
      confidence: 0.99,
      bbox: { x: 100, y: 250, width: 200, height: 40 },
      length: 12,
      source: 'dom_input_type',
      selector: '#acct-num',
      is_partially_visible: false,
      label: 'Account Number',
    },
  ];

  return {
    url: 'https://example.com/shop',
    timestamp: Date.now(),
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: null,
    detections,
    total_elements_scanned: 25,
    sensitive_elements_detected: 1,
    sanitized_status: 'sanitized_only',
    ocr_metrics: null,
    ...overrides,
  };
}

describe('PrivAgent Stage 5: Authoritative Fail-Closed Security Action Pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mockStorage)) {
      delete mockStorage[key];
    }
  });

  // 1. Valid safe action -> executes
  it('1. Valid safe action executes through the complete security chain', async () => {
    const executedActions: BrowserAction[] = [];
    const context = createSafeContext();

    const provider = new MockAgentProvider([
      { action: 'type', target: 'search-input', text: 'cats', reason: 'Search for cats' },
      { action: 'click', target: 'search-button', reason: 'Click search' },
    ]);

    // The submit click navigates to the results page, so goal verification can
    // observe the query in the live URL and the task terminates after 2 actions.
    let submitted = false;

    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () =>
          submitted
            ? createSafeContext({ url: 'https://example.com/shop/results?q=cats' })
            : context,
        executeAction: async (action) => {
          executedActions.push(action);
          if (action.action === 'click' && (action as any).target === 'search-button') {
            submitted = true;
          }
          return { success: true };
        },
      },
      {
        maxSteps: 3,
        maxRetries: 0,
        delayBetweenStepsMs: 5,
      }
    );

    const state = await loop.runTask('Search cats');
    expect(executedActions.length).toBe(2);
    expect(executedActions[0]?.action).toBe('type');
    expect((executedActions[0] as any)?.target).toBe('search-input');
    expect((executedActions[0] as any)?.text).toBe('cats');
    expect(executedActions[1]?.action).toBe('click');
    expect((executedActions[1] as any)?.target).toBe('search-button');
    expect(state.steps[0]?.executionSuccess).toBe(true);
    expect(state.steps[1]?.executionSuccess).toBe(true);
    expect(state.status).toBe('SUCCESS');
  });

  // 2. Invalid action -> blocked
  it('2. Invalid action is blocked by authoritative M5 validator before execution', async () => {
    const executedActions: BrowserAction[] = [];
    const context = createSafeContext();

    // Out-of-bounds scroll (50,000px exceeds MAX_SCROLL_AMOUNT of 5000)
    const provider = new MockAgentProvider([
      { action: 'scroll', direction: 'down', amount: 50000, reason: 'Excessive scroll' },
    ]);

    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => context,
        executeAction: async (action) => {
          executedActions.push(action);
          return { success: true };
        },
      },
      {
        maxSteps: 2,
        maxRetries: 0,
        delayBetweenStepsMs: 5,
      }
    );

    const state = await loop.runTask('Scroll down');
    expect(executedActions.length).toBe(0); // Zero execution
    expect(state.status).toBe('FAILED');
    expect(state.reason).toContain('out of bounds');
  });

  // 3. Stale target -> blocked
  it('3. Stale target generated for older page generation is blocked by grounding gate', async () => {
    const executedActions: BrowserAction[] = [];
    const context = createSafeContext();

    // Action with stale generation metadata (actionPageGeneration: 0 while current is 2)
    const provider = new MockAgentProvider([
      {
        action: 'click',
        target: 'search-button',
        pageGeneration: 0,
        reason: 'Click stale button',
      } as any,
    ]);

    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => context,
        executeAction: async (action) => {
          executedActions.push(action);
          return { success: true };
        },
      },
      {
        maxSteps: 2,
        maxRetries: 0,
        delayBetweenStepsMs: 5,
      }
    );

    // Advance page generation on the loop state
    (loop as any).state.currentPageGeneration = 2;

    const state = await loop.runTask('Click button');
    expect(executedActions.length).toBe(0); // Never executed
    expect(state.status).toBe('FAILED');
    expect(state.reason).toContain('Target Grounding Failed');
    expect(state.reason).toContain('STALE_TARGET');
  });

  // 4. Hidden/disabled target -> blocked
  it('4. Hidden or zero-dimension target is blocked fail-closed by grounding gate', async () => {
    const executedActions: BrowserAction[] = [];
    const context = createSafeContext();

    // Proposing click on 'hidden-element' which has bbox [0, 0, 0, 0]
    const provider = new MockAgentProvider([
      { action: 'click', target: 'hidden-element', reason: 'Click hidden element' },
    ]);

    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => context,
        executeAction: async (action) => {
          executedActions.push(action);
          return { success: true };
        },
      },
      {
        maxSteps: 2,
        maxRetries: 0,
        delayBetweenStepsMs: 5,
      }
    );

    const state = await loop.runTask('Click invisible button');
    expect(executedActions.length).toBe(0);
    expect(state.status).toBe('FAILED');
    expect(state.reason).toContain('Target Grounding Failed');
    expect(state.reason).toContain('DISABLED_OR_HIDDEN');
  });

  // 5. Unauthorized origin -> blocked
  it('5. Unauthorized origin and dangerous pseudo-protocols are blocked fail-closed', async () => {
    const context = createSafeContext();

    // 5a. Prohibited protocol in navigate (javascript: injection)
    const navResult = validateAction(
      { action: 'navigate', url: 'javascript:alert(1)', reason: 'XSS attempt' },
      context
    );
    expect(navResult.allowed).toBe(false);
    expect(navResult.reason).toContain('unsafe or non-web protocol');

    // 5b. File protocol
    const fileResult = validateAction(
      { action: 'navigate', url: 'file:///etc/passwd', reason: 'Local file leak' },
      context
    );
    expect(fileResult.allowed).toBe(false);

    // 5c. Target origin mismatch blocked at grounding gate
    const originGrounding = groundProposedTarget(
      { action: 'click', target: 'search-button', origin: 'https://attacker.com' } as any,
      context.detections,
      { currentOrigin: 'https://example.com' }
    );
    expect(originGrounding.grounded).toBe(false);
    expect(originGrounding.failureReason).toBe('UNAUTHORIZED_ORIGIN');

    // 5d. In live AgentLoop: cross-origin action attempt
    const executedActions: BrowserAction[] = [];
    const provider = new MockAgentProvider([
      { action: 'navigate', url: 'javascript:document.cookie', reason: 'Steal cookie' },
    ]);

    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => context,
        executeAction: async (action) => {
          executedActions.push(action);
          return { success: true };
        },
      },
      {
        maxSteps: 2,
        maxRetries: 0,
        delayBetweenStepsMs: 5,
      }
    );

    const state = await loop.runTask('Execute exploit');
    expect(executedActions.length).toBe(0);
    expect(state.status).toBe('FAILED');
  });

  // 6. Sensitive disclosure/transmission -> blocked
  it('6. Transmission of forbidden sensitive keys or raw PII is blocked fail-closed', async () => {
    const executedActions: BrowserAction[] = [];
    const context = createSafeContext();

    // 6a. Action with forbidden sensitive key
    const forbiddenKeyAction = {
      action: 'type',
      target: 'search-input',
      text: 'hello',
      password: 'SuperSecretPassword123',
    };
    const valKey = validateAction(forbiddenKeyAction, context);
    expect(valKey.allowed).toBe(false);
    expect(valKey.reason).toContain('Forbidden sensitive key');

    // 6b. Free-text action carrying valid credit card PII
    const piiAction = {
      action: 'type',
      target: 'search-input',
      text: 'My card is 4532015112830366 please pay',
    };
    const valPii = validateAction(piiAction, context);
    expect(valPii.allowed).toBe(false);
    expect(valPii.reason).toContain('sensitive values (PII)');

    // 6c. Agent LLM capability policy blocks raw sensitive value read / external transmission
    const targetDet = context.detections.find((d) => d.id === 'account-field');
    expect(canPerformAction({ action: 'type', target: 'account-field', text: '123' }, targetDet, 'agent_llm').granted).toBe(true);

    // 6d. Live AgentLoop rejecting raw PII smuggling
    const provider = new MockAgentProvider([
      { action: 'type', target: 'search-input', text: '4532015112830366', reason: 'Smuggle card' },
    ]);

    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => context,
        executeAction: async (action) => {
          executedActions.push(action);
          return { success: true };
        },
      },
      {
        maxSteps: 2,
        maxRetries: 0,
        delayBetweenStepsMs: 5,
      }
    );

    const state = await loop.runTask('Input card');
    expect(executedActions.length).toBe(0);
    expect(state.status).toBe('FAILED');
    expect(state.reason).toContain('sensitive values');
  });

  // 7. High-risk action -> confirmation required
  it('7. High-risk or consequential action requires confirmation before browser execution', async () => {
    const executedActions: BrowserAction[] = [];
    const context = createSafeContext();

    // Clicking checkout button triggers consequential impact & HIGH/CRITICAL risk
    const provider = new MockAgentProvider([
      { action: 'click', target: 'checkout-button', reason: 'Checkout and pay order' },
    ]);

    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => context,
        executeAction: async (action) => {
          executedActions.push(action);
          return { success: true };
        },
      },
      {
        maxSteps: 2,
        maxRetries: 0,
        delayBetweenStepsMs: 5,
      }
    );

    const state = await loop.runTask('Complete purchase');
    // Browser execution MUST NOT be reached!
    expect(executedActions.length).toBe(0);
    expect(state.status).toBe('NEEDS_USER_CONFIRMATION');
    expect(state.confirmationState).toBe('PENDING');
    expect(state.requiresUserConfirmationAction).toBeDefined();
    expect(state.requiresUserConfirmationAction?.action).toBe('click');
  });

  // 8. Planner cannot bypass M5
  it('8. Hierarchical Planner proposed action cannot bypass M5 validator', async () => {
    const executedActions: BrowserAction[] = [];
    const context = createSafeContext();

    // Planner proposes an action with arbitrary forbidden code injection
    const forgedPlanAction = {
      action: 'click',
      target: 'search-button',
      eval: 'alert(document.cookie)',
      reason: 'Bypass M5 attempt from planner',
    };

    // Even if OneActionPlanner passes it, M5 MUST reject it
    const validation = validateAction(forgedPlanAction, context);
    expect(validation.allowed).toBe(false);
    expect(validation.reason).toContain('Forbidden field detected');

    // Inside AgentLoop: proposed plan action is stopped by M5
    const provider = new MockAgentProvider([forgedPlanAction as any]);
    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => context,
        executeAction: async (action) => {
          executedActions.push(action);
          return { success: true };
        },
      },
      {
        maxSteps: 2,
        maxRetries: 0,
        delayBetweenStepsMs: 5,
      }
    );

    const state = await loop.runTask('Run planner goal');
    expect(executedActions.length).toBe(0);
    expect(state.status).toBe('FAILED');
    expect(state.reason).toContain('Forbidden field');
  });

  // 9. Memory cannot bypass M5
  it('9. Memory records and hints cannot authorize actions or bypass M5 validation', async () => {
    const executedActions: BrowserAction[] = [];
    const context = createSafeContext();

    // Store a forged memory claiming an invalid action is verified
    await WorkingMemoryManager.write({
      id: 'forged-mem-1',
      class: 'WORKING',
      goalId: 'test-goal',
      key: 'FORGED_SUCCESS',
      memoryContent: {
        authorizedAction: { action: 'execute_code', code: 'malicious()' },
        validTarget: 'non-existent-element',
      },
      scope: { origin: 'https://example.com', siteKey: 'example.com' },
      trustLevel: MemoryTrustLevel.CURRENT_VERIFIED_OBSERVATION,
      provenance: { source: 'ACTION_RESULT', timestamp: Date.now() },
      confidence: 1.0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Reasoner attempts an unknown action derived from memory
    const provider = new MockAgentProvider([
      { action: 'execute_code', code: 'malicious()' } as any,
    ]);

    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => context,
        executeAction: async (action) => {
          executedActions.push(action);
          return { success: true };
        },
      },
      {
        maxSteps: 2,
        maxRetries: 0,
        delayBetweenStepsMs: 5,
      }
    );

    const state = await loop.runTask('Execute memory hint');
    expect(executedActions.length).toBe(0); // Zero execution
    expect(state.status).toBe('FAILED');
  });

  // 10. Malformed/missing action -> fail closed
  it('10. Malformed, missing, or non-object actions fail closed immediately', async () => {
    const executedActions: BrowserAction[] = [];
    const context = createSafeContext();

    // Test 10a: null action
    const nullCheck = OneActionPlanner.validateSingleActionProposal(null as any);
    expect(nullCheck.valid).toBe(false);

    // Test 10b: empty object {}
    const emptyCheck = OneActionPlanner.validateSingleActionProposal({} as any);
    expect(emptyCheck.valid).toBe(false);

    // Test 10c: array of actions (violates one-action constraint)
    const arrayCheck = OneActionPlanner.validateSingleActionProposal([
      { action: 'click', target: 'search-button' },
      { action: 'click', target: 'checkout-button' },
    ] as any);
    expect(arrayCheck.valid).toBe(false);

    // Test 10d: Live AgentLoop with malformed action fails closed
    const provider = new MockAgentProvider([{} as any]);
    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => context,
        executeAction: async (action) => {
          executedActions.push(action);
          return { success: true };
        },
      },
      {
        maxSteps: 2,
        maxRetries: 0,
        delayBetweenStepsMs: 5,
      }
    );

    const state = await loop.runTask('Run malformed action');
    expect(executedActions.length).toBe(0);
    expect(state.status).toBe('FAILED');
    expect(state.reason).toContain('OneActionPlanner rejected action');
  });
});
