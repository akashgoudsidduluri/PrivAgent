/**
 * PHASE 18.8 / A14 — UNCERTAIN COMMIT (side-effect idempotency).
 *
 * The question every test here asks: when the device does NOT know whether a
 * consequential action landed, can anything it does next produce a SECOND one?
 *
 * Two layers:
 *   1. the pure commit-certainty contract (classification, assessment, the
 *      dispatch guard, external verification) — deterministic and local;
 *   2. the real AgentLoop, driven through synthetic perception/execution hosts,
 *      where a blocked dispatch, a resolution and a justified retry are observed
 *      as behaviour (how many actions reached the executor) rather than asserted
 *      from the contract's own words.
 *
 * Nothing here weakens an existing gate: grounding, M5, the security critic,
 * risk/confirmation, effect verification and goal verification all still run.
 * The commit guard can only ever REMOVE a dispatch.
 */
import { describe, it, expect, vi } from 'vitest';

import { AgentLoop } from '../extension/src/agent/agentLoop';
import type { BrowserAction } from '../extension/src/agent/actionTypes';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import type { PreActionSnapshot } from '../extension/src/agent/effectVerifier';
import { isTerminalTaskStatus, userFacingMessageForStatus } from '../extension/src/agent/agentState';
import { projectAgentOutput } from '../extension/src/agent/agentOutput';
import {
  assessCommit,
  classifyConsequential,
  isCommittedCode,
  isConsequential,
  mayDispatchConsequential,
  resolveCommit,
  settleCommitWithEffect,
  unresolvedCommitMessage,
  verifyExternalCommit,
  type CommitRecord,
} from '../extension/src/agent/commitCertainty';

const NOW = 1_760_000_000_000;
const URL_APP = 'https://bank.example.com/transfer';
/**
 * The task that makes the fixture action a TRANSFER-class commit. Its wording is
 * deliberately neutral to every intent-domain rule, so these tests exercise the
 * commit guard rather than the intent boundary (which has its own suites).
 */
const TASK = 'Proceed with the transfer to savings';

function record(overrides: Partial<CommitRecord> = {}): CommitRecord {
  return {
    step: 1,
    actionClass: 'TRANSFER',
    certainty: 'COMMIT_UNKNOWN',
    code: 'EXECUTION_FAILED',
    unresolved: true,
    at: NOW,
    ...overrides,
  };
}

// ── 1. Classification ────────────────────────────────────────────────────────

describe('A14 — classifying what is consequential', () => {
  it('1.1 checkout / submit / send / delete / transfer wording is recognised', () => {
    expect(classifyConsequential({ action: { action: 'click', target: 'place order' } })).toBe('BUY');
    expect(classifyConsequential({ action: { action: 'click', target: 'submit' } })).toBe('SUBMIT');
    expect(classifyConsequential({ action: { action: 'click', target: 'send message' } })).toBe('SUBMIT');
    expect(classifyConsequential({ action: { action: 'click', target: 'delete account' } })).toBe('DELETE');
    expect(classifyConsequential({ action: { action: 'click', url: 'https://bank.example.com/transfer' } })).toBe(
      'TRANSFER'
    );
    expect(classifyConsequential({ action: { action: 'click', target: 'create account' } })).toBe('CREATE');
  });

  it('1.2 an ordinary action is NOT consequential', () => {
    expect(classifyConsequential({ action: { action: 'click', target: 'product-12' } })).toBe('NONE');
    expect(classifyConsequential({ action: { action: 'scroll' } })).toBe('NONE');
  });

  it('1.3 the task may elevate a dispatch-capable action with a vague target', () => {
    expect(
      classifyConsequential({ action: { action: 'click', target: 'btn' }, task: 'Transfer the balance to savings' })
    ).toBe('TRANSFER');
    expect(classifyConsequential({ action: { action: 'click', target: 'btn' }, task: 'Delete the draft' })).toBe(
      'DELETE'
    );
  });

  it('1.4 but the task can NEVER turn a scroll or a navigation into a commit', () => {
    expect(
      classifyConsequential({ action: { action: 'scroll' }, task: 'Delete my account' })
    ).toBe('NONE');
    expect(
      classifyConsequential({
        action: { action: 'navigate', url: 'https://bank.example.com/transfer' },
        task: 'Transfer money',
      })
    ).toBe('NONE');
  });

  it('1.5 a mailto link is not a "send" to a server', () => {
    expect(classifyConsequential({ action: { action: 'click', url: 'mailto:help@example.com' } })).toBe('NONE');
  });

  it('1.6 only NONE is non-consequential', () => {
    expect(isConsequential('NONE')).toBe(false);
    for (const c of ['BUY', 'SUBMIT', 'SEND', 'DELETE', 'TRANSFER', 'CREATE'] as const) {
      expect(isConsequential(c)).toBe(true);
    }
  });
});

