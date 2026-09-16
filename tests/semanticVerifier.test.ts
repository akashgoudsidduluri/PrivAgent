import { describe, it, expect } from 'vitest';
import { verifySemanticAction } from '../extension/src/agent/semanticVerifier';
import { AgentContextPayload, AgentDetection } from '../extension/src/privacy/types';
import { BrowserAction } from '../extension/src/agent/actionTypes';

function makeMockContext(detections: AgentDetection[] = []): AgentContextPayload {
  return {
    url: 'https://bank.example.com/app',
    timestamp: Date.now(),
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: null,
    detections,
    total_elements_scanned: detections.length,
    sensitive_elements_detected: 0,
    sanitized_status: 'sanitized_only',
    ocr_metrics: null,
  };
}

describe('PrivAgent Semantic Pre-Execution Verifier (Feature 2)', () => {
  const detections: AgentDetection[] = [
    {
      id: 'btn_tx',
      type: 'account_number',
      confidence: 0.9,
      bbox: { x: 10, y: 10, width: 120, height: 30 },
      length: 10,
      source: 'dom_label',
      selector: '#view-transactions-btn',
      is_partially_visible: false,
    },
    {
      id: 'btn_pay',
      type: 'account_number',
      confidence: 0.9,
      bbox: { x: 10, y: 50, width: 120, height: 30 },
      length: 10,
      source: 'dom_label',
      selector: '#transfer-money-btn',
      is_partially_visible: false,
    },
  ];
  const ctx = makeMockContext(detections);

  it('marks actions matching user goal intent as ALIGNED', () => {
    const action: BrowserAction = { action: 'click', target: 'btn_tx', reason: 'Open transactions view' };
    const res = verifySemanticAction(action, 'View recent transactions', ctx);

    expect(res.verified).toBe(true);
    expect(res.targetAlignment).toBe('ALIGNED');
    expect(res.policyDecision).toBe('ALLOW');
    expect(res.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('detects prompt injection / contradictory targets as CONTRADICTORY and rejects them', () => {
    const action: BrowserAction = { action: 'click', target: 'btn_pay', reason: 'Transfer money' };
    const res = verifySemanticAction(action, 'View recent transactions', ctx);

    expect(res.verified).toBe(false);
    expect(res.targetAlignment).toBe('CONTRADICTORY');
    expect(res.policyDecision).toBe('REJECT');
    expect(res.reason).toMatch(/contradicts user task intent/i);
  });

  it('verifies scrolling actions as naturally ALIGNED visual exploration steps', () => {
    const action: BrowserAction = { action: 'scroll', direction: 'down', amount: 250 };
    const res = verifySemanticAction(action, 'Find account number', ctx);

    expect(res.verified).toBe(true);
    expect(res.targetAlignment).toBe('ALIGNED');
    expect(res.policyDecision).toBe('ALLOW');
  });

  it('rejects navigation actions attempting pseudo-protocols (javascript:, data:)', () => {
    const jsAction: BrowserAction = { action: 'navigate', url: 'javascript:alert(1)' };
    const res = verifySemanticAction(jsAction, 'Navigate home', ctx);

    expect(res.verified).toBe(false);
    expect(res.targetAlignment).toBe('CONTRADICTORY');
    expect(res.policyDecision).toBe('REJECT');
  });
});
