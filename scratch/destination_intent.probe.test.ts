/**
 * READ-ONLY destination-intent probe.
 *
 * For the real task, what EXACT structured information still represents
 * "store catalog" after each stage?
 *
 *   prompt -> goalParser -> HighLevelGoal -> taskDecomposer -> Subgoal
 *   Subgoal -> subgoalSelector -> world model -> tracker -> goalVerifier
 *
 * Read-only: no production file is imported for mutation, nothing is written.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';

import { parseUserGoal } from '../extension/src/agent/goalParser';
import { decomposeTask } from '../extension/src/hierarchicalPlanning/taskDecomposer';
import { classifyPageSemantics } from '../extension/src/semanticUnderstanding/pageClassifier';
import { discoverActionAffordances } from '../extension/src/semanticUnderstanding/actionAffordance';
import { observeWorkflowState } from '../extension/src/semanticUnderstanding/workflowState';
import { SubgoalSelector } from '../extension/src/hierarchicalPlanning/subgoalSelector';
import { SubgoalGraph } from '../extension/src/hierarchicalPlanning/subgoalGraph';
import type { BrowserWorldModel } from '../extension/src/worldModel/types';

const TASK =
  process.env.ST_TASK ??
  'open the store catalog at http://localhost:4174/results.html and open the first product listed';
const FIXTURE = join(process.cwd(), 'demo', 'shopping-fixture');
const PAGES = ['index.html', 'search.html', 'results.html', 'product.html'];

function worldModelFor(page: string): BrowserWorldModel {
  const html = readFileSync(join(FIXTURE, page), 'utf8');
  document.documentElement.innerHTML = html
    .replace(/<!DOCTYPE[^>]*>/i, '')
    .replace(/<head[\s\S]*?<\/head>/i, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');
  const nodes = document.querySelectorAll('input, button, a, select, textarea, .product-card, [data-product]');
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

describe('destination-intent survival', () => {
  it('stage by stage', () => {
    // ── STAGE 1: goalParser ────────────────────────────────────────────────
    const parsed = parseUserGoal(TASK);
    console.log('STAGE1 goalParser ' + JSON.stringify({
      normalizedGoal: parsed.normalizedGoal,
      targetEntities: parsed.targetEntities,
      constraints: parsed.constraints,
      confidence: parsed.confidence,
      // Does the phrase "catalog" survive anywhere?
      catalogSurvives: JSON.stringify(parsed).toLowerCase().includes('catalog'),
    }));

    // ── STAGE 2: HighLevelGoal ─────────────────────────────────────────────
    const g = decomposeTask(TASK, { currentUrl: 'http://localhost:4174/' });
    console.log('STAGE2 HighLevelGoal ' + JSON.stringify({
      taskCategory: g.goal.taskCategory,
      rawUserPromptKept: g.goal.rawUserPrompt === TASK,
      sanitizedGoalDescription: g.goal.sanitizedGoalDescription,
      targetEntities: g.goal.targetEntities,
      constraints: g.goal.constraints,
      catalogSurvives: JSON.stringify(g.goal).toLowerCase().includes('catalog'),
    }));

    // ── STAGE 3: Subgoal ───────────────────────────────────────────────────
    console.log('STAGE3 subgoals ' + JSON.stringify(g.subgoals.map((s) => ({
      id: s.id.slice(-6),
      cat: s.category,
      desc: s.description.slice(0, 70),
      expectedActionType: s.expectedActionType,
      targetEntity: s.targetEntity ?? null,
      cond: s.verificationCondition?.type,
      expectedValue: s.verificationCondition?.expectedValue ?? null,
      condDesc: s.verificationCondition?.description,
    }))));

    // ── STAGE 4/5: observed page identity per fixture page ────────────────
    for (const p of PAGES) {
      const wm = worldModelFor(p);
      const cls = classifyPageSemantics({ worldModel: wm, root: document, pageGeneration: 1 });
      const affs = discoverActionAffordances({
        pageType: cls.pageType,
        worldModel: wm,
        root: document,
        pageGeneration: 1,
      });
      const wf = observeWorkflowState({
        pageType: cls.pageType,
        pageState: 'populated',
        worldModel: wm,
        root: document,
        pageGeneration: 1,
      });
      console.log(
        'STAGE4 observed ' +
          JSON.stringify({
            page: p,
            url: wm.page.url,
            title: document.title,
            semanticPageType: cls.pageType,
            confidence: cls.confidence,
            secondary: cls.secondaryCandidates,
            evidence: cls.evidence,
            worldModelPageType: 'see classifyPage() — separate URL-keyword source',
            workflow: wf,
            affordanceTypes: affs.map((a) => a.type),
          })
      );
    }

    // ── STAGE 6: selector sees what? ──────────────────────────────────────
    const graph = new SubgoalGraph(g.goal.goalId, g.subgoals);
    const sel = SubgoalSelector.selectNextSubgoal({
      graph,
      worldModel: worldModelFor('results.html'),
      affordances: [],
    });
    console.log('STAGE6 selector ' + JSON.stringify({ status: sel.status, reason: sel.reason.slice(0, 120) }));

    // ── STAGE 7: does the tracker observation carry page identity? ─────────
    const probe = classifyPageSemantics({
      worldModel: worldModelFor('results.html'),
      root: document,
      pageGeneration: 1,
    });
    const ctxShape = {
      url: 'x',
      semantic_context: {
        pageType: probe.pageType,
        confidence: probe.confidence,
        pageState: 'populated',
        pageGeneration: 1,
        entities: [],
        affordances: [],
        workflow: { flowType: 'SHOPPING', currentStage: 'LISTING_VIEWED' },
      },
    };
    console.log('STAGE7 trackerObservation ' + JSON.stringify({
      hasSemanticPageType: 'semantic_context.pageType' in ctxShape.semantic_context,
      hasConfidence: 'confidence' in ctxShape.semantic_context,
      hasPageState: 'pageState' in ctxShape.semantic_context,
      hasPageGeneration: 'pageGeneration' in ctxShape.semantic_context,
      hasWorkflow: 'workflow' in ctxShape.semantic_context,
      trackerReadsPageTypeToday: false,
      trackerReadsWorkflowToday: false,
      trackerReadsPageGenerationToday: false,
    }));
  });
});
