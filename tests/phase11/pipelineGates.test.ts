/**
 * PrivAgent — Phase 11 Acceptance: authoritative pipeline gates
 *
 * Phase 11 added interaction quality, NOT authority. This file proves the
 * gates a human-like interaction must still pass:
 *
 *   GATE 1  Target grounding        — still rejects ungrounded/stale targets
 *   GATE 2  M5 local validator      — still owns the safe-key allowlist
 *   GATE 2.5 Security Critic        — still fails closed, still cross-checks
 *                                    destructive intent before any pressKey
 *   GATE 3  Privacy Firewall        — pressKey is CLICK-class, never TYPE/READ
 *   GATE 4  Risk engine             — pressKey is MEDIUM, not free
 *   Planner shape validation        — one atomic action, no compound payloads
 *   Effect Verification             — a pressKey is never assumed successful
 *   Goal Verification               — success needs an OBSERVED query
 */

import { describe, it, expect } from 'vitest';
import { groundProposedTarget } from '../../extension/src/agent/groundingEngine';
import { validateAction } from '../../extension/src/agent/actionValidator';
import { reviewProposedAction } from '../../extension/src/agent/securityCritic';
import { assessActionRisk } from '../../extension/src/agent/riskEngine';
import { canPerformAction } from '../../extension/src/agent/privacyPolicy';
import { verifyActionEffect } from '../../extension/src/agent/effectVerifier';
import { verifyTaskGoal } from '../../extension/src/agent/goalVerifier';
import { OneActionPlanner } from '../../extension/src/hierarchicalPlanning/oneActionPlanner';
import { BrowserAction } from '../../extension/src/agent/actionTypes';
import { ctx, det, snapshot } from './harness';

describe('P11-13 GATE 1 grounding stays authoritative', () => {
  it('13.1 a targeted pressKey grounds on a form control', () => {
    const r = groundProposedTarget(
      { action: 'pressKey', key: 'Enter', target: 'search-box' },
      ctx().detections
    );
    expect(r.grounded).toBe(true);
    expect(r.targetId).toBe('search-box');
    expect(r.confidence).toBeGreaterThanOrEqual(0.65);
  });

  it('13.2 a targeted pressKey does NOT ground on a non-form control', () => {
    const r = groundProposedTarget(
      { action: 'pressKey', key: 'Enter', target: 'results-link' },
      ctx().detections
    );
    expect(r.grounded).toBe(false);
    expect(r.failureReason).toBe('TARGET_MISMATCH');
  });

  it('13.3 an unknown target is never grounded', () => {
    const r = groundProposedTarget(
      { action: 'pressKey', key: 'Enter', target: 'phantom-control' },
      ctx().detections
    );
    expect(r.grounded).toBe(false);
  });

  it('13.4 a stale page generation is still rejected (Phase 11 added no bypass)', () => {
    const r = groundProposedTarget(
      { action: 'pressKey', key: 'Enter', target: 'search-box' },
      ctx().detections,
      { currentPageGeneration: 4, actionPageGeneration: 3 }
    );
    expect(r.grounded).toBe(false);
    expect(r.failureReason).toBe('STALE_TARGET');
  });

  it('13.5 a zero-geometry target is rejected as not interactable', () => {
    const c = ctx({ detections: [det('collapsed', 'input', 'input#c', [0, 0, 0, 0])] });
    const r = groundProposedTarget(
      { action: 'pressKey', key: 'Tab', target: 'collapsed' },
      c.detections
    );
    expect(r.grounded).toBe(false);
    expect(r.failureReason).toBe('DISABLED_OR_HIDDEN');
  });
});

