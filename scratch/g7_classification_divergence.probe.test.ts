/**
 * G7 — SEMANTIC CLASSIFICATION DIVERGENCE AUDIT (READ-ONLY PROBE).
 *
 * Audit only. This file adds NO production behaviour and changes NO production
 * file. It executes the real, unmodified production modules against the real,
 * unmodified fixture page to answer:
 *
 *   Q3  Are the independent scan and the AgentLoop using the SAME classifier?
 *   Q4  Are they using the SAME DOM / page?
 *   Q5  Are they using the SAME URL?
 *   Q11 Are the classifier INPUTS different?
 *
 * and to test the downstream hypothesis that the destination subgoal is never
 * re-evaluated after the loop has already selected it once.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { classifyPageSemantics } from '../extension/src/semanticUnderstanding/pageClassifier';
import { buildSemanticUnderstanding } from '../extension/src/semanticUnderstanding';
import { SubgoalGraph } from '../extension/src/hierarchicalPlanning/subgoalGraph';
import { SubgoalSelector } from '../extension/src/hierarchicalPlanning/subgoalSelector';
import type { Subgoal } from '../extension/src/hierarchicalPlanning/hierarchicalTypes';
import type { BrowserWorldModel } from '../extension/src/worldModel/types';

const FIXTURE = join(process.cwd(), 'demo', 'shopping-fixture', 'results.html');
const DEST_URL = 'http://localhost:4174/results.html?q=all';

/** A world model that mirrors ONLY what the production SW fallback can see. */
function swFallbackWorldModel(): BrowserWorldModel {
  return {
    id: 'wm-probe',
    page: {
      url: DEST_URL,
      title: 'ApexCart — Search Results',
      pageType: 'results',
      pageGeneration: 9,
      viewport: { width: 1280, height: 757, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
    },
    elements: [],
    entities: [],
    textRegions: [],
    ocrRegions: [],
    visualRegions: [],
    privacyFindings: [],
  } as unknown as BrowserWorldModel;
}

/** Minimal world model that exposes ONLY the real destination URL. */
const urlOnlyWorldModel = {
  page: { url: DEST_URL, title: 'ApexCart — Search Results' },
  elements: [],
  entities: [],
  textRegions: [],
} as unknown as BrowserWorldModel;

describe('G7 divergence audit — classifier identity', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.innerHTML = readFileSync(FIXTURE, 'utf8');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.innerHTML = '';
  });

  it('Q1/Q3/Q4/Q5/Q11: the SAME classifier on the SAME fixture DOM yields LISTING @ 0.99', () => {
    const withRoot = classifyPageSemantics({
      root: document,
      worldModel: urlOnlyWorldModel,
      pageGeneration: 9,
    });

    console.log('[PROBE] root=document ->', JSON.stringify({
      pageType: withRoot.pageType,
      confidence: withRoot.confidence,
      pageGeneration: withRoot.pageGeneration,
      evidenceCount: withRoot.evidence.length,
    }));

    expect(withRoot.pageType).toBe('LISTING');
    expect(withRoot.confidence).toBe(0.99);
  });

  it('Q11: WITHOUT a live DOM root the SAME classifier cannot see product cards', () => {
    // This is exactly the shape the MV3 service worker has: no `document`
    // global at all, so `targetDoc` resolves to null inside the classifier.
    vi.stubGlobal('document', undefined);
    const wm = swFallbackWorldModel();
    const noRoot = classifyPageSemantics({ worldModel: wm, pageGeneration: 9 });

    console.log('[PROBE] root=undefined (service-worker fallback) ->', JSON.stringify({
      pageType: noRoot.pageType,
      confidence: noRoot.confidence,
      pageGeneration: noRoot.pageGeneration,
      evidence: noRoot.evidence,
    }));

    // The worldModel-only path has no DOM, so no LISTING/SEARCH/DASHBOARD
    // signal can be produced at all.
    expect(noRoot.pageType).toBe('UNKNOWN');
    expect(noRoot.confidence).toBe(0.1);
  });

  it('Q3/Q12: the content-script build and the SW fallback build are the same function, different inputs', () => {
    const contentScriptStyle = buildSemanticUnderstanding({
      root: document,
      worldModel: urlOnlyWorldModel,
      pageGeneration: 9,
    });

    vi.stubGlobal('document', undefined);
    const serviceWorkerStyle = buildSemanticUnderstanding({
      worldModel: swFallbackWorldModel(),
      pageGeneration: 9,
      userGoal: 'open the store catalog',
    });

    console.log('[PROBE] buildSemanticUnderstanding contentScript ->', JSON.stringify({
      pageType: contentScriptStyle.sanitizedContext.pageType,
      confidence: contentScriptStyle.sanitizedContext.confidence,
      generation: contentScriptStyle.sanitizedContext.pageGeneration,
    }));
    console.log('[PROBE] buildSemanticUnderstanding serviceWorker ->', JSON.stringify({
      pageType: serviceWorkerStyle.sanitizedContext.pageType,
      confidence: serviceWorkerStyle.sanitizedContext.confidence,
      generation: serviceWorkerStyle.sanitizedContext.pageGeneration,
    }));

    expect(contentScriptStyle.sanitizedContext.pageType).toBe('LISTING');
    expect(serviceWorkerStyle.sanitizedContext.pageType).toBe('UNKNOWN');
    expect(serviceWorkerStyle.sanitizedContext.confidence).toBe(0.1);
  });
});

describe('G7 divergence audit — is the destination subgoal ever re-evaluated?', () => {
  function makeGraph(): SubgoalGraph {
    const graph = new SubgoalGraph('goal-probe');
    const nav: Subgoal = {
      id: 'sg1',
      goalId: 'goal-probe',
      index: 0,
      description: 'Reach the destination declared in the user request',
      category: 'NAVIGATE',
      state: 'READY',
      prerequisites: [],
      maxRetries: 2,
      retryCount: 0,
    } as unknown as Subgoal;
    graph.addSubgoal(nav);
    return graph;
  }

  it('Q7/Q10: once selected once, the destination subgoal is no longer selectable', () => {
    const graph = makeGraph();

    // Step 0 — the entry page. Selection happens and startSubgoal marks it IN_PROGRESS.
    const first = SubgoalSelector.selectNextSubgoal({ graph, affordances: [] });
    expect(first.status).toBe('SELECTED');
    expect(first.selectedSubgoal?.id).toBe('sg1');
    expect(graph.startSubgoal('sg1')).toBe(true);
    expect(graph.toData().subgoals['sg1']!.state).toBe('IN_PROGRESS');

    // Steps 1..N — the agent has navigated to the LISTING destination.
    const later = SubgoalSelector.selectNextSubgoal({ graph, affordances: [] });
    console.log('[PROBE] selectNextSubgoal after startSubgoal ->', JSON.stringify({
      status: later.status,
      reason: later.reason,
      selectedSubgoalId: later.selectedSubgoal?.id ?? null,
    }));

    expect(later.selectedSubgoal).toBeUndefined();
    expect(later.status).not.toBe('SELECTED');
    // Re-starting is refused too — it is not READY/PENDING any more.
    expect(graph.startSubgoal('sg1')).toBe(false);
  });
});