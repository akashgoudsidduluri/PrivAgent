/**
 * POST-17.10 G7 — declared-destination goal certification in GoalVerifier.
 *
 * Every fixture here is built with the PRODUCTION helpers — `decomposeTask`,
 * `SubgoalGraph`, `GoalProgressTracker` — so the plans under test are the
 * plans the agent actually gets. No destination logic is duplicated in this
 * file: negative cases are produced by degrading the OBSERVATION or the
 * subgoal state, and the expectations are that the real
 * `GoalProgressTracker` → `verifyDestination` chain refuses them.
 */
import { describe, it, expect } from 'vitest';
import { decomposeTask, SubgoalGraph } from '../extension/src/hierarchicalPlanning';
import { verifyTaskGoal } from '../extension/src/agent/goalVerifier';
import type { AgentTaskState } from '../extension/src/agent/agentState';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import type { Subgoal, SubgoalGraphData } from '../extension/src/hierarchicalPlanning/hierarchicalTypes';

const TASK = 'open the store catalog';
const COMPOUND_TASK = 'open the store catalog and buy the first item';
const ENTRY_URL = 'http://localhost:4174/';

function buildPlan(task: string): { graph: SubgoalGraph; data: () => SubgoalGraphData } {
  const decomp = decomposeTask(task, { currentUrl: ENTRY_URL });
  const graph = new SubgoalGraph(decomp.goal.goalId, decomp.subgoals);
  return { graph, data: () => graph.toData() };
}

function destinationSubgoalOf(data: SubgoalGraphData): Subgoal {
  const sg = Object.values(data.subgoals).find((s) => s.destination?.kind === 'DECLARED');
  if (!sg) throw new Error('plan has no destination subgoal');
  return sg;
}

function setState(data: SubgoalGraphData, sg: Subgoal, state: Subgoal['state']): SubgoalGraphData {
  return { ...data, subgoals: { ...data.subgoals, [sg.id]: { ...sg, state } } };
}

interface ObservationOpts {
  pageType?: string;
  confidence?: number;
  observedGeneration?: number;
  currentGeneration?: number;
  url?: string;
}

function makeState(data: SubgoalGraphData | undefined, currentGeneration = 9): AgentTaskState {
  return {
    subgoalGraphData: data,
    currentPageGeneration: currentGeneration,
    confirmedActionIds: [],
    steps: [],
    previousActions: [],
    currentUrl: 'http://localhost:4174/results.html?q=catalog',
    pageType: 'LISTING',
  } as unknown as AgentTaskState;
}

function makeContext(opts: ObservationOpts = {}): AgentContextPayload {
  const observed = opts.observedGeneration ?? 9;
  return {
    url: opts.url ?? 'http://localhost:4174/results.html?q=catalog',
    viewport: { width: 1280, height: 720, scroll_x: 0, scroll_y: 0 },
    detections: [],
    page_type: opts.pageType ?? 'LISTING',
    semantic_context: {
      pageType: opts.pageType ?? 'LISTING',
      confidence: opts.confidence ?? 0.99,
      pageGeneration: observed,
      pageState: 'READY',
      entities: [],
      affordances: [],
    },
  } as unknown as AgentContextPayload;
}

function successOnListing(data: SubgoalGraphData) {
  return verifyTaskGoal(TASK, makeState(data), makeContext());
}

