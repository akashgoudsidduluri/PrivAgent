/**
 * POST-17.10 Step 10.6 (G7) — bounded rate-limit retry.
 *
 * Two layers are exercised separately, because they carry different
 * responsibilities and different bounds:
 *
 *   BackendAgentProvider  — CLASSIFIES. Decides retryable from the provider's
 *                           OWN clamped Retry-After, never from a remote flag.
 *   AgentLoop             — BOUNDS. Caps attempts by `providerRetries`, clamps
 *                           the delay, and fails closed when the bound is hit.
 *
 * The two properties that make this safe are asserted directly:
 *   1. A provider retry happens BEFORE any BrowserAction exists, so it can
 *      never duplicate a browser side effect.
 *   2. A rate limit with no valid Retry-After keeps the pre-existing
 *      non-retryable, zero-retry behaviour.
 *
 * No test performs a real network call and no test waits in real time.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { BackendAgentProvider } from '../extension/src/agent/backendAgentProvider';
import { ProviderError } from '../extension/src/agent/openRouterProvider';
import { parseRetryAfter } from '../extension/src/agent/providerResponse';
import { AgentLoop } from '../extension/src/agent/agentLoop';
import type { AgentProvider } from '../extension/src/agent/agentProvider';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import type { BrowserAction } from '../extension/src/agent/actionTypes';

const CONTEXT = {
  url: 'http://localhost:4174/',
  timestamp: 1720000000000,
  viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
  screenshot_dimensions: null,
  detections: [
    {
      id: 'elem_1',
      type: 'button',
      confidence: 0.95,
      bbox: { x: 10, y: 20, width: 120, height: 30 },
      length: 0,
      source: 'dom',
      selector: '#catalog',
      is_partially_visible: true,
    },
  ],
  total_elements_scanned: 3,
  sensitive_elements_detected: 0,
  sanitized_status: 'sanitized_only',
  ocr_metrics: null,
} as unknown as AgentContextPayload;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const RATE_LIMIT_BODY = {
  detail: {
    success: false,
    reason: 'Reasoning unavailable: groq (rate_limit)',
    error_kind: 'rate_limit',
    retryable: true,
  },
};

/** Drive BackendAgentProvider against a stubbed fetch; return the thrown error. */
async function classify(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<ProviderError> {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(status, body, headers));
  vi.stubGlobal('fetch', fetchMock);
  const provider = new BackendAgentProvider({ baseUrl: 'http://127.0.0.1:8010' });
  try {
    await provider.requestAction('open the store catalog', CONTEXT);
  } catch (err) {
    return err as ProviderError;
  }
  throw new Error('expected requestAction to reject');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('G7 — provider rate-limit classification', () => {
  it('1. 429 + Retry-After: 12 → retryable, 12000ms hint', async () => {
    const err = await classify(429, RATE_LIMIT_BODY, { 'retry-after': '12' });
    expect(err.kind).toBe('rate_limit');
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(12_000);
  });

  it('2. 429 + Retry-After: 4 → retryable, 4000ms hint', async () => {
    const err = await classify(429, RATE_LIMIT_BODY, { 'retry-after': '4' });
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(4_000);
  });

  it('3. 429 without Retry-After → existing fail-closed behaviour (no retry)', async () => {
    const err = await classify(429, RATE_LIMIT_BODY);
    expect(err.kind).toBe('rate_limit');
    expect(err.retryable).toBe(false);
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('4. malformed Retry-After is refused, so the step fails closed', async () => {
    for (const bad of ['soon', '-5', 'Wed, 99 ZZZ 2099', '']) {
      expect(parseRetryAfter(bad)).toBeUndefined();
      const err = await classify(429, RATE_LIMIT_BODY, { 'retry-after': bad });
      expect(err.retryable).toBe(false);
    }
  });

  it('4b. an absurd Retry-After is clamped, never trusted verbatim', () => {
    const parsed = parseRetryAfter('999999');
    expect(typeof parsed).toBe('number');
    expect(parsed!).toBeLessThanOrEqual(30_000);
  });

  it('6. non-rate-limit 4xx is never given a rate-limit retry', async () => {
    // A target-resolution refusal. It carries a Retry-After header precisely to
    // prove the new rule keys on the ERROR KIND, not on the header: a header
    // alone never makes anything retryable.
    const err = await classify(
      422,
      { detail: { success: false, reason: 'Target does not exist', error_kind: 'unknown_target' } },
      { 'retry-after': '12' }
    );
    expect(err.kind).not.toBe('rate_limit');
    expect(err.retryable).toBe(false);
  });

  it('7. a policy refusal is never retried even when a Retry-After is present', async () => {
    const err = await classify(
      502,
      {
        detail: {
          success: false,
          reason: 'PrivAgent action policy refused',
          error_kind: 'invalid_action',
        },
      },
      { 'retry-after': '12' }
    );
    expect(err.kind).not.toBe('rate_limit');
    expect(err.retryable).toBe(false);
  });

  it('8. an auth failure is never retried', async () => {
    const err = await classify(401, { detail: { success: false, error_kind: 'auth' } }, { 'retry-after': '12' });
    expect(err.kind).toBe('auth');
    expect(err.retryable).toBe(false);
  });
});

/** A stub provider that fails `times` times, then returns a valid action. */
function stubProvider(
  times: number,
  opts: { retryAfterMs?: number; kind?: 'rate_limit' | 'timeout' } = {}
) {
  const dispatches: BrowserAction[] = [];
  let calls = 0;
  const provider: AgentProvider = {
    name: 'StubProvider',
    async requestAction(): Promise<BrowserAction> {
      calls += 1;
      if (calls <= times) {
        // Mirrors the PRODUCTION classification rule exactly: a rate limit is
        // retryable only when the provider supplied a Retry-After. Encoding
        // that here (rather than always `true`) is what makes the
        // "no Retry-After → never retried" control meaningful.
        const kind = opts.kind ?? 'rate_limit';
        throw new ProviderError('rate limited', kind, {
          retryable: kind === 'rate_limit' ? typeof opts.retryAfterMs === 'number' : true,
          retryAfterMs: opts.retryAfterMs,
        });
      }
      return { action: 'click', target: 'elem_1', reason: 'open the catalog' };
    },
  };
  return { provider, dispatches, calls: () => calls };
}

async function runLoop(provider: AgentProvider, dispatches: BrowserAction[], providerRetries: number) {
  const loop = new AgentLoop(provider, {
    perceivePage: async () => CONTEXT,
    executeAction: async (a) => {
      dispatches.push(a);
      return { success: true };
    },
  }, {
    maxSteps: 1,
    providerRetries,
    providerRetryDelayMs: 1,
    // A containment scope is REQUIRED for a dispatch to be permitted: null is
    // UNINITIALIZED and containment denies it fail-closed. Supplying a real
    // scope lets the retried action reach the pipeline instead of being
    // stopped by a gate this task is not testing.
    containmentScope: {
      rootHost: 'localhost',
      origin: 'http://localhost:4174',
      tabId: 1,
      dashboardOrigin: 'http://localhost:5173',
    },
  });

  const p = loop.runTask('open the store catalog');
  // Advance virtual time so a Retry-After wait costs no real seconds.
  for (let i = 0; i < 60 && !(await Promise.race([p.then(() => true), Promise.resolve(false)])); i += 1) {
    await vi.advanceTimersByTimeAsync(1000);
  }
  await vi.advanceTimersByTimeAsync(60_000);
  return p;
}

describe('G7 — bounded rate-limit retry in the loop', () => {
  it('5. the retry bound is enforced: exhausting it fails closed with no action', async () => {
    vi.useFakeTimers();
    const { provider, dispatches } = stubProvider(99, { retryAfterMs: 12_000 });
    const state = await runLoop(provider, dispatches, 2);

    // providerRetries = 2 → exactly 1 initial attempt + 2 retries = 3 calls.
    expect(state.providerAttempts).toBe(3);
    expect(dispatches).toHaveLength(0);
    expect(state.status).not.toBe('SUCCESS');
  });

  it('9. one transient rate limit → exactly ONE action reaches the pipeline', async () => {
    vi.useFakeTimers();
    const { provider, dispatches, calls } = stubProvider(1, { retryAfterMs: 12_000 });
    const state = await runLoop(provider, dispatches, 2);

    expect(calls()).toBe(2);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.action).toBe('click');
    expect(state.status).not.toBe('SUCCESS');
  });

  it('10. the retried action is not duplicated: N provider failures yield ONE dispatch', async () => {
    vi.useFakeTimers();
    const { provider, dispatches, calls } = stubProvider(2, { retryAfterMs: 4_000 });
    await runLoop(provider, dispatches, 2);

    // Three provider calls (1 initial + 2 retries). The two FAILED calls
    // produced zero browser side effects — a provider failure returns no
    // BrowserAction, so nothing can be dispatched — and the one successful
    // call yields exactly one action.
    expect(calls()).toBe(3);
    expect(dispatches).toHaveLength(1);
  });

  it('a non-retryable rate limit with no Retry-After is never retried', async () => {
    vi.useFakeTimers();
    const { provider, dispatches, calls } = stubProvider(1, { retryAfterMs: undefined });
    await runLoop(provider, dispatches, 2);
    expect(calls()).toBe(1);
    expect(dispatches).toHaveLength(0);
  });
});
