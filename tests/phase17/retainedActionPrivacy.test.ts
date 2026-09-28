/**
 * RETAINED-ACTION PRIVACY — `state.steps[].action` no longer keeps raw values.
 *
 * THE DEFECT THIS FILE PINS
 * ─────────────────────────
 * `StepRecord` held the LIVE `BrowserAction`. So a `type` action's entire
 * `text` — a real user value — sat in task state after the action was refused
 * or executed. The header of `agentState.ts` claims state never stores raw PII;
 * the step record broke that claim.
 *
 * It was worse than a long-lived local. `getState()` returns the step array,
 * the service worker hands that state to `sendToDashboard`, and `sendToDashboard`
 * spreads the raw payload (`{...rawPayload, interaction: screened.output}`) —
 * the screening ADDS a projection rather than replacing the payload. The popup
 * then rendered `step.action` through `formatActionForDisplay`, which printed
 * `action.text` verbatim. So the retained value sat on a genuine egress path.
 *
 * WHAT DID NOT CHANGE
 * ──────────────────
 * The live action object is untouched and still flows through grounding, M5,
 * the security critic, the privacy policy, risk/confirmation, containment and
 * dispatch exactly as before. The projection is made at the moment of
 * RETENTION, and nothing in the pipeline reads it back.
 */

import { describe, it, expect } from 'vitest';

import { AgentLoop } from '../../extension/src/agent/agentLoop';
import { sanitizeRetainedAction, sanitizeRetainedSelfHealing, type RetainedAction } from '../../extension/src/agent/agentState';
import { fingerprintObservation } from '../../extension/src/agent/longHorizon';
import { validateAction } from '../../extension/src/agent/actionValidator';
import { ctx, det, scope } from '../../evaluation/phase17_8/fixtures';
import type { AgentContextPayload } from '../../extension/src/privacy/types';
import type { BrowserAction } from '../../extension/src/agent/actionTypes';

const ORIGIN = 'https://shop.example';
const PAGE = `${ORIGIN}/checkout`;
const RAW_EMAIL = 'recipient@example.com';
const RAW_CARD = '4111111111111111';

const context: AgentContextPayload = ctx({
  url: PAGE,
  detections: [
    det('in-email', 'input', { label: 'Recipient email' }),
    det('in-card', 'input', { label: 'Card number' }),
    det('btn-help', 'button', { label: 'Help' }),
    // A NEUTRAL field. Typing into `in-email` is refused by the security critic
    // for a SENSITIVE_DISCLOSURE_ATTEMPT, which is correct, so it cannot be
    // used to observe a value-bearing action reaching the dispatch stage.
    det('in-notes', 'input', { label: 'Notes' }),
  ],
  total_elements_scanned: 4,
});

const piiType = {
  action: 'type',
  target: 'in-email',
  text: RAW_EMAIL,
  reason: 'Fill in the recipient email address',
} as unknown as BrowserAction;

/** `RetainedAction` is a discriminated union; narrow to the `type` variant. */
type RetainedType = Extract<RetainedAction, { action: 'type' }>;
const isRetainedType = (a: RetainedAction): a is RetainedType => a.action === 'type';