describe('G7 — declared destination goal certification', () => {
  it('1. declared destination + COMPLETED destination subgoal → SUCCESS', () => {
    const { graph, data } = buildPlan(TASK);
    const d = data();
    graph.completeSubgoal(destinationSubgoalOf(d).id);

    const r = successOnListing(data());
    expect(r.satisfied).toBe(true);
    expect(r.status).toBe('SUCCESS');
    // The reason must come from the destination verifier, not from a local
    // re-implementation of the match.
    expect(r.reason).toContain('destination verifier');
  });

  it('2. destination subgoal PENDING → not SUCCESS', () => {
    const { data } = buildPlan(TASK);
    const d = data();
    const r = successOnListing(setState(d, destinationSubgoalOf(d), 'PENDING'));
    expect(r.satisfied).toBe(false);
    expect(r.status).not.toBe('SUCCESS');
  });

  it('3. destination subgoal IN_PROGRESS → not SUCCESS', () => {
    const { data } = buildPlan(TASK);
    const d = data();
    const r = successOnListing(setState(d, destinationSubgoalOf(d), 'IN_PROGRESS'));
    expect(r.satisfied).toBe(false);
  });

  it('4. destination subgoal FAILED → not SUCCESS', () => {
    const { data } = buildPlan(TASK);
    const d = data();
    const r = successOnListing(setState(d, destinationSubgoalOf(d), 'FAILED'));
    expect(r.satisfied).toBe(false);
  });

  it('5. no declared destination → not SUCCESS', () => {
    const { graph, data } = buildPlan(TASK);
    const d = data();
    graph.completeSubgoal(destinationSubgoalOf(d).id);
    // Strip the declaration entirely: no destination subgoal remains, so this
    // is not a destination goal and must fall through to the catch-all.
    const stripped: SubgoalGraphData = {
      ...data(),
      subgoals: Object.fromEntries(
        Object.entries(data().subgoals).map(([k, v]) => [
          k,
          k === destinationSubgoalOf(d).id ? { ...v, destination: undefined } : v,
        ])
      ),
    };
    const r = verifyTaskGoal(TASK, makeState(stripped), makeContext());
    expect(r.satisfied).toBe(false);
  });

  it('5b. no subgoal graph at all → not SUCCESS', () => {
    const r = verifyTaskGoal(TASK, makeState(undefined), makeContext());
    expect(r.satisfied).toBe(false);
  });

  it('6. destination MISMATCH (wrong role) → not SUCCESS', () => {
    const { graph, data } = buildPlan(TASK);
    const d = data();
    graph.completeSubgoal(destinationSubgoalOf(d).id);
    const r = verifyTaskGoal(TASK, makeState(data()), makeContext({ pageType: 'ARTICLE', url: 'http://localhost:4174/a.html' }));
    expect(r.satisfied).toBe(false);
    expect(r.reason).toContain('MISMATCH');
  });

  it('7. destination UNKNOWN (unknown page type) → not SUCCESS', () => {
    const { graph, data } = buildPlan(TASK);
    const d = data();
    graph.completeSubgoal(destinationSubgoalOf(d).id);
    const r = verifyTaskGoal(TASK, makeState(data()), makeContext({ pageType: 'UNKNOWN' }));
    expect(r.satisfied).toBe(false);
    expect(r.reason).toContain('UNKNOWN');
  });

  it('8. stale observation (generation mismatch) → not SUCCESS', () => {
    const { graph, data } = buildPlan(TASK);
    const d = data();
    graph.completeSubgoal(destinationSubgoalOf(d).id);
    const r = verifyTaskGoal(
      TASK,
      makeState(data(), 9),
      makeContext({ observedGeneration: 3, currentGeneration: 9 })
    );
    expect(r.satisfied).toBe(false);
    expect(r.reason).toContain('UNKNOWN');
  });

  it('9. low-confidence destination → not SUCCESS', () => {
    const { graph, data } = buildPlan(TASK);
    const d = data();
    graph.completeSubgoal(destinationSubgoalOf(d).id);
    const r = verifyTaskGoal(TASK, makeState(data()), makeContext({ confidence: 0.1 }));
    expect(r.satisfied).toBe(false);
    expect(r.reason).toContain('UNKNOWN');
  });

  it('10. a model success claim alone never certifies the goal', () => {
    const { graph, data } = buildPlan(TASK);
    const d = data();
    graph.completeSubgoal(destinationSubgoalOf(d).id);
    const state = {
      ...makeState(data()),
      // Nothing in the production state type carries a model claim; inject one
      // anyway to prove it is not read.
      modelClaimedSuccess: true,
      goalStatus: 'SUCCESS',
    } as unknown as AgentTaskState;
    // The destination subgoal is still PENDING here.
    const pending = setState(d, destinationSubgoalOf(d), 'IN_PROGRESS');
    const r = verifyTaskGoal(TASK, { ...state, subgoalGraphData: pending }, makeContext());
    expect(r.satisfied).toBe(false);
  });

  it('11. action success without destination completion → not SUCCESS', () => {
    const { data } = buildPlan(TASK);
    const d = data();
    const state = {
      ...makeState(setState(d, destinationSubgoalOf(d), 'IN_PROGRESS')),
      steps: [
        {
          action: 'click',
          target: 'elem_1',
          executionSuccess: true,
          executionError: undefined,
          url: 'http://localhost:4174/results.html?q=catalog',
        },
      ],
    } as unknown as AgentTaskState;
    const r = verifyTaskGoal(TASK, state, makeContext());
    expect(r.satisfied).toBe(false);
  });

  it('12. destination complete but a consequential subgoal is outstanding → not SUCCESS', () => {
    const { graph, data } = buildPlan(COMPOUND_TASK);
    let d = data();
    graph.completeSubgoal(destinationSubgoalOf(d).id);
    d = data();
    // The compound plan carries a CONFIRM/USER_CONFIRMED subgoal that has not
    // been satisfied: the user asked to BUY, so reaching the catalog is not
    // the end of the task.
    const confirm = Object.values(d.subgoals).find(
      (s) => s.verificationCondition?.type === 'USER_CONFIRMED'
    );
    expect(confirm, 'compound plan must carry a confirmation subgoal').toBeDefined();

    const r = verifyTaskGoal(COMPOUND_TASK, makeState(d), makeContext());
    expect(r.satisfied).toBe(false);
    expect(r.reason).toContain('outstanding');
  });

  it('13. destination complete + every required subgoal complete → SUCCESS', () => {
    const { graph, data } = buildPlan(TASK);
    let d = data();
    graph.completeSubgoal(destinationSubgoalOf(d).id);
    d = data();
    // Complete the remaining requirements too. The decomposer's KNOWN-
    // UNVERIFIABLE scaffolding (AFFORDANCE_AVAILABLE with no expectedValue,
    // STATE_CHANGED) is not a requirement and is left untouched.
    const subgoals = Object.fromEntries(
      Object.entries(d.subgoals).map(([k, v]) => {
        const cond = v.verificationCondition;
        const required =
          cond &&
          cond.type !== 'DESTINATION_VERIFIED' &&
          cond.type !== 'STATE_CHANGED' &&
          !(cond.type === 'AFFORDANCE_AVAILABLE' && !cond.expectedValue);
        return [k, required ? { ...v, state: 'COMPLETED' as const } : v];
      })
    );
    const r = verifyTaskGoal(TASK, makeState({ ...d, subgoals }), makeContext());
    expect(r.satisfied).toBe(true);
  });

  it('14. a completed graph alone does not survive a changed observation', () => {
    // Proves the branch re-runs the verifier rather than trusting the recorded
    // COMPLETE state: the page is no longer the destination.
    const { graph, data } = buildPlan(TASK);
    const d = data();
    graph.completeSubgoal(destinationSubgoalOf(d).id);
    const r = verifyTaskGoal(
      TASK,
      makeState(data()),
      makeContext({ pageType: 'SEARCH', url: 'http://localhost:4174/search.html' })
    );
    expect(r.satisfied).toBe(false);
  });
});
