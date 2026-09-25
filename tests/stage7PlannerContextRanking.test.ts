/**
 * PrivAgent — Stage 7 (B2): Goal-Aware Planner Context Ranking
 *
 * The 2 KB planner context budget is unchanged. What changed is WHICH elements
 * survive it: ranking is now driven by the goal (target entities, sanitized goal
 * description, active subgoal) and by the locally computed semantic
 * affordances, instead of by label/selector substring hits alone.
 *
 * These are SYNTHETIC TEST RESULTs: the real-Chrome measurement of the same
 * behaviour lives in docs/evidence/stage7-real-browser/.
 */

import { describe, it, expect } from 'vitest';
import {
  PlannerContextBuilder,
  TARGET_PLANNER_CONTEXT_BUDGET_BYTES,
} from '../extension/src/hierarchicalPlanning/plannerContextBuilder';
import { decomposeTask } from '../extension/src/hierarchicalPlanning/taskDecomposer';
import { SubgoalSelector } from '../extension/src/hierarchicalPlanning/subgoalSelector';
import { SubgoalGraph } from '../extension/src/hierarchicalPlanning/subgoalGraph';
import { AgentContextPayload, AgentDetection } from '../extension/src/privacy/types';
import { scanForRawSensitiveValues } from '../extension/src/privacy/rawValueScanner';

function det(
  id: string,
  type: AgentDetection['type'],
  selector: string,
  label?: string,
  confidence = 0.95
): AgentDetection {
  return {
    id,
    type,
    selector,
    confidence,
    bbox: { x: 10, y: 10, width: 120, height: 30 },
    length: 0,
    source: 'dom_attribute',
    is_partially_visible: false,
    ...(label ? { label } : {}),
  };
}

/**
 * The detection set actually observed on real Google by the PrivAgent content
 * script (ids/selectors/labels as measured), trimmed to the interactive set.
 */
function realGoogleDetections(): AgentDetection[] {
  return [
    det('ti6dpd', 'input', '#ti6dpd'),                                  // the real search box
    det('inter-button-9', 'button', 'input[name="btnK"]', 'Google Search'),
    det('inter-button-10', 'button', 'input[name="btnI"]', "I'm Feeling Lucky"),
    det('gbqfbb', 'button', '#gbqfbb', "I'm Feeling Lucky (#2)"),
    det('inter-button-7', 'button', 'div[role="button"]', 'Search by voice'),
    det('inter-link-12', 'link', 'a.eQtdDf', 'Advertising'),
    det('inter-link-13', 'link', 'a[role="menuitem"]', 'Search settings'),
    det('inter-link-14', 'link', 'div[role="link"]', 'Dark theme: Off'),
    det('heading-1', 'heading', 'h1', 'Google'),
  ];
}

function payload(detections: AgentDetection[]): AgentContextPayload {
  return {
    url: 'https://www.google.com/',
    timestamp: 1720000000000,
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: { width: 1280, height: 800 },
    sanitized_status: 'sanitized_only',
    total_elements_scanned: 213,
    sensitive_elements_detected: 0,
    ocr_metrics: { regions_scanned: 4, sensitive_detected: 0, latency_ms: 9 },
    detections,
  };
}

const TASK = 'Open Google and search cats';

