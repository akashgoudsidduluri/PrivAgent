/**
 * G7 REPAIR 1 — DESTINATION SUBGOAL RE-EVALUATION (focused regression suite).
 *
 * The G7 blocker was lifecycle, not classification. A destination subgoal was
 * selected exactly once — while the browser was still on the ENTRY page — and
 * `startSubgoal` moved it to IN_PROGRESS. `getReadySubgoals` only returns
 * READY/PENDING subgoals, so from the next cycle on the selector reported
 * NEEDS_REPLAN, `activeSubgoal` was undefined, and the AgentLoop's
 * verification guard could never run again. The destination was therefore
 * proven once, BEFORE arrival, and never re-checked once the browser got there.
 *
 * These tests cover the requirement list A-K. They drive the REAL AgentLoop,
 * the REAL SubgoalGraph/SubgoalSelector, the REAL GoalProgressTracker and the
 * REAL DestinationVerifier. No destination logic is duplicated here: the
 * negative cases degrade the OBSERVATION or the subgraph state and assert the
 * production chain refuses them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { AgentLoop } from '../extension/src/agent/agentLoop';
import { MockAgentProvider } from '../extension/src/agent/mockAgentProvider';
import { buildBrowserWorldModel } from '../extension/src/worldModel/worldModelBuilder';
import { SubgoalGraph } from '../extension/src/hierarchicalPlanning/subgoalGraph';
import { SubgoalSelector } from '../extension/src/hierarchicalPlanning/subgoalSelector';
import { GoalProgressTracker } from '../extension/src/hierarchicalPlanning/goalProgressTracker';
import { verifyDestination } from '../extension/src/planning/destinationVerifier';
import { decomposeTask } from '../extension/src/hierarchicalPlanning';
import { assertNoSensitiveDataInState } from '../extension/src/agent/agentLoop';
import { observingHost, simulatedBrowser, type ObservedPageState } from './helpers/observingHost';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import type { BrowserAction } from '../extension/src/agent/actionTypes';
import type { Subgoal } from '../extension/src/hierarchicalPlanning/hierarchicalTypes';

const TASK = 'open the store catalog';
const ENTRY_URL = 'http://localhost:4174/';
const DEST_URL = 'http://localhost:4174/results.html?q=all';

// ── Production-plan helpers ──────────────────────────────────────────────────

function buildPlan(): { graph: SubgoalGraph; destinationSubgoal: Subgoal } {
  const decomp = decomposeTask(TASK, { currentUrl: ENTRY_URL });
  const graph = new SubgoalGraph(decomp.goal.goalId, decomp.subgoals);
  const destinationSubgoal = graph
    .getAllSubgoals()
    .find((s) => s.verificationCondition?.type === 'DESTINATION_VERIFIED');
  if (!destinationSubgoal) throw new Error('production plan produced no destination subgoal');
  return { graph, destinationSubgoal };
}

function listingDom(): string {
  return `<html><body>
    <h2>Search Results</h2>
    <div class="product-card"><div class="product-title">A</div></div>
    <div class="product-card"><div class="product-title">B</div></div>
    <div class="product-card"><div class="product-title">C</div></div>
    <div class="product-card"><div class="product-title">D</div></div>
  </body></html>`;
}

function entryDom(): string {
  return `<html><body><h1>ApexCart</h1><button id="btn-shop-now">Shop</button></body></html>`;
}

interface PerceptionSpec {
  url: string;
  generation: number;
  html: string;
}

/** Builds the exact payload shape the service worker's perceivePage returns. */
function makePerception(spec: PerceptionSpec) {
  document.documentElement.innerHTML = spec.html;
  const worldModel = buildBrowserWorldModel({
    root: document,
    pageGeneration: spec.generation,
  });
  worldModel.page = { ...worldModel.page, url: spec.url };

  const context = {
    url: spec.url,
    timestamp: Date.now(),
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    detections: [],
    total_elements_scanned: 40,
    sensitive_elements_detected: 0,
    sanitized_status: 'sanitized_only',
    ocr_metrics: null,
  } as unknown as AgentContextPayload;

  return {
    context,
    worldModel,
    activeWorldModelRef: {
      pageGeneration: spec.generation,
      worldModelId: worldModel.id,
    },
  };
}

