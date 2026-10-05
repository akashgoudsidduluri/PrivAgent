/**
 * PrivAgent — M7 Phase 5: Extension-Side Full Reasoning Pipeline Integration Test
 *
 * Connects the extension seams WITHOUT any real network access:
 *
 *   fabricated LLM response (fetch stub)
 *     → OpenRouterProvider.parseLLMAction (fences, chatter, field limits)
 *     → M5 validateAction (allowlist, target grounding, PII scan)
 *     → M5 privacyPolicy.canPerformAction
 *     → M6 AgentLoop execution boundary (fresh perception each step)
 *
 * Mirrors backend/tests/test_full_reasoning_pipeline.py. No live network.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenRouterProvider, parseLLMAction } from '../extension/src/agent/openRouterProvider';
import { validateAction } from '../extension/src/agent/actionValidator';
import { canPerformAction } from '../extension/src/agent/privacyPolicy';
import { AgentLoop, TaskState } from '../extension/src/agent/agentLoop';
import { AgentContextPayload } from '../extension/src/privacy/types';
import { BrowserAction } from '../extension/src/agent/actionTypes';

/**
 * PHASE 17.2A fixture, repaired for the corrected action/verification ordering
 * (PHASE 18.8 / A10-F2).
 *
 * The page changes as the plan progresses, which is what a real portal does,
 * and the plan is genuinely required for the goal to become verifiable:
 *
 *   after 0 actions — the details section is closed: only its control exists;
 *   after 1 action  — details opened: the ACCOUNT-HISTORY CONTROL appears;
 *   after 2 actions — the scroll has revealed that control; clicking it is the
 *                     third action;
 *   after 3 actions — the TRANSACTION SURFACE has loaded, and the GoalVerifier
 *                     (rule 4) can finally observe it.
 *
 * The actionable control and the observed surface are deliberately DIFFERENT
 * detections. When they were one detection the fixture could not require the
 * plan at all: the moment the target became clickable, "a transaction surface
 * is in the current perception" was already true, so the loop correctly
 * verified the goal and stopped after one action. The goal state now lags the
 * action that produces it, which is the only honest way for a three-action plan
 * to be necessary.
 *
 * No M5 assertion is touched: the test still proves that click, scroll and click
 * are all dispatched and all pass the action allowlist.
 */
function contextForProgress(executed: number): AgentContextPayload {
  const detailsOpened = executed >= 1;
  const historySurfaceLoaded = executed >= 3;
  return {
    url: 'https://bank.example.com/portal',
    timestamp: 1720000000000,
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: null,
    detections: [
      {
        id: 'element_details',
        type: 'person_name',
        confidence: 0.92,
        bbox: { x: 100, y: 200, width: 150, height: 30 },
        length: 8,
        source: 'dom_label',
        selector: '#btn-details',
        is_partially_visible: false,
      },
      ...(detailsOpened
        ? [
            {
              id: 'element_history_link',
              type: 'button',
              confidence: 0.95,
              bbox: { x: 100, y: 320, width: 180, height: 30 },
              length: 12,
              source: 'dom_label',
              selector: '#btn-history',
              is_partially_visible: false,
            },
          ]
        : []),
      ...(historySurfaceLoaded
        ? [
            {
              id: 'element_transactions_surface',
              type: 'table',
              confidence: 0.95,
              bbox: { x: 60, y: 400, width: 520, height: 240 },
              length: 0,
              source: 'dom_label',
              selector: '#transactions-list',
              is_partially_visible: true,
            },
          ]
        : []),
    ],
    total_elements_scanned: 40,
    sensitive_elements_detected: detailsOpened ? 2 : 1,
    sanitized_status: 'sanitized_only',
    ocr_metrics: null,
  } as AgentContextPayload;
}

const CONTEXT: AgentContextPayload = contextForProgress(0);

