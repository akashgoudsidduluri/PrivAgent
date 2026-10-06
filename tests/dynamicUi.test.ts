/**
 * DYNAMIC TASK-AWARE UI — focused acceptance tests (Phase 10).
 *
 * Proves, at the DOM and projection level:
 *   1  conversation renders NO browser-agent UI
 *   2  browser tasks render a dynamic browser surface
 *   3  an activity appears only when its event actually exists
 *   4  no fabricated step counters, anywhere
 *   5  a terminal state replaces the active state
 *   6  cancellation is truthful
 *   7  supersession is truthful (adapter + projection)
 *   8  clarification is truthful (and browser-work-free when nothing ran)
 *   9  failure is truthful and the UI is never stuck "working"
 *  10  commit-unknown is a notice, not a success and not a failure
 *  11  no raw internal/sensitive content can reach the UI projection
 *  12  the proven normal-chat routing and the UI surface agree
 *
 * These tests exercise ONLY display decisions. No security authority is
 * mocked, weakened, or bypassed anywhere in this file.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  projectUi,
  mergeActivities,
  EMPTY_LOG,
  type ActivityLog,
  type UiModel,
} from '../frontend/src/ui/uiProjection';
import { AgentWorkspace } from '../frontend/src/components/agentWorkspace';
import { ExtensionAgentAdapter } from '../frontend/src/adapters/extensionAdapter';
import { classifyMessageRoute } from '../extension/src/agent/conversationRoute';
import type { DashboardAgentState, AgentInteractionState } from '../frontend/src/types/dashboard';

// ── State builders ───────────────────────────────────────────────────────────

const baseCategories = {
  password: 0, credit_card: 0, account_number: 0, email: 0,
  phone: 0, pan: 0, cvv: 0, otp: 0,
};

function base(over: Partial<DashboardAgentState>): DashboardAgentState {
  return {
    status: 'RUNNING',
    task: 'search for cats',
    currentStep: 0,
    maxSteps: 10,
    currentPipelineStage: 'PERCEPTION',
    currentUrl: '',
    steps: [],
    sensitiveItemsCount: 0,
    categories: baseCategories,
    ...over,
  };
}

function interaction(over: Partial<AgentInteractionState>): AgentInteractionState {
  return {
    outcome: 'RUNNING',
    activity: { phase: 'PERCEPTION', summary: 'Reading the page.', step: 1, maxSteps: 10, cycle: null },
    terminal: null,
    result: { kind: 'NONE', summary: 'No result yet.', count: 0, items: [] },
    artifacts: [],
    timeline: [],
    awaitingConfirmation: null,
    ...over,
  };
}

function chatAnswer(body: string, task: string): DashboardAgentState {
  return base({
    status: 'ANSWER',
    task,
    answerSource: 'CONVERSATION',
    currentPipelineStage: 'IDLE',
    interaction: interaction({
      outcome: 'ANSWERED',
      activity: { phase: 'TERMINAL', summary: 'Answered directly.', step: 0, maxSteps: 0, cycle: null },
      terminal: { outcome: 'ANSWERED', reason: 'CONVERSATIONAL_ANSWER', headline: 'Answered directly.' },
      finalResult: { kind: 'ANSWER', headline: 'Answered directly.', body, provenance: null, remaining: [] },
    }),
  });
}

function chatAck(task: string): DashboardAgentState {
  // Exactly what the port ack + content-script relay produce: provenance but
  // no interaction and no body yet.
  return base({
    status: 'ANSWER',
    task,
    answerSource: 'CONVERSATION',
    currentPipelineStage: 'IDLE',
  });
}

function scrollStep(n = 1) {
  return {
    step: n,
    actionType: 'scroll',
    targetDescription: 'Scroll down (500px)',
    validationPassed: true,
    executionSuccess: true,
    sensitiveCategoryDetected: undefined,
    timestamp: 1,
    effectStatus: 'EFFECT_VERIFIED',
    effectDetails: 'Page height changed',
  } as any;
}

function project(state: DashboardAgentState, log: ActivityLog = EMPTY_LOG): { ui: UiModel; log: ActivityLog } {
  const next = mergeActivities(log, state);
  return { ui: projectUi(state, next), log: next };
}

function makeWorkspace() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const workspace = new AgentWorkspace(container, {
    onPresetSelected: () => {},
    onConfirmAction: () => {},
    onCancelAction: () => {},
    onRetryTask: () => {},
  });
  const html = () => container.querySelector('#workspace-content')!.innerHTML;
  const text = () => container.querySelector('#workspace-content')!.textContent || '';
  return { workspace, html, text, container };
}

const BROWSER_CHROME_MARKERS = [
  'Agent Activity Timeline',
  'activity-timeline-section',
  'Browser Context',
  'Local Privacy Boundary',
  'agent-response-card',
  'timeline-entry',
  'diagnostics-details',
  'Task received &amp; parsed',
  'Privacy boundary active',
];

function expectNoBrowserChrome(markup: string) {
  for (const marker of BROWSER_CHROME_MARKERS) {
    expect(markup, `browser chrome marker present: ${marker}`).not.toContain(marker);
  }
  expect(markup).not.toMatch(/Step \d+ of \d+/);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('1. conversation renders no browser-agent UI', () => {
  it('1a. a settled conversational answer is user message + assistant response only', () => {
    const { workspace, html, text } = makeWorkspace();
    workspace.update(chatAnswer('Hello! How can I help you today?', 'hi'));

    const markup = html();
    expect(markup).toContain('data-surface="conversation"');
    expect(markup).toContain('user-message-bubble');
    expect(text()).toContain('Hello! How can I help you today?');
    expectNoBrowserChrome(markup);
    // No browser-ish working indicator either.
    expect(markup).not.toContain('Working');
    expect(markup).not.toContain('Reading the page');
  });

  it('1b. the in-flight chat ack shows a typing indicator, never browser chrome', () => {
    const { workspace, html } = makeWorkspace();
    workspace.update(chatAck('what is machine learning?'));
    const markup = html();
    expect(markup).toContain('typing-dots');
    expect(markup).toContain('data-surface="conversation"');
    expectNoBrowserChrome(markup);
  });

  it('1c. a chat that could not be answered renders as chat, not as a browser failure', () => {
    const { workspace, html, text } = makeWorkspace();
    const state = base({
      status: 'PROVIDER_UNAVAILABLE',
      task: 'hi',
      answerSource: 'CONVERSATION',
      currentPipelineStage: 'IDLE',
      interaction: interaction({
        outcome: 'FAILED',
        activity: { phase: 'TERMINAL', summary: 'Unavailable.', step: 0, maxSteps: 0, cycle: null },
        terminal: { outcome: 'FAILED', reason: 'REASONER_FAILED', headline: 'The reasoning service was unavailable.' },
        finalResult: { kind: 'PROVIDER_UNAVAILABLE', headline: 'The reasoning service was unavailable.', body: null, provenance: null, remaining: [] },
      }),
    });
    workspace.update(state);
    const markup = html();
    expect(markup).toContain('data-surface="conversation"');
    expect(text()).toContain('The reasoning service was unavailable.');
    expectNoBrowserChrome(markup);
    expect(markup).not.toContain('retry-action-btn');
  });
});

describe('2. browser tasks get the dynamic browser surface', () => {
  it('2a. a running browser task renders the working row and its observed activities', () => {
    const { workspace, html, text } = makeWorkspace();
    const state = base({
      status: 'RUNNING',
      task: 'search for cats',
      currentPipelineStage: 'PERCEPTION',
      interaction: interaction({ activity: { phase: 'PERCEPTION', summary: 'Reading.', step: 1, maxSteps: 10, cycle: null } }),
    });
    workspace.update(state);
    const markup = html();
    expect(markup).toContain('data-surface="browser"');
    expect(markup).toContain('data-state="working"');
    expect(text()).toContain('Reading the page');
    expect(markup).toContain('1 activity');
    expect(markup).toContain('timeline-entry');
    // The diagnostics are folded away, not gone.
    expect(markup).toContain('diagnostics-details');
    expect(markup).not.toMatch(/id="diagnostics-details"[^>]*\sopen/);
  });

  it('2b. an executed step contributes its own activity with its real verdict', () => {
    const { ui } = project(
      base({
        status: 'RUNNING',
        steps: [scrollStep()],
        // No interaction projection yet: the step alone is the event.
      }),
    );
    expect(ui.surface).toBe('BROWSER_ACTIVITY');
    expect(ui.activityCount).toBe(1);
    expect(ui.activities[0]!.label).toBe('Looking further down the page');
    expect(ui.activities[0]!.detail).toContain('effect verified');
  });
});

describe('3. an activity appears only when its event exists', () => {
  it('3a. perception alone yields exactly one activity — no verification, no steps', () => {
    const { ui } = project(
      base({
        status: 'RUNNING',
        interaction: interaction({ activity: { phase: 'PERCEPTION', summary: 'r', step: 1, maxSteps: 10, cycle: null } }),
      }),
    );
    expect(ui.activityCount).toBe(1);
    expect(ui.activities.map((a) => a.label)).toEqual(['Reading the page']);
  });

  it('3b. activities accumulate from reported events only, in order, without duplicates', () => {
    let log: ActivityLog = EMPTY_LOG;
    let ui: UiModel;
    ({ ui, log } = project(base({ status: 'RUNNING', interaction: interaction({ activity: { phase: 'PERCEPTION', summary: 'r', step: 1, maxSteps: 10, cycle: null } }) }), log));
    expect(ui.activities.map((a) => a.label)).toEqual(['Reading the page']);
    ({ ui, log } = project(base({ status: 'RUNNING', steps: [scrollStep()], interaction: interaction({ activity: { phase: 'EXECUTION', summary: 'r', step: 1, maxSteps: 10, cycle: null } }) }), log));
    expect(ui.activities.map((a) => a.label)).toEqual(['Reading the page', 'Looking further down the page', 'Performing the requested action']);
    // Re-reporting the same phase must not duplicate it.
    ({ ui, log } = project(base({ status: 'RUNNING', steps: [scrollStep()], interaction: interaction({ activity: { phase: 'EXECUTION', summary: 'r', step: 1, maxSteps: 10, cycle: null } }) }), log));
    expect(ui.activityCount).toBe(3);
    // Only the most recent event is ACTIVE.
    expect(ui.activities.filter((a) => a.status === 'ACTIVE').map((a) => a.label)).toEqual(['Performing the requested action']);
  });

  it('3c. a task with no reported events shows no activity list at all', () => {
    const { workspace, html } = makeWorkspace();
    workspace.update(base({
      status: 'NEEDS_CLARIFICATION',
      task: 'Tell me about it.',
      currentPipelineStage: 'IDLE',
      interaction: interaction({
        outcome: 'UNANSWERED',
        activity: { phase: 'TERMINAL', summary: 'Clarify.', step: 0, maxSteps: 0, cycle: null },
        terminal: { outcome: 'UNANSWERED', reason: 'NEEDS_CLARIFICATION', headline: 'One detail is missing' },
        finalResult: { kind: 'NEEDS_CLARIFICATION', headline: 'One detail is missing', body: 'Which one do you mean?', provenance: null, remaining: [] },
      }),
    }));
    expect(html()).not.toContain('timeline-entry');
    expect(html()).not.toContain('activity-section');
  });
});

describe('4. no fabricated step counters', () => {
  it('4a. the projection never produces a step counter', () => {
    for (const state of [
      chatAnswer('4', 'what is 2 + 2?'),
      chatAck('hi'),
      base({ status: 'RUNNING', interaction: interaction({ activity: { phase: 'PLANNING', summary: 'p', step: 3, maxSteps: 10, cycle: null } }) }),
      base({ status: 'SUCCESS', steps: [scrollStep(), scrollStep(2)] }),
    ]) {
      const { ui } = project(state);
      expect(ui.stepCounter).toBeNull();
    }
  });

  it('4b. no surface ever renders "Step N of M"', () => {
    const { workspace, html } = makeWorkspace();
    for (const state of [
      chatAnswer('Hello!', 'hi'),
      chatAck('hello'),
      base({ status: 'RUNNING', interaction: interaction({ activity: { phase: 'PERCEPTION', summary: 'r', step: 1, maxSteps: 10, cycle: null } }) }),
      base({ status: 'FAILED', steps: [scrollStep()] }),
    ]) {
      workspace.update(state);
      expect(html()).not.toMatch(/Step \d+ of \d+/);
    }
  });

  it('4c. the count shown is a count of observed activities, not a budget', () => {
    const { workspace, html } = makeWorkspace();
    workspace.update(base({
      status: 'RUNNING',
      steps: [scrollStep()],
      interaction: interaction({ activity: { phase: 'EXECUTION', summary: 'r', step: 1, maxSteps: 10, cycle: null } }),
    }));
    expect(html()).toContain('2 activities');
    expect(html()).not.toMatch(/of 10/);
  });
});

describe('5. a terminal state replaces the active state', () => {
  it('5a. nothing stays ACTIVE and the result panel becomes the primary element', () => {
    let log: ActivityLog = EMPTY_LOG;
    let ui: UiModel;
    ({ ui, log } = project(base({
      status: 'RUNNING',
      steps: [scrollStep()],
      interaction: interaction({ activity: { phase: 'VERIFICATION', summary: 'r', step: 1, maxSteps: 10, cycle: null } }),
    }), log));
    expect(ui.activeCount).toBeGreaterThan(0);

    const terminalState = base({
      status: 'ANSWER',
      steps: [scrollStep()],
      interaction: interaction({
        outcome: 'ANSWERED',
        activity: { phase: 'TERMINAL', summary: 'done', step: 1, maxSteps: 10, cycle: null },
        terminal: { outcome: 'ANSWERED', reason: 'ANSWERED', headline: 'Found it.' },
        finalResult: { kind: 'ANSWER', headline: 'Found it.', body: 'Two cats found.', provenance: null, remaining: [] },
      }),
    });
    ({ ui, log } = project(terminalState, log));
    expect(ui.activeCount).toBe(0);
    expect(ui.workingLabel).toBeNull();
    expect(ui.terminal?.body).toBe('Two cats found.');

    const { workspace, html, text } = makeWorkspace();
    workspace.update(terminalState);
    const markup = html();
    expect(markup).toContain('final-response-panel');
    expect(text()).toContain('Two cats found.');
    expect(markup).toContain('data-state="terminal"');
    expect(markup).not.toContain('data-state="working"');
    // History is present but collapsed behind a disclosure.
    expect(markup).toContain('id="activity-details"');
    const detailsOpen = /<details[^>]*id="activity-details"[^>]*\sopen/.test(markup);
    expect(detailsOpen).toBe(false);
  });
});

describe('6. cancellation is truthful', () => {
  it('6a. STOPPED renders as cancelled, not failed and not working', () => {
    const { ui } = project(base({ status: 'STOPPED', task: 'search for cats' }));
    expect(ui.terminal?.kind).toBe('CANCELLED');
    expect(ui.terminal?.headline).toBe('Task cancelled.');
    expect(ui.workingLabel).toBeNull();
    expect(ui.pending).toBe(false);
  });

  it('6b. the cancelled card shows the notice and no retry-success', () => {
    const { workspace, html, text } = makeWorkspace();
    workspace.update(base({ status: 'STOPPED', task: 'search for cats', steps: [scrollStep()] }));
    const markup = html();
    expect(markup).toContain('final-response-panel notice');
    expect(text()).toContain('Task cancelled.');
    expect(markup).not.toContain('retry-action-btn');
    expect(markup).not.toContain('data-state="working"');
  });
});

describe('7. supersession is truthful', () => {
  it('7a. projection: a replaced run reports SUPERSEDED with its own copy', () => {
    const { ui } = project(base({
      status: 'STOPPED',
      task: 'Task A: old task',
      supersededPreviousTask: 'Task A: old task',
    }));
    expect(ui.terminal?.kind).toBe('SUPERSEDED');
    expect(ui.terminal?.headline).toBe('Task replaced by a newer request.');
    expect(ui.supersededNotice).toContain('Task A: old task');
  });

  it('7b. adapter: starting Task B while A runs emits a truthful SUPERSEDED transition', async () => {
    const adapter = new ExtensionAgentAdapter();
    vi.spyOn(adapter, 'checkExtensionConnected').mockResolvedValue(true);
    const events: DashboardAgentState[] = [];
    adapter.onStateChange((s) => events.push(JSON.parse(JSON.stringify(s))));

    await adapter.startTask('Task A: long browser job');
    expect(adapter.getState().status).toBe('RUNNING');

    const bPromise = adapter.startTask('Task B: replacement');
    // The supersede happens synchronously before the new task's own state.
    await new Promise((r) => setTimeout(r, 0));
    const supersededEvent = events.find((e) => e.supersededPreviousTask === 'Task A: long browser job');
    expect(supersededEvent).toBeDefined();
    expect(supersededEvent!.status).toBe('STOPPED');
    const ui = projectUi(supersededEvent!);
    expect(ui.terminal?.kind).toBe('SUPERSEDED');

    await bPromise;
    const after = adapter.getState();
    expect(after.task).toBe('Task B: replacement');
    expect(after.status).toBe('RUNNING');
    // The new card must not carry the old card's supersession flag.
    expect(after.supersededPreviousTask).toBeUndefined();
    adapter.destroy();
  });
});

describe('8. clarification is truthful', () => {
  it('8a. NEEDS_CLARIFICATION renders the question directly, with no browser work implied', () => {
    const { workspace, html, text } = makeWorkspace();
    workspace.update(base({
      status: 'NEEDS_CLARIFICATION',
      task: 'Tell me about it.',
      currentPipelineStage: 'IDLE',
      interaction: interaction({
        outcome: 'UNANSWERED',
        activity: { phase: 'TERMINAL', summary: 'c', step: 0, maxSteps: 0, cycle: null },
        terminal: { outcome: 'UNANSWERED', reason: 'NEEDS_CLARIFICATION', headline: 'One detail is missing' },
        finalResult: { kind: 'NEEDS_CLARIFICATION', headline: 'One detail is missing', body: 'I do not know which item you mean.', provenance: null, remaining: [] },
      }),
    }));
    const markup = html();
    expect(markup).toContain('final-response-panel notice');
    expect(text()).toContain('I do not know which item you mean.');
    expect(markup).not.toContain('timeline-entry');
    expect(markup).not.toContain('retry-action-btn');
    expect(markup).not.toMatch(/Step \d+ of \d+/);
  });
});

describe('9. failure is truthful and never stuck working', () => {
  it('9a. FAILED shows a concise failure, preserves activity context, and stops the working indicator', () => {
    let log: ActivityLog = EMPTY_LOG;
    let ui: UiModel;
    ({ ui, log } = project(base({ status: 'RUNNING', steps: [scrollStep()] }), log));
    expect(ui.workingLabel).not.toBeNull();

    const failed = base({
      status: 'FAILED',
      task: 'search for cats',
      steps: [scrollStep()],
      reason: 'INTERNAL: secret provider detail 4111 1111 1111 1111',
      interaction: interaction({
        outcome: 'FAILED',
        activity: { phase: 'TERMINAL', summary: 'f', step: 1, maxSteps: 10, cycle: null },
        terminal: { outcome: 'FAILED', reason: 'REASONER_FAILED', headline: 'The model could not continue.' },
        finalResult: { kind: 'FAILED', headline: 'The model could not continue.', body: null, provenance: null, remaining: [] },
      }),
    });
    ({ ui } = project(failed, log));
    expect(ui.terminal?.kind).toBe('FAILED');
    expect(ui.terminal?.tone).toBe('failure');
    expect(ui.workingLabel).toBeNull();
    expect(ui.activityCount).toBeGreaterThan(0);

    const { workspace, html, text } = makeWorkspace();
    workspace.update(failed);
    const markup = html();
    expect(markup).toContain('final-response-panel failure');
    expect(markup).toContain('retry-action-btn');
    expect(markup).not.toContain('data-state="working"');
    expect(markup).toContain('timeline-entry');
    expect(markup).not.toContain('4111');
    expect(text()).not.toContain('4111');
  });

  it('9b. a provider failure mid-run keeps its observed activities and says nothing succeeded', () => {
    const { workspace, html, text } = makeWorkspace();
    workspace.update(base({
      status: 'PROVIDER_UNAVAILABLE',
      steps: [scrollStep()],
      interaction: interaction({
        outcome: 'FAILED',
        activity: { phase: 'TERMINAL', summary: 'x', step: 1, maxSteps: 10, cycle: null },
        terminal: { outcome: 'FAILED', reason: 'REASONER_FAILED', headline: 'The reasoning service was unavailable, so nothing was changed on the page.' },
        finalResult: { kind: 'PROVIDER_UNAVAILABLE', headline: 'The reasoning service was unavailable, so nothing was changed on the page.', body: null, provenance: null, remaining: [] },
      }),
    }));
    const markup = html();
    expect(markup).toContain('final-response-panel failure');
    expect(markup).toContain('Looking further down the page');
    expect(text()).toContain('nothing was changed on the page');
    expect(markup).not.toContain('final-response-panel success');
    expect(markup).not.toContain('data-state="working"');
  });
});

describe('10. commit unknown is a notice', () => {
  it('10a. COMMIT_UNKNOWN renders as "check this yourself", never as success or failure', () => {
    const { workspace, html, text } = makeWorkspace();
    workspace.update(base({
      status: 'COMMIT_UNKNOWN',
      steps: [scrollStep()],
      interaction: interaction({
        outcome: 'UNANSWERED',
        activity: { phase: 'TERMINAL', summary: 'x', step: 1, maxSteps: 10, cycle: null },
        terminal: { outcome: 'UNANSWERED', reason: 'COMMIT_UNVERIFIED', headline: 'The send could not be confirmed.' },
        finalResult: { kind: 'COMMIT_UNKNOWN', headline: 'The send could not be confirmed.', body: 'Check the page to see whether it went through.', provenance: null, remaining: [] },
      }),
    }));
    const markup = html();
    expect(markup).toContain('final-response-panel notice');
    expect(markup).not.toContain('final-response-panel success');
    expect(markup).not.toContain('final-response-panel failure');
    expect(markup).not.toContain('retry-action-btn');
    expect(text()).toContain('Check the page to see whether it went through.');
  });
});

describe('11. no raw internal or sensitive content reaches the UI projection', () => {
  it('11a. state.reason is internal and never appears in the projection or the DOM', () => {
    const secret = 'INTERNAL DEBUG: card 4111 1111 1111 1111 token gsk_superuser_secret';
    const state = base({
      status: 'FAILED',
      reason: secret,
      interaction: interaction({
        outcome: 'FAILED',
        activity: { phase: 'TERMINAL', summary: 'f', step: 0, maxSteps: 0, cycle: null },
        terminal: { outcome: 'FAILED', reason: 'UNKNOWN', headline: 'Something went wrong.' },
        finalResult: { kind: 'FAILED', headline: 'Something went wrong.', body: null, provenance: null, remaining: [] },
      }),
    });
    const { ui } = project(state);
    expect(JSON.stringify(ui)).not.toContain('4111');
    expect(JSON.stringify(ui)).not.toContain('gsk_');
    expect(JSON.stringify(ui)).not.toContain('INTERNAL DEBUG');

    const { workspace, html } = makeWorkspace();
    workspace.update(state);
    expect(html()).not.toContain('4111');
    expect(html()).not.toContain('gsk_');
    expect(html()).not.toContain('INTERNAL DEBUG');
  });

  it('11b. a conversational body is rendered as text, never as markup', () => {
    const { workspace, html, container } = makeWorkspace();
    workspace.update(chatAnswer('<img src=x onerror="alert(1)"> attack', 'hi'));
    const markup = html();
    expect(markup).not.toContain('<img');
    expect(markup).toContain('&lt;img src=x');
    // Parsed reality: no element was ever created from the body.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)"> attack');
  });

  it('11c. malformed or partial state fails closed to an honest minimal surface', () => {
    // Missing interaction, missing steps, unknown stage — no crash, no chrome.
    const { ui } = project(base({ status: 'RUNNING', currentPipelineStage: 'IDLE' as any }) as any);
    expect(ui.surface).toBe('BROWSER_ACTIVITY');
    expect(ui.workingLabel).toBe('Working…');
    expect(ui.activities).toEqual([]);
    expect(ui.activityCount).toBe(0);

    // Null-ish state fails closed to IDLE.
    const idle = projectUi({ status: 'IDLE', task: '' } as any);
    expect(idle.surface).toBe('IDLE');
  });

  it('11d. activity labels come from the fixed table, never from action arguments', () => {
    const { ui } = project(base({
      status: 'RUNNING',
      steps: [{ ...scrollStep(), targetDescription: 'input[name="password"] raw secret' }],
    }));
    expect(JSON.stringify(ui.activities)).not.toContain('password');
    expect(ui.activities[0]!.label).toBe('Looking further down the page');
  });
});

describe('12. the proven normal-chat routing and the UI surface agree', () => {
  const acceptance = [
    'Hi', 'Hello', 'How are you?', 'What is machine learning?',
    'Explain TCP vs UDP', 'What is 2 + 2?', 'What is a binary search tree?',
  ];

  it('12a. every CONVERSATION-routed message projects to the conversation surface', () => {
    for (const msg of acceptance) {
      const decision = classifyMessageRoute(msg);
      expect(decision.route, msg).toBe('CONVERSATION');
      const { ui } = project(chatAnswer(`answer to: ${msg}`, msg));
      expect(ui.surface, msg).toBe('CONVERSATION');
    }
  });

  it('12b. every PIPELINE-routed message projects to the browser surface', () => {
    for (const msg of ['search for cats', 'open the third result', 'Tell me about it.', 'Find the latest news about ISRO']) {
      expect(classifyMessageRoute(msg).route, msg).toBe('PIPELINE');
      const { ui } = project(base({ status: 'RUNNING', task: msg }));
      expect(ui.surface, msg).toBe('BROWSER_ACTIVITY');
    }
  });

  it('12c. a new normal-chat message after a browser task leaves no browser residue (multi-turn)', () => {
    const { workspace, html, text } = makeWorkspace();
    // Browser task runs and finishes.
    workspace.update(base({
      status: 'ANSWER',
      task: 'search for cats',
      steps: [scrollStep()],
      interaction: interaction({
        outcome: 'ANSWERED',
        activity: { phase: 'TERMINAL', summary: 'd', step: 1, maxSteps: 10, cycle: null },
        terminal: { outcome: 'ANSWERED', reason: 'ANSWERED', headline: 'Found results.' },
        finalResult: { kind: 'ANSWER', headline: 'Found results.', body: 'Two cats.', provenance: null, remaining: [] },
      }),
    }));
    expect(html()).toContain('data-surface="browser"');

    // The adapter clears interaction/provenance on startTask; the new chat
    // answer then renders on the conversation surface with a fresh log.
    workspace.update(chatAnswer('Hello again!', 'hi'));
    const markup = html();
    expect(markup).toContain('data-surface="conversation"');
    expect(markup).not.toContain('timeline-entry');
    expectNoBrowserChrome(markup);
    expect(text()).toContain('Hello again!');
    expect(text()).not.toContain('Two cats.');
  });

  it('12d. startTask clears the previous run interaction and provenance', async () => {
    const adapter = new ExtensionAgentAdapter();
    vi.spyOn(adapter, 'checkExtensionConnected').mockResolvedValue(true);
    await adapter.startTask('search for cats');
    (adapter as any).handleExtensionProgress({
      runId: (adapter as any).currentRunId,
      task: 'search for cats',
      status: 'RUNNING',
      currentStep: 1,
      maxSteps: 10,
      steps: [scrollStep()],
      interaction: interaction({ outcome: 'RUNNING' }),
      answerSource: 'PAGE_EVIDENCE',
    });
    expect(adapter.getState().interaction).toBeDefined();
    expect(adapter.getState().answerSource).toBe('PAGE_EVIDENCE');

    await adapter.startTask('hi');
    const s = adapter.getState();
    expect(s.interaction).toBeUndefined();
    expect(s.answerSource).toBeUndefined();
    expect(s.steps).toEqual([]);
    adapter.destroy();
  });
});
