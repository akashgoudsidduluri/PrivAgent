import { describe, it, expect } from 'vitest';
import { verifyTaskGoal } from '../extension/src/agent/goalVerifier';
import { createAgentTaskState } from '../extension/src/agent/agentState';
import { AgentContextPayload } from '../extension/src/privacy/types';

function createMockContext(url: string, detections: any[] = []): AgentContextPayload {
  return {
    url,
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

describe('PrivAgent Phase 3 — Verified Goal Completion', () => {
  it('verifies Google search goal only when actual search query param exists in results URL', () => {
    const task = 'Search google for cats';
    const state = createAgentTaskState(task, { currentUrl: 'https://www.google.com' });

    // Pre-search state: on google.com home page
    const homeCtx = createMockContext('https://www.google.com');
    expect(verifyTaskGoal(task, state, homeCtx).satisfied).toBe(false);

    // Results state: URL contains q=cats
    const resultsCtx = createMockContext('https://www.google.com/search?q=cats');
    const res = verifyTaskGoal(task, state, resultsCtx);
    expect(res.satisfied).toBe(true);
    expect(res.status).toBe('SUCCESS');
    expect(res.reason).toContain('cats');
  });

  it('verifies shopping goal when a candidate matching all constraints is discovered on results page', () => {
    const task = 'Find an XXL black baggy bag under ₹1000';
    const state = createAgentTaskState(task, {
      constraints: {
        category: 'bag',
        color: 'black',
        size: 'XXL',
        style: 'baggy',
        maxPrice: 1000,
        currency: '₹',
      },
    });

    // 1. Initial search page — no candidates yet
    const searchCtx = createMockContext('http://localhost:4174/search.html');
    expect(verifyTaskGoal(task, state, searchCtx).satisfied).toBe(false);

    // 2. Results page with qualifying product detection
    const resultsCtx = createMockContext('http://localhost:4174/results.html', [
      {
        id: 'det-1',
        type: 'person_name', // non-sensitive element type used by M4
        confidence: 0.95,
        bbox: { x: 10, y: 10, width: 200, height: 100 },
        length: 20,
        source: 'dom_attribute',
        selector: '#product-xxl-black-baggy-bag-899',
        is_partially_visible: false,
      },
    ]);

    const res = verifyTaskGoal(task, state, resultsCtx);
    expect(res.satisfied).toBe(true);
    expect(res.status).toBe('SUCCESS');
    expect(res.verifiedCandidates?.length).toBe(1);
    expect(res.verifiedCandidates?.[0]?.price).toBe(899);
  });

  it('rejects goal completion when candidate violates price or color constraints', () => {
    const task = 'Find an XXL black bag under ₹1000';
    const state = createAgentTaskState(task, {
      constraints: {
        color: 'black',
        size: 'XXL',
        maxPrice: 1000,
      },
    });

    // Results page containing only expensive bag (₹1499) and blue bag (₹950)
    const nonMatchingCtx = createMockContext('http://localhost:4174/results.html', [
      {
        id: 'det-1',
        type: 'address',
        confidence: 0.9,
        bbox: { x: 10, y: 10, width: 200, height: 100 },
        length: 20,
        source: 'dom_attribute',
        selector: '#product-office-bag-1499', // fails price
        is_partially_visible: false,
      },
      {
        id: 'det-2',
        type: 'address',
        confidence: 0.9,
        bbox: { x: 10, y: 10, width: 200, height: 100 },
        length: 20,
        source: 'dom_attribute',
        selector: '#product-blue-bag-950', // fails color
        is_partially_visible: false,
      },
    ]);

    const res = verifyTaskGoal(task, state, nonMatchingCtx);
    expect(res.satisfied).toBe(false);
    expect(res.status).toBe('IN_PROGRESS');
  });

  it('verifies login completion when URL transitions away from login page after credential submission', () => {
    const task = 'Login to shopping portal';
    const state = createAgentTaskState(task, { currentUrl: 'http://localhost:4174/login.html' });

    // Step 1: on login page
    state.steps.push({
      step: 1,
      action: { action: 'type', target: 'input-username', text: 'shopper' },
      validationAllowed: true,
      validationReason: 'Valid',
      executionSuccess: true,
      url: 'http://localhost:4174/login.html',
      timestamp: Date.now(),
    });
    state.previousActions.push({ action: 'type', target: 'input-username', text: 'shopper' });
    state.previousActions.push({ action: 'click', target: 'btn-signin' });

    // Login verified when page is now authenticated at search.html
    const postLoginCtx = createMockContext('http://localhost:4174/search.html');
    const res = verifyTaskGoal(task, state, postLoginCtx);
    expect(res.satisfied).toBe(true);
    expect(res.status).toBe('SUCCESS');
  });
});
