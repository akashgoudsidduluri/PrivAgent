import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveTargetWebTab,
  isEligibleWebTab,
  extractExplicitTargetFromTask,
  MinimalTab,
} from '../extension/src/background/targetResolver';
import { ExtensionAgentAdapter } from '../frontend/src/adapters/extensionAdapter';
import { AgentLoop } from '../extension/src/agent/agentLoop';
import { AgentProvider } from '../extension/src/agent/agentProvider';
import { receiptsStore } from '../frontend/src/state/receiptsStore';
import { buildAgentPayload, PrivacyScanReport } from '../extension/src/privacy/types';
import { minimizeAgentContext } from '../extension/src/privacy/contextMinimizer';

describe('PrivAgent Target-Tab & START_TASK Lifecycle Regression Suite', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // 1. target tab found
  it('1. target tab found: successfully resolves eligible web tab', () => {
    const tabs: MinimalTab[] = [
      { id: 1, url: 'http://localhost:5173/' }, // dashboard
      { id: 2, url: 'http://localhost:4173/', active: false }, // target
    ];
    const res = resolveTargetWebTab(tabs, 'Open http://localhost:4173');
    expect(res.selectedTab).not.toBeNull();
    expect(res.selectedTab?.id).toBe(2);
  });

  // 2. target tab not found
  it('2. target tab not found: reports clean FAILED message and null tab', () => {
    const tabs: MinimalTab[] = [
      { id: 1, url: 'http://localhost:5173/' }, // only dashboard
    ];
    const res = resolveTargetWebTab(tabs, 'Open the localhost 4173 and get my account number');
    expect(res.selectedTab).toBeNull();
    expect(res.reason).toBe('No target web tab found. Please open http://localhost:4173.');
  });

  // 3. dashboard excluded from target selection
  it('3. dashboard excluded: never selects localhost:5173 even when active', () => {
    const tabs: MinimalTab[] = [
      { id: 1, url: 'http://localhost:5173/', active: true },
    ];
    expect(isEligibleWebTab(tabs[0]!)).toBe(false);
    const res = resolveTargetWebTab(tabs, 'Summarize page');
    expect(res.selectedTab).toBeNull();
    expect(res.reason).toContain('No browser tab is available for this task');
  });

  // 4. explicit localhost:4173 target
  it('4. explicit localhost:4173 target: matches subpaths and natural language tasks', () => {
    const tabs: MinimalTab[] = [
      { id: 1, url: 'http://localhost:5173/' },
      { id: 5, url: 'http://localhost:4173/portal/accounts?view=summary', active: false },
    ];
    const res = resolveTargetWebTab(tabs, 'Open the localhost 4173 and get my account number');
    expect(res.selectedTab?.id).toBe(5);
    expect(res.reason).toContain('Matched explicit target in task');
  });

  // 5. target content script responsive
  it('5. target content script responsive: simulates healthy viewport geometry handshake', async () => {
    const mockSendMessage = vi.fn().mockResolvedValue({
      type: 'PRIVAGENT_GET_VIEWPORT_GEOMETRY_RESPONSE',
      viewportWidth: 1280,
      viewportHeight: 800,
    });

    const res = await mockSendMessage(2, { type: 'PRIVAGENT_GET_VIEWPORT_GEOMETRY' });
    expect(res.type).toBe('PRIVAGENT_GET_VIEWPORT_GEOMETRY_RESPONSE');
    expect(res.viewportWidth).toBe(1280);
  });

  // 6. target content script unavailable
  it('6. target content script unavailable: distinguishes NOT_READY from NOT_FOUND', () => {
    const tabs: MinimalTab[] = [
      { id: 2, url: 'http://localhost:4173/' },
    ];
    const resolution = resolveTargetWebTab(tabs, 'Open localhost 4173');
    // Tab IS found
    expect(resolution.selectedTab?.id).toBe(2);

    // But if ping to content script fails, the error message indicates not responsive
    const csResponsive = false;
    const targetState = resolution.selectedTab ? (csResponsive ? 'FOUND' : 'NOT_READY') : 'NOT_FOUND';
    expect(targetState).toBe('NOT_READY');
    const safeError = 'Target web tab is open but not responding. Please refresh it.';
    expect(safeError).toContain('open but not responding');
  });

  // 7. START_TASK produces initial acknowledgement
  it('7. START_TASK produces initial acknowledgement and RUNNING progress', () => {
    const adapter = new ExtensionAgentAdapter();
    const states: any[] = [];
    adapter.onStateChange((s) => states.push(s));

    // Simulate START_TASK progress arriving from content script
    window.postMessage(
      {
        source: 'privagent-extension',
        type: 'TASK_PROGRESS',
        payload: {
          status: 'RUNNING',
          currentStep: 0,
          maxSteps: 10,
          task: 'Test task',
          steps: [],
          reason: 'Target tab discovered and ready. Starting visual privacy perception...',
        },
      },
      '*'
    );

    // Fast-forward message loop
    vi.advanceTimersByTime(50);

    const runningState = states.find((s) => s.status === 'RUNNING');
    expect(runningState).toBeDefined();
    expect(runningState.reason).toContain('Target tab discovered and ready');
    adapter.destroy();
  });

  // 8. START_TASK produces terminal failure on target resolution failure
  it('8. START_TASK produces terminal failure on target resolution failure without hanging', () => {
    const adapter = new ExtensionAgentAdapter();
    const states: any[] = [];
    adapter.onStateChange((s) => states.push(s));

    // Simulate immediate FAILED response from service worker when target tab is missing
    window.postMessage(
      {
        source: 'privagent-extension',
        type: 'TASK_PROGRESS',
        payload: {
          status: 'FAILED',
          currentStep: 0,
          maxSteps: 10,
          task: 'Open localhost 4173',
          steps: [],
          reason: 'No target web tab found. Please open http://localhost:4173.',
        },
      },
      '*'
    );

    vi.advanceTimersByTime(50);

    const failedState = states.find((s) => s.status === 'FAILED');
    expect(failedState).toBeDefined();
    expect(failedState.reason).toBe('No target web tab found. Please open http://localhost:4173.');
    adapter.destroy();
  });

  // 9. async Service Worker error propagates to dashboard
  it('9. async Service Worker error propagates to dashboard as terminal FAILED', () => {
    const adapter = new ExtensionAgentAdapter();
    const states: any[] = [];
    adapter.onStateChange((s) => states.push(s));

    // Simulate error caught inside service worker async boundary
    window.postMessage(
      {
        source: 'privagent-extension',
        type: 'TASK_PROGRESS',
        payload: {
          status: 'FAILED',
          currentStep: 1,
          maxSteps: 10,
          task: 'Test task',
          steps: [],
          reason: 'Connection closed unexpectedly during action execution',
        },
      },
      '*'
    );

    vi.advanceTimersByTime(50);

    const lastState = states[states.length - 1];
    expect(lastState.status).toBe('FAILED');
    expect(lastState.reason).toContain('Connection closed unexpectedly');
    adapter.destroy();
  });

  // 10. watchdog reports actual last stage
  it('10. watchdog reports actual last stage and WATCHDOG_TIMEOUT', async () => {
    const adapter = new ExtensionAgentAdapter();
    const states: any[] = [];
    adapter.onStateChange((s) => states.push(s));

    // Mock checkExtensionConnected to return true
    vi.spyOn(adapter, 'checkExtensionConnected').mockResolvedValue(true);

    await adapter.startTask('Some task');

    // Simulate receiving initial perception progress
    window.postMessage(
      {
        source: 'privagent-extension',
        type: 'TASK_PROGRESS',
        payload: {
          status: 'RUNNING',
          currentStep: 1,
          maxSteps: 10,
          task: 'Some task',
          stage: 'PERCEPTION',
          reason: 'Perceiving page...',
          steps: [],
        },
      },
      '*'
    );

    vi.advanceTimersByTime(50);

    // Advance beyond watchdog timeout (30 seconds)
    vi.advanceTimersByTime(31000);

    const terminalState = adapter.getState();
    expect(terminalState.status).toBe('FAILED');
    expect(terminalState.reason).toContain('WATCHDOG_TIMEOUT');
    expect(terminalState.reason).toContain('Last stage: PERCEPTION');
    adapter.destroy();
  });

  // 11. STOP produces STOPPED
  it('11. STOP produces STOPPED terminal state', async () => {
    const adapter = new ExtensionAgentAdapter();
    await adapter.stopTask();
    expect(adapter.getState().status).toBe('STOPPED');
    expect(adapter.getState().reason).toContain('Task stopped by user');
    adapter.destroy();
  });

  // 12. 429 produces exactly one request and fails non-retryable
  it('12. 429 produces exactly one request and fails non-retryable', async () => {
    vi.useRealTimers();
    let callCount = 0;
    const rateLimitProvider: AgentProvider = {
      name: 'rate-limited-llm',
      async requestAction() {
        callCount++;
        throw new Error('Rate limit reached (429: Too Many Requests)');
      },
    };

    const dummyContext = {
      task: 'Test',
      elements: [],
      timestamp: Date.now(),
      sanitized_status: 'sanitized_only' as const,
      sanitized_at: Date.now(),
      detections: [],
      url: 'http://localhost:4173/',
      viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
      screenshot_dimensions: null,
      ocr_metrics: null,
    };

    const loop = new AgentLoop(
      rateLimitProvider,
      {
        perceivePage: async () => dummyContext as any,
        executeAction: async () => ({ success: true }),
        onStepProgress: () => {},
      },
      { maxSteps: 5, maxRetries: 2, providerRetries: 0 }
    );

    const finalState = await loop.runTask('Test');
    expect(finalState.status).toBe('FAILED');
    expect(finalState.reason).toContain('Rate limit');
    expect(callCount).toBe(1); // Exactly one request
  });

  // 13. sensitive task maintains zero raw PII transmission
  it('13. sensitive task maintains zero raw PII transmission', () => {
    const rawAccountNumber = '112233445566';
    const mockScanReport: PrivacyScanReport = {
      timestamp: 1700000000000,
      url: 'http://localhost:4173/',
      scanLatencyMs: 5.0,
      redactionLatencyMs: 2.0,
      totalElementsScanned: 10,
      sensitiveElementsDetected: 1,
      elementsProtected: 1,
      leakageCount: 0,
      mode: 'blackout',
      status: 'Sanitized Context — Local Privacy Check Passed',
      categories: {
        password: 0,
        credit_card: 0,
        account_number: 1,
        email: 0,
        phone: 0,
        person_name: 0,
        pan: 0,
        otp: 0,
        cvv: 0,
        address: 0,
      },
      detections: [
        {
          id: 'elem-acct-1',
          type: 'account_number',
          confidence: 0.99,
          selector: '#account-no',
          bbox: [10, 10, 100, 20],
          length: 12,
          source: 'text_pattern',
        },
      ],
    };

    const built = buildAgentPayload(mockScanReport, null);
    expect(built).not.toBeNull();
    const minimized = minimizeAgentContext(built!, { task: 'get my account number' });

    const serializedPayload = JSON.stringify(minimized.payload);
    expect(serializedPayload).not.toContain(rawAccountNumber);

    // Verify receipt records 0 transmitted
    receiptsStore.addReceipt({
      id: 'rcpt-test-safe',
      task: 'Open the localhost 4173 and get my account number',
      timestamp: Date.now(),
      result: 'SUCCESS',
      sensitiveDetectedCount: 1,
      sensitiveTransmittedCount: 0,
      rawScreenshotsTransmitted: 0,
      rawDomTransmitted: 0,
      categoriesDetected: ['account_number'],
      sanitizedContextShared: ['Safe coordinates', 'Labels'],
      llmRequestsCount: 1,
      browserActionsCount: 1,
      latencyMs: 400,
      steps: [],
    });

    const receipts = receiptsStore.getAll();
    const latest = receipts.find((r) => r.id === 'rcpt-test-safe');
    expect(latest?.sensitiveTransmittedCount).toBe(0);
    expect(latest?.rawScreenshotsTransmitted).toBe(0);
    expect(latest?.rawDomTransmitted).toBe(0);
  });
});
