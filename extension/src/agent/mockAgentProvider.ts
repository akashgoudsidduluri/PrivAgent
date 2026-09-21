/**
 * PrivAgent — Deterministic Mock Agent Provider (Milestone 5.3 & 6)
 *
 * Deterministic agent reasoning implementation used for unit testing,
 * CI/CD verification, and local reproducible demonstrations.
 *
 * Does not make external network requests.
 * Consumes strictly sanitized M4 context.
 * Supports multi-step action sequences and history awareness for M6 autonomous loops.
 */

import { AgentProvider, ModelRole } from './agentProvider';
import { BrowserAction } from './actionTypes';
import { AgentContextPayload } from '../privacy/types';
import { assertSanitizedContextSafe } from './privacyPolicy';

export class MockAgentProvider implements AgentProvider {
  readonly name = 'MockAgentProvider';

  private customAction: BrowserAction | null = null;
  private actionSequence: BrowserAction[] = [];
  private customHandler: ((task: string, context: AgentContextPayload, history?: BrowserAction[]) => BrowserAction) | null = null;

  /**
   * Override next action for testing edge cases (e.g. invalid targets, malformed actions).
   */
  setNextAction(action: BrowserAction | null): void {
    this.customAction = action;
  }

  /**
   * Queue a sequence of actions for multi-step test cases.
   */
  setActionSequence(actions: BrowserAction[]): void {
    this.actionSequence = [...actions];
  }

  /**
   * Set custom reasoning function for test suites.
   */
  setCustomHandler(handler: ((task: string, context: AgentContextPayload, history?: BrowserAction[]) => BrowserAction) | null): void {
    this.customHandler = handler;
  }

  /**
   * Process a user task with the current sanitized page context and action history.
   */
  async requestAction(
    task: string,
    context: AgentContextPayload,
    history: BrowserAction[] = [],
    role?: ModelRole
  ): Promise<BrowserAction> {
    // Defense-in-depth: verify that context is sanitized before reasoning
    assertSanitizedContextSafe(context);

    // If an action sequence was queued, pop the next action
    if (this.actionSequence.length > 0) {
      const next = this.actionSequence.shift()!;
      return next;
    }

    if (this.customAction) {
      const action = this.customAction;
      this.customAction = null;
      return action;
    }

    if (this.customHandler) {
      return this.customHandler(task, context, history);
    }

    const lowerTask = task.toLowerCase();

    // M6 Demo Multi-Step Task: "Open the account details and find the recent transactions"
    if (
      (lowerTask.includes('account details') || lowerTask.includes('details')) &&
      (lowerTask.includes('transaction') || lowerTask.includes('transactions'))
    ) {
      const stepIndex = history.length;
      if (stepIndex === 0) {
        // Step 1: Open/Click account details
        const det = context.detections.find(
          (d) => d.type === 'account_number' || d.selector?.includes('details') || d.type === 'person_name'
        ) || (context.detections.length > 0 ? context.detections[0] : undefined);

        if (det) {
          return {
            action: 'click',
            target: det.id,
            reason: 'Step 1: Clicking account details element from sanitized context.',
          };
        }
        return {
          action: 'scroll',
          direction: 'down',
          amount: 400,
          reason: 'Step 1: Scrolling down to locate account details.',
        };
      }

      if (stepIndex === 1) {
        // Step 2: Scroll down to reveal transaction section
        return {
          action: 'scroll',
          direction: 'down',
          amount: 500,
          reason: 'Step 2: Scrolling down to locate transaction section.',
        };
      }

      // Step 3: Click transaction section or first element
      const transDet = context.detections.find(
        (d) => d.selector?.includes('transaction') || d.type === 'account_number' || d.type === 'credit_card'
      ) || (context.detections.length > 0 ? context.detections[0] : undefined);

      if (transDet) {
        return {
          action: 'click',
          target: transDet.id,
          reason: 'Step 3: Interacting with transaction element.',
        };
      }

      return {
        action: 'scroll',
        direction: 'down',
        amount: 300,
        reason: 'Step 3: Scrolling into transaction section view.',
      };
    }

    // Demo Task 1: "Find and click the account number field"
    if (lowerTask.includes('account number') || lowerTask.includes('account_number')) {
      const targetDet = context.detections.find((d) => d.type === 'account_number');
      if (targetDet) {
        return {
          action: 'click',
          target: targetDet.id,
          reason: 'Identified account number element from sanitized context metadata.',
        };
      }
      if (context.detections.length > 0 && context.detections[0]) {
        return {
          action: 'click',
          target: context.detections[0].id,
          reason: 'Fallback to first detected element.',
        };
      }
      throw new Error("No suitable 'account_number' element found in the sanitized context.");
    }

    // Demo Task 2: "Scroll down and find the transaction section"
    if (lowerTask.includes('scroll down') || lowerTask.includes('scroll')) {
      return {
        action: 'scroll',
        direction: 'down',
        amount: 500,
        reason: 'User requested scrolling to inspect lower section.',
      };
    }

    // Demo Task 3: "Open the account details"
    if (lowerTask.includes('account details') || lowerTask.includes('details')) {
      const det = context.detections.find(
        (d) => d.type === 'account_number' || d.type === 'person_name' || d.selector?.includes('details')
      ) || (context.detections.length > 0 ? context.detections[0] : undefined);

      if (det) {
        return {
          action: 'click',
          target: det.id,
          reason: 'Clicking element associated with account details.',
        };
      }
      return {
        action: 'scroll',
        direction: 'down',
        amount: 300,
        reason: 'Scrolling to locate account details section.',
      };
    }

    // Default action: Click first interactive detection or scroll down
    if (context.detections.length > 0 && context.detections[0]) {
      const firstId = context.detections[0].id;
      return {
        action: 'click',
        target: firstId,
        reason: `Default action: interacting with element ${firstId}.`,
      };
    }

    return {
      action: 'scroll',
      direction: 'down',
      amount: 400,
      reason: 'No interactive detections in current viewport; scrolling down.',
    };
  }
}