// ── 2. Assessment: success is not proof ──────────────────────────────────────

describe('A14 — what is known after a dispatch', () => {
  it('2.1 a non-consequential action is never unresolved and keeps no record', () => {
    const a = assessCommit({ actionClass: 'NONE', executionSuccess: false });
    expect(a.unresolved).toBe(false);
    expect(a.resolution).toBe('PROCEED');
    expect(a.record).toBeNull();
  });

  it('2.2 a FAILED consequential dispatch is COMMIT_UNKNOWN, not a failure to retry', () => {
    const a = assessCommit({ actionClass: 'BUY', executionSuccess: false, step: 4, at: NOW });
    expect(a.certainty).toBe('COMMIT_UNKNOWN');
    expect(a.code).toBe('EXECUTION_FAILED');
    expect(a.resolution).toBe('VERIFY_EXTERNAL');
    expect(a.unresolved).toBe(true);
    expect(a.record).toEqual({
      step: 4,
      actionClass: 'BUY',
      certainty: 'COMMIT_UNKNOWN',
      code: 'EXECUTION_FAILED',
      unresolved: true,
      at: NOW,
    });
  });

  it('2.3 a SUCCESSFUL consequential dispatch with nothing observed is still unverified', () => {
    const a = assessCommit({ actionClass: 'SUBMIT', executionSuccess: true });
    expect(a.certainty).toBe('EFFECT_UNVERIFIED');
    expect(a.unresolved).toBe(true);
    expect(a.resolution).toBe('VERIFY_EXTERNAL');
  });

  it('2.4 the effect verifier can only ever settle an open commit, never open one', () => {
    // Observed change → the commit is treated as landed (fail-SAFE: never retry).
    const verified = settleCommitWithEffect(record(), { effectVerified: true, effectStatus: 'DOM_MUTATION_OBSERVED' });
    expect(verified.certainty).toBe('EFFECT_VERIFIED');
    expect(verified.code).toBe('RESOLVED_COMMITTED');
    expect(verified.unresolved).toBe(false);

    // Could not observe → unknown, still open.
    const unverifiable = settleCommitWithEffect(record(), {
      effectVerified: false,
      effectStatus: 'EFFECT_UNVERIFIABLE',
    });
    expect(unverifiable.certainty).toBe('EFFECT_NOT_OBSERVABLE');
    expect(unverifiable.code).toBe('EFFECT_NOT_OBSERVABLE');
    expect(unverifiable.unresolved).toBe(true);

    // Observed and nothing moved → still unknown in the world, still open.
    const noEffect = settleCommitWithEffect(record(), { effectVerified: false, effectStatus: 'ACTION_NO_EFFECT' });
    expect(noEffect.certainty).toBe('EFFECT_UNVERIFIED');
    expect(noEffect.unresolved).toBe(true);
  });

  it('2.5 settling returns a NEW record and never mutates the old one', () => {
    const open = record();
    const settled = settleCommitWithEffect(open, { effectVerified: true, effectStatus: 'URL_NAVIGATION_OBSERVED' });
    expect(settled).not.toBe(open);
    expect(open.unresolved).toBe(true);
    expect(open.certainty).toBe('COMMIT_UNKNOWN');
  });
});

// ── 3. The dispatch guard is on the CLASS ────────────────────────────────────

describe('A14 — an unresolved commit blocks its class', () => {
  it('3.1 an open commit of the same class blocks a DIFFERENT action of that class', () => {
    const open = record({ actionClass: 'TRANSFER' });
    const same = mayDispatchConsequential('TRANSFER', [open]);
    expect(same.allowed).toBe(false);
    expect(same.blockedBy).toBe(open);
  });

  it('3.2 a resolved commit blocks nothing', () => {
    const closed = record({ unresolved: false, certainty: 'EFFECT_VERIFIED', code: 'RESOLVED_COMMITTED' });
    expect(mayDispatchConsequential('TRANSFER', [closed]).allowed).toBe(true);
  });

  it('3.3 an open commit does not block a different class', () => {
    expect(mayDispatchConsequential('SUBMIT', [record({ actionClass: 'TRANSFER' })]).allowed).toBe(true);
  });

  it('3.4 non-consequential work is never blocked, whatever is open', () => {
    expect(mayDispatchConsequential('NONE', [record()]).allowed).toBe(true);
  });
});

// ── 4. External verification ─────────────────────────────────────────────────

