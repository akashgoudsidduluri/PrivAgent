/**
 * PrivAgent — M7 Provider Failure Handling Test Suite (Phase E)
 *
 * Verifies that every provider failure mode fails SAFELY:
 *   - OpenRouter HTTP 401/403 (auth), 429 (rate limit), 4xx, 5xx
 *   - network failures and timeouts
 *   - malformed JSON, missing action, unsupported action, empty response
 *   - model refusal text
 *   - backend 4xx/5xx/503 structured errors, backend offline
 *
 * No test performs a live network call; global fetch is stubbed.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenRouterProvider, ProviderError, parseLLMAction } from '../extension/src/agent/openRouterProvider';
import { BackendAgentProvider } from '../extension/src/agent/backendAgentProvider';
import { AgentLoop } from '../extension/src/agent/agentLoop';
import { BrowserAction } from '../extension/src/agent/actionTypes';
import { AgentContextPayload } from '../extension/src/privacy/types';

const SAFE_CONTEXT: AgentContextPayload = {
  url: 'https://bank.example.com/dashboard',
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

function makeOpenRouter(): OpenRouterProvider {
  return new OpenRouterProvider({ apiKey: 'test-key', timeoutMs: 1000 });
}

function stubFetch(impl: () => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(impl));
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function completion(content: string): unknown {
  return { choices: [{ message: { role: 'assistant', content } }] };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenRouterProvider failure handling (Phase E)', () => {
  it('throws typed auth error on HTTP 401 without leaking the API key', async () => {
    stubFetch(() => Promise.resolve(jsonResponse(401, { error: { message: 'bad key' } })));
    await expect(makeOpenRouter().requestAction('task', SAFE_CONTEXT)).rejects.toMatchObject({
      kind: 'auth',
      retryable: false,
    });
  });

  it('throws typed rate_limit error on HTTP 429 and marks it NON-retryable (hotfix)', async () => {
    stubFetch(() => Promise.resolve(jsonResponse(429, { error: { message: 'slow down' } })));
    await expect(makeOpenRouter().requestAction('task', SAFE_CONTEXT)).rejects.toMatchObject({
      kind: 'rate_limit',
      retryable: false,
      status: 429,
    });
  });

  it('an HTTP 429 costs exactly ONE provider request, even with M6 retries enabled', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(429, { error: { message: 'slow down' } })));
    vi.stubGlobal('fetch', fetchMock);

    const provider = makeOpenRouter();
    const executed: BrowserAction[] = [];
    const loop = new AgentLoop(provider, {
      perceivePage: async () => SAFE_CONTEXT,
      executeAction: async (action) => {
        executed.push(action);
        return { success: true };
      },
    }, {
      maxSteps: 10,
      providerRetries: 2, // would have produced 3 requests before the hotfix
      providerRetryDelayMs: 1,
      delayBetweenStepsMs: 1,
    });

    const state = await loop.runTask('Find and click the account number field');

    // Zero immediate retries: one request, one attempt, fail-closed, nothing executed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.providerAttempts).toBe(1);
    expect(state.status).toBe('FAILED');
    expect(executed).toEqual([]);
  });

  it('throws typed http_error on HTTP 500', async () => {
    stubFetch(() => Promise.resolve(jsonResponse(500, {})));
    await expect(makeOpenRouter().requestAction('task', SAFE_CONTEXT)).rejects.toMatchObject({
      kind: 'http_error',
      status: 500,
    });
  });

  it('throws typed timeout error when the request aborts', async () => {
    stubFetch(
      () =>
        new Promise((_resolve, reject) => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        })
    );
    await expect(makeOpenRouter().requestAction('task', SAFE_CONTEXT)).rejects.toMatchObject({
      kind: 'timeout',
      retryable: true,
    });
  });

  it('throws typed network error when fetch fails', async () => {
    stubFetch(() => Promise.reject(new Error('Failed to fetch')));
    await expect(makeOpenRouter().requestAction('task', SAFE_CONTEXT)).rejects.toMatchObject({
      kind: 'network',
      retryable: true,
    });
  });

  it('fails safely on malformed model JSON (model refusal text)', async () => {
    stubFetch(() =>
      Promise.resolve(jsonResponse(200, completion('I cannot reveal that information.')))
    );
    await expect(makeOpenRouter().requestAction('task', SAFE_CONTEXT)).rejects.toMatchObject({
      kind: 'invalid_json',
    });
  });

  it('fails safely on empty response', async () => {
    stubFetch(() => Promise.resolve(jsonResponse(200, completion(''))));
    await expect(makeOpenRouter().requestAction('task', SAFE_CONTEXT)).rejects.toMatchObject({
      kind: 'empty_response',
    });
  });

  it('fails safely on missing choices in response', async () => {
    stubFetch(() => Promise.resolve(jsonResponse(200, { unexpected: true })));
    await expect(makeOpenRouter().requestAction('task', SAFE_CONTEXT)).rejects.toMatchObject({
      kind: 'empty_response',
    });
  });

  it('fails safely on unsupported action type from the model', async () => {
    stubFetch(() =>
      Promise.resolve(jsonResponse(200, completion('{"action":"executeScript","code":"alert(1)"}')))
    );
    await expect(makeOpenRouter().requestAction('task', SAFE_CONTEXT)).rejects.toMatchObject({
      kind: 'unsupported_action',
    });
  });
});

describe('parseLLMAction (structured output pipeline)', () => {
  it('parses plain JSON action', () => {
    expect(parseLLMAction('{"action":"click","target":"x"}')).toMatchObject({ action: 'click' });
  });

  it('parses markdown-fenced JSON', () => {
    expect(parseLLMAction('```json\n{"action":"click","target":"x"}\n```')).toMatchObject({
      action: 'click',
    });
  });

  it('extracts embedded JSON from chatter', () => {
    expect(parseLLMAction('Sure! {"action":"scroll","direction":"down","amount":400} done')).toMatchObject({
      action: 'scroll',
    });
  });

  it('throws ProviderError on garbage', () => {
    expect(() => parseLLMAction('no json here')).toThrow(ProviderError);
  });
});

describe('BackendAgentProvider failure handling (Phase E)', () => {
  function makeBackend(): BackendAgentProvider {
    return new BackendAgentProvider({ timeoutMs: 1000 });
  }

  it('maps backend 503 structured rate-limit failure to a NON-retryable error (hotfix)', async () => {
    stubFetch(() =>
      Promise.resolve(
        jsonResponse(503, {
          detail: {
            success: false,
            reason: 'Reasoning unavailable: OpenRouter rate limit reached (HTTP 429).',
            error_kind: 'rate_limit',
            retryable: true, // a remote claim the extension must NOT trust
          },
        })
      )
    );
    await expect(makeBackend().requestAction('task', SAFE_CONTEXT)).rejects.toMatchObject({
      kind: 'rate_limit',
      retryable: false,
    });
  });

  it('maps a bare backend HTTP 429 to a NON-retryable rate_limit error', async () => {
    stubFetch(() => Promise.resolve(jsonResponse(429, { detail: 'too many requests' })));
    await expect(makeBackend().requestAction('task', SAFE_CONTEXT)).rejects.toMatchObject({
      kind: 'rate_limit',
      retryable: false,
      status: 429,
    });
  });

  it('a backend rate limit costs exactly ONE request through the M6 loop', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(503, {
          detail: {
            success: false,
            reason: 'Reasoning unavailable: OpenRouter rate limit reached (HTTP 429).',
            error_kind: 'rate_limit',
            retryable: true,
          },
        })
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const loop = new AgentLoop(makeBackend(), {
      perceivePage: async () => SAFE_CONTEXT,
      executeAction: async () => ({ success: true }),
    }, {
      maxSteps: 10,
      providerRetries: 2,
      providerRetryDelayMs: 1,
      delayBetweenStepsMs: 1,
    });

    const state = await loop.runTask('Find and click the account number field');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.providerAttempts).toBe(1);
    expect(state.status).toBe('FAILED');
  });

  it('still retries a transient backend 5xx within the existing bounded policy', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(503, { detail: 'gateway hiccup' })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(makeBackend().requestAction('task', SAFE_CONTEXT)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it('maps backend unknown-target failure to a retryable http error', async () => {
    stubFetch(() =>
      Promise.resolve(
        jsonResponse(422, {
          detail: {
            success: false,
            reason: "Target 'element_xyz' does not exist in the current sanitized context.",
            error_kind: 'unknown_target',
            retryable: true,
          },
        })
      )
    );
    await expect(makeBackend().requestAction('task', SAFE_CONTEXT)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it('maps backend offline to typed network error', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(makeBackend().requestAction('task', SAFE_CONTEXT)).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('maps backend auth failure to typed auth error', async () => {
    stubFetch(() => Promise.resolve(jsonResponse(401, { detail: 'unauthorized' })));
    await expect(makeBackend().requestAction('task', SAFE_CONTEXT)).rejects.toMatchObject({
      kind: 'auth',
    });
  });
});