function completion(content: string): unknown {
  return { choices: [{ message: { role: 'assistant', content } }] };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Extension full pipeline: fabricated LLM response → validated action', () => {
  it('multi-step: click details → scroll → click the account history control, all validated', async () => {
    const completions = [
      '{"action":"click","target":"element_details","reason":"Open the account details section."}',
      '{"action":"scroll","direction":"down","amount":500,"reason":"Account history not visible yet."}',
      '{"action":"click","target":"element_history_link","reason":"Open the transaction history."}',
    ];
    let call = 0;
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ''));
        return jsonResponse(completion(completions[call++]!));
      })
    );

    const provider = new OpenRouterProvider({ apiKey: 'test-key' });
    const executed: BrowserAction[] = [];
    let snapshotCall = 0;

    const loop = new AgentLoop(provider, {
      // The page genuinely advances with the plan: the history control appears
      // after the details click lands and the transaction surface only after it
      // has been activated (see `contextForProgress`).
      perceivePage: async () => contextForProgress(executed.length),
      executeAction: async (action) => {
        executed.push(action);
        return { success: true };
      },
      //
      // PHASE 18.8 / A10-F2 — the host MUST supply an effect observation
      // channel for a multi-step run. The production service worker always
      // does (it reads the live target tab before and after dispatch), and the
      // typed contract now bounds an UNOBSERVABLE effect to a single
      // re-perception: with no channel every step would be
      // `EFFECT_UNVERIFIABLE` and the loop would correctly stop after the first
      // bounded retry rather than continue acting blind. These snapshots change
      // on every observation, so each action's effect is genuinely observed.
      getEffectSnapshot: async () => {
        const n = snapshotCall++;
        return {
          url: 'http://localhost:4197/',
          scrollX: 0,
          scrollY: n * 100,
          targetValueLength: 0,
          openModalsCount: 0,
          activeElementSelector: 'body',
          domElementCount: 100 + n,
          timestamp: 1 + n,
        };
      },
    }, {
      maxSteps: 6,
      delayBetweenStepsMs: 1,
      providerRetries: 1,
      providerRetryDelayMs: 1,
    });

    const state: TaskState = await loop.runTask(
      'Open the account details and find the recent transactions'
    );

    // Multi-step behavior was driven by fresh perception each step.
    expect(executed.length).toBeGreaterThanOrEqual(3);
    expect(executed[0]).toMatchObject({ action: 'click', target: 'element_details' });

    // Every executed action is exactly a supported 5-action allowlist member.
    for (const action of executed) {
      expect(['click', 'scroll', 'type', 'select', 'navigate']).toContain(action.action);
    }

    // Outbound request bodies contain sanitized metadata only.
    for (const body of bodies) {
      expect(body).not.toContain('DemoPassword123');
      expect(body).not.toContain('4111111111111111');
      expect(body).not.toContain('Rahul');
      expect(body).not.toMatch(/base64,/);
      expect(body).not.toContain('test-key'); // key only in Authorization header
    }
  });

  it('hallucinated target: provider returns it, M5 validator grounds it — rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(completion('{"action":"click","target":"element_invented_xyz"}')))
    );
    const provider = new OpenRouterProvider({ apiKey: 'test-key' });
    const action = await provider.requestAction('Find anything', CONTEXT);

    const validation = validateAction(action, CONTEXT);
    expect(validation.allowed).toBe(false);
    expect(validation.reason).toContain('does not exist');
  });

  it('stale target from previous page: M5 validator rejects against fresh context', async () => {
    const stale = { action: 'click', target: 'element_old_page_button' };
    const validation = validateAction(stale, CONTEXT);
    expect(validation.allowed).toBe(false);
  });

  it('PII in type text: parse → validate chain rejects before policy/execution', () => {
    const action = parseLLMAction(
      '{"action":"type","target":"element_details","text":"Rahul Sharma"}'
    );
    const validation = validateAction(action, CONTEXT);
    expect(validation.allowed).toBe(false);
    expect(validation.reason.toLowerCase()).toContain('sensitive');
  });

  it('PII in model reason: M5 validator rejects before execution', () => {
    const action = parseLLMAction(
      '{"action":"click","target":"element_details","reason":"Account holder Rahul Sharma."}'
    );
    const validation = validateAction(action, CONTEXT);
    expect(validation.allowed).toBe(false);
  });

  it('javascript: URL from the model: M5 validator rejects before policy', () => {
    const action = parseLLMAction('{"action":"navigate","url":"javascript:alert(1)"}');
    const validation = validateAction(action, CONTEXT);
    expect(validation.allowed).toBe(false);
  });

  it('layered gates on a password detection: validator PII scan + policy capability checks', () => {
    const passwordContext: AgentContextPayload = {
      ...CONTEXT,
      detections: [
        {
          id: 'element_pwd',
          type: 'password',
          confidence: 1.0,
          bbox: { x: 10, y: 10, width: 100, height: 20 },
          length: 10,
          source: 'dom_input_type',
          selector: '#pwd',
          is_partially_visible: false,
        },
      ],
    };
    const targetDet = passwordContext.detections[0];

    // Layer 1 — the PII damper blocks credential-shaped text before execution.
    const smuggle = { action: 'type', target: 'element_pwd', text: 'DemoPassword123' } as BrowserAction;
    expect(validateAction(smuggle, passwordContext).allowed).toBe(false);

    // Layer 2 — READ_SENSITIVE_VALUE stays denied for the LLM caller
    // (frozen M5 policy: capabilities are granted but raw values are never
    // reachable because they never exist in the sanitized context).
    const readPolicy = canPerformAction(
      { action: 'click', target: 'element_pwd' } as BrowserAction,
      targetDet,
      'agent_llm'
    );
    expect(readPolicy.granted).toBe(true); // CLICK capability on metadata only
    expect(canPerformAction(smuggle, targetDet, 'agent_llm').granted).toBe(true); // TYPE on benign text

    // The structural guarantee: no API exists for the LLM to obtain the value.
    expect(targetDet).not.toHaveProperty('value');
    expect(targetDet).not.toHaveProperty('text');
  });

  it('oversized model text rejected by the extension parser (Phase 3)', () => {
    const huge = 'x'.repeat(600);
    expect(() =>
      parseLLMAction(`{"action":"type","target":"element_details","text":"${huge}"}`)
    ).toThrow(/500-character limit/);
  });

  it('oversized model reason rejected by the extension parser (Phase 3)', () => {
    const huge = 'r'.repeat(400);
    expect(() =>
      parseLLMAction(`{"action":"click","target":"element_details","reason":"${huge}"}`)
    ).toThrow(/300-character limit/);
  });
});