/** Captures `[AgentTrace]` console output so the verifier's own verdict text
 *  can be asserted, rather than a re-implementation of it. */
function captureTrace(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  return { lines, restore: () => { console.info = original; } };
}

function destinationSubgoalInProgress(): { graph: SubgoalGraph; subgoal: Subgoal } {
  const { graph, destinationSubgoal } = buildPlan();
  graph.startSubgoal(destinationSubgoal.id);
  return { graph, subgoal: graph.getSubgoal(destinationSubgoal.id)! };
}

function contextAt(opts: {
  url?: string;
  pageType?: string;
  confidence?: number;
  observedGeneration?: number;
}): AgentContextPayload {
  return {
    url: opts.url ?? DEST_URL,
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    detections: [],
    semantic_context: {
      pageType: opts.pageType ?? 'LISTING',
      confidence: opts.confidence ?? 0.99,
      pageGeneration: opts.observedGeneration ?? 7,
      pageState: 'READY',
      entities: [],
      affordances: [],
    },
  } as unknown as AgentContextPayload;
}

// ── Requirement A–G: the full lifecycle ──────────────────────────────────────

describe('G7 Repair 1 — destination subgoal is re-evaluated after arrival', () => {
  let trace: ReturnType<typeof captureTrace>;
  beforeEach(() => {
    trace = captureTrace();
  });

  async function runUntilTerminal(opts: {
    specs: PerceptionSpec[];
    maxSteps?: number;
  }): Promise<{ state: Awaited<ReturnType<AgentLoop['runTask']>>; traceLines: string[] }> {
    let i = 0;
    const perceivePage = vi.fn(async () => {
      const index = Math.min(i, opts.specs.length - 1);
      const spec = opts.specs[index] ?? opts.specs[opts.specs.length - 1]!;
      i += 1;
      return makePerception(spec);
    });

    const provider = new MockAgentProvider();
    // A scroll needs no grounded target, so it exercises the loop's lifecycle
    // without introducing a target-authorization failure into the fixture.
    const scroll: BrowserAction = { action: 'scroll', direction: 'down', amount: 100 } as BrowserAction;
    provider.setActionSequence([scroll, scroll, scroll, scroll, scroll, scroll]);

    // The product always supplies a live observation channel; without it the
    // loop correctly reports EFFECT_UNVERIFIABLE for every action and takes the
    // recovery path, which would never reach the verification block under test.
    const page: ObservedPageState = { url: ENTRY_URL, scrollY: 0, domElementCount: 40 };

    const loop = new AgentLoop(
      provider,
      {
        getEffectSnapshot: observingHost(page),
        perceivePage,
        executeAction: vi.fn(async (a: BrowserAction) => {
          await simulatedBrowser(page)(a);
          return { success: true, message: 'Executed' };
        }),
      },
      { delayBetweenStepsMs: 1, maxSteps: opts.maxSteps ?? 6 }
    );

    const state = await loop.runTask(TASK);
    trace.restore();
    return { state, traceLines: trace.lines };
  }

  it('A+B+C+D+E+F+G. entry page → arrival → re-verified → MATCH → COMPLETED → goal evaluable', async () => {
    const { state, traceLines } = await runUntilTerminal({
      specs: [
        { url: ENTRY_URL, generation: 2, html: entryDom() },
        { url: DEST_URL, generation: 7, html: listingDom() },
      ],
    });

    const completed = traceLines.filter((l) => l.includes('[AgentTrace] subgoal completed'));
    expect(completed.length).toBeGreaterThan(0);

    // D + E: the verdict text is the REAL DestinationVerifier MATCH reason —
    // it is the production verifier's own wording, not a re-implementation.
    expect(completed.join('\n')).toMatch(
      /Observed page identity .* is one of the declared roles/i
    );

    // C-guard: the subgoal that completed is exactly the one the revisit path
    // surfaced, and it is the destination subgoal.
    const revisitIds = traceLines
      .filter((l) => l.includes('destination subgoal eligible for re-verification'))
      .map((l) => /"subgoalId":"([^"]+)"/.exec(l)?.[1])
      .filter(Boolean);
    expect(revisitIds.length).toBeGreaterThan(0);
    const completedIds = completed.map((l) => /"subgoalId":"([^"]+)"/.exec(l)?.[1]).filter(Boolean);
    expect(completedIds.some((id) => revisitIds.includes(id))).toBe(true);

    // F: the destination subgoal reached COMPLETED in the real graph.
    const subgoals = Object.values(state.subgoalGraphData?.subgoals ?? {});
    const destination = subgoals.find(
      (s) => (s.verificationCondition as { type?: string } | undefined)?.type === 'DESTINATION_VERIFIED'
    );
    expect(destination?.state).toBe('COMPLETED');

    // G: GoalVerifier owned the final decision. `goalStatus = 'SUCCESS'` is
    // only ever assigned downstream of `verifyTaskGoal(...).satisfied`
    // (agentLoop.ts:1139, 2644, 2980), so this proves it was reached and
    // accepted — it is not a shortcut around it.
    expect(state.goalStatus).toBe('SUCCESS');
    expect(state.status).toBe('SUCCESS');
    expect(state.reason ?? '').toMatch(/destination verifier/i);

    // No raw values may reach the task state through the new path.
    expect(() => assertNoSensitiveDataInState(state)).not.toThrow();
  });

  it('B. the destination subgoal starts IN_PROGRESS while still on the entry page', async () => {
    const { graph, destinationSubgoal } = buildPlan();
    // Reproduce the real cycle-0 selection.
    const selection = SubgoalSelector.selectNextSubgoal({ graph, affordances: [] });
    expect(selection.status).toBe('SELECTED');
    expect(selection.selectedSubgoal?.id).toBe(destinationSubgoal.id);
    graph.startSubgoal(selection.selectedSubgoal!.id);
    expect(graph.getSubgoal(destinationSubgoal.id)?.state).toBe('IN_PROGRESS');
  });

  it('C. an IN_PROGRESS destination subgoal becomes eligible only after the page changes', async () => {
    const { graph, destinationSubgoal } = buildPlan();
    graph.startSubgoal(destinationSubgoal.id);

    // No change yet → not eligible.
    const unchanged = SubgoalSelector.selectDestinationSubgoalForRevisit({
      graph,
      currentUrl: ENTRY_URL,
      currentGeneration: 2,
      previousUrl: ENTRY_URL,
      previousGeneration: 2,
    });
    expect(unchanged.status).toBe('NONE');
    expect(unchanged.selectedSubgoal).toBeUndefined();

    // The browser moved → eligible, and ONLY for the destination subgoal.
    const changed = SubgoalSelector.selectDestinationSubgoalForRevisit({
      graph,
      currentUrl: DEST_URL,
      currentGeneration: 7,
      previousUrl: ENTRY_URL,
      previousGeneration: 2,
    });
    expect(changed.status).toBe('REVISIT');
    expect(changed.selectedSubgoal?.id).toBe(destinationSubgoal.id);
  });

  it('C-guard. a non-destination IN_PROGRESS subgoal is NOT made re-selectable', () => {
    const decomp = decomposeTask(TASK, { currentUrl: ENTRY_URL });
    const graph = new SubgoalGraph(decomp.goal.goalId, decomp.subgoals);
    const nonDestination = graph
      .getAllSubgoals()
      .find((s) => s.verificationCondition?.type !== 'DESTINATION_VERIFIED');
    expect(nonDestination).toBeDefined();
    graph.startSubgoal(nonDestination!.id);

    const revisit = SubgoalSelector.selectDestinationSubgoalForRevisit({
      graph,
      currentUrl: DEST_URL,
      currentGeneration: 7,
      previousUrl: ENTRY_URL,
      previousGeneration: 2,
    });
    // Only the destination subgoal is ever returned by this path.
    if (revisit.status === 'REVISIT') {
      expect(revisit.selectedSubgoal?.verificationCondition?.type).toBe('DESTINATION_VERIFIED');
    } else {
      expect(revisit.status).toBe('NONE');
    }
  });
});