describe('P11-14 M5 remains authoritative over every Phase 11 action', () => {
  it('14.1 a safe pressKey passes and is normalized', () => {
    const r = validateAction(
      { action: 'pressKey', key: 'Enter', target: 'search-box', reason: 'Submit the query' },
      ctx()
    );
    expect(r.allowed).toBe(true);
    if (r.allowed && r.action.action === 'pressKey') {
      expect(r.action.key).toBe('Enter');
      expect(r.action.target).toBe('search-box');
    } else {
      throw new Error('expected a validated pressKey action');
    }
  });

  it('14.2 an off-allowlist key is rejected by M5 with a stable reason', () => {
    const r = validateAction({ action: 'pressKey', key: 'Delete' }, ctx());
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/safe-key allowlist/i);
  });

  it('14.3 a non-string key is rejected', () => {
    for (const key of [42, null, { key: 'Enter' }, ['Enter']]) {
      expect(validateAction({ action: 'pressKey', key }, ctx()).allowed).toBe(false);
    }
  });

  it('14.4 an over-long key string is rejected', () => {
    const r = validateAction({ action: 'pressKey', key: 'E'.repeat(33) }, ctx());
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/requires a 'key' string/i);
  });

  it('14.5 a pressKey target that is not in the sanitized context is rejected', () => {
    const r = validateAction({ action: 'pressKey', key: 'Enter', target: 'not-in-context' }, ctx());
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/does not exist in the current sanitized context/i);
  });

  it('14.6 an unknown field on a pressKey is rejected', () => {
    const r = validateAction({ action: 'pressKey', key: 'Enter', script: 'alert(1)' }, ctx());
    expect(r.allowed).toBe(false);
  });

  it('14.7 a sensitive value may never ride along on a pressKey', () => {
    const r = validateAction({ action: 'pressKey', key: 'Enter', value: 'hunter2' }, ctx());
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/sensitive key|forbidden/i);
  });

  it('14.8 attempts to modify local security policy are still refused', () => {
    const r = validateAction({ action: 'bypass_confirmation', target: 'search-box' }, ctx());
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/M5_UNMODIFIABLE/);
  });

  it('14.9 a click on an unknown target is rejected', () => {
    expect(validateAction({ action: 'click', target: 'nope' }, ctx()).allowed).toBe(false);
  });

  it('14.10 a scroll beyond the validator bounds is rejected', () => {
    expect(validateAction({ action: 'scroll', direction: 'down', amount: 99_999 }, ctx()).allowed).toBe(false);
    expect(validateAction({ action: 'scroll', direction: 'down', amount: 0 }, ctx()).allowed).toBe(false);
  });

  it('14.11 an unsafe navigate protocol is rejected', () => {
    expect(validateAction({ action: 'navigate', url: 'javascript:alert(1)' }, ctx()).allowed).toBe(false);
    expect(validateAction({ action: 'navigate', url: 'file:///etc/passwd' }, ctx()).allowed).toBe(false);
  });
});

describe('P11-15 raw sensitive values never transit through an action', () => {
  it('15.1 typing a credit card number is refused by M5', () => {
    const r = validateAction(
      { action: 'type', target: 'search-box', text: '4111 1111 1111 1111' },
      ctx()
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/sensitive|PII/i);
  });

  it('15.2 typing an email address is refused by M5', () => {
    expect(
      validateAction({ action: 'type', target: 'search-box', text: 'someone@example.com' }, ctx()).allowed
    ).toBe(false);
  });

  it('15.3 a labelled credential in typed text is refused by M5', () => {
    expect(
      validateAction({ action: 'type', target: 'search-box', text: 'password: hunter2' }, ctx()).allowed
    ).toBe(false);
  });

  it('15.4 script injection through typed text is refused by M5', () => {
    const r = validateAction(
      { action: 'type', target: 'search-box', text: '<script>alert(1)</script>' },
      ctx()
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/script injection/i);
  });

  it('15.5 a select option carrying PII is refused by M5', () => {
    expect(
      validateAction(
        { action: 'select', target: 'colour-select', option: '4111111111111111' },
        ctx()
      ).allowed
    ).toBe(false);
  });

  it('15.6 the privacy firewall maps pressKey to CLICK capability, never TYPE or READ', () => {
    const target = ctx({ detections: [det('pw', 'password', 'input#pw')] }).detections[0];
    expect(target).toBeDefined();
    if (!target) return;

    const asClick = canPerformAction({ action: 'click', target: 'pw' }, target, 'agent_llm');
    const asKey = canPerformAction({ action: 'pressKey', key: 'Enter', target: 'pw' }, target, 'agent_llm');

    expect(asKey.granted).toBe(asClick.granted);
    expect(asKey.reason).toContain("'CLICK'");
    expect(asKey.reason).not.toContain("'TYPE'");
    expect(asKey.reason).not.toContain('READ_SENSITIVE_VALUE');
  });
});

describe('P11-16 the Security Critic and risk engine still govern keyboard actions', () => {
  const task = 'Search the site for black cats';

  it('16.1 a grounded, allowlisted pressKey is not a blanket BLOCK', () => {
    const r = reviewProposedAction({
      action: { action: 'pressKey', key: 'Enter', target: 'search-box' },
      task,
      context: ctx(),
    });
    expect(r.verdict).not.toBe('BLOCK');
    expect(r.inputWellFormed).toBe(true);
  });

  it('16.2 the critic still fails closed on malformed input for a pressKey', () => {
    expect(reviewProposedAction({ action: null as never, task, context: ctx() }).verdict).toBe('BLOCK');
  });

  it('16.3 the critic still refuses an unsanitized context for a pressKey', () => {
    const r = reviewProposedAction({
      action: { action: 'pressKey', key: 'Enter' },
      task,
      context: { ...ctx(), sanitized_status: 'raw' as never },
    });
    expect(r.verdict).toBe('BLOCK');
  });

  it('16.4 the destructive cross-check still runs before the pressKey case', () => {
    const c = ctx({
      detections: [det('delete-btn', 'button', 'button#delete', [10, 10, 100, 30], 'Delete account')],
    });
    const r = reviewProposedAction({ action: { action: 'click', target: 'delete-btn' }, task, context: c });
    expect(r.verdict).toBe('BLOCK');
  });

  it('16.5 pressKey carries MEDIUM action-type risk, not the base LOW score', () => {
    const r = assessActionRisk({ action: 'pressKey', key: 'Enter' }, ctx(), ctx().url);
    expect(r.riskFactors.actionTypeRisk).toBe('MEDIUM');
    expect(r.score).toBeGreaterThanOrEqual(0.2);
    expect(r.reasons.join(' ')).toMatch(/allowlisted key/i);
  });

  it('16.6 pressKey is not cheaper than a plain scroll', () => {
    const key = assessActionRisk({ action: 'pressKey', key: 'Enter' }, ctx(), ctx().url);
    const scroll = assessActionRisk({ action: 'scroll', direction: 'down', amount: 300 }, ctx(), ctx().url);
    expect(key.score).toBeGreaterThan(scroll.score);
  });
});