describe('A14 — re-perception is the only other way to settle a commit', () => {
  it('4.1 page CONFIRMATION wording proves the commit happened', () => {
    const v = verifyExternalCommit({ markers: ['Order confirmed', 'Your order'], currentUrl: URL_APP }, record({ actionClass: 'BUY' }));
    expect(v.status).toBe('COMMITTED');
    expect(v.code).toBe('CONFIRMATION_OBSERVED');
    expect(v.certainty).toBe('EFFECT_VERIFIED');
    expect(v.resolved).toBe(true);
    expect(isCommittedCode(v.code)).toBe(true);
  });

  it('4.2 only POSITIVE failure wording unblocks a retry', () => {
    const v = verifyExternalCommit({ markers: ['Payment failed'], currentUrl: URL_APP }, record());
    expect(v.status).toBe('NOT_COMMITTED');
    expect(v.code).toBe('FAILURE_OBSERVED');
    expect(v.resolved).toBe(true);
    expect(isCommittedCode(v.code)).toBe(false);
  });

  it('4.3 a page that merely does not mention the outcome settles NOTHING', () => {
    for (const markers of [[], ['Savings account', 'Balance £120'], ['Continue']]) {
      const v = verifyExternalCommit({ markers, currentUrl: URL_APP }, record());
      expect(v.status).toBe('UNKNOWN');
      expect(v.code).toBe('NOTHING_OBSERVED');
      expect(v.certainty).toBe('COMMIT_UNKNOWN');
      expect(v.resolved).toBe(false);
    }
  });

  it('4.4 an explicit expectation is honoured when the caller declares one', () => {
    const marker = verifyExternalCommit(
      { markers: ['Reference: ABC-1'], expectedMarker: 'reference:' },
      record()
    );
    expect(marker.code).toBe('EXPECTED_MARKER_PRESENT');
    const url = verifyExternalCommit(
      { markers: [], currentUrl: 'https://bank.example.com/transfer/done' },
      record()
    );
    expect(url.status).toBe('UNKNOWN'); // no expectation declared → not a proof
    const urlExpected = verifyExternalCommit(
      { markers: [], currentUrl: 'https://bank.example.com/transfer/done', expectedUrl: '/transfer/done' },
      record()
    );
    expect(urlExpected.code).toBe('EXPECTED_URL_REACHED');
    expect(urlExpected.resolved).toBe(true);
  });

  it('4.5 an inconclusive verification leaves the record OPEN', () => {
    const open = record();
    const inconclusive = verifyExternalCommit({ markers: ['Continue'], currentUrl: URL_APP }, open);
    const records = resolveCommit([open], open, inconclusive);
    expect(records[0]!.unresolved).toBe(true);
    expect(records[0]!.code).toBe('EXECUTION_FAILED');
    expect(records).not.toBe([open]);
  });

  it('4.6 a conclusive verification rewrites the record in place, leaving siblings alone', () => {
    const open = record();
    const other = record({ step: 2, actionClass: 'SUBMIT' });
    const records = resolveCommit([open, other], open, verifyExternalCommit({ markers: ['Order confirmed'] }, open));
    expect(records[0]!.unresolved).toBe(false);
    expect(records[0]!.code).toBe('RESOLVED_COMMITTED');
    expect(records[1]).toBe(other);
  });

  it('4.7 the user-facing sentence for an unresolved commit carries no internal code', () => {
    for (const c of ['BUY', 'SUBMIT', 'SEND', 'DELETE', 'TRANSFER', 'CREATE'] as const) {
      const msg = unresolvedCommitMessage(c);
      expect(msg).toMatch(/could not confirm/i);
      expect(msg).toMatch(/duplicate/i);
      expect(msg).not.toMatch(/COMMIT_UNKNOWN|EFFECT_UNVERIFIED|EFFECT_NOT_OBSERVABLE|_ERROR/);
    }
  });
});

// ── 5. The loop: no duplicate dispatch, ever ─────────────────────────────────

function det(id: string, label: string) {
  return {
    id,
    type: 'button' as const,
    selector: `#${id}`,
    label,
    confidence: 0.95,
    bbox: { x: 10, y: 10, width: 120, height: 30 },
    length: 0,
    source: 'dom_attribute',
    is_partially_visible: false,
  };
}

function ctx(detections = [det('btn', 'Confirm'), det('btn2', 'Confirm again')]): AgentContextPayload {
  return {
    url: URL_APP,
    timestamp: NOW,
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: { width: 1280, height: 800 },
    sanitized_status: 'sanitized_only',
    detections,
    total_elements_scanned: detections.length,
    sensitive_elements_detected: 0,
    ocr_metrics: null,
  } as unknown as AgentContextPayload;
}