it('M2-guard. an action whose URL matches the destination does NOT complete it', async () => {
    // A navigation action to the destination URL, dispatched successfully,
    // while the browser is still OBSERVED on the entry page. Dispatch success
    // and the action's own URL are not evidence of arrival.
    let i = 0;
    const specs: PerceptionSpec[] = [
      { url: ENTRY_URL, generation: 2, html: entryDom() },
      { url: ENTRY_URL, generation: 4, html: entryDom() },
    ];
    const perceivePage = vi.fn(async () => {
      const index = Math.min(i, specs.length - 1);
      i += 1;
      return makePerception(specs[index] ?? specs[specs.length - 1]!);
    });

    const provider = new MockAgentProvider();
    provider.setActionSequence([
      { action: 'navigate', url: DEST_URL } as BrowserAction,
      { action: 'navigate', url: DEST_URL } as BrowserAction,
    ]);

    const page: ObservedPageState = { url: ENTRY_URL, scrollY: 0, domElementCount: 40 };
    const loop = new AgentLoop(
      provider,
      {
        getEffectSnapshot: observingHost(page),
        perceivePage,
        executeAction: vi.fn(async () => {
          page.url = DEST_URL; // the dispatch really did navigate…
          return { success: true, message: 'navigated' };
        }),
      },
      { delayBetweenStepsMs: 1, maxSteps: 3 }
    );

    const t = captureTrace();
    const state = await loop.runTask(TASK);
    t.restore();

    const subgoals = Object.values(state.subgoalGraphData?.subgoals ?? {});
    const destination = subgoals.find(
      (s) => (s.verificationCondition as { type?: string } | undefined)?.type === 'DESTINATION_VERIFIED'
    );
    // …but the observation still says the browser is on the entry page, so the
    // destination cannot be certified from it.
    expect(destination?.state).not.toBe('COMPLETED');
  });

  // ── Requirements H–K: nothing else can complete the destination ───────────────

