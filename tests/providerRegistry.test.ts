/**
 * PrivAgent — Reasoning Provider Registry & Abstraction Test Suite
 *
 * Proves the provider-space contract WITHOUT any live network call:
 *   1. The registry declares the production provider (backend → Gemma) and the
 *      offline provider (mock), and keeps client-side-key providers out of the
 *      popup.
 *   2. Provider selection is configuration-driven and returns the expected
 *      provider implementations.
 *   3. A provider that needs a client-side API key can only be constructed with
 *      an explicit dev/test opt-in — the extension can never silently hold a key.
 *   4. M6 `AgentLoop` depends ONLY on the `AgentProvider` interface: swapping the
 *      provider does not change loop behavior, steps, or the M5 gates.
 *   5. Every registered provider re-asserts the sanitized-context boundary
 *      before any network I/O (no raw values, no raw text, no screenshot data).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AGENT_PROVIDERS,
  ProviderRegistryError,
  createAgentProvider,
  describeProvider,
  getProviderDescriptor,
  listAgentProviders,
} from '../extension/src/agent/providerRegistry';
import { AgentProvider } from '../extension/src/agent/agentProvider';
import { AgentLoop } from '../extension/src/agent/agentLoop';
import { MockAgentProvider } from '../extension/src/agent/mockAgentProvider';
import { OpenRouterProvider, DEFAULT_OPENROUTER_MODEL } from '../extension/src/agent/openRouterProvider';
import { BackendAgentProvider } from '../extension/src/agent/backendAgentProvider';
import { AgentContextPayload } from '../extension/src/privacy/types';
import { BrowserAction } from '../extension/src/agent/actionTypes';

const CONTEXT: AgentContextPayload = {
  url: 'https://bank.example.com/portal',
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
  ],
  total_elements_scanned: 15,
  sensitive_elements_detected: 1,
  sanitized_status: 'sanitized_only',
  ocr_metrics: null,
};

const TASK = 'Find and click the account number field';

function backendCompletion(url?: string): Response {
  if (url && url.endsWith('/review')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ safe: true, reason: 'Safe' }),
    } as unknown as Response;
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      action: { action: 'click', target: 'element_account_num', reason: 'Click account number.' },
      reason: 'ok',
      telemetry: { provider: 'openrouter', model: DEFAULT_OPENROUTER_MODEL, latency_ms: 1, attempts: 1 },
    }),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Provider registry declaration', () => {
  it('registers the production backend provider as the selectable default', () => {
    const selectable = listAgentProviders({ selectableOnly: true }).map((d) => d.id);
    expect(selectable).toContain('backend');
    expect(selectable).toContain('mock');
    expect(selectable[0]).toBe('backend');
  });

  it('keeps client-side-key providers out of the popup selector', () => {
    const openrouter = AGENT_PROVIDERS.openrouter;
    expect(openrouter.requiresClientApiKey).toBe(true);
    expect(openrouter.selectableInPopup).toBe(false);
    expect(openrouter.kind).toBe('remote');
  });

  it('describes every registered provider with provider-agnostic telemetry metadata', () => {
    for (const descriptor of listAgentProviders()) {
      expect(descriptor.id).toBeTruthy();
      expect(descriptor.label).toBeTruthy();
      expect(['local_process', 'remote']).toContain(descriptor.kind);
      expect(typeof descriptor.create).toBe('function');
    }
    expect(getProviderDescriptor('backend')?.id).toBe('backend');
  });
});

describe('createAgentProvider (configuration-driven selection)', () => {
  it('builds the production backend provider by configuration', () => {
    const provider = createAgentProvider({ provider: 'backend' });
    expect(provider).toBeInstanceOf(BackendAgentProvider);
    expect(provider.name).toBe('BackendAgentProvider');
  });

  it('builds the offline mock provider by configuration', () => {
    const provider = createAgentProvider({ provider: 'mock' });
    expect(provider).toBeInstanceOf(MockAgentProvider);
    expect(describeProvider(provider)).toMatchObject({ provider: 'MockAgentProvider' });
  });

  it('refuses to build a client-side-key provider without an explicit dev/test opt-in', () => {
    expect(() => createAgentProvider({ provider: 'openrouter', apiKey: 'test-key' })).toThrow(
      ProviderRegistryError
    );
  });

  it('builds the direct provider only with the explicit opt-in and a key', () => {
    expect(() =>
      createAgentProvider({ provider: 'openrouter' }, { allowClientSideApiKey: true })
    ).toThrow(ProviderRegistryError);

    const provider = createAgentProvider(
      { provider: 'openrouter', apiKey: 'test-key', model: 'vendor/model-x' },
      { allowClientSideApiKey: true }
    );
    expect(provider).toBeInstanceOf(OpenRouterProvider);
    // Provider-specific model is carried as telemetry, not branched on by M6.
    expect(describeProvider(provider)).toEqual({
      provider: 'OpenRouterProvider',
      model: 'vendor/model-x',
    });
  });

  it('rejects unregistered provider ids', () => {
    expect(() =>
      createAgentProvider({ provider: 'not-a-provider' as never })
    ).toThrow(/Unknown reasoning provider/);
  });
});

describe('M6 is provider-agnostic (one loop, swappable provider)', () => {
  it('produces identical loop outcomes for backend→Gemma, mock, and a future provider', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => backendCompletion(url)));

    // A stand-in for "Provider B": same interface, different reasoning backend.
    const futureProvider: AgentProvider = {
      name: 'FutureProvider',
      model: 'vendor/future-model',
      async requestAction(): Promise<BrowserAction> {
        return { action: 'click', target: 'element_account_num', reason: 'Future provider click.' };
      },
    };

    const providers: AgentProvider[] = [
      createAgentProvider({ provider: 'backend' }),
      createAgentProvider({ provider: 'mock' }),
      futureProvider,
    ];

    const outcomes: Array<{ status: string; steps: number; attempts: number; action: BrowserAction }> = [];

    for (const provider of providers) {
      const executed: BrowserAction[] = [];
      const loop = new AgentLoop(provider, {
        perceivePage: async () => CONTEXT,
        executeAction: async (action) => {
          executed.push(action);
          return { success: true };
        },
      }, { maxSteps: 5, delayBetweenStepsMs: 1, providerRetries: 1, providerRetryDelayMs: 1 });

      const state = await loop.runTask(TASK);
      outcomes.push({
        status: state.status,
        steps: state.steps.length,
        attempts: state.providerAttempts,
        action: executed[0] as BrowserAction,
      });
    }

    // Same task + same sanitized context ⇒ same M6 outcome regardless of model.
    // (Only the free-text `reason` is provider-specific; the loop, the M5 gates,
    // and the executed action contract are identical.)
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('SUCCESS');
      expect(outcome.steps).toBe(1);
      expect(outcome.attempts).toBe(1);
      expect(outcome.action).toMatchObject({ action: 'click', target: 'element_account_num' });
    }
  });

  it('the M5 gates still reject a hallucinated target from any provider', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            action: { action: 'click', target: 'element_invented_xyz' },
            reason: 'ok',
          }),
        }) as unknown as Response
      )
    );

    const loop = new AgentLoop(createAgentProvider({ provider: 'backend' }), {
      perceivePage: async () => CONTEXT,
      executeAction: async () => ({ success: true }),
    }, { maxSteps: 3, maxRetries: 0, delayBetweenStepsMs: 1 });

    const state = await loop.runTask(TASK);
    expect(state.status).toBe('FAILED');
    expect(state.previousActions).toEqual([]);
    expect(state.reason).toMatch(/does not exist in the current sanitized context/i);
  });
});

describe('Sanitized context remains the provider boundary', () => {
  it('every registered provider refuses a context carrying a raw sensitive value', async () => {
    const fetchMock = vi.fn(async (url: string) => backendCompletion(url));
    vi.stubGlobal('fetch', fetchMock);

    // Defense-in-depth fixture: a raw value that must never leave the device.
    const unsafeContext = {
      ...CONTEXT,
      detections: [{ ...CONTEXT.detections[0]!, value: '123456789012' }],
    } as unknown as AgentContextPayload;

    const providers: AgentProvider[] = [
      createAgentProvider({ provider: 'backend' }),
      createAgentProvider({ provider: 'mock' }),
      createAgentProvider(
        { provider: 'openrouter', apiKey: 'test-key' },
        { allowClientSideApiKey: true }
      ),
    ];

    for (const provider of providers) {
      await expect(provider.requestAction(TASK, unsafeContext)).rejects.toThrow(/forbidden key/i);
    }

    // Blocked locally: no provider transport was ever opened.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
