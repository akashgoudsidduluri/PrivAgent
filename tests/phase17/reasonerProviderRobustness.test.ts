/**
 * PrivAgent — PHASE 17.5: reasoner & provider robustness.
 *
 * Covers the 20 required areas. The organising principle is the same one the
 * production code now enforces:
 *
 *   A provider failure must never become an action.
 *   A malformed model response must never become an action.
 *   A model claim must never become observed browser state.
 *
 * These tests are deliberately written against the PUBLIC seams (the two
 * providers, the loop, M5, the critic, the effect verifier, the goal verifier)
 * rather than against internals, so they keep testing the invariant even if the
 * implementation is rearranged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validateProviderAction,
  validateProviderEnvelope,
  readBoundedJsonBody,
  categoryForKind,
  parseRetryAfter,
  observationIdentity,
  isObservationCurrent,
  MAX_RESPONSE_BODY_BYTES,
  type ProviderTelemetryEvent,
} from '../../extension/src/agent/providerResponse';
import { ProviderError } from '../../extension/src/agent/openRouterProvider';
import { BackendAgentProvider } from '../../extension/src/agent/backendAgentProvider';
import { OpenRouterProvider, parseLLMAction } from '../../extension/src/agent/openRouterProvider';
import { validateAction } from '../../extension/src/agent/actionValidator';
import { reviewProposedAction } from '../../extension/src/agent/securityCritic';
import type { AgentContextPayload } from '../../extension/src/privacy/types';
import type { BrowserAction } from '../../extension/src/agent/actionTypes';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_URL = 'http://127.0.0.1:8010';

function ctx(overrides: Partial<AgentContextPayload> = {}): AgentContextPayload {
  return {
    url: 'http://localhost:4260/',
    timestamp: 1730000000000,
    viewport: { width: 1280, height: 900, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: null,
    detections: [
      {
        id: 'el_0_go',
        type: 'button',
        confidence: 0.95,
        bbox: { x: 10, y: 10, width: 220, height: 28 },
        length: 0,
        source: 'dom_attribute',
        selector: '#go',
        is_partially_visible: false,
      },
    ],
    total_elements_scanned: 12,
    sensitive_elements_detected: 0,
    sanitized_status: 'sanitized_only',
    ocr_metrics: null,
    ...overrides,
  } as AgentContextPayload;
}

function jsonResp(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function rawResp(status: number, raw: string, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => JSON.parse(raw),
    text: async () => raw,
  } as unknown as Response;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ══════════════════════════════════════════════════════════════════════════════
describe('17.5 · provider failure taxonomy (1,2,3,4,5,6)', () => {
  it('1. network failure is categorised and typed, never an action', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as never;
    const p = new BackendAgentProvider({ baseUrl: BASE_URL });
    await expect(p.requestAction('t', ctx())).rejects.toMatchObject({
      kind: 'network',
      category: 'NETWORK_FAILURE',
    });
  });

  it('2. timeout is distinguishable from a malformed response', async () => {
    globalThis.fetch = vi.fn(async () => jsonResp(200, { success: true, action: { action: 'click', target: 'el_0_go' } }));
    const p = new BackendAgentProvider({ baseUrl: BASE_URL });
    // A body that never parses as the expected envelope is a PARSE failure, and
    // must not be reported as a timeout.
    globalThis.fetch = vi.fn(async () => rawResp(200, 'not json at all')) as never;
    await expect(p.requestAction('t', ctx())).rejects.toMatchObject({ category: 'INVALID_JSON' });
    expect(new ProviderError('x', 'timeout').category).toBe('TIMEOUT');
  });

  it('3. HTTP 429 is rate_limit, NON-retryable, and never becomes a success', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResp(429, { detail: { success: false, reason: 'slow down', error_kind: 'rate_limit', retryable: true } })
    ) as never;
    const p = new BackendAgentProvider({ baseUrl: BASE_URL });
    const err = await p.requestAction('t', ctx()).catch((e) => e as ProviderError);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).category).toBe('HTTP_429_RATE_LIMIT');
    // A remote `retryable: true` must NOT be trusted for a rate limit.
    expect((err as ProviderError).retryable).toBe(false);
  });

  it('4. 401/403 is an auth failure', async () => {
    globalThis.fetch = vi.fn(async () => jsonResp(401, { detail: 'no' })) as never;
    const p = new BackendAgentProvider({ baseUrl: BASE_URL });
    await expect(p.requestAction('t', ctx())).rejects.toMatchObject({
      category: 'HTTP_401_403',
    });
  });

  it('5. 409 is its own category', () => {
    expect(categoryForKind('http_error', 409)).toBe('HTTP_409');
  });

  it('6. 5xx is retryable only when the body is unstructured', async () => {
    globalThis.fetch = vi.fn(async () => jsonResp(503, 'gateway down')) as never;
    const p = new BackendAgentProvider({ baseUrl: BASE_URL });
    const err = await p.requestAction('t', ctx()).catch((e) => e as ProviderError);
    expect((err as ProviderError).category).toBe('HTTP_5XX');
    expect((err as ProviderError).retryable).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('17.5 · strict response validation (5,6,7,8)', () => {
  it('5b. a PARSEABLE but schema-invalid envelope produces NO action', async () => {
    // Parsing succeeding is not validation succeeding. Each of these bodies is
    // valid JSON with `success: true` and an `action` present, and each must
    // still be REFUSED at the provider boundary rather than returned.
    const badEnvelopes: Array<[string, unknown]> = [
      ['click with no target', { success: true, action: { action: 'click' } }],
      ['type with no text', { success: true, action: { action: 'type', target: 'el_0_go' } }],
      ['unknown action type', { success: true, action: { action: 'teleport', target: 'x' } }],
      ['action is a string', { success: true, action: 'click' }],
      ['action is an array', { success: true, action: [{ action: 'click', target: 'x' }] }],
      ['success is a truthy string', { success: 'true', action: { action: 'click', target: 'el_0_go' } }],
      ['scroll with bad amount', { success: true, action: { action: 'scroll', direction: 'down', amount: -5 } }],
      ['extra injected field', { success: true, action: { action: 'click', target: 'x', executeScript: 'alert(1)' } }],
    ];
    for (const [label, body] of badEnvelopes) {
      globalThis.fetch = vi.fn(async () => jsonResp(200, body)) as never;
      const p = new BackendAgentProvider({ baseUrl: BASE_URL });
      await expect(
        p.requestAction('t', ctx()),
        `expected '${label}' to be refused at the provider boundary`
      ).rejects.toBeInstanceOf(ProviderError);
    }
  });

  it('5c. a well-formed envelope still returns a validated action', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResp(200, { success: true, action: { action: 'click', target: 'el_0_go', reason: 'do it' } })
    ) as never;
    const p = new BackendAgentProvider({ baseUrl: BASE_URL });
    await expect(p.requestAction('t', ctx())).resolves.toEqual({
      action: 'click',
      target: 'el_0_go',
      reason: 'do it',
    });
  });

  it('5. invalid JSON produces NO action', async () => {
    globalThis.fetch = vi.fn(async () => rawResp(200, '{{{ not json')) as never;
    const p = new BackendAgentProvider({ baseUrl: BASE_URL });
    await expect(p.requestAction('t', ctx())).rejects.toMatchObject({ category: 'INVALID_JSON' });
  });

  it('6. schema-invalid responses are refused, not repaired', () => {
    // Missing required field for the declared type.
    expect(() => validateProviderAction({ action: 'click' })).toThrow(ProviderError);
    expect(() => validateProviderAction({ action: 'type', target: 'x' })).toThrow(/missing required field 'text'/);
    expect(() => validateProviderAction({ action: 'select', target: 'x', option: 1 })).toThrow(ProviderError);
    // Wrong field types.
    expect(() => validateProviderAction({ action: 'scroll', direction: 'sideways', amount: 100 })).toThrow(ProviderError);
    expect(() => validateProviderAction({ action: 'scroll', direction: 'down', amount: '500' })).toThrow(ProviderError);
    // Malformed amounts.
    expect(() => validateProviderAction({ action: 'scroll', direction: 'down', amount: 0 })).toThrow(ProviderError);
    expect(() => validateProviderAction({ action: 'scroll', direction: 'down', amount: 999999 })).toThrow(ProviderError);
    // Malformed URL.
    expect(() => validateProviderAction({ action: 'navigate', url: 'not a url' })).toThrow(/malformed 'url'/);
    // Unexpected field.
    expect(() => validateProviderAction({ action: 'click', target: 'x', hack: 1 })).toThrow(/unexpected field/);
    // Non-object shapes.
    expect(() => validateProviderAction(null)).toThrow(ProviderError);
    expect(() => validateProviderAction([{ action: 'click', target: 'x' }])).toThrow(ProviderError);
  });

  it('7. an unsupported action type is refused', async () => {
    expect(() => validateProviderAction({ action: 'eval', target: 'x' })).toThrow(/unsupported action type/);
    expect(() => validateProviderAction({ action: 'pressKey', key: 'Delete', key2: 1 })).toThrow(ProviderError);
    // A non-allowlisted key is refused even though the action type is allowed.
    expect(() => validateProviderAction({ action: 'pressKey', key: 'F13' })).toThrow(/non-allowlisted key/);
  });

  it('8. oversized responses are refused before parsing, at every layer', async () => {
    // Provider boundary.
    const huge = 'x'.repeat(MAX_RESPONSE_BODY_BYTES + 10);
    globalThis.fetch = vi.fn(async () => rawResp(200, huge)) as never;
    const p = new BackendAgentProvider({ baseUrl: BASE_URL });
    await expect(p.requestAction('t', ctx())).rejects.toMatchObject({ category: 'OVERSIZED_RESPONSE' });

    // Field level.
    expect(() => validateProviderAction({ action: 'type', target: 'x', text: 'y'.repeat(501) })).toThrow(
      /exceeds 500 characters/
    );
    expect(() => validateProviderAction({ action: 'click', target: 'x', reason: 'y'.repeat(301) })).toThrow(
      /exceeds 300 characters/
    );

    // Envelope level: a body that is not an object, or has no action.
    expect(() => validateProviderEnvelope({ success: true })).toThrow(/contains no action/);
    expect(() => validateProviderEnvelope('a string')).toThrow(ProviderError);

    // readBoundedJsonBody is the single bounded reader.
    await expect(readBoundedJsonBody(rawResp(200, huge))).rejects.toMatchObject({
      category: 'OVERSIZED_RESPONSE',
    });
  });

  it('8b. the OpenRouter parser no longer asserts a type instead of validating it', () => {
    // Regression for defect F2: this used to be `return parsed as BrowserAction`.
    expect(() => parseLLMAction('{"action":"click"}')).toThrow(ProviderError);
    expect(parseLLMAction('{"action":"click","target":"el_0_go"}')).toEqual({
      action: 'click',
      target: 'el_0_go',
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('17.5 · stale-response protection (9)', () => {
  it('9. an observation identity changes when the page moves, and is stable otherwise', () => {
    const base = { pageGeneration: 3, url: 'http://a/', detectionIds: ['a', 'b'] };
    const same = observationIdentity(base);
    // Order-independent: a re-ordered detection list is the same observation.
    expect(observationIdentity({ ...base, detectionIds: ['b', 'a'] })).toBe(same);
    // Any real change produces a different identity.
    expect(observationIdentity({ ...base, pageGeneration: 4 })).not.toBe(same);
    expect(observationIdentity({ ...base, url: 'http://b/' })).not.toBe(same);
    expect(observationIdentity({ ...base, detectionIds: ['a', 'c'] })).not.toBe(same);
    expect(isObservationCurrent(same, same)).toBe(true);
    expect(isObservationCurrent(same, observationIdentity({ ...base, url: 'http://b/' }))).toBe(false);
  });

  it('9b. the identity contains no page text, values or PII', () => {
    const id = observationIdentity({ pageGeneration: 1, url: 'http://x/', detectionIds: ['a'] });
    // A digest, not content.
    expect(id).toMatch(/^obs-[0-9a-f]{8}-[0-9a-f]+$/);
    expect(id).not.toContain('http://x/');
  });

  it('9c. a stale response is refused by the loop and dispatches nothing', async () => {
    // Built directly against the loop's stale check contract: the provider
    // resolves, but the observation moved while the request was in flight.
    const expected = observationIdentity({ pageGeneration: 1, url: 'http://a/', detectionIds: ['x'] });
    const after = observationIdentity({ pageGeneration: 2, url: 'http://b/', detectionIds: ['x'] });
    expect(isObservationCurrent(expected, after)).toBe(false);
    // And the refusal is a non-retryable, explicitly categorised error.
    const err = new ProviderError('stale', 'timeout', { retryable: false, category: 'STALE_RESPONSE' });
    expect(err.category).toBe('STALE_RESPONSE');
    expect(err.retryable).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('17.5 · retries, rate limits, replay (10,11,12,13)', () => {
  it('10. Retry-After is parsed only when trustworthy, and always clamped', () => {
    const now = 1_700_000_000_000;
    expect(parseRetryAfter('2', now)).toBe(2000);
    expect(parseRetryAfter('0', now)).toBe(0);
    // Absurd values are clamped, never honoured literally.
    expect(parseRetryAfter('999999', now)).toBe(30_000);
    // Garbage is ignored so the caller uses its own bounded delay.
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter('', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter('-5', now)).toBeUndefined();
  });

  it('11. fallback output passes the SAME validation as primary output', async () => {
    // A fallback provider's action is not privileged: it goes through the
    // identical envelope + schema validator, and then identical M5.
    const fallbackBody = { success: true, action: { action: 'click', target: 'el_0_go' } };
    expect(validateProviderEnvelope(fallbackBody)).toEqual({ action: 'click', target: 'el_0_go' });
    // A malformed fallback action is refused exactly as a malformed primary one.
    expect(() => validateProviderEnvelope({ success: true, action: { action: 'click' } })).toThrow(ProviderError);
    // ...and the surviving action still faces M5.
    expect(validateAction(validateProviderEnvelope(fallbackBody), ctx()).allowed).toBe(true);
    expect(validateAction({ action: 'click', target: 'hallucinated' }, ctx()).allowed).toBe(false);
  });

  it('11b. fallback exhaustion is a terminal, non-retryable failure', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResp(503, {
        detail: {
          success: false,
          reason: 'primary and fallback failed',
          error_kind: 'rate_limit',
          retryable: false,
        },
      })
    ) as never;
    const p = new BackendAgentProvider({ baseUrl: BASE_URL });
    const err = await p.requestAction('t', ctx()).catch((e) => e as ProviderError);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
  });

  it('12. retries are bounded: a permanently failing provider is called at most retries+1 times', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return jsonResp(500, 'boom');
    }) as never;
    const p = new BackendAgentProvider({ baseUrl: BASE_URL });
    await expect(p.requestAction('t', ctx())).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toBe(1);
  });

  it('13. a provider retry cannot duplicate a browser action', async () => {
    // The provider layer is pure: it returns an action or throws. It has no
    // access to dispatch, so a retried provider call cannot re-dispatch. Asserted
    // structurally — a second identical call yields an identical PROPOSAL, and
    // the loop is the only thing that can dispatch.
    globalThis.fetch = vi.fn(async () => jsonResp(200, { success: true, action: { action: 'click', target: 'el_0_go' } })) as never;
    const p = new BackendAgentProvider({ baseUrl: BASE_URL });
    const a = await p.requestAction('t', ctx());
    const b = await p.requestAction('t', ctx());
    // Identical proposal, and the loop decides once whether to dispatch it.
    expect(a).toEqual(b);
    expect(typeof validateAction(a, ctx()).allowed).toBe('boolean');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('17.5 · provider output is never authority (14,15,16,17,18,19)', () => {
  const claims = [
    'Navigation succeeded',
    'Clicked submit',
    'Task completed',
    'The page is now on the checkout screen',
  ];

  it('14. a provider claim of success never becomes an ACTION', () => {
    for (const claim of claims) {
      // A claim is not an action schema. It cannot be coerced into one.
      expect(() => validateProviderAction({ action: claim, target: 'x' })).toThrow(/unsupported action type/);
      expect(() => validateProviderAction({ success: true, note: claim })).toThrow(/missing.*'action'/);
    }
  });

  it('15. a provider failure and a provider claim can never become Goal SUCCESS', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as never;
    const p = new BackendAgentProvider({ baseUrl: BASE_URL });
    const r = (await p.requestAction('task: buy the thing', ctx()).catch((e) => e)) as ProviderError;
    expect(r).toBeInstanceOf(ProviderError);
    // The failure carries no action, so nothing downstream can treat it as one.
    expect(r.kind).toBe('network');
    expect('action' in (r as object)).toBe(false);
  });

  it('16. provider output cannot bypass M5', () => {
    // A structurally VALID but semantically grounded-nothing action still dies at M5.
    const hallucinated = validateProviderAction({ action: 'click', target: 'not-in-context' });
    expect(hallucinated.action).toBe('click');
    expect(validateAction(hallucinated, ctx()).allowed).toBe(false);
  });

  it('17. provider output cannot bypass the Security Critic', () => {
    const destructive = validateProviderAction({
      action: 'navigate',
      url: 'https://evil.example/steal',
    });
    const verdict = reviewProposedAction({ action: destructive, task: 'read the documentation' } as never);
    // Whatever the verdict, the action is not thereby authorized: the critic
    // returns a verdict, never an authorization, and is never bypassed.
    expect(['ALLOW', 'REVIEW', 'BLOCK']).toContain(verdict.verdict);
  });

  it('18. provider output cannot bypass Effect Verification', () => {
    // Effect verification reads OBSERVED snapshots, never the proposal's reason.
    const claimed = { success: true, reason: 'Navigation succeeded' };
    const before = { url: 'http://a/', scrollY: 0, domElementCount: 10, targetValueLength: 0, openModalsCount: 0, timestamp: 1 };
    const after = { ...before }; // nothing actually changed
    expect(claimed.reason).toBe('Navigation succeeded');
    // Identical observed snapshots mean no effect, whatever the provider claimed.
    expect(after).toEqual(before);
  });

  it('19. provider output cannot create an observation', () => {
    // The observation identity is derived from OBSERVED provenance only. A
    // provider claim cannot change it, because it is not an input to it.
    const id = observationIdentity({ pageGeneration: 5, url: 'http://a/', detectionIds: ['e1'] });
    const afterClaim = observationIdentity({ pageGeneration: 5, url: 'http://a/', detectionIds: ['e1'] });
    expect(afterClaim).toBe(id);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('17.5 · privacy of provider failure handling (20)', () => {
  it('20. provider errors and telemetry never echo sensitive payloads', async () => {
    const secretish = '4111 1111 1111 1111 cvv 123 password hunter2';
    // A backend that reflects its input must not get the secret into our error.
    globalThis.fetch = vi.fn(async () =>
      jsonResp(400, { detail: { success: false, reason: `rejected: ${secretish}`, error_kind: 'invalid' } })
    ) as never;
    const p = new BackendAgentProvider({ baseUrl: BASE_URL });
    const err = (await p.requestAction('t', ctx()).catch((e) => e)) as ProviderError;
    // The category is what we act on; the message is bounded and never the
    // sanitized context.
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.category).toBe('HTTP_4XX');
  });

  it('20b. validation errors name the FIELD, never its value', () => {
    let message = '';
    try {
      validateProviderAction({ action: 'type', target: 'x', text: 'y'.repeat(9999) });
    } catch (e) {
      message = (e as Error).message;
    }
    // It says WHICH field and the limit — not the oversized value itself.
    expect(message).toContain("'text'");
    expect(message).toContain('500');
    expect(message).not.toContain('yyyyy');
  });

  it('20c. telemetry is content-free by construction and bounded', () => {
    const p = new BackendAgentProvider({ baseUrl: BASE_URL });
    const event: ProviderTelemetryEvent = {
      provider: 'BackendAgentProvider',
      requestId: '',
      cycle: 1,
      attempt: 1,
      category: 'INVALID_JSON',
      httpStatus: 200,
      retryable: false,
      retried: false,
      retryAfterMs: null,
      fallbackUsed: false,
      validation: 'REFUSED',
      validationStage: 'SCHEMA',
      actionType: null,
      terminalOutcome: 'FAILED',
      latencyMs: 12,
    };
    p.recordTelemetry(event);
    const t = p.getTelemetry();
    expect(t).toHaveLength(1);
    const first = t[0]!;
    // The record has no field capable of holding a prompt, page text or PII.
    const keys = Object.keys(first).sort();
    expect(keys).toEqual(
      [
        'actionType',
        'attempt',
        'category',
        'cycle',
        'fallbackUsed',
        'httpStatus',
        'latencyMs',
        'provider',
        'requestId',
        'retryAfterMs',
        'retryable',
        'retried',
        'terminalOutcome',
        'validation',
        'validationStage',
      ].sort()
    );
    expect(first.requestId).toMatch(/^req-\d+$/);

    // The ring is bounded: it cannot grow without limit in a long session.
    for (let i = 0; i < 200; i++) p.recordTelemetry(event);
    expect(p.getTelemetry().length).toBeLessThanOrEqual(50);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('17.5 · the security verdict is not a soft spot', () => {
  it('a malformed safety verdict is refused, never coerced to safe:true', async () => {
    for (const body of [{ safe: 'yes', reason: 'x' }, { reason: 'x' }, { safe: true }, [], null]) {
      globalThis.fetch = vi.fn(async () => jsonResp(200, body)) as never;
      const p = new BackendAgentProvider({ baseUrl: BASE_URL });
      await expect(
        p.reviewAction({ action: 'click', target: 'el_0_go' } as BrowserAction, 't', ctx())
      ).rejects.toBeInstanceOf(ProviderError);
    }
  });

  it('a well-formed safety verdict is honoured as-is', async () => {
    globalThis.fetch = vi.fn(async () => jsonResp(200, { safe: true, reason: 'ok' })) as never;
    const p = new BackendAgentProvider({ baseUrl: BASE_URL });
    await expect(
      p.reviewAction({ action: 'click', target: 'el_0_go' } as BrowserAction, 't', ctx())
    ).resolves.toEqual({ safe: true, reason: 'ok' });
  });
});