describe('G7 Repair 1 — only a real MATCH completes the destination', () => {
  it('E. a genuine MATCH is accepted by the production verifier', () => {
    const { subgoal } = destinationSubgoalInProgress();
    const r = GoalProgressTracker.verifySubgoalCondition(subgoal, {
      context: contextAt({}),
      pageGeneration: 7,
    });
    expect(r.satisfied).toBe(true);
    expect(r.reason).not.toContain('not confirmed');
  });

  it('H. dispatch success alone cannot complete the destination', () => {
    // The observation carries NO execution result at all — that is the point:
    // `SubgoalObservation` has no such field, so success cannot be consulted.
    const { subgoal } = destinationSubgoalInProgress();
    const onWrongPage = contextAt({ url: ENTRY_URL, pageType: 'UNKNOWN', confidence: 0.1 });
    const r = GoalProgressTracker.verifySubgoalCondition(subgoal, {
      context: onWrongPage,
      pageGeneration: 2,
    });
    expect(r.satisfied).toBe(false);
  });

  it('I. UNKNOWN classification cannot complete the destination', () => {
    const { subgoal } = destinationSubgoalInProgress();
    const r = GoalProgressTracker.verifySubgoalCondition(subgoal, {
      context: contextAt({ pageType: 'UNKNOWN', confidence: 0.1 }),
      pageGeneration: 7,
    });
    expect(r.satisfied).toBe(false);
    expect(r.reason).toContain('UNKNOWN');
  });

  it('J. MISMATCH (wrong page role) cannot complete the destination', () => {
    const { subgoal } = destinationSubgoalInProgress();
    const r = GoalProgressTracker.verifySubgoalCondition(subgoal, {
      context: contextAt({ pageType: 'CHECKOUT', confidence: 0.99 }),
      pageGeneration: 7,
    });
    expect(r.satisfied).toBe(false);
    expect(r.reason).toContain('MISMATCH');
  });

  it('K. a stale observation cannot complete the destination', () => {
    const { subgoal } = destinationSubgoalInProgress();
    // The classification was captured at generation 5; the browser is now at 7.
    const r = GoalProgressTracker.verifySubgoalCondition(subgoal, {
      context: contextAt({ observedGeneration: 5 }),
      pageGeneration: 7,
    });
    expect(r.satisfied).toBe(false);
    expect(r.reason).toMatch(/UNKNOWN|MISMATCH/);
  });

  it('K-guard. freshness is unchanged: the verifier still refuses a stale verdict directly', () => {
    const { subgoal } = destinationSubgoalInProgress();
    const declaration = subgoal.destination!;
    const verdict = verifyDestination({
      declaration,
      observation: {
        url: DEST_URL,
        pageGeneration: 5,
        semantic: { pageType: 'LISTING', confidence: 0.99, pageGeneration: 5 },
      },
      currentPageGeneration: 7,
    });
    expect(verdict.kind).not.toBe('MATCH');
  });
});

