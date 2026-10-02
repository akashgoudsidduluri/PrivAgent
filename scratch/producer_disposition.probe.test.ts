/**
 * READ-ONLY PROBE — dispositions for the four AFFORDANCE_AVAILABLE producers.
 *
 * For the REAL tasks the real decomposer is asked to decompose, this replays
 * production code end to end with no model:
 *
 *   decomposeTask()                        -> the four subgoals
 *   verifySubgoalCondition() (POST-FIX)    -> satisfied on each REAL fixture page
 *   SubgoalGraph + SubgoalSelector         -> does the plan still progress?
 *
 * Answers, per producer: can it be truthfully re-expressed with an existing
 * observation-backed condition, or is it blocked?
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';

import { decomposeTask } from '../extension/src/hierarchicalPlanning/taskDecomposer';
import { GoalProgressTracker } from '../extension/src/hierarchicalPlanning/goalProgressTracker';
import { SubgoalGraph } from '../extension/src/hierarchicalPlanning/subgoalGraph';
import { SubgoalSelector } from '../extension/src/hierarchicalPlanning/subgoalSelector';
import { discoverActionAffordances } from '../extension/src/semanticUnderstanding/actionAffordance';
import { classifyPageSemantics } from '../extension/src/semanticUnderstanding/pageClassifier';
import type { BrowserWorldModel } from '../extension/src/worldModel/types';
import type { AgentContextPayload } from '../extension/src/privacy/types';

const FIXTURE = join(process.cwd(), 'demo', 'shopping-fixture');
const PAGES = ['index.html', 'search.html', 'results.html', 'product.html'];

function wmFor(page: string): BrowserWorldModel {
  const html = readFileSync(join(FIXTURE, page), 'utf8');
  document.documentElement.innerHTML = html
    .replace(/<!DOCTYPE[^>]*>/i, '')
    .replace(/<head[\s\S]*?<\/head>/i, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');
  const nodes = document.querySelectorAll('input, button, a, select, textarea');
  const elements = Array.from(nodes).map((n, i) => {
    const tag = n.tagName.toLowerCase();
    return {
      id: `el_${i}`,
      type: (tag === 'input'
        ? (n as HTMLInputElement).type === 'search'
          ? 'search'
          : 'input'
        : tag === 'button'
          ? 'button'
          : tag === 'a'
            ? 'link'
            : tag === 'select'
              ? 'select'
              : 'other') as never,
      tag,
      label: (n.textContent || '').trim().slice(0, 80),
      selector: `#${n.id || `${tag}-${i}`}`,
      visible: true,
      enabled: true,
      boundingBox: { x: 0, y: 0, width: 100, height: 20 },
      attributes: {},
      privacyRisk: 'none',
    };
  });
  return {
    page: {
      url: `http://localhost:4174/${page === 'index.html' ? '' : page}`,
      title: document.title,
      pageGeneration: 1,
      viewport: { width: 1280, height: 720, scroll_x: 0, scroll_y: 0 },
    },
    elements,
    detections: [],
    scanLatencyMs: 0,
    totalElementsScanned: elements.length,
  } as never;
}

function ctxFor(page: string) {
  const wm = wmFor(page);
  const cls = classifyPageSemantics({ worldModel: wm, root: document, pageGeneration: 1 });
  const affs = discoverActionAffordances({ pageType: cls.pageType, worldModel: wm, root: document, pageGeneration: 1 });
  return {
    url: wm.page.url,
    semantic_context: {
      pageType: cls.pageType,
      confidence: cls.confidence,
      pageState: 'populated',
      pageGeneration: 1,
      entities: [],
      affordances: affs.map((a) => ({
        id: a.id,
        type: a.type,
        targetElementId: a.targetElementId,
        requiresConfirmation: a.requiresConfirmation,
        description: a.description,
      })),
    },
    detections: [],
  } as unknown as AgentContextPayload;
}

const TASKS: Array<{ label: string; prompt: string; url: string }> = [
  { label: 'ECOMMERCE (real task)', prompt: 'open the store catalog at http://localhost:4174 and open the first product listed', url: 'http://localhost:4174/' },
  { label: 'INFORMATION_RETRIEVAL', prompt: 'find information about quantum computing on the web', url: 'http://localhost:4174/' },
  { label: 'GENERIC_INTERACTION', prompt: 'do something with this page', url: 'http://localhost:4174/' },
];

describe('producer dispositions', () => {
  for (const t of TASKS) {
    it(t.label, () => {
      const graph = decomposeTask(t.prompt, { currentUrl: t.url, pageClassifier: classifyPageSemantics as never });
      const rows: Array<Record<string, unknown>> = [];
      for (const sg of graph.subgoals) {
        const perPage: Record<string, boolean> = {};
        for (const p of PAGES) {
          const v = GoalProgressTracker.verifySubgoalCondition(sg, { context: ctxFor(p), pageGeneration: 1 });
          perPage[p] = v.satisfied;
        }
        rows.push({
          id: sg.id,
          category: sg.category,
          action: sg.expectedActionType,
          cond: sg.verificationCondition?.type,
          expectedValue: sg.verificationCondition?.expectedValue ?? null,
          desc: sg.verificationCondition?.description,
          targetEntity: sg.targetEntity ?? null,
          prereqs: sg.prerequisites,
          satisfiedPerPage: perPage,
        });
      }
      console.log('DECOMP ' + t.label + ' ' + JSON.stringify(rows));

      // Does the plan still progress? Walk the real selector.
      const g = new SubgoalGraph(graph.goalId, graph.subgoals);
      const trace: string[] = [];
      for (let cycle = 0; cycle < 8; cycle += 1) {
        const page = PAGES[cycle % PAGES.length];
        const sel = SubgoalSelector.selectNextSubgoal({
          graph: g,
          worldModel: wmFor(page),
          affordances: ctxFor(page).semantic_context!.affordances as never,
        });
        trace.push(`${page}: ${sel.status}${sel.selectedSubgoal ? ' ' + sel.selectedSubgoal.category : ''}`);
        if (sel.status !== 'SELECTED' || !sel.selectedSubgoal) break;
        g.startSubgoal(sel.selectedSubgoal.id);
        const v = GoalProgressTracker.verifySubgoalCondition(sel.selectedSubgoal, { context: ctxFor(page), pageGeneration: 1 });
        if (v.satisfied) g.completeSubgoal(sel.selectedSubgoal.id);
      }
      console.log('SELECT ' + t.label + ' ' + JSON.stringify(trace));
    });
  }
});