describe('P11-17 the planner accepts a well-formed pressKey and nothing else', () => {
  it('17.1 a well-formed pressKey is accepted', () => {
    expect(
      OneActionPlanner.validateSingleActionProposal({
        action: 'pressKey',
        key: 'Enter',
        target: 'search-box',
      }).valid
    ).toBe(true);
  });

  it('17.2 a pressKey without a string key is rejected as an invalid shape', () => {
    expect(OneActionPlanner.validateSingleActionProposal({ action: 'pressKey' }).valid).toBe(false);
    expect(OneActionPlanner.validateSingleActionProposal({ action: 'pressKey', key: 7 }).valid).toBe(false);
  });

  it('17.3 a non-string pressKey target is rejected', () => {
    expect(
      OneActionPlanner.validateSingleActionProposal({
        action: 'pressKey',
        key: 'Enter',
        target: 5,
      }).valid
    ).toBe(false);
  });

  it('17.4 a compound pressKey proposal is still rejected — one atomic action only', () => {
    expect(
      OneActionPlanner.validateSingleActionProposal({
        action: 'pressKey',
        key: 'Enter',
        actions: [{ action: 'navigate', url: 'https://evil.example' }],
      }).valid
    ).toBe(false);
  });
});

describe('P11-18 a pressKey is effect-verified like any other meaningful action', () => {
  const action: BrowserAction = { action: 'pressKey', key: 'Enter', target: 'search-box' };

  it('18.1 an inert key is reported as ACTION_NO_EFFECT and requests recovery', () => {
    const r = verifyActionEffect(action, snapshot(), snapshot({ timestamp: 1 }));
    expect(r.hasEffect).toBe(false);
    expect(r.status).toBe('ACTION_NO_EFFECT');
    expect(r.shouldRecover).toBe(true);
  });

  it('18.2 pressKey is NEVER assumed successful (regression guard for the old default branch)', () => {
    const posts = [
      snapshot(),
      snapshot({
        url: 'https://example.com/search?q=cats',
        openModalsCount: 1,
        targetValueLength: 4,
        domElementCount: 99,
        activeElementSelector: 'search-box',
      }),
    ];
    for (const post of posts) {
      expect(verifyActionEffect(action, snapshot(), post).status).not.toBe('EFFECT_OBSERVED');
    }
  });

  it('18.3 navigation from a key press is observed', () => {
    const r = verifyActionEffect(
      action,
      snapshot(),
      snapshot({ url: 'https://example.com/search?q=black+cats' })
    );
    expect(r.hasEffect).toBe(true);
    expect(r.status).toBe('URL_NAVIGATION_OBSERVED');
    expect(r.shouldRecover).toBe(false);
  });

  it('18.4 a modal opened by a key press is observed', () => {
    expect(verifyActionEffect(action, snapshot(), snapshot({ openModalsCount: 1 })).status).toBe(
      'MODAL_STATE_CHANGED'
    );
  });

  it('18.5 a value change from a key press is observed', () => {
    expect(verifyActionEffect(action, snapshot(), snapshot({ targetValueLength: 4 })).status).toBe(
      'VALUE_STATE_CHANGED'
    );
  });

  it('18.6 a DOM mutation from a key press is observed', () => {
    expect(verifyActionEffect(action, snapshot(), snapshot({ domElementCount: 40 })).status).toBe(
      'DOM_MUTATION_OBSERVED'
    );
  });

  it('18.7 a focus shift from Tab is observed', () => {
    const r = verifyActionEffect(
      { action: 'pressKey', key: 'Tab' },
      snapshot(),
      snapshot({ activeElementSelector: '#next' })
    );
    expect(r.status).toBe('FOCUS_SHIFT_OBSERVED');
  });
});

describe('P11-19 goal verification stays authoritative', () => {
  it('19.1 a search goal is satisfied only by an observed query in the live URL', () => {
    const state = { previousActions: [] } as never;
    const c = ctx({ url: 'https://www.google.com/search?q=black+cats' });
    expect(verifyTaskGoal('Search for black cats', state, c).satisfied).toBe(true);
  });

  it('19.2 a typed-but-unsubmitted query is NOT success', () => {
    const state = {
      previousActions: [{ action: 'type', target: 'search-box', text: 'black cats' }],
    } as never;
    const r = verifyTaskGoal('Search for black cats', state, ctx({ url: 'https://example.com/search' }));
    expect(r.satisfied).toBe(false);
  });
});