// ── The selection path itself grants no authority ────────────────────────────

describe('G7 Repair 1 — revisit eligibility is not a verdict', () => {
  it('selectDestinationSubgoalForRevisit never mutates subgoal state', () => {
    const { graph, destinationSubgoal } = buildPlan();
    graph.startSubgoal(destinationSubgoal.id);

    const r = SubgoalSelector.selectDestinationSubgoalForRevisit({
      graph,
      currentUrl: DEST_URL,
      currentGeneration: 7,
      previousUrl: ENTRY_URL,
      previousGeneration: 2,
    });

    expect(r.status).toBe('REVISIT');
    // Still IN_PROGRESS — only `verifySubgoalCondition` → MATCH may complete it.
    expect(graph.getSubgoal(destinationSubgoal.id)?.state).toBe('IN_PROGRESS');
  });

  it('a COMPLETED or FAILED destination subgoal is never revisited', () => {
    for (const terminal of ['COMPLETED', 'FAILED', 'SKIPPED'] as const) {
      const { graph, destinationSubgoal } = buildPlan();
      if (terminal === 'COMPLETED') graph.completeSubgoal(destinationSubgoal.id);
      else if (terminal === 'FAILED') graph.failSubgoal(destinationSubgoal.id, 'x');
      else graph.skipSubgoal(destinationSubgoal.id, 'x');

      const r = SubgoalSelector.selectDestinationSubgoalForRevisit({
        graph,
        currentUrl: DEST_URL,
        currentGeneration: 7,
        previousUrl: ENTRY_URL,
        previousGeneration: 2,
      });
      expect(r.status).toBe('NONE');
    }
  });

  it('a missing destination declaration fails closed even when revisited', () => {
    const { graph, destinationSubgoal } = buildPlan();
    graph.startSubgoal(destinationSubgoal.id);
    // Strip the user-derived declaration — the verifier must refuse.
    const stripped: Subgoal = {
      ...graph.getSubgoal(destinationSubgoal.id)!,
      destination: { kind: 'AMBIGUOUS', candidates: [['LISTING']], provenance: 'EXPLICIT_PAGE_ROLE' },
    };
    const r = GoalProgressTracker.verifySubgoalCondition(stripped, {
      context: contextAt({}),
      pageGeneration: 7,
    });
    expect(r.satisfied).toBe(false);
  });
});