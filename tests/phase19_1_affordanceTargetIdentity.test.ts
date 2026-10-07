/**
 * PHASE 19.1 — AFFORDANCE TARGET IDENTITY (real-browser finding, unit-pinned).
 *
 * Two defects were reproduced in real Chrome on the login fixture
 * (`docs/evidence/e2e-verify/e2e_affordance.json`, stub log
 * `DECOY_AFFORDANCES`):
 *
 *  1. The model-facing semantic context carried affordances whose
 *     `targetElementId` was NOT an offered detection id. Measured on the wire:
 *     offered ids [btn-signin, inter-link-1, privagent-det-1], affordance
 *     targets [input-username, input-password, btn-signin, null] — two decoys.
 *     The prompt tells the model "the ONLY valid values for target are the ids
 *     listed under Detected elements" and then lists affordances naming ids
 *     that are not in that list.
 *     Cause: `minimizeAgentContext` applies `filterAffordancesToOfferedIds`
 *     (the A4 invariant), and the agent loop then overwrote
 *     `context.semantic_context` with the RAW context, discarding that result.
 *
 *  2. Typing into the account-identifier field was refused as TARGET_MISMATCH
 *     even when the model used the SANITIZED id, because grounding's structural
 *     `formControlLike` set omitted `email` and `phone` — the two contact
 *     identifier types the M8 policy grants TYPE on and the risk engine scores
 *     MEDIUM for modification. The same omission also made the fuzzy fallback
 *     SKIP that element, which is why the affordance's raw id failed as
 *     ELEMENT_NOT_FOUND at 0% confidence instead of resolving to the sanitized
 *     identity. A login/contact form was therefore unfillable.
 *
 * These tests are the regression pins for both, and they are behavioural: they
 * run the loop and the real grounding function, never a private helper.
 */

import { describe, it, expect, vi } from 'vitest';

import { AgentLoop } from '../extension/src/agent/agentLoop';
import { groundProposedTarget } from '../extension/src/agent/groundingEngine';
import { filterAffordancesToOfferedIds } from '../extension/src/privacy/contextMinimizer';
import { buildBrowserWorldModel } from '../extension/src/worldModel/worldModelBuilder';
import type { BrowserWorldModel } from '../extension/src/worldModel/types';
import { AgentContextPayload } from '../extension/src/privacy/types';

const SANITIZED_ID = 'privagent-det-1';
const PHONE_SANITIZED_ID = 'privagent-det-9';
const RAW_DOM_ID = 'input-username';
const RAW_PASSWORD_ID = 'input-password';
const LOGIN_ORIGIN = 'http://localhost:4174';
const GENERATION = 1;

const LOGIN_HTML = `
  <form id="form-login">
    <input type="text" id="input-username" value="shopper">
    <input type="text" id="input-phone" value="0000000000">
    <button id="btn-signin">Sign In</button>
  </form>`;

function loginDetections(): AgentContextPayload['detections'] {
  return [
    {
      id: SANITIZED_ID,
      type: 'email',
      confidence: 0.95,
      bbox: { x: 40, y: 120, width: 220, height: 32 },
      length: 7,
      source: 'dom_input_type',
      selector: '#input-username',
      is_partially_visible: false,
    },
    {
      id: PHONE_SANITIZED_ID,
      type: 'phone',
      confidence: 0.93,
      bbox: { x: 40, y: 170, width: 220, height: 32 },
      length: 10,
      source: 'dom_input_type',
      selector: '#input-phone',
      is_partially_visible: false,
    },
    {
      id: 'btn-signin',
      type: 'button',
      confidence: 0.9,
      bbox: { x: 40, y: 220, width: 120, height: 36 },
      length: 0,
      source: 'dom_interactive',
      selector: '#btn-signin',
      is_partially_visible: false,
    },
  ] as AgentContextPayload['detections'];
}

function loginContext(): AgentContextPayload {
  return {
    url: `${LOGIN_ORIGIN}/login.html`,
    timestamp: Date.now(),
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: null,
    detections: loginDetections(),
    total_elements_scanned: 3,
    sensitive_elements_detected: 2,
    sanitized_status: 'sanitized_only',
    ocr_metrics: null,
  };
}

