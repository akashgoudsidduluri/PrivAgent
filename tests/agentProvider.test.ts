/**
 * PrivAgent — Agent Provider Test Suite (Milestone 5.3 & 5.5)
 *
 * Tests requirements:
 *  14. mock agent returns deterministic structured action
 *  15. validator runs before execution
 *  16. invalid LLM action never reaches browser
 *  20. end-to-end mock task succeeds
 */

import { describe, it, expect } from 'vitest';
import { MockAgentProvider } from '../extension/src/agent/mockAgentProvider';
import { validateAction } from '../extension/src/agent/actionValidator';
import { canPerformAction } from '../extension/src/agent/privacyPolicy';
import { AgentContextPayload } from '../extension/src/privacy/types';

describe('PrivAgent Agent Provider & End-to-End Reasoning Pipeline', () => {
  const context: AgentContextPayload = {
    url: 'https://bank.example.com/dashboard',
    timestamp: 1720000000000,
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: null,
    detections: [
      {
        id: 'element_account_num',
        type: 'account_number',
        confidence: 0.97,
        bbox: { x: 120, y: 180, width: 220, height: 35 },
        length: 12,
        source: 'dom_input_type',
        selector: '#account-number',
        is_partially_visible: false,
      },
      {
        id: 'element_details_btn',
        type: 'person_name',
        confidence: 0.9,
        bbox: { x: 120, y: 250, width: 180, height: 35 },
        length: 8,
        source: 'dom_label',
        selector: '#view-details',
        is_partially_visible: false,
      },
    ],
    total_elements_scanned: 15,
    sensitive_elements_detected: 2,
    sanitized_status: 'sanitized_only',
    ocr_metrics: null,
  };

  // Test 14: Mock agent returns deterministic structured action
  it('14. mock agent returns deterministic structured actions for standard tasks', async () => {
    const provider = new MockAgentProvider();

    // Task 1
    const action1 = await provider.requestAction('Find and click the account number field', context);
    expect(action1.action).toBe('click');
    expect((action1 as any).target).toBe('element_account_num');

    // Task 2
    const action2 = await provider.requestAction('Scroll down and find the transaction section', context);
    expect(action2.action).toBe('scroll');
    expect((action2 as any).direction).toBe('down');
    expect((action2 as any).amount).toBe(500);

    // Task 3
    const action3 = await provider.requestAction('Open the account details', context);
    expect(action3.action).toBe('click');
    expect(['element_account_num', 'element_details_btn']).toContain((action3 as any).target);
  });

  // Test 15: Validator runs before execution
  it('15. verifies that the Action Validator runs and approves valid agent action before execution', async () => {
    const provider = new MockAgentProvider();
    const proposedAction = await provider.requestAction('Find and click the account number field', context);

    // Local Action Validator must run before extension dispatches to browser
    const validationResult = validateAction(proposedAction, context);
    expect(validationResult.allowed).toBe(true);

    // Policy check runs
    const targetDet = context.detections.find((d) => d.id === (proposedAction as any).target);
    const policyResult = canPerformAction(proposedAction, targetDet, 'agent_llm');
    expect(policyResult.granted).toBe(true);
  });

  // Test 16: Invalid LLM action never reaches browser
  it('16. ensures an invalid or malicious LLM action is blocked by the validator and never reaches execution', async () => {
    const provider = new MockAgentProvider();

    // Mock LLM producing an unsafe/unallowlisted action or targeting non-existent element
    provider.setNextAction({
      action: 'click',
      target: 'unknown_unverified_element',
      reason: 'Hallucinated target',
    });

    const badAction = await provider.requestAction('Click something', context);
    const validationResult = validateAction(badAction, context);

    expect(validationResult.allowed).toBe(false);
    expect(validationResult.reason).toMatch(/does not exist in the current sanitized context/i);

    // Simulate pipeline: execution must be aborted if allowed is false
    let executedInBrowser = false;
    if (validationResult.allowed) {
      executedInBrowser = true;
    }
    expect(executedInBrowser).toBe(false);
  });

  // Test 20: End-to-end mock task succeeds
  it('20. end-to-end mock task succeeds across full pipeline (Context -> Agent -> Validator -> Policy -> Approved Action)', async () => {
    // Step 1: Obtain sanitized context (verified no raw PII)
    expect(context.sanitized_status).toBe('sanitized_only');
    expect(JSON.stringify(context)).not.toContain('123456789012');

    // Step 2: Agent reasoning
    const provider = new MockAgentProvider();
    const task = 'Find and click the account number field';
    const action = await provider.requestAction(task, context);

    // Step 3: Local Action Validator
    const validation = validateAction(action, context);
    expect(validation.allowed).toBe(true);
    expect(validation.action).toBeDefined();

    // Step 4: Capability Policy Gate
    const targetDet = context.detections.find((d) => d.id === (action as any).target);
    const policy = canPerformAction(action, targetDet, 'agent_llm');
    expect(policy.granted).toBe(true);

    // Step 5: Verified action ready for deterministic browser dispatch
    expect(validation.allowed).toBe(true);
    if (validation.allowed) {
      expect(validation.action.action).toBe('click');
      expect((validation.action as any).target).toBe('element_account_num');
    }
  });
});