/**
 * A page whose own wording is the only thing that can settle a commit. The
 * generation advances with every perception, exactly as a live page's does — a
 * stale world model is rejected by the loop, and must be, or re-perception would
 * be reading yesterday's page.
 */
function pageWith(wording: string | null, generation: number, url = URL_APP) {
  return {
    context: ctx(),
    worldModel: {
      id: `wm-${generation}`,
      page: { url, title: wording ?? 'Transfer', pageGeneration: generation, pageType: 'app', totalDomElements: 40 },
      entities: [],
      textRegions: wording
        ? [{ id: 'tr-1', bbox: [0, 0, 200, 24], length: wording.length, tag: 'h1', isHeading: true, sanitizedPreview: wording }]
        : [],
      ocrRegions: [],
      visualRegions: [],
      privacyFindings: [],
    },
  } as never;
}

interface Harness {
  loop: AgentLoop;
  executed: BrowserAction[];
  infos: string[];
  state: () => any;
  run: (task: string) => Promise<unknown>;
}

function makeHarness(options: {
  actions: BrowserAction[];
  /** Page wording BEFORE the first dispatch (usually none). */
  wordingBefore?: string | null;
  /** Page wording AFTER a dispatch has happened — the re-perception state. */
  wordingAfter?: string | null;
  effectSnapshot?: boolean;
  maxSteps?: number;
  maxRetries?: number;
}): Harness {
  const executed: BrowserAction[] = [];
  const infos: string[] = [];
  let dispatchCount = 0;
  let snapshotCount = 0;
  let perceptions = 0;
  const queue = [...options.actions];

  const infoSpy = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    infos.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  });
  void infoSpy;

  const loop = new AgentLoop(
    {
      name: 'A14FixtureProvider',
      requestAction: async () => (queue.length > 1 ? queue.shift()! : queue[0]!),
      reviewAction: async () => ({ safe: true, reason: 'fixture' }),
      registerFailure: vi.fn(),
      resetEscalation: vi.fn(),
    } as never,
    {
      perceivePage: async () => {
        perceptions += 1;
        return dispatchCount === 0
          ? pageWith(options.wordingBefore ?? null, perceptions + 1)
          : pageWith(options.wordingAfter ?? null, perceptions + 1);
      },
      executeAction: async (action) => {
        executed.push(action as BrowserAction);
        dispatchCount += 1;
        return { success: true };
      },
      //
      // The REAL host always has the pre-action observation channel (the service
      // worker implements it), and A16 will not let a consequential action be
      // dispatched against a view nobody looked at. A fixture that omits the
      // channel is not modelling the product, so this one always provides it:
      // `effectSnapshot` decides only whether the page CHANGES between the pre
      // and post readings. Without a change the effect verifier reports
      // ACTION_NO_EFFECT, which is the unresolved-commit state these tests are
      // about.
      //
      getEffectSnapshot: async (): Promise<PreActionSnapshot> => {
        snapshotCount += 1;
        return {
          url: URL_APP,
          scrollX: 0,
          scrollY: 0,
          domElementCount: options.effectSnapshot && snapshotCount > 1 ? 44 : 40,
          openModalsCount: 0,
          targetValueLength: 0,
          activeElementSelector: '',
          timestamp: NOW + snapshotCount,
        };
      },
      onStepProgress: () => {},
    },
    {
      maxSteps: options.maxSteps ?? 4,
      maxRetries: options.maxRetries ?? 3,
      delayBetweenStepsMs: 1,
    }
  );

  return {
    loop,
    executed,
    infos,
    state: () => loop.getState() as any,
    run: (task: string) => loop.runTask(task),
  };
}