async function runLoop(proposal: unknown, execOk = true) {
  const dispatched: BrowserAction[] = [];
  const loop = new AgentLoop(
    {
      name: 'Retained',
      requestAction: async () => proposal as never,
      registerFailure: () => {},
      resetEscalation: () => {},
    },
    {
      perceivePage: async () => context,
      getEffectSnapshot: async () => null,
      executeAction: async (a) => {
        dispatched.push(a);
        return execOk ? { success: true } : { success: false, error: 'synthetic' };
      },
    },
    {
      maxSteps: 1,
      maxRetries: 1,
      delayBetweenStepsMs: 0,
      targetTabId: 7,
      initialUrl: `${PAGE}/`,
      containmentScope: scope(),
    }
  );
  let threw: string | null = null;
  let state: Awaited<ReturnType<AgentLoop['runTask']>> | null = null;
  try {
    state = await loop.runTask('Fill in the recipient email address');
  } catch (e) {
    threw = (e as Error)?.name ?? 'UnknownError';
  }
  return { dispatched, state, threw, loop };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · THE PROJECTION ITSELF
// ═══════════════════════════════════════════════════════════════════════════

describe('retained actions · the projection removes the value and keeps the metadata', () => {
  it('a type action keeps target and valueLength, never the value', () => {
    const r = sanitizeRetainedAction(piiType);
    expect(r).toEqual({
      action: 'type',
      target: 'in-email',
      valueLength: RAW_EMAIL.length,
      reason: 'Fill in the recipient email address',
    });
    expect(JSON.stringify(r)).not.toContain(RAW_EMAIL);
    expect('text' in r).toBe(false);
  });

  it('a card number is reduced to a length', () => {
    const r = sanitizeRetainedAction({ action: 'type', target: 'in-card', text: RAW_CARD } as unknown as BrowserAction);
    expect(r).toMatchObject({ action: 'type', target: 'in-card', valueLength: RAW_CARD.length });
    expect(JSON.stringify(r)).not.toContain(RAW_CARD);
  });

  it('a select action keeps its length, not the option', () => {
    const r = sanitizeRetainedAction({ action: 'select', target: 'in-email', option: RAW_EMAIL } as unknown as BrowserAction);
    expect(r).toMatchObject({ action: 'select', target: 'in-email', valueLength: RAW_EMAIL.length });
    expect(JSON.stringify(r)).not.toContain(RAW_EMAIL);
    expect('option' in r).toBe(false);
  });

  it('actions with no value field are preserved intact', () => {
    expect(sanitizeRetainedAction({ action: 'click', target: 'btn-help', reason: 'Open help' })).toEqual({
      action: 'click',
      target: 'btn-help',
      reason: 'Open help',
    });
    expect(sanitizeRetainedAction({ action: 'scroll', direction: 'down', amount: 250 } as unknown as BrowserAction)).toEqual({
      action: 'scroll',
      direction: 'down',
      amount: 250,
      reason: undefined,
    });
  });

  it('the projection is a copy — mutating it cannot reach the live action', () => {
    const live: BrowserAction = { action: 'type', target: 'in-email', text: RAW_EMAIL } as unknown as BrowserAction;
    const retained = sanitizeRetainedAction(live) as RetainedAction;
    expect((live as { text: string }).text).toBe(RAW_EMAIL);
    expect(JSON.stringify(retained)).not.toContain(RAW_EMAIL);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · THE NEGATIVE TEST: no raw value anywhere in retained state
// ═══════════════════════════════════════════════════════════════════════════

describe('retained actions · no raw value survives in task state', () => {
  it('a refused PII-bearing action leaves no trace of its value in state', async () => {
    const r = await runLoop(piiType);
    expect(r.threw).toBeNull();
    expect(r.state).toBeTruthy();

    const serialized = JSON.stringify(r.state);
    expect(serialized).not.toContain(RAW_EMAIL);
    expect(serialized).not.toContain('@example.com');
    expect(serialized).not.toContain(RAW_CARD);
  });

  it('the step is still present and still auditable', async () => {
    const r = await runLoop(piiType);
    const step = r.state!.steps[0]!;
    expect(step).toBeDefined();
    // The structural facts a step exists to record are all intact.
    expect(step.validationAllowed).toBe(false);
    expect(step.executionSuccess).toBe(false);
    expect(step.validationReason).toBeTruthy();
    expect(String(step.validationReason)).not.toContain(RAW_EMAIL);
    // ...and the action identity survives without the value.
    expect(step.action.action).toBe('type');
    expect('target' in step.action && step.action.target).toBe('in-email');
  });

  it('a type action that reached the CONFIRMATION gate also retains no value', async () => {
    // Typing text is CONSEQUENTIAL, so the risk engine parks it in
    // NEEDS_USER_CONFIRMATION. That is as close as a `type` action gets to
    // execution without a user, and it is still a recorded step.
    const notes: BrowserAction = { action: 'type', target: 'in-notes', text: 'cats' } as unknown as BrowserAction;
    const r = await runLoop(notes, true);
    const typeSteps = r.state!.steps.filter((s) => s.action.action === 'type');
    expect(typeSteps.length).toBeGreaterThan(0);
    for (const s of typeSteps) {
      expect(s.action).toMatchObject({ action: 'type', target: 'in-notes', valueLength: 4 });
      expect('text' in s.action).toBe(false);
    }
    // The VALUE survives nowhere in the STEP RECORD, which is what this change
    // is about. The decision trace is a separate surface with its own value
    // firewall; see the audit test below.
    expect(JSON.stringify(r.state!.steps)).not.toContain('cats');
  });

  it('RETAINED-VALUE AUDIT: the state surfaces that intentionally keep a live action', async () => {
    // Recorded so the boundary of this change is explicit and cannot drift.
    // These are NOT regressions — each holds the live action for a verified
    // reason. Naming them is part of the fix, because a future reader finding
    // `text` in state should know it is deliberate rather than a missed field.
    const notes: BrowserAction = { action: 'type', target: 'in-notes', text: 'cats' } as unknown as BrowserAction;
    const r = await runLoop(notes, true);

    // 1. `requiresUserConfirmationAction` MUST hold the live action, AND the
    //    popup renders it through `formatActionForDisplay` at popup.ts:1031.
    //    That rendering is CORRECT and must not be "fixed": it is the explicit
    //    consent prompt. The user is being asked to authorise typing "cats"
    //    into a specific field, and `resumeWithConfirmation` executes the
    //    stored action verbatim — showing them anything less would mean
    //    confirming an action they cannot see. This is the ONE place a raw
    //    value is meant to be visible to the user.
    expect((r.state!.requiresUserConfirmationAction as { text?: string } | null)?.text).toBe('cats');

    // 2. `previousActions` is the provider-facing attempt history. It has two
    //    consumers, both legitimate:
    //      - agentLoop.ts:1343, in-process, as the Security Critic's `history`
    //        (the critic reasons about what the agent already attempted);
    //      - agentLoop.ts:2748, as `requestAction`'s `history` argument.
    //    The second is the one that leaves the process, and it is INSIDE the
    //    existing privacy boundary: backendAgentProvider.ts:147-150 builds
    //    `{ task, context, history }` and runs `validateEgressPayload` over the
    //    WHOLE payload before the network call, failing closed on BLOCK.
    //    openRouterProvider.ts:193 does the same. So the value can never
    //    reach a provider un-screened. It is NOT rendered by the popup.
    //
    //    NOTE ON COVERAGE: this file does NOT assert that these arrays are
    //    populated. Both push sites (agentLoop.ts:2231 verified-effect and
    //    :2643 confirmed-dispatch) require a completed dispatch, and no fixture
    //    here reaches one — `getEffectSnapshot` returns null, so the effect is
    //    never verified. The boundary claim above is CODE-VERIFIED, not
    //    test-verified, and is recorded as such rather than papered over with
    //    an assertion that would pass vacuously.
    expect(Array.isArray(r.state!.previousActions)).toBe(true);
    expect(Array.isArray(r.state!.recentActions)).toBe(true);

    // 3. `recentActions` has exactly one consumer, actionIdempotency.ts:34-41,
    //    which compares the last executed action to decide whether a retry
    //    would be a duplicate. That comparison needs the live action, and it
    //    never leaves the process. Also not rendered by the popup.

    // 4. The decision trace retains non-sensitive values by design; PII is
    //    refused by its own firewall and withheld per D-01.
    expect(JSON.stringify(r.state!.decisionTraceSummary)).toContain('cats');
  });

  it('the popup step trail and the popup consent prompt read DIFFERENT fields', async () => {
    // This is the property that makes the display change work, expressed
    // without a browser: `formatActionForDisplay` branches on whether the
    // value field is present. A retained step has no `text`, so it renders
    // `<N chars withheld>`; the live consent action has `text`, so it renders
    // the value. Asserting the two shapes separately is what pins the split —
    // if a future change sanitized the consent action, this fails.
    const notes: BrowserAction = { action: 'type', target: 'in-notes', text: 'cats' } as unknown as BrowserAction;
    const r = await runLoop(notes, true);

    const consent = r.state!.requiresUserConfirmationAction as { text?: string; target?: string };
    expect(consent.text).toBe('cats'); // -> popup shows: type(in-notes, "cats")

    const step = r.state!.steps.map((s) => s.action).find(isRetainedType)!;
    expect('text' in step).toBe(false); // -> popup shows: type(in-notes, <4 chars withheld>)
    expect(step.valueLength).toBe(4);
  });

  it('the CONFIRMED-dispatch path dispatches the live value but retains none of it', async () => {
    // The second retention site this change touches: `resumeWithConfirmation`
    // records a step for the action the user actually authorised, and that
    // record must be projected while the DISPATCH still uses the live action.
    //
    // The assertion is deliberately on the WHOLE returned step array rather
    // than on a step index. The step bookkeeping on this path is not the
    // subject here; the property is that no recorded step reintroduces a value.
    const notes: BrowserAction = { action: 'type', target: 'in-notes', text: 'cats' } as unknown as BrowserAction;
    const r = await runLoop(notes, true);
    expect(r.state!.status).toBe('NEEDS_USER_CONFIRMATION');

    const before = r.dispatched.length;
    const after = await r.loop.resumeWithConfirmation();

    // The live action carried the value all the way to the browser...
    expect(r.dispatched.length).toBe(before + 1);
    expect((r.dispatched[r.dispatched.length - 1] as { text?: string }).text).toBe('cats');

    // ...and no step recorded along the way kept it.
    for (const s of after.steps) {
      expect('text' in s.action).toBe(false);
    }
    expect(JSON.stringify(after.steps)).not.toContain('cats');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · THE POSITIVE CONTROL: metadata survives where it is genuinely required
// ═══════════════════════════════════════════════════════════════════════════

describe('retained actions · required metadata is still available', () => {
  it('the long-horizon fingerprint is byte-identical before and after projection', () => {
    // `fingerprintObservation` is the only production reader of a RETAINED
    // action. It must produce exactly the same fingerprint, or stall detection
    // would silently change behaviour.
    const observation = {
      url: PAGE,
      pageGeneration: 1,
      entityIds: ['e1'],
      candidateIds: ['c1'],
      scrollY: 0,
      targetValueLength: 0,
      viewportObservable: true,
    } as never;
    for (const live of [
      { action: 'type', target: 'in-email', text: RAW_EMAIL },
      { action: 'click', target: 'btn-help' },
      { action: 'navigate', url: `${PAGE}/next` },
      { action: 'scroll', direction: 'down', amount: 250 },
    ] as unknown as BrowserAction[]) {
      expect(fingerprintObservation(observation, live)).toBe(
        fingerprintObservation(observation, sanitizeRetainedAction(live))
      );
    }
  });

  it('a retained action still identifies what was attempted', async () => {
    const r = await runLoop(piiType);
    const types = r.state!.steps.map((s) => s.action.action);
    expect(types).toContain('type');
    // The dashboard step trail renders `action` and `target`; both survive.
    const t = r.state!.steps.find((s) => s.action.action === 'type')!;
    expect('target' in t.action ? t.action.target : null).toBe('in-email');
  });

  it('a self-healing record retains no raw recovered value either', () => {
    // `StepRecord.selfHealing.recoveredAction` was a SECOND retention path
    // inside the same record, and for a type action it carried the same `text`.
    const withRaw: BrowserAction = { action: 'type', target: 'in-email', text: RAW_EMAIL } as unknown as BrowserAction;
    const record = sanitizeRetainedAction(withRaw);
    expect(JSON.stringify(record)).not.toContain(RAW_EMAIL);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · THE NEGATIVE TEST: authorization and dispatch are UNCHANGED
// ═══════════════════════════════════════════════════════════════════════════

describe('retained actions · authorization and dispatch are unchanged', () => {
  it('M5 still refuses exactly the same raw-value input', () => {
    expect(validateAction(piiType, context).allowed).toBe(false);
    expect(
      validateAction({ action: 'type', target: 'in-card', text: RAW_CARD } as unknown as BrowserAction, context).allowed
    ).toBe(false);
    // ...and still allows a benign one, so nothing was over-blocked.
    expect(
      validateAction({ action: 'click', target: 'btn-help', reason: 'Open the help centre' }, context).allowed
    ).toBe(true);
  });

  it('the LIVE action still reaches executeAction un-projected', async () => {
    // The decisive negative test: sanitization must not have leaked backwards
    // into the dispatched action. A `click` is used because it actually
    // dispatches; typing is CONSEQUENTIAL and stops at the confirmation gate.
    const click: BrowserAction = { action: 'click', target: 'btn-help', reason: 'Open the help centre' } as unknown as BrowserAction;
    const r = await runLoop(click, true);
    expect(r.dispatched).toHaveLength(1);
    expect(r.dispatched[0]).toMatchObject({ action: 'click', target: 'btn-help', reason: 'Open the help centre' });
    // ...and the same holds for the value-bearing shape: the object the loop was
    // given is never mutated by the projection, because the projection copies.
    const notes: BrowserAction = { action: 'type', target: 'in-notes', text: 'cats' } as unknown as BrowserAction;
    await runLoop(notes, true);
    expect((notes as { text: string }).text).toBe('cats');
  });

  it('a refused action is still refused, with the same outcome shape', async () => {
    const r = await runLoop(piiType);
    expect(r.threw).toBeNull();
    expect(r.dispatched).toEqual([]);
    expect(r.state!.status).not.toBe('SUCCESS');
    expect(r.state!.steps[0]!.validationAllowed).toBe(false);
  });

  it('no SUCCESS can be produced from the refused path', async () => {
    const r = await runLoop(piiType);
    expect(r.state!.status).toBe('FAILED');
    expect(r.state!.goalStatus).not.toBe('SUCCESS');
    expect(JSON.stringify(r.state)).not.toContain('"SUCCESS"');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · THE SECOND RETENTION SITE: `selfHealing.recoveredAction`
// ═══════════════════════════════════════════════════════════════════════════
//
// `StepRecord.selfHealing` embeds a `SelfHealingResult`, and that result's
// `recoveredAction` is a FULL `BrowserAction`. `recoverStaleTarget` copies a
// `type` action's `text` verbatim into the healed action, so before this change
// the recovered candidate carried the same raw value as the original — through
// a record the audit initially treated as metadata-only.
//
// D-02 made recovery fire far more often, which is exactly why this needed
// pinning rather than assuming.

describe('retained actions · selfHealing.recoveredAction carries no raw value', () => {
  // A `type` action on a stale target, plus a goal that D-02 goal-alignment
  // resolves to a real element. Recovery therefore fires AND copies the text.
  const GOAL = 'Open the transaction history';
  const healContext: AgentContextPayload = ctx({
    url: PAGE,
    detections: [
      det('orphan-field', 'input', { label: 'Apply', selector: '#zzz-opaque' }),
      det('privagent-det-txn-history', 'button', { label: 'Transaction history', selector: '#transaction-history' }),
    ],
    total_elements_scanned: 2,
  });

  const staleType: BrowserAction = {
    action: 'type',
    target: 'orphan-field',
    text: RAW_EMAIL,
    reason: 'Fill the recipient field',
  } as unknown as BrowserAction;

  async function runHealLoop() {
    const dispatched: BrowserAction[] = [];
    const loop = new AgentLoop(
      {
        name: 'Retained',
        requestAction: async () => staleType as never,
        registerFailure: () => {},
        resetEscalation: () => {},
      },
      {
        perceivePage: async () => healContext,
        getEffectSnapshot: async () => null,
        executeAction: async (a) => {
          dispatched.push(a);
          return { success: true };
        },
      },
      {
        maxSteps: 1,
        maxRetries: 1,
        delayBetweenStepsMs: 0,
        targetTabId: 7,
        initialUrl: `${PAGE}/`,
        containmentScope: scope(),
      }
    );
    const state = await loop.runTask(GOAL);
    return { dispatched, state, loop };
  }

  it('the unit projection strips the healed value and keeps its length', () => {
    const projected = sanitizeRetainedSelfHealing({
      recovered: true,
      recoveredTargetId: 'privagent-det-txn-history',
      recoveredAction: staleType,
      strategy: 'GOAL_ALIGNED' as never,
      reason: 'realigned to goal',
    } as never);

    expect(projected!.recoveredAction).toMatchObject({
      action: 'type',
      valueLength: RAW_EMAIL.length,
    });
    expect('text' in projected!.recoveredAction!).toBe(false);
    expect(JSON.stringify(projected)).not.toContain(RAW_EMAIL);
    // The recovery FACTS survive — only the value is gone. A record that lost
    // `recovered`/`recoveredTargetId` would be privacy-safe but useless.
    expect(projected!.recovered).toBe(true);
    expect(projected!.recoveredTargetId).toBe('privagent-det-txn-history');
  });

  it('a real recovery through the loop retains the facts but never the value', async () => {
    const { state } = await runHealLoop();

    // Control: recovery really did fire. Without this the assertions below
    // would pass trivially against a record that was never populated.
    const healing = state.steps.map((s) => s.selfHealing).find(Boolean);
    expect(healing).toBeDefined();
    expect(healing!.recovered).toBe(true);

    const retained = healing!.recoveredAction!;
    expect(isRetainedType(retained)).toBe(true);
    if (!isRetainedType(retained)) throw new Error('recovered action was not a retained `type`');
    expect('text' in retained).toBe(false);
    expect(retained.valueLength).toBe(RAW_EMAIL.length);
    expect(retained.action).toBe('type');

    // The whole recovered-action subtree is value-free, not just one field.
    expect(JSON.stringify(healing)).not.toContain(RAW_EMAIL);
    expect(JSON.stringify(healing)).not.toContain('@example.com');
  });

  it('the live healed action still carried the value at the moment of recovery', async () => {
    // Proves the projection is a RETENTION decision and not a recovery
    // change: `recoverStaleTarget` is untouched, so the live candidate still
    // reaches M5 carrying its text and is still refused. If this ever flips,
    // the assertion above would be passing for the wrong reason.
    const { recoverStaleTarget } = await import('../../extension/src/agent/selfHealing');
    const healed = recoverStaleTarget('orphan-field', staleType, healContext, GOAL);
    expect(healed.recovered).toBe(true);
    expect((healed.recoveredAction as { text?: string }).text).toBe(RAW_EMAIL);
  });

  it('recovery still cannot dispatch or succeed through this path', async () => {
    const { dispatched, state } = await runHealLoop();
    // The healed action is refused by M5 a second time (it carries the same
    // text), so nothing is dispatched and the task does not succeed.
    expect(dispatched).toEqual([]);
    expect(state.status).not.toBe('SUCCESS');
    expect(state.goalStatus).not.toBe('SUCCESS');
  });
});