describe('Stage 7 B2 — goal-aware planner context ranking', () => {
  it('keeps the real Google search input inside the 2 KB context', () => {
    const { goal } = decomposeTask(TASK);
    const result = PlannerContextBuilder.buildContext(
      payload(realGoogleDetections()),
      goal,
      undefined,
      undefined
    );

    const ids = result.contextPayload.detections.map((d) => d.id);
    expect(ids).toContain('ti6dpd');
    // The query input is the affordance the task actually needs.
    expect(ids[0]).toBe('ti6dpd');
    // The budget itself is unchanged.
    expect(result.byteSize).toBeLessThanOrEqual(TARGET_PLANNER_CONTEXT_BUDGET_BYTES);
    expect(TARGET_PLANNER_CONTEXT_BUDGET_BYTES).toBe(2048);
  });

  it('keeps the real Google search input for the subgoal the selector actually picks', () => {
    const { goal, subgoals } = decomposeTask(TASK);
    const selection = SubgoalSelector.selectNextSubgoal({
      graph: new SubgoalGraph(goal.goalId, subgoals),
      worldModel: undefined,
      affordances: [],
      recentFailures: [],
    } as never);
    const subgoal = selection.status === 'SELECTED' ? selection.selectedSubgoal : undefined;

    const result = PlannerContextBuilder.buildContext(payload(realGoogleDetections()), goal, subgoal);
    const ids = result.contextPayload.detections.map((d) => d.id);
    expect(ids).toContain('ti6dpd');
    expect(result.byteSize).toBeLessThanOrEqual(TARGET_PLANNER_CONTEXT_BUDGET_BYTES);
  });

  it('keeps both the query input and a usable submit control', () => {
    const { goal } = decomposeTask(TASK);
    const result = PlannerContextBuilder.buildContext(payload(realGoogleDetections()), goal);
    const kept = result.contextPayload.detections;
    const ids = kept.map((d) => d.id);

    expect(ids).toContain('ti6dpd');
    // "Google Search" is a real submit control; "I'm Feeling Lucky" is not.
    const submits = kept.filter(
      (d) => d.type === 'button' && /google search/i.test(d.label || '')
    );
    expect(submits.length).toBeGreaterThan(0);
  });

  it('ranks the search input above decorative controls for a search goal', () => {
    const { goal } = decomposeTask(TASK);
    const ranked = PlannerContextBuilder.buildContext(
      payload(realGoogleDetections()),
      goal
    ).contextPayload.detections;

    const inputIndex = ranked.findIndex((d) => d.id === 'ti6dpd');
    const decorative = ['inter-link-12', 'inter-link-14', 'heading-1'].map((id) =>
      ranked.findIndex((d) => d.id === id)
    );
    for (const idx of decorative) {
      if (idx >= 0) expect(inputIndex).toBeLessThan(idx);
    }
  });

  it('is deterministic: identical input yields an identical order', () => {
    const { goal } = decomposeTask(TASK);
    const a = PlannerContextBuilder.buildContext(payload(realGoogleDetections()), goal)
      .contextPayload.detections.map((d) => d.id);
    const b = PlannerContextBuilder.buildContext(payload(realGoogleDetections()), goal)
      .contextPayload.detections.map((d) => d.id);
    expect(a).toEqual(b);
  });

  it('does not change ranking for a non-search goal', () => {
    const { goal } = decomposeTask('Find the account number field');
    const ranked = PlannerContextBuilder.buildContext(
      payload([
        det('q', 'input', 'input#q'),
        det('submit', 'button', 'button#go', 'Go'),
        det('acc', 'input', 'input#account-number', 'Account number'),
      ]),
      goal
    ).contextPayload.detections.map((d) => d.id);

    // Without search intent the goal-matched field wins, not a generic input.
    expect(ranked[0]).toBe('acc');
  });

  it('boosts detections named by local semantic affordances', () => {
    const { goal } = decomposeTask(TASK);
    const base = payload([
      det('plain-1', 'button', 'button#a', 'Alpha'),
      det('plain-2', 'button', 'button#b', 'Beta'),
      det('plain-3', 'button', 'button#c', 'Gamma'),
      det('afforded', 'input', 'input#d'),
    ]);
    const withAffordance: AgentContextPayload = {
      ...base,
      semantic_context: {
        pageGeneration: 3,
        pageType: 'SEARCH',
        pageState: 'populated',
        entities: [],
        affordances: [
          { id: 'a1', type: 'TYPE', targetElementId: 'afforded', requiresConfirmation: false, description: 'Enter the search query' },
        ],
        promptInjectionDetected: false,
      } as never,
    };

    const ranked = PlannerContextBuilder.buildContext(withAffordance, goal).contextPayload.detections;
    expect(ranked[0]?.id).toBe('afforded');
  });

  it('preserves privacy: the ranked context still passes the raw-value firewall', () => {
    const { goal } = decomposeTask(TASK);
    const result = PlannerContextBuilder.buildContext(payload(realGoogleDetections()), goal);
    expect(scanForRawSensitiveValues(result.contextPayload)).toHaveLength(0);
    expect(result.contextPayload.sanitized_status).toBe('sanitized_only');
  });

  it('never grows the bounded context beyond the budget on a large real page', () => {
    const { goal } = decomposeTask(TASK);
    const many: AgentDetection[] = Array.from({ length: 60 }, (_, i) =>
      det(`ctl-${i}`, i % 3 === 0 ? 'button' : 'element', `div#ctl-${i}`, `Control ${i}`)
    );
    many.push(det('ti6dpd', 'input', '#ti6dpd'));
    many.push(det('inter-button-9', 'button', 'input[name="btnK"]', 'Google Search'));

    const result = PlannerContextBuilder.buildContext(payload(many), goal);
    expect(result.byteSize).toBeLessThanOrEqual(TARGET_PLANNER_CONTEXT_BUDGET_BYTES);
    const ids = result.contextPayload.detections.map((d) => d.id);
    expect(ids).toContain('ti6dpd');
    // Capability preservation still holds: the search input survives.
    expect(ids).toContain('ti6dpd');
  });
});