describe('A14 — the loop refuses a duplicate consequential dispatch', () => {
  it('5.1 an unobservable consequential effect halts the run instead of re-submitting', async () => {
    const h = makeHarness({
      actions: [{ action: 'click', target: 'btn', reason: 'confirm the step' }],
    });
    await h.run(TASK);

    expect(h.executed.length).toBe(1);
    const state = h.state();
    // A typed TERMINAL state, not the confirmation pause: the run has ENDED and
    // the user is told the outcome is unknown.
    expect(state.status).toBe('COMMIT_UNKNOWN');
    expect(isTerminalTaskStatus('COMMIT_UNKNOWN')).toBe(true);
    expect(state.commitBlocked).toBe(true);
    expect(state.reason).toMatch(/duplicate/i);
    const records = state.commitRecords as CommitRecord[];
    expect(records.length).toBe(1);
    expect(records[0]!.actionClass).toBe('TRANSFER');
    expect(records[0]!.unresolved).toBe(true);
    expect(h.infos.join('\n')).toContain('dispatch blocked — commit unresolved');
  });

  it('5.2 the guard is on the CLASS: a different second action of the same class is blocked too', async () => {
    const h = makeHarness({
      actions: [
        { action: 'click', target: 'btn', reason: 'confirm the step' },
        { action: 'click', target: 'btn2', reason: 'confirm the step' },
      ],
    });
    await h.run(TASK);

    expect(h.executed.length).toBe(1);
    expect(h.executed[0]).toMatchObject({ target: 'btn' });
    const blocked = h.infos.filter((l) => l.includes('dispatch blocked — commit unresolved'));
    expect(blocked.length).toBeGreaterThan(0);
  });

  it('5.3 CONFIRMATION wording on the re-perceived page resolves the commit and is never re-sent', async () => {
    const h = makeHarness({
      actions: [{ action: 'click', target: 'btn', reason: 'confirm the step' }],
      wordingAfter: 'Transfer complete',
    });
    await h.run(TASK);

    expect(h.executed.length).toBe(1);
    const state = h.state();
    expect(state.lastCommit.certainty).toBe('EFFECT_VERIFIED');
    expect(state.lastCommit.code).toBe('RESOLVED_COMMITTED');
    expect(state.lastCommit.unresolved).toBe(false);
    // A proven commit still stops the run: repeating it would duplicate it.
    expect(state.status).toBe('COMMIT_UNKNOWN');
    expect(h.infos.join('\n')).toContain('external commit verification');
  });

  it('5.4 FAILURE wording on the re-perceived page justifies exactly one retry', async () => {
    const h = makeHarness({
      actions: [
        { action: 'click', target: 'btn', reason: 'confirm the step' },
        { action: 'click', target: 'btn2', reason: 'confirm the step' },
      ],
      wordingAfter: 'Transfer failed',
      maxSteps: 2,
    });
    await h.run(TASK);

    const records = h.state().commitRecords as CommitRecord[];
    expect(records[0]!.code).toBe('RESOLVED_NOT_COMMITTED');
    expect(records[0]!.unresolved).toBe(false);
    expect(h.executed.length).toBe(2);
    expect(h.state().commitBlocked).toBe(false);
  });

  it('5.5 an OBSERVED effect closes the commit, so a later same-class action is allowed', async () => {
    const h = makeHarness({
      actions: [
        { action: 'click', target: 'btn', reason: 'confirm the step' },
        { action: 'click', target: 'btn2', reason: 'confirm the step' },
      ],
      effectSnapshot: true,
      maxSteps: 2,
    });
    await h.run(TASK);

    const records = h.state().commitRecords as CommitRecord[];
    expect(records[0]!.unresolved).toBe(false);
    // Both transfers reached the executor: the first was OBSERVED to change the
    // page, so it is a completed commit and not an open one.
    expect(h.executed.length).toBe(2);
    expect(h.state().commitBlocked).not.toBe(true);
  });

  it('5.7 the unconfirmed commit is projected as a typed terminal outcome the user can act on', async () => {
    const h = makeHarness({
      actions: [{ action: 'click', target: 'btn', reason: 'confirm the step' }],
    });
    await h.run(TASK);

    const output = projectAgentOutput(h.state()) as any;
    expect(output.terminal.reason).toBe('COMMIT_UNVERIFIED');
    expect(output.terminal.outcome).toBe('UNANSWERED');
    expect(output.terminal.headline).not.toMatch(/COMMIT_|EFFECT_/);
    expect(output.finalResult.kind).toBe('COMMIT_UNKNOWN');
    expect(output.finalResult.body).toContain('could not confirm');
    expect(output.finalResult.body).toContain('duplicate');
    expect(output.finalResult.headline).toBe('Outcome not confirmed');
    // The fixed sentence for the run state never claims failure or success.
    const runMessage = userFacingMessageForStatus('COMMIT_UNKNOWN');
    expect(runMessage).toMatch(/could not be confirmed/i);
    expect(runMessage).not.toMatch(/fail|succeed|completed/i);
  });

  it('5.6 a task about deleting never invents a commit for a non-mutating action', async () => {
    const h = makeHarness({
      actions: [{ action: 'scroll', direction: 'down', amount: 200, reason: 'read on' }],
      maxSteps: 2,
    });
    await h.run('Delete the draft and confirm');

    expect((h.state().commitRecords as CommitRecord[]).length).toBe(0);
    expect(h.state().commitBlocked).not.toBe(true);
  });
});
