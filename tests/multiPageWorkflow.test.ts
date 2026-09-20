import { describe, it, expect, vi } from 'vitest';
import { AgentLoop, assertNoSensitiveDataInState } from '../extension/src/agent/agentLoop';
import { CandidateProductItem } from '../extension/src/agent/agentState';
import { MockAgentProvider } from '../extension/src/agent/mockAgentProvider';
import { AgentContextPayload } from '../extension/src/privacy/types';

describe('PrivAgent Phase 10 & 11 — Multi-Page Workflow Acceptance Test', () => {
  it('executes full multi-page workflow: Landing -> Login -> Search -> Results -> Goal Verification', async () => {
    let currentPage = 'landing';
    let perceptionCount = 0;

    // Simulate page contexts based on active workflow page
    const perceivePage = vi.fn(async (): Promise<AgentContextPayload> => {
      perceptionCount++;
      if (currentPage === 'landing') {
        return {
          url: 'http://localhost:4174/index.html',
          timestamp: Date.now(),
          viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
          screenshot_dimensions: null,
          detections: [
            {
              id: 'det-login-link',
              type: 'person_name',
              confidence: 0.95,
              bbox: { x: 900, y: 20, width: 80, height: 30 },
              length: 7,
              source: 'dom_attribute',
              selector: '#link-login',
              is_partially_visible: false,
            },
          ],
          total_elements_scanned: 10,
          sensitive_elements_detected: 0,
          sanitized_status: 'sanitized_only',
          ocr_metrics: null,
        };
      } else if (currentPage === 'login') {
        return {
          url: 'http://localhost:4174/login.html',
          timestamp: Date.now(),
          viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
          screenshot_dimensions: null,
          detections: [
            {
              id: 'det-username-input',
              type: 'email',
              confidence: 0.98,
              bbox: { x: 400, y: 200, width: 300, height: 40 },
              length: 7,
              source: 'dom_input_type',
              selector: '#input-username',
              is_partially_visible: false,
            },
            {
              // Password field detected by M1 DOM privacy engine
              id: 'det-password-input',
              type: 'password',
              confidence: 1.0,
              bbox: { x: 400, y: 280, width: 300, height: 40 },
              length: 0, // Zero raw password value
              source: 'dom_input_type',
              selector: '#input-password',
              is_partially_visible: false,
            },
            {
              id: 'det-signin-btn',
              type: 'person_name',
              confidence: 0.95,
              bbox: { x: 400, y: 350, width: 300, height: 45 },
              length: 7,
              source: 'dom_attribute',
              selector: '#btn-signin',
              is_partially_visible: false,
            },
          ],
          total_elements_scanned: 15,
          sensitive_elements_detected: 1, // 1 password detected & protected locally
          sanitized_status: 'sanitized_only',
          ocr_metrics: null,
        };
      } else if (currentPage === 'search') {
        return {
          url: 'http://localhost:4174/search.html',
          timestamp: Date.now(),
          viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
          screenshot_dimensions: null,
          detections: [
            {
              id: 'det-search-input',
              type: 'person_name',
              confidence: 0.92,
              bbox: { x: 350, y: 200, width: 400, height: 45 },
              length: 0,
              source: 'dom_input_type',
              selector: '#input-search-query',
              is_partially_visible: false,
            },
            {
              id: 'det-search-btn',
              type: 'person_name',
              confidence: 0.95,
              bbox: { x: 350, y: 270, width: 400, height: 45 },
              length: 6,
              source: 'dom_attribute',
              selector: '#btn-search-submit',
              is_partially_visible: false,
            },
          ],
          total_elements_scanned: 12,
          sensitive_elements_detected: 0,
          sanitized_status: 'sanitized_only',
          ocr_metrics: null,
        };
      } else {
        // Results page with 4 deterministic products
        return {
          url: 'http://localhost:4174/results.html?q=XXL+black+baggy+bag',
          timestamp: Date.now(),
          viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
          screenshot_dimensions: null,
          detections: [
            {
              id: 'det-product-1-qualifying',
              type: 'person_name',
              confidence: 0.98,
              bbox: { x: 50, y: 100, width: 250, height: 300 },
              length: 25,
              source: 'dom_attribute',
              selector: '#product-xxl-black-baggy-bag-899',
              is_partially_visible: false,
            },
            {
              id: 'det-product-2-expensive',
              type: 'person_name',
              confidence: 0.95,
              bbox: { x: 320, y: 100, width: 250, height: 300 },
              length: 28,
              source: 'dom_attribute',
              selector: '#product-office-bag-1499',
              is_partially_visible: false,
            },
            {
              id: 'det-product-3-wrong-color',
              type: 'person_name',
              confidence: 0.95,
              bbox: { x: 590, y: 100, width: 250, height: 300 },
              length: 25,
              source: 'dom_attribute',
              selector: '#product-red-bag-699',
              is_partially_visible: false,
            },
          ],
          total_elements_scanned: 25,
          sensitive_elements_detected: 0,
          sanitized_status: 'sanitized_only',
          ocr_metrics: null,
        };
      }
    });

    const executeAction = vi.fn(async (action) => {
      // Simulate browser transitions on click
      if (action.action === 'click' && action.target === 'det-login-link') {
        currentPage = 'login';
      } else if (action.action === 'click' && action.target === 'det-signin-btn') {
        currentPage = 'search';
      } else if (action.action === 'click' && action.target === 'det-search-btn') {
        currentPage = 'results';
      }
      return { success: true };
    });

    // Mock Provider returns sequence of single actions based on active page
    const provider = new MockAgentProvider();
    provider.setCustomHandler((_task, context) => {
      if (context.url.includes('index.html')) {
        return { action: 'click', target: 'det-login-link', reason: 'Proceed to login' };
      } else if (context.url.includes('login.html')) {
        // First type, then click sign in
        const hasTyped = context.detections.some((d) => d.id === 'det-username-input');
        return { action: 'click', target: 'det-signin-btn', reason: 'Sign in securely' };
      } else if (context.url.includes('search.html')) {
        return { action: 'click', target: 'det-search-btn', reason: 'Submit search query' };
      } else {
        return { action: 'scroll', direction: 'down', amount: 300, reason: 'Inspect results' };
      }
    });

    const onNavigationComplete = vi.fn(async () => true);

    const loop = new AgentLoop(
      provider,
      {
        perceivePage,
        executeAction,
        onNavigationComplete,
      },
      { maxSteps: 8, delayBetweenStepsMs: 5 }
    );

    const task = 'Open the shopping site, login, search for an XXL black baggy bag under ₹1000, and identify qualifying products.';
    const finalState = await loop.runTask(task);

    // 1. Goal completion verified
    expect(finalState.status).toBe('SUCCESS');
    expect(finalState.goalStatus).toBe('SUCCESS');

    // 2. Constraints persisted throughout task
    expect(finalState.taskConstraints.maxPrice).toBe(1000);
    expect(finalState.taskConstraints.color).toBe('black');
    expect(finalState.taskConstraints.size).toBe('XXL');
    expect(finalState.taskConstraints.style).toBe('baggy');

    // 3. Multi-page progression verified
    expect(perceptionCount).toBeGreaterThanOrEqual(4);
    expect(finalState.currentPageGeneration).toBeGreaterThanOrEqual(3);

    // 4. Qualifying product discovered and verified
    expect(finalState.candidateItems.length).toBeGreaterThanOrEqual(1);
    const qualifying = finalState.candidateItems.find((c: CandidateProductItem) => c.matchesConstraints);
    expect(qualifying).toBeDefined();
    expect(qualifying?.price).toBe(899);
    expect(qualifying?.size).toBe('XXL');
    expect(qualifying?.color).toBe('black');

    // 5. Zero sensitive data in state (PII invariant strictly satisfied)
    expect(() => assertNoSensitiveDataInState(finalState)).not.toThrow();
  });
});