function loginWorldModel(): BrowserWorldModel {
  const parsed = new DOMParser().parseFromString(
    `<!doctype html><html><body>${LOGIN_HTML}</body></html>`,
    'text/html'
  );
  return buildBrowserWorldModel({
    root: parsed.body,
    pageGeneration: GENERATION,
    id: `wm-g${GENERATION}`,
  });
}

/** The raw semantic context as the page layer produces it: affordances name RAW DOM ids. */
function rawSemanticContext() {
  return {
    pageType: 'login',
    pageState: 'form_complete',
    pageGeneration: GENERATION,
    entities: [],
    affordances: [
      {
        type: 'FILL_FIELD',
        targetElementId: RAW_DOM_ID,
        description: 'Fill form input field (Protected Credential Field)',
        requiresConfirmation: false,
      },
      {
        type: 'ENTER_PASSWORD_LOCAL',
        targetElementId: RAW_PASSWORD_ID,
        description: 'Local on-device credential entry (never forwarded to remote reasoner)',
        requiresConfirmation: true,
      },
      {
        type: 'SUBMIT_LOGIN',
        targetElementId: 'btn-signin',
        description: 'Submit authentication credentials to session endpoint',
        requiresConfirmation: false,
      },
      { type: 'SCROLL', description: 'Scroll viewport downward', requiresConfirmation: false },
    ],
  } as never;
}

type AffordanceView = { targetElementId?: string };

describe('19.1-A the model-facing context never offers a target it did not offer a detection for', () => {
  it('drops affordances whose targetElementId is not an offered detection id (loop-level)', async () => {
    const seen: AgentContextPayload[] = [];
    const loop = new AgentLoop(
      {
        registerFailure: vi.fn(),
        resetEscalation: vi.fn(),
        requestAction: async (_task: string, context: AgentContextPayload) => {
          // Snapshot exactly what the provider was handed.
          seen.push(JSON.parse(JSON.stringify(context)) as AgentContextPayload);
          return { action: 'scroll', direction: 'down', amount: 120, reason: 'observing the page' };
        },
      } as never,
      {
        perceivePage: async () => ({
          context: loginContext(),
          worldModel: loginWorldModel(),
          activeWorldModelRef: { pageGeneration: GENERATION, worldModelId: `wm-g${GENERATION}` },
          semanticContext: rawSemanticContext(),
          // The real service worker always supplies this alongside the context.
          // Without it the loop rebuilds the semantic understanding locally from
          // the world model, which would replace the fixture context and make
          // this test assert about a different object.
          semanticUnderstanding: { sanitizedContext: rawSemanticContext(), entities: [], set() {} } as never,
        }),
        executeAction: async () => ({ success: true }),
        getEffectSnapshot: async () => null,
      } as never,
      { maxSteps: 1, maxRetries: 1, delayBetweenStepsMs: 1 }
    );

    await loop.runTask('sign in to the store');

    expect(seen.length).toBeGreaterThan(0);

    // The assertion is not vacuous: the RAW context really does contain decoys
    // (two of its four affordances name ids the device never offered).
    const offeredForRaw = new Set(loginDetections().map((d) => d.id));
    const rawDecoys = (rawSemanticContext() as { affordances: AffordanceView[] }).affordances.filter(
      (a) => a.targetElementId && !offeredForRaw.has(a.targetElementId)
    );
    expect(rawDecoys.map((a) => a.targetElementId).sort()).toEqual([RAW_PASSWORD_ID, RAW_DOM_ID]);

    // The model-facing context must have the invariant restored.
    const offered = new Set(seen[0]!.detections.map((d) => d.id));
    const affordances = ((seen[0]!.semantic_context as { affordances?: AffordanceView[] })
      ?.affordances ?? []) as AffordanceView[];
    expect(affordances.length).toBeGreaterThan(0);
    for (const a of affordances) {
      if (a.targetElementId == null) continue;
      expect(offered.has(a.targetElementId)).toBe(true);
    }
    // Only decoys were removed: the legitimate offered affordance survived, and
    // the unfiltered affordance with no target (SCROLL) is untouched.
    expect(affordances.some((a) => a.targetElementId === 'btn-signin')).toBe(true);
    expect(affordances.some((a) => a.targetElementId === RAW_DOM_ID)).toBe(false);
    expect(affordances.some((a) => a.targetElementId === RAW_PASSWORD_ID)).toBe(false);
  });

  it('the same rule holds for the model-facing projection used by the local path', () => {
    const filtered = filterAffordancesToOfferedIds(
      rawSemanticContext() as { affordances: AffordanceView[] },
      loginDetections()
    );
    const offered = new Set(loginDetections().map((d) => d.id));
    for (const a of (filtered as { affordances: AffordanceView[] }).affordances) {
      if (a.targetElementId == null) continue;
      expect(offered.has(a.targetElementId)).toBe(true);
    }
  });
});

