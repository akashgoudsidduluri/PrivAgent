/**
 * PrivAgent — M7 Outbound LLM Privacy & Network Payload Test Suite (Phase F)
 *
 * Verifies — by inspecting the SERIALIZED request body passed to fetch, not by
 * source inspection — that the reasoning request to the LLM contains ONLY
 * sanitized metadata and never:
 *   - password values / card numbers / CVV / PAN / account numbers
 *   - email values / phone values
 *   - raw OCR / raw DOM text
 *   - screenshots / base64 image data
 *   - forbidden keys (value, text, password, cardNumber, rawOCR, ...)
 *
 * Also verifies the LLM leakage-injection attempts (forbidden fields on
 * actions) are rejected by the M5 validator, and that the M6 loop never
 * forwards raw PII to any provider (network boundary test with a capturing
 * provider).
 *
 * All values used are synthetic; no test performs a live network call.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenRouterProvider } from '../extension/src/agent/openRouterProvider';
import { BackendAgentProvider } from '../extension/src/agent/backendAgentProvider';
import { validateAction } from '../extension/src/agent/actionValidator';
import { AgentLoop } from '../extension/src/agent/agentLoop';
import { AgentProvider } from '../extension/src/agent/agentProvider';
import { AgentContextPayload } from '../extension/src/privacy/types';
import { BrowserAction } from '../extension/src/agent/actionTypes';

// ── Synthetic-only sensitive values (from the demo portal fixtures) ──────────
const SYNTHETIC_PII = [
  '123456789012', // account number
  '4111111111111111',
  '4111 1111 1111 1111', // credit card
  'ABCDE1234F', // PAN
  'rahul.sharma@example.com', // email
  '9876543210', // phone
  'DemoPassword123', // password
  'Rahul Sharma', // name
  '892', // CVV
];

const FORBIDDEN_KEYS = [
  'value', 'text', 'textContent', 'innerText', 'rawText', 'rawOCR', 'ocrText',
  'password', 'words', 'lines', 'token', 'secret', 'card', 'cardNumber',
  'cvv', 'pan', 'accountNumber', 'raw', 'sensitiveValue', 'pii',
];

function walkKeys(obj: unknown, out: string[] = []): string[] {
  if (obj === null || obj === undefined) return out;
  if (Array.isArray(obj)) {
    obj.forEach((item) => walkKeys(item, out));
  } else if (typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      out.push(key);
      walkKeys(value, out);
    }
  }
  return out;
}

const RICH_CONTEXT: AgentContextPayload = {
  url: 'https://bank.example.com/portal',
  timestamp: 1720000000000,
  viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
  screenshot_dimensions: { width: 2560, height: 1600 },
  detections: [
    {
      id: 'element_account_num',
      type: 'account_number',
      confidence: 0.97,
      bbox: { x: 120, y: 180, width: 220, height: 35 },
      length: 12,
      source: 'dom_input_type',
      selector: '#input-account-no',
      is_partially_visible: false,
    },
    {
      id: 'element_card',
      type: 'credit_card',
      confidence: 0.98,
      bbox: { x: 120, y: 260, width: 240, height: 35 },
      length: 19,
      source: 'dom_autocomplete',
      selector: '#input-card-number',
      is_partially_visible: false,
    },
    {
      id: 'element_pwd',
      type: 'password',
      confidence: 1.0,
      bbox: { x: 120, y: 340, width: 220, height: 35 },
      length: 15,
      source: 'dom_input_type',
      selector: '#input-account-password',
      is_partially_visible: false,
    },
  ],
  total_elements_scanned: 45,
  sensitive_elements_detected: 3,
  sanitized_status: 'sanitized_only',
  ocr_metrics: { regions_scanned: 12, sensitive_detected: 2, latency_ms: 311.4 },
};

function completion(content: string): unknown {
  return { choices: [{ message: { role: 'assistant', content } }] };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── OpenRouter direct provider: serialized outbound payload ──────────────────

describe('OpenRouter outbound payload privacy (Phase F)', () => {
  it('serialized request body contains only sanitized metadata', async () => {
    const captured: { url?: string; body?: string; headers?: Record<string, string> } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        captured.url = String(url);
        captured.body = String(init?.body ?? '');
        captured.headers = Object.fromEntries(new Headers(init?.headers).entries());
        return jsonResponse(200, completion('{"action":"click","target":"element_account_num"}'));
      })
    );

    const provider = new OpenRouterProvider({ apiKey: 'test-key' });
    const action = await provider.requestAction('Find and click the account number field', RICH_CONTEXT);
    expect(action.action).toBe('click');

    expect(captured.body).toBeDefined();
    const parsed = JSON.parse(captured.body!) as Record<string, unknown>;

    // 1. No forbidden sensitive keys anywhere in the outbound request.
    const keys = walkKeys(parsed).map((k) => k.toLowerCase().replace(/_/g, ''));
    const forbiddenNormalized = FORBIDDEN_KEYS.map((k) => k.toLowerCase().replace(/_/g, ''));
    for (const key of keys) {
      expect(forbiddenNormalized, `forbidden key: ${key}`).not.toContain(key);
    }

    // 2. No synthetic PII values in the serialized request.
    for (const pii of SYNTHETIC_PII) {
      expect(captured.body!.toLowerCase()).not.toContain(pii.toLowerCase());
    }

    // 3. No screenshot / base64 image data.
    expect(captured.body).not.toMatch(/data:image/i);
    expect(captured.body).not.toMatch(/base64,[A-Za-z0-9+/]{40,}/);

    // 4. Safe metadata IS present (the model can reason over it).
    expect(captured.body).toContain('element_account_num');
    expect(captured.body).toContain('account_number');

    // 5. API key travels only in the Authorization header, never in the body.
    expect(captured.headers?.['authorization']).toBe('Bearer test-key');
    expect(captured.body).not.toContain('test-key');
  });
});

// ── Backend provider: extension→backend hop payload ──────────────────────────

describe('BackendAgentProvider outbound payload privacy (Phase F)', () => {
  it('serialized request to the local backend contains only sanitized context', async () => {
    const captured: { url?: string; body?: string } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        captured.url = String(url);
        captured.body = String(init?.body ?? '');
        return jsonResponse(200, {
          success: true,
          action: { action: 'click', target: 'element_account_num', reason: 'r' },
          reason: 'ok',
        });
      })
    );

    const provider = new BackendAgentProvider({ timeoutMs: 1000 });
    const history: BrowserAction[] = [{ action: 'scroll', direction: 'down', amount: 500 }];
    const action = await provider.requestAction('Find the account number', RICH_CONTEXT, history);

    expect(action.action).toBe('click');
    expect(captured.url).toBe('http://127.0.0.1:8010/api/v1/agent/action');

    const parsed = JSON.parse(captured.body!) as Record<string, unknown>;
    const keys = walkKeys(parsed).map((k) => k.toLowerCase().replace(/_/g, ''));
    const forbiddenNormalized = FORBIDDEN_KEYS.map((k) => k.toLowerCase().replace(/_/g, ''));
    for (const key of keys) {
      expect(forbiddenNormalized, `forbidden key: ${key}`).not.toContain(key);
    }
    for (const pii of SYNTHETIC_PII) {
      expect(captured.body!.toLowerCase()).not.toContain(pii.toLowerCase());
    }
    expect(captured.body).toContain('"sanitized_status":"sanitized_only"');
  });
});

// ── LLM leakage-injection attempts must be rejected by the M5 validator ──────

describe('LLM leakage-injection rejection (Phase F)', () => {
  const injectionAttempts: Array<Record<string, unknown>> = [
    { action: 'type', target: 'element_account_num', text: 'Rahul Sharma' },
    { action: 'type', target: 'element_account_num', text: 'DemoPassword123' },
    { action: 'click', target: 'element_account_num', password: 'fake-password' },
    { action: 'click', target: 'element_account_num', cardNumber: '4111111111111111' },
    { action: 'scroll', direction: 'down', amount: 500, rawOCR: 'fake sensitive OCR' },
    { action: 'click', target: 'element_account_num', value: '123456789012' },
    { action: 'click', target: 'element_account_num', eval: 'alert(1)' },
    { action: 'navigate', url: 'javascript:alert(document.cookie)' },
  ];

  for (const attempt of injectionAttempts) {
    it(`rejects injected action ${JSON.stringify(attempt)}`, () => {
      const result = validateAction(attempt, RICH_CONTEXT);
      expect(result.allowed).toBe(false);
    });
  }

  it('still allows legitimate structured actions', () => {
    expect(validateAction({ action: 'click', target: 'element_account_num' }, RICH_CONTEXT).allowed).toBe(true);
    expect(
      validateAction({ action: 'scroll', direction: 'down', amount: 500 }, RICH_CONTEXT).allowed
    ).toBe(true);
  });
});

// ── Golden free-text PII heuristic cases (M7 hardening, Phase 1) ─────────────

describe('Free-text PII heuristic golden cases (Phase 1)', () => {
  const GOLDEN_BLOCKED: Array<[string, string]> = [
    ['PAN fixture (project demo data)', 'ABCDE1234F'],
    ['PAN embedded in sentence', 'ref ABCDE1234F done'],
    ['email', 'rahul.sharma@example.com'],
    ['phone', '9876543210'],
    ['labeled credential', 'password=DemoPassword123'],
    ['credential-shaped token', 'DemoPassword123'],
    ['Luhn-valid card', '4111111111111111'],
  ];

  const GOLDEN_ALLOWED: Array<[string, string]> = [
    ['Indian state name', 'Gujarat'],
    ['benign prose with acronym', 'Gmail POP3 settings'],
    ['short number', 'Amount 500'],
    ['single word', 'transactions'],
  ];

  for (const [label, text] of GOLDEN_BLOCKED) {
    it(`BLOCKS type text: ${label} ("${text}")`, () => {
      const result = validateAction({ action: 'type', target: 'element_account_num', text }, RICH_CONTEXT);
      expect(result.allowed).toBe(false);
    });
    it(`BLOCKS select option: ${label} ("${text}")`, () => {
      const result = validateAction({ action: 'select', target: 'element_account_num', option: text }, RICH_CONTEXT);
      expect(result.allowed).toBe(false);
    });
  }

  for (const [label, text] of GOLDEN_ALLOWED) {
    it(`allows benign type text: ${label} ("${text}")`, () => {
      const result = validateAction({ action: 'type', target: 'element_account_num', text }, RICH_CONTEXT);
      expect(result.allowed).toBe(true);
    });
  }
});

// ── M6 loop: provider receives sanitized context only (network boundary) ─────

describe('M6 → provider network boundary (Phase F)', () => {
  it('never forwards raw PII from perception into the provider request', async () => {
    let providerSawPayload = '';

    const capturingProvider: AgentProvider = {
      name: 'CapturingProvider',
      async requestAction(_task, context): Promise<BrowserAction> {
        providerSawPayload = JSON.stringify(context);
        return { action: 'scroll', direction: 'down', amount: 400 };
      },
    };

    const perceivePage = vi.fn(async () => RICH_CONTEXT);
    const executeAction = vi.fn(async () => ({ success: true }));

    const loop = new AgentLoop(capturingProvider, { perceivePage, executeAction }, {
      maxSteps: 1,
      delayBetweenStepsMs: 5,
    });
    await loop.runTask('Inspect the page');

    expect(providerSawPayload).toContain('"sanitized_status":"sanitized_only"');
    for (const pii of SYNTHETIC_PII) {
      expect(providerSawPayload.toLowerCase()).not.toContain(pii.toLowerCase());
    }
    // Detection metadata (safe) is present.
    expect(providerSawPayload).toContain('element_pwd');
  });
});
