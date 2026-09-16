import { describe, it, expect } from 'vitest';
import { recoverStaleTarget } from '../extension/src/agent/selfHealing';
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

describe('PrivAgent Self-Healing Target Recovery (Feature 4)', () => {
  it('recovers a mutated target selector by label / selector token similarity', () => {
    const liveDetections: AgentDetection[] = [
      {
        id: 'det_new_account_details_btn',
        type: 'account_number',
        confidence: 0.95,
        bbox: { x: 50, y: 100, width: 220, height: 45 },
        length: 12,
        source: 'dom_label',
        selector: '#btn-account-details-view-v2',
        is_partially_visible: false,
      },
    ];
    const ctx = makeMockContext(liveDetections);

    const failedAction: BrowserAction = {
      action: 'click',
      target: 'det_old_account_details',
      reason: 'account details view',
    };

    const recovery = recoverStaleTarget(
      'det_old_account_details',
      failedAction,
      ctx,
      'Open account details'
    );

    expect(recovery.recovered).toBe(true);
    expect(recovery.recoveredTargetId).toBe('det_new_account_details_btn');
    expect(recovery.confidence).toBeGreaterThanOrEqual(0.40);
    expect(recovery.recoveredAction).toBeDefined();
    expect((recovery.recoveredAction as any).target).toBe('det_new_account_details_btn');
  });

  it('fails safely with NONE strategy when no plausible match exists', () => {
    const liveDetections: AgentDetection[] = [
      {
        id: 'det_logout_link',
        type: 'password',
        confidence: 0.8,
        bbox: { x: 900, y: 10, width: 80, height: 25 },
        length: 6,
        source: 'dom_label',
        selector: '#logout-btn',
        is_partially_visible: false,
      },
    ];
    const ctx = makeMockContext(liveDetections);

    const failedAction: BrowserAction = {
      action: 'click',
      target: 'det_nonexistent_table',
      reason: 'Inspect monthly statement table',
    };

    const recovery = recoverStaleTarget('det_nonexistent_table', failedAction, ctx);

    expect(recovery.recovered).toBe(false);
    expect(recovery.strategy).toBe('NONE');
    expect(recovery.recoveredTargetId).toBeUndefined();
  });
});