describe('19.1-B grounding: contact-identifier fields are form controls, everything else is unchanged', () => {
  const options = { currentPageGeneration: GENERATION, actionPageGeneration: GENERATION, currentOrigin: LOGIN_ORIGIN };

  it('grounds `type` on the SANITIZED id of an email field', () => {
    const result = groundProposedTarget(
      { action: 'type', target: SANITIZED_ID, text: 'shopper', reason: 'fill the account field' },
      loginDetections(),
      options
    );
    expect(result.grounded).toBe(true);
    expect(result.targetId).toBe(SANITIZED_ID);
  });

  it('grounds `type` on the SANITIZED id of a phone field', () => {
    const result = groundProposedTarget(
      { action: 'type', target: PHONE_SANITIZED_ID, text: '12345', reason: 'fill the contact field' },
      loginDetections(),
      options
    );
    expect(result.grounded).toBe(true);
    expect(result.targetId).toBe(PHONE_SANITIZED_ID);
  });

  it('grounds `click` on the offered submit control', () => {
    const result = groundProposedTarget(
      { action: 'click', target: 'btn-signin', reason: 'submit the form' },
      loginDetections(),
      options
    );
    expect(result.grounded).toBe(true);
  });

  it('STILL rejects `type` into a button (structural mismatch preserved)', () => {
    const result = groundProposedTarget(
      { action: 'type', target: 'btn-signin', text: 'shopper', reason: 'fill' },
      loginDetections(),
      options
    );
    expect(result.grounded).toBe(false);
    expect(result.failureReason).toBe('TARGET_MISMATCH');
  });

  it('STILL rejects an id that matches no offered detection on any signal', () => {
    const result = groundProposedTarget(
      { action: 'type', target: 'some-other-field', text: 'shopper', reason: 'fill' },
      loginDetections(),
      options
    );
    expect(result.grounded).toBe(false);
    expect(result.failureReason).toBe('ELEMENT_NOT_FOUND');
  });

  it('a fuzzy target can only ever be RE-TARGETED to an offered identity, never executed raw', () => {
    // The selector-overlap fallback resolves the affordance's raw DOM id — but
    // only because an OFFERED detection carries that selector, and it returns
    // the SANITIZED id as the execution target. No arbitrary DOM id can reach
    // the content script: grounding rewrites the action's target (agentLoop:
    // "Grounding successful: update action target if resolved").
    const result = groundProposedTarget(
      { action: 'type', target: RAW_DOM_ID, text: 'shopper', reason: 'fill' },
      loginDetections(),
      options
    );
    expect(result.grounded).toBe(true);
    expect(result.targetId).toBe(SANITIZED_ID);
    expect(result.targetId).not.toBe(RAW_DOM_ID);
  });

  it('STILL rejects a target from a superseded page generation', () => {
    const result = groundProposedTarget(
      { action: 'type', target: SANITIZED_ID, text: 'shopper', reason: 'fill' },
      loginDetections(),
      { currentPageGeneration: 4, actionPageGeneration: GENERATION, currentOrigin: LOGIN_ORIGIN }
    );
    expect(result.grounded).toBe(false);
    expect(result.failureReason).toBe('STALE_TARGET');
  });
});
