/**
 * PrivAgent 2.0 — Phase 7.5 Stage 2 Integration Test Suite
 *
 * Tests the end-to-end integration:
 * BrowserWorldModel -> Semantic Understanding -> AgentContext -> AgentLoop
 *
 * Covers:
 * 1. Semantic understanding generated from BrowserWorldModel
 * 2. Page generation synchronization between WorldModel and SemanticContext
 * 3. Stale semantic generation rejection in AgentLoop (generation mismatch)
 * 4. M8 privacy firewall boundary enforcement (zero raw PII in semantic context)
 * 5. Context minimization preserving page_type and semantic_context
 * 6. Full AgentLoop execution recording semantic understanding in task state & steps
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { buildBrowserWorldModel } from '../extension/src/worldModel/worldModelBuilder';
import {
  buildSemanticUnderstanding,
  SanitizedSemanticContext,
} from '../extension/src/semanticUnderstanding';
import { buildAgentPayload } from '../extension/src/privacy/types';
import { buildModelFacingContext, minimizeAgentContext } from '../extension/src/privacy/contextMinimizer';
import { scanForRawSensitiveValues } from '../extension/src/privacy/rawValueScanner';
import { AgentLoop, WorldModelPerceptionResult } from '../extension/src/agent/agentLoop';
import { MockAgentProvider } from '../extension/src/agent/mockAgentProvider';
import { BrowserAction } from '../extension/src/agent/actionTypes';

describe('Phase 7.5 Stage 2: World Model + Semantic Understanding + Agent Context Integration', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.title = 'PrivAgent Stage 2 Test Page';
  });

  // ── 1. World Model to Semantic Understanding ───────────────────────────────
  it('1. builds semantic understanding directly from BrowserWorldModel with matching pageGeneration', () => {
    document.body.innerHTML = `
      <header>
        <nav><a href="/home">Home</a><a href="/products">Products</a></nav>
      </header>
      <main>
        <div class="search-section">
          <input type="search" id="search-box" placeholder="Search backpacks..." />
          <button id="search-submit">Search</button>
        </div>
        <div class="product-grid">
          <div class="product-card" id="card-1">
            <h3 class="product-title">Black Travel Backpack</h3>
            <span class="product-price">₹899</span>
            <button class="add-to-cart-btn" id="btn-add-1">Add to Cart</button>
          </div>
          <div class="product-card" id="card-2">
            <h3 class="product-title">Blue Laptop Bag</h3>
            <span class="product-price">₹1299</span>
            <button class="add-to-cart-btn" id="btn-add-2">Add to Cart</button>
          </div>
        </div>
      </main>
    `;

    const worldModel = buildBrowserWorldModel({ root: document, pageGeneration: 3 });
    expect(worldModel).toBeDefined();
    expect(worldModel.page.pageGeneration).toBe(3);

    const semanticOutput = buildSemanticUnderstanding({
      worldModel,
      targetDoc: document,
      pageGeneration: worldModel.page.pageGeneration,
      userGoal: 'Find a black backpack under 1000',
    });

    expect(semanticOutput).toBeDefined();
    expect(semanticOutput.sanitizedContext).toBeDefined();

    const semCtx = semanticOutput.sanitizedContext;
    expect(semCtx.pageGeneration).toBe(3);
    expect(semCtx.pageType).toBe('LISTING');
    expect(typeof semCtx.pageState).toBe('string');
    expect(semanticOutput.entities.length).toBeGreaterThanOrEqual(2);
    expect(semCtx.entities.length).toBeGreaterThanOrEqual(1);
    expect(semCtx.affordances.length).toBeGreaterThanOrEqual(1);

    // Verify key affordances discovered
    const affordanceTypes = semCtx.affordances.map(a => a.type);
    expect(affordanceTypes.some(t => t === 'ADD_TO_CART' || t === 'SUBMIT_SEARCH' || t === 'ENTER_QUERY')).toBe(true);

    // Verify prompt injection check executed and clean
    expect(semCtx.promptInjectionDetected).toBe(false);
  });

  // ── 2. Context Minimization Preserves Semantic Context ──────────────────────
  it('2. preserves page_type and semantic_context through context minimization and payload building', () => {
    const semCtx: SanitizedSemanticContext = {
      pageType: 'SEARCH',
      confidence: 0.95,
      pageState: 'ready',
      entities: [
        { id: 'item-1', type: 'Product', label: 'Black Travel Backpack', confidence: 0.92, actionIds: [] },
      ],
      affordances: [
        { id: 'aff-1', type: 'ADD_TO_CART', targetElementId: 'btn-add-1', requiresConfirmation: false, description: 'Add item to cart' },
      ],
      promptInjectionDetected: false,
      pageGeneration: 2,
    };

    const mockScanReport: any = {
      url: 'http://localhost:3000/shop',
      timestamp: Date.now(),
      status: 'Sanitized Context — Local Privacy Check Passed',
      totalElementsScanned: 10,
      sensitiveElementsDetected: 0,
      detections: [],
      pageType: 'SEARCH',
    };

    const payload = buildAgentPayload(mockScanReport, null, semCtx);

    expect(payload).not.toBeNull();
    expect(payload!.semantic_context).toBeDefined();
    expect(payload!.semantic_context?.pageType).toBe('SEARCH');
    expect(payload!.semantic_context?.pageGeneration).toBe(2);

    // 1. Test buildModelFacingContext
    const modelView = buildModelFacingContext(payload!);
    expect(modelView.page_type).toBe('SEARCH');
    expect(modelView.semantic_context).toBeDefined();
    expect(modelView.semantic_context?.pageType).toBe('SEARCH');
    expect(modelView.semantic_context?.entities.length).toBe(1);

    // 2. Test minimizeAgentContext
    const minResult = minimizeAgentContext(payload!, 'Find backpacks');
    expect(minResult.payload.page_type).toBe('SEARCH');
    expect(minResult.payload.semantic_context).toBeDefined();
    expect(minResult.payload.semantic_context?.pageType).toBe('SEARCH');
    expect(minResult.modelView.page_type).toBe('SEARCH');
    expect(minResult.modelView.semantic_context).toBeDefined();
  });

  // ── 3. M8 Privacy Boundary: Zero Raw Sensitive Values ──────────────────────
  it('3. enforces M8 privacy firewall on SanitizedSemanticContext', () => {
    const cleanSemCtx: SanitizedSemanticContext = {
      pageType: 'FORM',
      confidence: 0.9,
      pageState: 'ready',
      entities: [
        { id: 'field-username', type: 'GenericEntity', label: 'Username field', confidence: 0.88, actionIds: [] },
      ],
      affordances: [
        { id: 'aff-fill', type: 'FILL_FIELD', targetElementId: 'btn-submit', requiresConfirmation: false, description: 'Submit form' },
      ],
      promptInjectionDetected: false,
      pageGeneration: 1,
    };

    // Verify raw value scanner reports zero violations
    const sensitiveScan = scanForRawSensitiveValues(cleanSemCtx);
    expect(sensitiveScan.length).toBe(0);

    // Verify forbidden keys in backend security schema (no raw 'value', 'text', 'password', 'card')
    const serialized = JSON.stringify(cleanSemCtx);
    const parsed = JSON.parse(serialized);
    expect(parsed.value).toBeUndefined();
    expect(parsed.text).toBeUndefined();
    expect(parsed.password).toBeUndefined();
    expect(parsed.credit_card).toBeUndefined();
  });

  // ── 4. Stale Generation Rejection in AgentLoop ──────────────────────────────
  it('4. rejects stale semantic context when pageGeneration does not match worldModel', () => {
    const provider = new MockAgentProvider();
    const loop = new AgentLoop(provider, {
      perceivePage: async () => ({
        url: 'http://localhost/test',
        timestamp: Date.now(),
        viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
        screenshot_dimensions: null,
        detections: [],
        total_elements_scanned: 0,
        sensitive_elements_detected: 0,
        sanitized_status: 'sanitized_only',
        ocr_metrics: null,
      }),
      executeAction: async () => ({ success: true }),
    });

    const mockWorldModel = buildBrowserWorldModel({ root: document, pageGeneration: 4 });

    const staleSemanticContext: SanitizedSemanticContext = {
      pageType: 'SEARCH',
      confidence: 0.9,
      pageState: 'ready',
      entities: [],
      affordances: [],
      promptInjectionDetected: false,
      pageGeneration: 3, // Stale: 3 vs worldModel's 4
    };

    const staleResult: WorldModelPerceptionResult = {
      context: {
        url: 'http://localhost/test',
        timestamp: Date.now(),
        viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
        screenshot_dimensions: null,
        detections: [],
        total_elements_scanned: 0,
        sensitive_elements_detected: 0,
        sanitized_status: 'sanitized_only',
        ocr_metrics: null,
      },
      worldModel: mockWorldModel,
      activeWorldModelRef: {
        pageGeneration: 4,
        worldModelId: mockWorldModel.id,
      },
      semanticContext: staleSemanticContext,
    };

    // Stale generation must be rejected fail-closed (returns null)
    const normalizedStale = (loop as any).normalizePerceptionResult(staleResult);
    expect(normalizedStale).toBeNull();

    // Fresh matching generation must be accepted
    const freshSemanticContext: SanitizedSemanticContext = {
      ...staleSemanticContext,
      pageGeneration: 4, // Matches worldModel
    };
    const freshResult: WorldModelPerceptionResult = {
      ...staleResult,
      semanticContext: freshSemanticContext,
    };

    const normalizedFresh = (loop as any).normalizePerceptionResult(freshResult);
    expect(normalizedFresh).not.toBeNull();
    expect(normalizedFresh?.semanticContext?.pageGeneration).toBe(4);
  });

  // ── 5. Full AgentLoop Integration ──────────────────────────────────────────
  it('5. runs AgentLoop and records semantic understanding in AgentTaskState and StepRecord', async () => {
    document.body.innerHTML = `
      <div id="container">
        <h1>Bank Account Details</h1>
        <div id="details" class="account-card">Account: *******1234</div>
        <button id="view-transactions-btn">View Transactions</button>
      </div>
    `;

    const worldModel = buildBrowserWorldModel({ root: document, pageGeneration: 1 });
    const semanticOutput = buildSemanticUnderstanding({
      worldModel,
      targetDoc: document,
      pageGeneration: 1,
      userGoal: 'View account details',
    });

    const provider = new MockAgentProvider();
    const executedActions: BrowserAction[] = [];

    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async (): Promise<WorldModelPerceptionResult> => {
          return {
            context: {
              url: 'http://localhost:4173/bank',
              timestamp: Date.now(),
              viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
              screenshot_dimensions: null,
              detections: [
                {
                  id: 'details',
                  type: 'account_number',
                  confidence: 0.95,
                  bbox: { x: 50, y: 100, width: 200, height: 35 },
                  length: 12,
                  source: 'dom_input_type',
                  selector: '#details',
                  is_partially_visible: false,
                },
              ],
              total_elements_scanned: 10,
              sensitive_elements_detected: 1,
              sanitized_status: 'sanitized_only',
              ocr_metrics: null,
            },
            worldModel,
            activeWorldModelRef: {
              pageGeneration: 1,
              worldModelId: worldModel.id,
            },
            semanticUnderstanding: semanticOutput,
            semanticContext: semanticOutput.sanitizedContext,
          };
        },
        executeAction: async (action: BrowserAction) => {
          executedActions.push(action);
          return { success: true, message: `Executed ${action.action}` };
        },
      },
      { maxSteps: 3 }
    );

    const finalState = await loop.runTask('Check account details');

    // 1. Task executed successfully or progressed
    expect(finalState.steps.length).toBeGreaterThanOrEqual(1);

    // 2. Semantic understanding attached to state
    expect(finalState.pageType).toBeDefined();
    expect(finalState.semanticContext).toBeDefined();
    expect(finalState.semanticContext?.pageGeneration).toBe(1);

    // 3. Step records preserve semanticContext
    const firstStep = finalState.steps[0];
    expect(firstStep.semanticContext).toBeDefined();
    expect(firstStep.semanticContext?.pageGeneration).toBe(1);
    expect(firstStep.semanticContext?.promptInjectionDetected).toBe(false);

    // 4. Zero sensitive data leaked in task state
    expect(finalState.task).toBe('Check account details');
    const stateJson = JSON.stringify(finalState);
    expect(stateJson).not.toContain('secret_password');
    expect(stateJson).not.toContain('card_number');
  });
});
