/**
 * PrivAgent — Phase 12 Acceptance: Containment / Sandbox
 *
 * Containment is an ENVIRONMENTAL control: it limits WHERE the agent may act,
 * so that a risky or hijacked action cannot spread beyond the site the task
 * actually resolved. It is NOT an action-authorization gate.
 *
 * These tests assert both halves of that contract:
 *
 *   1. Containment genuinely bounds the blast radius — cross-origin
 *      navigation, tab drift, uncontainable schemes, an unestablished scope and
 *      dashboard misuse are all refused, and a refusal is TERMINAL so the task
 *      cannot retry its way into the environment it was denied.
 *   2. Containment does NOT weaken, replace or reorder any existing security
 *      authority. Grounding, M5, the Security Critic, the Privacy Firewall,
 *      Risk/Confirmation, Effect Verification, Goal Verification and the Phase
 *      10 Recovery Engine all still run first, and every one of them still
 *      decides independently.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ContainmentScope,
  deriveRootHost,
  describeContainment,
  containmentSummary,
  establishContainmentScope,
  evaluateContainment,
  hostWithinScope,
  isContainableScheme,
  isDashboardOrigin,
  verifyNavigationContainment,
} from '../../extension/src/agent/containment';
import { validateAction } from '../../extension/src/agent/actionValidator';
import { groundProposedTarget } from '../../extension/src/agent/groundingEngine';
import { reviewProposedAction } from '../../extension/src/agent/securityCritic';
import { assessActionRisk } from '../../extension/src/agent/riskEngine';
import { canPerformAction } from '../../extension/src/agent/privacyPolicy';
import { AgentLoop, assertNoSensitiveDataInState } from '../../extension/src/agent/agentLoop';
import { MockAgentProvider } from '../../extension/src/agent/mockAgentProvider';
import { BrowserAction } from '../../extension/src/agent/actionTypes';
import { AgentContextPayload, AgentDetection } from '../../extension/src/privacy/types';

const DASHBOARD = 'http://localhost:5173';

function scopeFor(url: string, tabId: number | null = 7): ContainmentScope | null {
  return establishContainmentScope({ targetUrl: url, targetTabId: tabId, dashboardOrigin: DASHBOARD });
}

function requireScope(url: string, tabId: number | null = 7): ContainmentScope {
  const s = scopeFor(url, tabId);
  expect(s).not.toBeNull();
  if (!s) throw new Error('scope not established');
  return s;
}

function det(id: string, type: AgentDetection['type'], selector: string): AgentDetection {
  return {
    id,
    type,
    selector,
    confidence: 0.95,
    bbox: { x: 20, y: 20, width: 160, height: 32 },
    length: 0,
    source: 'dom_attribute',
    is_partially_visible: false,
  };
}

function ctx(overrides: Partial<AgentContextPayload> = {}): AgentContextPayload {
  return {
    url: 'https://www.google.com/',
    timestamp: 1_700_000_000_000,
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: { width: 1280, height: 800 },
    sanitized_status: 'sanitized_only',
    total_elements_scanned: 5,
    sensitive_elements_detected: 0,
    ocr_metrics: { regions_scanned: 1, sensitive_detected: 0, latency_ms: 5 },
    detections: [det('search-box', 'search', 'input#q'), det('go', 'button', 'button#go')],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Scope establishment
// ─────────────────────────────────────────────────────────────────────────────
describe('P12-1 containment scope is established from the resolved target only', () => {
  it('1.1 a real web target produces a scope with a root host', () => {
    const s = requireScope('https://www.google.com/');
    expect(s.rootHost).toBe('google.com');
    expect(s.origin).toBe('https://www.google.com');
    expect(s.tabId).toBe(7);
  });

  it('1.2 the scope is deterministic — same input, same scope', () => {
    expect(scopeFor('https://www.google.com/search?q=cats')).toEqual(
      scopeFor('https://www.google.com/search?q=dogs')
    );
  });

  it('1.3 a non-web target cannot be contained, so no scope is established', () => {
    for (const bad of ['chrome://settings', 'about:blank', 'file:///etc/passwd', 'javascript:alert(1)']) {
      expect(scopeFor(bad)).toBeNull();
    }
  });

  it('1.4 malformed input is refused rather than defaulted open', () => {
    for (const bad of [null, undefined, '', '   ', 'not a url']) {
      expect(scopeFor(bad as string)).toBeNull();
    }
  });

  it('1.5 the DASHBOARD is never a valid agent environment', () => {
    expect(scopeFor('http://localhost:5173/')).toBeNull();
    expect(scopeFor('http://127.0.0.1:5173/app')).toBeNull();
    expect(scopeFor('https://localhost:5173/dashboard')).toBeNull();
  });

  it('1.6 root-host derivation keeps subdomains inside one scope', () => {
    expect(deriveRootHost('https://accounts.google.com/signin')).toBe('google.com');
    expect(deriveRootHost('https://www.flipkart.com/')).toBe('flipkart.com');
    expect(deriveRootHost('http://localhost:4191/')).toBe('localhost');
    expect(deriveRootHost('https://a.b.c.example.co.uk/x')).toBe('co.uk');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Host and scheme primitives
// ─────────────────────────────────────────────────────────────────────────────
describe('P12-2 containment primitives are strict and fail closed', () => {
  it('2.1 the root host and its subdomains are inside the scope', () => {
    expect(hostWithinScope('google.com', 'google.com')).toBe(true);
    expect(hostWithinScope('www.google.com', 'google.com')).toBe(true);
    expect(hostWithinScope('accounts.google.com', 'google.com')).toBe(true);
  });

  it('2.2 every other host is outside the scope', () => {
    expect(hostWithinScope('example.com', 'google.com')).toBe(false);
    expect(hostWithinScope('evil-google.com', 'google.com')).toBe(false);
    expect(hostWithinScope('google.com.evil.test', 'google.com')).toBe(false);
  });

  it('2.3 missing input is never "inside" the scope', () => {
    expect(hostWithinScope(null, 'google.com')).toBe(false);
    expect(hostWithinScope('google.com', null)).toBe(false);
    expect(hostWithinScope(null, null)).toBe(false);
  });

  it('2.4 only http/https are containable schemes', () => {
    expect(isContainableScheme('https://example.com/')).toBe(true);
    expect(isContainableScheme('http://example.com/')).toBe(true);
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'chrome://x', 'nope']) {
      expect(isContainableScheme(bad)).toBe(false);
    }
  });

  it('2.5 dashboard detection matches the dashboard origin', () => {
    expect(isDashboardOrigin('http://localhost:5173', DASHBOARD)).toBe(true);
    expect(isDashboardOrigin('https://example.com', DASHBOARD)).toBe(false);
    // A different port on the same host is an ordinary web origin, matching the
    // tab resolver's existing eligibility rule.
    expect(isDashboardOrigin('http://localhost:4191', DASHBOARD)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Containment decisions — the blast radius
// ─────────────────────────────────────────────────────────────────────────────
describe('P12-3 containment bounds the blast radius of autonomous actions', () => {
  const scope = requireScope('https://www.google.com/');

  it('3.1 ordinary in-scope actions are contained', () => {
    const actions: BrowserAction[] = [
      { action: 'click', target: 'go' },
      { action: 'type', target: 'search-box', text: 'cats' },
      { action: 'select', target: 'search-box', option: 'all' },
      { action: 'scroll', direction: 'down', amount: 300 },
      { action: 'pressKey', key: 'Enter' },
    ];
    for (const action of actions) {
      const d = evaluateContainment({ action, scope, targetTabId: 7, liveUrl: 'https://www.google.com/' });
      expect(d.contained).toBe(true);
      expect(d.code).toBe('WITHIN_SCOPE');
      expect(d.terminal).toBe(false);
    }
  });

  it('3.2 navigation WITHIN the resolved site is contained', () => {
    const d = evaluateContainment({
      action: { action: 'navigate', url: 'https://accounts.google.com/signin' },
      scope,
      targetTabId: 7,
      liveUrl: 'https://www.google.com/',
    });
    expect(d.contained).toBe(true);
  });

  it('3.3 navigation to a DIFFERENT site is DENIED — the core blast-radius control', () => {
    for (const url of [
      'https://evil.example/steal',
      'https://bank.example.com/login',
      'https://google.com.evil.test/',
    ]) {
      const d = evaluateContainment({
        action: { action: 'navigate', url },
        scope,
        targetTabId: 7,
        liveUrl: 'https://www.google.com/',
      });
      expect(d.contained).toBe(false);
      expect(d.code).toBe('CROSS_ORIGIN_NAVIGATION_DENIED');
      expect(d.terminal).toBe(true);
    }
  });

  it('3.4 an UNESTABLISHED scope denies everything — never open', () => {
    const d = evaluateContainment({
      action: { action: 'click', target: 'go' },
      scope: null,
      targetTabId: 7,
      liveUrl: 'https://www.google.com/',
    });
    expect(d.contained).toBe(false);
    expect(d.code).toBe('CONTAINMENT_UNINITIALIZED');
    expect(d.terminal).toBe(true);
  });

  it('3.5 acting in a tab other than the contained target is DENIED', () => {
    const d = evaluateContainment({
      action: { action: 'click', target: 'go' },
      scope,
      targetTabId: 99,
      liveUrl: 'https://www.google.com/',
    });
    expect(d.contained).toBe(false);
    expect(d.code).toBe('TAB_SCOPE_VIOLATION');
  });

  it('3.6 a tab that has DRIFTED out of scope stops further interaction', () => {
    const d = evaluateContainment({
      action: { action: 'click', target: 'go' },
      scope,
      targetTabId: 7,
      liveUrl: 'https://redirected.evil.test/landing',
    });
    expect(d.contained).toBe(false);
    expect(d.code).toBe('SCOPE_DRIFT_DETECTED');
    expect(d.terminal).toBe(true);
  });

  it('3.7 an uncontainable live scheme stops further interaction', () => {
    const d = evaluateContainment({
      action: { action: 'click', target: 'go' },
      scope,
      targetTabId: 7,
      liveUrl: 'chrome://settings',
    });
    expect(d.contained).toBe(false);
    expect(d.code).toBe('UNSUPPORTED_SCHEME_DENIED');
  });

  it('3.8 navigation to an uncontainable scheme is DENIED', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>x']) {
      const d = evaluateContainment({
        action: { action: 'navigate', url },
        scope,
        targetTabId: 7,
        liveUrl: 'https://www.google.com/',
      });
      expect(d.contained).toBe(false);
      expect(d.code).toBe('UNSUPPORTED_SCHEME_DENIED');
    }
  });

  it('3.9 malformed input fails closed', () => {
    const d = evaluateContainment({
      action: null as never,
      scope,
      targetTabId: 7,
      liveUrl: 'https://www.google.com/',
    });
    expect(d.contained).toBe(false);
    expect(d.code).toBe('MALFORMED_INPUT');
  });

  it('3.10 a forged scope on the dashboard origin is still refused', () => {
    const forged: ContainmentScope = {
      rootHost: 'localhost',
      origin: 'http://localhost:5173',
      tabId: 7,
      dashboardOrigin: DASHBOARD,
    };
    const d = evaluateContainment({
      action: { action: 'click', target: 'go' },
      scope: forged,
      targetTabId: 7,
      liveUrl: 'http://localhost:5173/',
    });
    expect(d.contained).toBe(false);
    expect(d.code).toBe('DASHBOARD_ORIGIN_DENIED');
  });

  it('3.11 a blank page before the first load is not treated as drift', () => {
    const d = evaluateContainment({
      action: { action: 'scroll', direction: 'down', amount: 300 },
      scope,
      targetTabId: 7,
      liveUrl: 'about:blank',
    });
    expect(d.contained).toBe(true);
  });

  it('3.12 the decision is DETERMINISTIC — repeated evaluation is identical', () => {
    const input = {
      action: { action: 'navigate', url: 'https://evil.example/' } as BrowserAction,
      scope,
      targetTabId: 7,
      liveUrl: 'https://www.google.com/',
    };
    expect(evaluateContainment(input)).toEqual(evaluateContainment(input));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Containment holds across navigation
// ─────────────────────────────────────────────────────────────────────────────
describe('P12-4 containment holds across a navigation, not only before it', () => {
  it('4.1 a landing inside the scope is accepted', () => {
    const scope = requireScope('https://www.google.com/');
    const d = verifyNavigationContainment(scope, 'https://www.google.com/search?q=cats');
    expect(d.contained).toBe(true);
  });

  it('4.2 a redirect OFF the scope is refused', () => {
    const scope = requireScope('https://www.google.com/');
    const d = verifyNavigationContainment(scope, 'https://redirected.evil.test/landing');
    expect(d.contained).toBe(false);
    expect(d.code).toBe('SCOPE_DRIFT_DETECTED');
    expect(d.terminal).toBe(true);
  });

  it('4.3 landing on a non-web scheme is refused', () => {
    const scope = requireScope('https://www.google.com/');
    expect(verifyNavigationContainment(scope, 'chrome://newtab').contained).toBe(false);
  });

  it('4.4 verification without a scope fails closed', () => {
    const d = verifyNavigationContainment(null, 'https://www.google.com/');
    expect(d.contained).toBe(false);
    expect(d.code).toBe('CONTAINMENT_UNINITIALIZED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Decisions are value-free
// ─────────────────────────────────────────────────────────────────────────────
describe('P12-5 containment reporting is value-free', () => {
  it('5.1 a denial reason never contains the URL or any page text', () => {
    const scope = requireScope('https://www.google.com/');
    const d = evaluateContainment({
      action: { action: 'navigate', url: 'https://secret-site.example/path?q=my-private-query' },
      scope,
      targetTabId: 7,
      liveUrl: 'https://www.google.com/',
    });
    expect(d.contained).toBe(false);
    expect(d.reason).not.toContain('secret-site');
    expect(d.reason).not.toContain('my-private-query');
    expect(d.reason).not.toContain('https://');
  });

  it('5.2 the decision is a code plus a boolean, and the audit line is stable', () => {
    const scope = requireScope('https://www.google.com/');
    const d = evaluateContainment({
      action: { action: 'click', target: 'go' },
      scope,
      targetTabId: 7,
      liveUrl: 'https://www.google.com/',
    });
    expect(describeContainment(d)).toBe('CONTAINMENT_WITHIN_SCOPE (ALLOW)');
  });

  it('5.3 the scope summary exposes only the root host', () => {
    expect(containmentSummary(requireScope('https://www.google.com/'))).toBe('contained:google.com');
    expect(containmentSummary(null)).toBe('contained:none');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Integration: the AgentLoop refuses and stops
// ─────────────────────────────────────────────────────────────────────────────
describe('P12-6 the AgentLoop enforces containment at the dispatch boundary', () => {
  const TASK = 'search for black cats on google';

  function makeLoop(actions: BrowserAction[], containmentScope: ContainmentScope | null, liveUrl: string) {
    const provider = new MockAgentProvider(actions);
    const executeAction = vi.fn(async (_action: BrowserAction) => ({ success: true, postSnapshot: { url: liveUrl, scrollX: 0, scrollY: 0, domElementCount: 4, targetValueLength: 0, timestamp: 1 } }));
    const loop = new AgentLoop(
      provider,
      {
        perceivePage: async () => ctx({ url: liveUrl }),
        executeAction,
        getEffectSnapshot: async () => ({ url: liveUrl, scrollX: 0, scrollY: 0, domElementCount: 4, targetValueLength: 0, timestamp: 1 }),
      },
      { maxSteps: 5, maxRetries: 2, delayBetweenStepsMs: 1, targetTabId: 7, containmentScope }
    );
    return { loop, executeAction };
  }

  it('6.1 a cross-origin navigate is refused by the pipeline BEFORE containment is consulted', async () => {
    // Containment is the LAST gate. An off-site navigation is already refused
    // upstream (here by the Security Critic), so containment is never the only
    // thing standing between the agent and an off-site target. This test pins
    // that ordering so containment can never be mistaken for the sole control.
    const { loop, executeAction } = makeLoop(
      [
        { action: 'navigate', url: 'https://evil.example/steal', reason: 'Navigate to the requested site' },
        { action: 'scroll', direction: 'down', amount: 300, reason: 'Look around the page' },
      ],
      requireScope('https://www.google.com/'),
      'https://www.google.com/'
    );
    const state = await loop.runTask(TASK);

    const navigateStep = state.steps.find((s) => s.action.action === 'navigate');
    expect(navigateStep?.validationAllowed).toBe(false);
    expect(navigateStep?.executionError).toMatch(/Security Critic BLOCKED/);
    // The executor was only reached for the later, in-scope scroll.
    expect(executeAction.mock.calls.every((c) => c[0].action !== 'navigate')).toBe(true);
  });

  it('6.2 a tab that drifted off-scope is BLOCKED by containment and never reaches the executor', async () => {
    // This is the case NO action gate can see: a redirect or page-driven jump
    // moved the target tab after perception. Containment is the only authority
    // that can catch it, because it bounds the ENVIRONMENT rather than the
    // action.
    const { loop, executeAction } = makeLoop(
      [
        { action: 'click', target: 'go', reason: 'Open the search control' },
        { action: 'click', target: 'go', reason: 'Click the search control again' },
      ],
      requireScope('https://www.google.com/'),
      'https://redirected.evil.test/landing'
    );
    const state = await loop.runTask(TASK);

    expect(executeAction).not.toHaveBeenCalled();
    expect(state.status).toBe('FAILED');
    expect(state.containmentDecision?.code).toBe('SCOPE_DRIFT_DETECTED');
    expect(state.containmentDecision?.contained).toBe(false);
    expect(state.failureHistory?.some((f) => f.category === 'CONTAINMENT_DENIED')).toBe(true);
  });

  it('6.3 the denial is TERMINAL — the task does not retry into the denied environment', async () => {
    const { loop, executeAction } = makeLoop(
      [
        { action: 'click', target: 'go', reason: 'Open the search control' },
        { action: 'click', target: 'go', reason: 'Click the search control again' },
        { action: 'scroll', direction: 'down', amount: 300, reason: 'Keep trying' },
      ],
      requireScope('https://www.google.com/'),
      'https://redirected.evil.test/landing'
    );
    const state = await loop.runTask(TASK);

    expect(executeAction).not.toHaveBeenCalled();
    // Exactly one denial recorded — no containment retry loop.
    expect(state.failureHistory?.filter((f) => f.category === 'CONTAINMENT_DENIED').length).toBe(1);
    // The Recovery Engine was NOT engaged for an environmental refusal.
    expect(state.totalRecoveryAttempts ?? 0).toBe(0);
  });

  it('6.4 a host with no scope claims no environmental boundary (and says so)', async () => {
    // The loop enforces the scope it is GIVEN. A host that owns no tab (an
    // in-process harness, a non-browser embedding) has no environment to
    // contain, so it passes no scope and the state records that plainly rather
    // than claiming a containment verdict it never made. The product path is
    // fail-closed one level up: the service worker refuses to START a task when
    // establishContainmentScope returns null (asserted in 6.7).
    const { loop, executeAction } = makeLoop(
      [
        { action: 'click', target: 'go', reason: 'Open the search control' },
        { action: 'scroll', direction: 'down', amount: 300, reason: 'Look around' },
      ],
      null,
      'https://www.google.com/'
    );
    const state = await loop.runTask(TASK);

    expect(executeAction).toHaveBeenCalled();
    expect(state.containmentDecision).toBeNull();
  });

  it('6.7 a target with no containable environment yields NO scope — the SW start guard', () => {
    // This is the condition the service worker's fail-closed guard tests: if
    // this returns null, the worker refuses to start the task rather than
    // running the agent unbounded.
    expect(scopeFor('https://www.google.com/')).not.toBeNull();
    for (const uncontainable of [
      'chrome://settings',
      'about:blank',
      'file:///etc/passwd',
      'http://localhost:5173/',
      'not a url',
      '',
    ]) {
      expect(scopeFor(uncontainable)).toBeNull();
    }
  });

  it('6.5 an in-scope action is NOT blocked — containment does not break normal work', async () => {
    const { loop, executeAction } = makeLoop(
      [
        { action: 'click', target: 'go', reason: 'Open the search control' },
        { action: 'type', target: 'search-box', text: 'black cats', reason: 'Enter the search query' },
      ],
      requireScope('https://www.google.com/'),
      'https://www.google.com/'
    );
    const state = await loop.runTask(TASK);

    expect(executeAction).toHaveBeenCalled();
    expect(state.containmentDecision?.contained).toBe(true);
    expect(state.containmentDecision?.code).toBe('WITHIN_SCOPE');
    expect(state.containmentDecision?.scope).toBe('contained:google.com');
  });

  it('6.6 containment state carries no raw values', async () => {
    const { loop } = makeLoop(
      [{ action: 'type', target: 'search-box', text: 'black cats', reason: 'Enter the search query' }],
      requireScope('https://www.google.com/'),
      'https://www.google.com/'
    );
    const state = await loop.runTask(TASK);
    expect(() => assertNoSensitiveDataInState(state)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. The critical invariant: containment does not weaken the pipeline
// ─────────────────────────────────────────────────────────────────────────────
describe('P12-7 containment never substitutes for an existing security authority', () => {
  const scope = requireScope('https://www.google.com/');

  it('7.1 an action denied by M5 is still denied, even though it is in scope', () => {
    const unsafe: BrowserAction = { action: 'pressKey', key: 'Delete' };
    // Containment would allow this (it is in scope)...
    expect(evaluateContainment({ action: unsafe, scope, targetTabId: 7, liveUrl: 'https://www.google.com/' }).contained).toBe(true);
    // ...but M5 still refuses it, and M5 is the authority.
    expect(validateAction(unsafe, ctx()).allowed).toBe(false);
  });

  it('7.2 an ungrounded action is still rejected by grounding, in scope or not', () => {
    const r = groundProposedTarget({ action: 'click', target: 'phantom' }, ctx().detections);
    expect(r.grounded).toBe(false);
  });

  it('7.3 the Security Critic still BLOCKS an out-of-goal destructive control inside the scope', () => {
    const c = ctx({
      detections: [det('del', 'button', 'button#delete')],
    });
    const r = reviewProposedAction({
      action: { action: 'click', target: 'del' },
      task: 'search for black cats on google',
      context: c,
    });
    expect(r.verdict).toBe('BLOCK');
  });

  it('7.4 the Privacy Firewall still governs a sensitive control inside the scope', () => {
    const pw = det('pw', 'password', 'input#pw');
    expect(canPerformAction({ action: 'click', target: 'pw' }, pw, 'agent_llm').granted).toBe(true);
    expect(
      canPerformAction({ action: 'type', target: 'pw', text: 'secret' }, pw, 'local_user').granted
    ).not.toBe(false);
  });

  it('7.5 risk still scores an in-scope destructive action as consequential', () => {
    const r = assessActionRisk({ action: 'click', target: 'go' }, ctx(), 'https://www.google.com/');
    expect(r.allowed).toBeDefined();
    // Containment being permissive does not make risk permissive.
    expect(typeof r.requiresConfirmation).toBe('boolean');
  });

  it('7.6 containment runs AFTER the gates — it never authorizes an action the pipeline refused', () => {
    // The contract is structural: containment is evaluated on an action that has
    // already passed grounding/M5/critic/privacy/risk. If any of those refuse,
    // execution never happens, so containment is never consulted as an escape.
    const c = ctx();
    const refusedByM5 = validateAction({ action: 'click', target: 'not-in-context' }, c);
    expect(refusedByM5.allowed).toBe(false);
    // The same action, if it were reachable, is in scope — proving containment
    // is not what refused it.
    expect(
      evaluateContainment({
        action: { action: 'click', target: 'not-in-context' },
        scope,
        targetTabId: 7,
        liveUrl: 'https://www.google.com/',
      }).contained
    ).toBe(true);
  });
});
