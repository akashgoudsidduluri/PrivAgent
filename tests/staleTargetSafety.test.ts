import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../extension/src/agent/agentLoop';
import { MockAgentProvider } from '../extension/src/agent/mockAgentProvider';
import { AgentContextPayload } from '../extension/src/privacy/types';
import { validateAction } from '../extension/src/agent/actionValidator';

function createMockContext(pageUrl: string, elementIds: string[]): AgentContextPayload {
  return {
    url: pageUrl,
    timestamp: Date.now(),
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: null,
    detections: elementIds.map((id, idx) => ({
      id,
      type: 'account_number',
      confidence: 0.95,
      bbox: { x: 50, y: 50 + idx * 50, width: 200, height: 35 },
      length: 12,
      source: 'dom_attribute',
      selector: `#${id}`,
      is_partially_visible: false,
    })),
    total_elements_scanned: elementIds.length,
    sensitive_elements_detected: elementIds.length,
    sanitized_status: 'sanitized_only',
    ocr_metrics: null,
  };
}

describe('PrivAgent Phase 5 — Stale Target Rejection & Page Generation Safety', () => {
  it('M5 local validator rejects actions targeting elements from previous page context', () => {
    // Page Generation 1 context (Landing page with login button)
    const page1Context = createMockContext('http://localhost:4174/index.html', ['btn-login-cta']);

    // Valid action for Page 1
    const validPage1Action = { action: 'click', target: 'btn-login-cta' };
    expect(validateAction(validPage1Action, page1Context).allowed).toBe(true);

    // Page Generation 2 context (Login page with sign in button; btn-login-cta no longer exists!)
    const page2Context = createMockContext('http://localhost:4174/login.html', ['input-username', 'btn-signin']);

    // Stale action attempting to target old element on the new page
    const staleAction = { action: 'click', target: 'btn-login-cta' };
    const validation = validateAction(staleAction, page2Context);

    expect(validation.allowed).toBe(false);
    expect(validation.reason).toContain('does not exist in the current sanitized context');
  });

  it('AgentLoop clears stale element IDs on page transition and perceives fresh targets', async () => {
    const provider = new MockAgentProvider();
    let currentStep = 0;

    // Simulation: Step 0 is Landing; Step 1 is Search
    const perceivePage = vi.fn(async () => {
      if (currentStep === 0) {
        return createMockContext('http://localhost:4174/index.html', ['btn-shop-now']);
      }
      return createMockContext('http://localhost:4174/search.html', ['input-search-query', 'btn-search-submit']);
    });

    const executeAction = vi.fn(async (action) => {
      currentStep++;
      return { success: true };
    });

    // Step 0 proposes clicking btn-shop-now
    provider.setNextAction({ action: 'click', target: 'btn-shop-now' });

    const loop = new AgentLoop(
      provider,
      {
        perceivePage,
        executeAction,
        onNavigationComplete: async () => true,
      },
      { maxSteps: 2, delayBetweenStepsMs: 5 }
    );

    const state = await loop.runTask('Browse Catalog');

    // Visited element IDs were recorded on the step
    expect(state.steps.length).toBeGreaterThanOrEqual(1);
    expect(state.steps[0]?.targetId).toBe('btn-shop-now');
    expect(state.currentPageGeneration).toBeGreaterThanOrEqual(1);
  });
});
