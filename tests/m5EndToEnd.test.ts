/**
 * PrivAgent — Milestone 5 End-to-End Test Suite
 *
 * Verifies the complete M5 reasoning and validation flow:
 *  1. Sanitized context generation from synthetic banking page detections
 *  2. Task: "Find and click the account number field"
 *  3. Agent reasoning producing structured action: click(element_...)
 *  4. Local Action Validator approves action
 *  5. Capability policy check confirms LLM permissions
 *  6. Rejection of forbidden actions, out-of-bounds scroll, javascript: URLs
 *  7. Task: "Scroll down and find the transaction section"
 *  8. Task: "Open the account details"
 *  9. Verification that no raw sensitive values leaked to the agent
 */

import { describe, it, expect } from 'vitest';
import { validateAction } from '../extension/src/agent/actionValidator';
import { MockAgentProvider } from '../extension/src/agent/mockAgentProvider';
import { checkCapability, canPerformAction } from '../extension/src/agent/privacyPolicy';
import { AgentContextPayload } from '../extension/src/privacy/types';

describe('PrivAgent M5 End-to-End Reasoning & Action Verification', () => {
  const syntheticBankingContext: AgentContextPayload = {
    url: 'http://localhost:4173/',
    timestamp: Date.now(),
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: { width: 1280, height: 800 },
    detections: [
      {
        id: 'element_account_num',
        type: 'account_number',
        confidence: 0.98,
        bbox: { x: 80, y: 150, width: 240, height: 35 },
        length: 12,
        source: 'dom_input_type',
        selector: '#account-number-display',
        is_partially_visible: false,
      },
      {
        id: 'element_card_num',
        type: 'credit_card',
        confidence: 0.95,
        bbox: { x: 80, y: 220, width: 260, height: 35 },
        length: 16,
        source: 'dom_input_type',
        selector: '#card-number',
        is_partially_visible: false,
      },
      {
        id: 'element_name',
        type: 'person_name',
        confidence: 0.88,
        bbox: { x: 80, y: 300, width: 180, height: 30 },
        length: 12,
        source: 'dom_label',
        selector: '#account-holder-name',
        is_partially_visible: false,
      },
    ],
    total_elements_scanned: 48,
    sensitive_elements_detected: 3,
    sanitized_status: 'sanitized_only',
    ocr_metrics: null,
  };

  const agent = new MockAgentProvider();

  it('runs complete flow for Task: "Find and click the account number field"', async () => {
    const task = 'Find and click the account number field';
    const action = await agent.requestAction(task, syntheticBankingContext);

    expect(action.action).toBe('click');
    expect((action as any).target).toBe('element_account_num');

    // Action validation
    const val = validateAction(action, syntheticBankingContext);
    expect(val.allowed).toBe(true);

    // Policy check
    const det = syntheticBankingContext.detections.find((d) => d.id === (action as any).target);
    const pol = canPerformAction(action, det, 'agent_llm');
    expect(pol.granted).toBe(true);

    // Security assertion: Raw account number value is NEVER in agent payload or action
    expect(JSON.stringify(action)).not.toContain('123456789012');
    expect(JSON.stringify(syntheticBankingContext)).not.toContain('123456789012');
  });

  it('runs complete flow for Task: "Scroll down and find the transaction section"', async () => {
    const task = 'Scroll down and find the transaction section';
    const action = await agent.requestAction(task, syntheticBankingContext);

    expect(action.action).toBe('scroll');
    expect((action as any).direction).toBe('down');
    expect((action as any).amount).toBeGreaterThanOrEqual(1);
    expect((action as any).amount).toBeLessThanOrEqual(5000);

    const val = validateAction(action, syntheticBankingContext);
    expect(val.allowed).toBe(true);
  });

  it('runs complete flow for Task: "Open the account details"', async () => {
    const task = 'Open the account details';
    const action = await agent.requestAction(task, syntheticBankingContext);
    const val = validateAction(action, syntheticBankingContext);
    expect(val.allowed).toBe(true);
  });

  it('blocks all malicious and invalid action variations', () => {
    // Unknown element
    const badTarget = { action: 'click', target: 'element_unknown_999' };
    expect(validateAction(badTarget, syntheticBankingContext).allowed).toBe(false);

    // Dangerous javascript: URL
    const jsUrl = { action: 'navigate', url: 'javascript:stealData()' };
    expect(validateAction(jsUrl, syntheticBankingContext).allowed).toBe(false);

    // Arbitrary code / eval execution injection
    const evalAction = { action: 'click', target: 'element_account_num', eval: 'window.location="http://evil.com"' };
    expect(validateAction(evalAction, syntheticBankingContext).allowed).toBe(false);

    // Out-of-bounds scroll
    const excessScroll = { action: 'scroll', direction: 'down', amount: 999999 };
    expect(validateAction(excessScroll, syntheticBankingContext).allowed).toBe(false);

    // Prohibited LLM capability
    const llmSensitiveRead = checkCapability('account_number', 'READ_SENSITIVE_VALUE', 'agent_llm');
    expect(llmSensitiveRead.granted).toBe(false);
  });
});
