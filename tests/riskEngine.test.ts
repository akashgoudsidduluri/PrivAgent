import { describe, it, expect } from 'vitest';
import { assessActionRisk, ActionRiskAssessment } from '../extension/src/agent/riskEngine';
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

describe('PrivAgent Risk Engine (Feature 1)', () => {
  it('classifies scrolling and benign button clicks as LOW risk', () => {
    const ctx = makeMockContext([
      {
        id: 'btn_toggle',
        type: 'account_number',
        confidence: 0.9,
        bbox: { x: 10, y: 10, width: 100, height: 30 },
        length: 8,
        source: 'dom_label',
        selector: '#view-details-btn',
        is_partially_visible: false,
      },
    ]);

    const scrollAction: BrowserAction = { action: 'scroll', direction: 'down', amount: 300 };
    const scrollRisk = assessActionRisk(scrollAction, ctx, ctx.url);
    expect(scrollRisk.riskLevel).toBe('LOW');
    expect(scrollRisk.requiresConfirmation).toBe(false);

    const clickAction: BrowserAction = { action: 'click', target: 'btn_toggle', reason: 'Expand details' };
    const clickRisk = assessActionRisk(clickAction, ctx, ctx.url);
    expect(clickRisk.riskLevel).toBe('LOW');
    expect(clickRisk.requiresConfirmation).toBe(false);
  });

  it('classifies modifying sensitive fields (password, account number) via type as HIGH risk', () => {
    const ctx = makeMockContext([
      {
        id: 'input_pass',
        type: 'password',
        confidence: 0.99,
        bbox: { x: 10, y: 50, width: 200, height: 35 },
        length: 10,
        source: 'dom_input_type',
        selector: '#password-field',
        is_partially_visible: false,
      },
    ]);

    const typeAction: BrowserAction = { action: 'type', target: 'input_pass', text: 'user-token' };
    const risk = assessActionRisk(typeAction, ctx, ctx.url);
    expect(risk.riskLevel).toBe('HIGH');
    expect(risk.requiresConfirmation).toBe(true);
  });

  it('escalates consequential financial or destructive operations to CRITICAL risk', () => {
    const ctx = makeMockContext([
      {
        id: 'btn_pay',
        type: 'account_number',
        confidence: 0.95,
        bbox: { x: 10, y: 100, width: 150, height: 40 },
        length: 12,
        source: 'dom_label',
        selector: '#pay-and-transfer-btn',
        is_partially_visible: false,
      },
      {
        id: 'btn_delete',
        type: 'password',
        confidence: 0.95,
        bbox: { x: 10, y: 200, width: 150, height: 40 },
        length: 8,
        source: 'dom_label',
        selector: '#delete-account-permanently',
        is_partially_visible: false,
      },
    ]);

    const payAction: BrowserAction = { action: 'click', target: 'btn_pay', reason: 'Execute transfer' };
    const payRisk = assessActionRisk(payAction, ctx, ctx.url);
    expect(payRisk.riskLevel).toBe('CRITICAL');
    expect(payRisk.requiresConfirmation).toBe(true);

    const deleteAction: BrowserAction = { action: 'click', target: 'btn_delete', reason: 'Delete account' };
    const deleteRisk = assessActionRisk(deleteAction, ctx, ctx.url);
    expect(deleteRisk.riskLevel).toBe('CRITICAL');
    expect(deleteRisk.requiresConfirmation).toBe(true);
  });

  it('escalates cross-domain navigation to HIGH risk and malformed/non-web protocols to CRITICAL', () => {
    const ctx = makeMockContext();

    const crossDomain: BrowserAction = { action: 'navigate', url: 'https://other-domain.com/login' };
    const crossRisk = assessActionRisk(crossDomain, ctx, 'https://bank.example.com/app');
    expect(crossRisk.riskLevel).toBe('HIGH');
    expect(crossRisk.requiresConfirmation).toBe(true);

    const jsNav: BrowserAction = { action: 'navigate', url: 'javascript:alert(1)' };
    const jsRisk = assessActionRisk(jsNav, ctx, ctx.url);
    expect(jsRisk.riskLevel).toBe('CRITICAL');
    expect(jsRisk.allowed).toBe(false);
  });
});
