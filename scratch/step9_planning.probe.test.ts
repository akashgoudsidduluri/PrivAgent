/**
 * STEP 9 — production planning decision + failure controls, over the REAL Chrome
 * capture.
 *
 * Runs the REAL production `decomposeTask`, `GoalProgressTracker` and
 * `verifyDestination` against observations captured from the rebuilt production
 * extension in a real Chrome tab.
 *
 * Phase 7 controls are computed on REAL captured observations. Controls whose
 * "observed" page was produced by a HARNESS navigation are labelled
 * `agentDirected: false` in the source capture and are classified
 * CONTROLLED_FIXTURE_PROVEN, never as agent-directed success.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';

import {
  classifyTaskCategory,
  decomposeTask,
} from '../extension/src/hierarchicalPlanning/taskDecomposer';
import { OneActionPlanner } from '../extension/src/hierarchicalPlanning/oneActionPlanner';
import { GoalProgressTracker } from '../extension/src/hierarchicalPlanning/goalProgressTracker';
import { verifyDestination } from '../extension/src/planning/destinationVerifier';
import type { Subgoal } from '../extension/src/hierarchicalPlanning/hierarchicalTypes';
import type { AgentContextPayload } from '../privacy/types';
import type { SemanticPageType } from '../semanticUnderstanding/semanticTypes';

const DIR = join(process.cwd(), 'docs', 'evidence', 'post-17-9', 'destination-verifier');
const explicit = JSON.parse(readFileSync(join(DIR, 'step9_real_chrome_results.json'), 'utf8')) as {
  environment: Record<string, unknown>;
  runs: Array<{
    task: string;
    targetTab: Record<string, unknown>;
    observations: Array<Record<string, unknown> & { label: string; agentDirected: boolean }>;
    productionTrace: Record<string, string[]>;
    providerCalls: number;
  }>;
};
const canonical = JSON.parse(readFileSync(join(DIR, 'step9_real_chrome_canonical.json'), 'utf8')) as typeof explicit;

const log = (s: string) => console.log(s);
type Obs = Record<string, unknown> & { label: string; agentDirected: boolean };

const contextFrom = (o: Obs): AgentContextPayload =>
  ({
    url: String(o.url ?? ''),
    timestamp: Date.now(),
    viewport: { width: 1280, height: 900, scroll_x: 0, scroll_y: 0 },
    viewportObservable: true,
    screenshot_dimensions: null,
    detections: [],
    total_elements_scanned: Number(o.totalElementsScanned ?? 0),
    sensitive_elements_detected: Number(o.sensitiveDetected ?? 0),
    sanitized_status: 'sanitized_only',
    ocr_metrics: null,
    semantic_context: {
      pageType: String(o.semanticPageType) as SemanticPageType,
      confidence: Number(o.semanticConfidence),
      pageState: String(o.semanticPageState ?? 'unknown'),
      pageGeneration: Number(o.semanticPageGeneration),
      entities: [],
      affordances: ((o.affordanceTypes ?? []) as string[]).map((t, i) => ({
        id: `af_${i}`,
        type: t as never,
        targetElementId: `el_${i}`,
        requiresConfirmation: false,
        description: `${t} affordance`,
      })),
    },
  }) as AgentContextPayload;

const decide = (subgoal: Subgoal, o: Obs) =>
  GoalProgressTracker.verifySubgoalCondition(subgoal, {
    context: contextFrom(o),
    pageGeneration: Number(o.semanticPageGeneration),
  });

const verdict = (declaration: unknown, o: Obs, currentGen?: number) =>
  verifyDestination({
    declaration: declaration as never,
    observation: {
      url: String(o.url),
      pageGeneration: Number(o.semanticPageGeneration),
      semantic: {
        pageType: String(o.semanticPageType) as SemanticPageType,
        confidence: Number(o.semanticConfidence),
        pageGeneration: Number(o.semanticPageGeneration),
      },
    },
    currentPageGeneration: currentGen ?? Number(o.semanticPageGeneration),
  });

const report: Record<string, unknown> = {
  work:
    'POST-17.10 step 9 — production planning decision and Phase 7 failure controls over the real Chrome capture',
  provenance: {
    observation: 'PROVEN_REAL — rebuilt production extension, real Chrome tab, real configured reasoner',
    navigator: 'PROVEN_REAL — production OneActionPlanner.proposeDestinationNavigation',
    inBrowserE2E:
      'PARTIAL. The deterministic navigator fired in a real browser with ZERO provider calls and the real ' +
      'observation of the agent-directed run is the declared destination at LISTING @ 0.99. However Effect ' +
      'Verification reported ACTION_NO_EFFECT (the tab was already at that URL, provisioned there by the target ' +
      'resolver), the run went to recovery and terminated, so the destination subgoal completion line and an ' +
      'in-browser verifier verdict were never reached.',
  },
  environment: explicit.environment,
  runs: [],
  phase7Controls: {},
};

describe('step 9 production decision and failure controls', () => {
  it('runs the production planning path over both real captures', () => {
    for (const [name, cap] of [
      ['explicit-destination-url', explicit],
      ['canonical-role-only', canonical],
    ] as const) {
      const run = cap.runs[0]!;
      const plan = decomposeTask(run.task, { currentUrl: '' });
      const nav = plan.subgoals.find((s) => s.destination !== undefined);
      const proposal = nav ? OneActionPlanner.proposeDestinationNavigation(nav) : null;
      const trace = run.productionTrace.traceSample;
      const entry = {
        name,
        task: run.task,
        taskCategory: classifyTaskCategory(run.task),
        goalDeclaration: JSON.parse(JSON.stringify(plan.goal.destinationDeclaration)),
        destinationSubgoal: nav
          ? { id: nav.id, conditionType: nav.verificationCondition!.type, state: nav.state }
          : null,
        deterministicProposal: proposal
          ? { action: proposal.action, url: (proposal as { url?: string }).url }
          : null,
        providerWasConsulted: trace.some((l) => l.includes('requesting reasoning')),
        deterministicNavigationFired: trace.some((l) =>
          l.includes('destination navigation proposed deterministically')
        ),
        subgoalCompleted: trace.some((l) => l.includes('subgoal completed')),
        subgoalNotCompleted: trace.some((l) => l.includes('subgoal NOT completed')),
        actionNoEffect: trace.some((l) => l.includes('ACTION_NO_EFFECT')),
        targetTabProvisionedBy: run.targetTab.provisionedBy,
        targetTabUrl: run.targetTab.url,
        providerCalls: run.providerCalls,
        decisions: run.observations.map((o) => ({
          label: o.label,
          agentDirected: o.agentDirected,
          url: o.url,
          pageType: o.semanticPageType,
          confidence: o.semanticConfidence,
          pageGeneration: o.semanticPageGeneration,
          subgoalWouldComplete: nav ? decide(nav, o).satisfied : null,
          reason: nav ? decide(nav, o).reason : 'no destination subgoal is planned',
        })),
      };
      log(`=== ${name} :: ${run.task}`);
      log(`    category=${entry.taskCategory} proposal=${JSON.stringify(entry.deterministicProposal)}`);
      log(`    providerConsulted=${entry.providerWasConsulted} deterministicNav=${entry.deterministicNavigationFired}`);
      for (const d of entry.decisions) log(`    ${d.label} -> satisfied=${d.subgoalWouldComplete}`);
      report.runs!.push(entry);
    }

    // ── PHASE 7 FAILURE CONTROLS, on REAL captured observations ────────────
    const ex = explicit.runs[0]!;
    const nav = decomposeTask(ex.task, { currentUrl: '' }).subgoals.find(
      (s) => s.destination !== undefined
    )!;
    const catalog = ex.observations.find((o) => o.semanticPageType === 'LISTING')!;
    const product = ex.observations.find((o) => o.label === 'fixture-product-html')!;
    const searchPage = canonical.runs[0]!.observations.find((o) => o.label === 'agent-end-of-run')!;
    const canonicalNav = decomposeTask(canonical.runs[0]!.task, { currentUrl: '' }).subgoals.find(
      (s) => s.destination !== undefined
    )!;

    report.phase7Controls = {
      c1_agentReachedSearchPage: {
        description:
          'declared destination URL /results.html, real agent-reached landing page (UNKNOWN @ 0.10) — URL mismatch',
        observationLabel: searchPage.label,
        agentDirected: searchPage.agentDirected,
        verdict: verdict(nav.destination, searchPage),
      },
      c1b_roleOnlyAgentReachedUnknown: {
        description:
          'declared ROLE LISTING (canonical prompt), real agent-reached UNKNOWN @ 0.10 page — must be UNKNOWN, not MATCH',
        observationLabel: searchPage.label,
        agentDirected: searchPage.agentDirected,
        subgoalWouldComplete: decide(canonicalNav, searchPage).satisfied,
        verdict: verdict(canonicalNav.destination, searchPage),
      },
      c2_agentReachedUnknownPage: {
        description: 'declared destination URL, real agent-reached UNKNOWN page',
        observationLabel: searchPage.label,
        agentDirected: searchPage.agentDirected,
        subgoalWouldComplete: decide(nav, searchPage).satisfied,
      },
      c3_agentReachedWrongPageType: {
        description: 'declared LISTING, real product page (UNKNOWN @ 0.10)',
        agentDirected: product.agentDirected,
        subgoalWouldComplete: decide(nav, product).satisfied,
      },
      c4_correctTypeStaleObservation: {
        description: 'real LISTING observation verified at a newer generation',
        verdict: verdict(nav.destination, catalog, Number(product.semanticPageGeneration)),
        verdictAtOwnGeneration: verdict(nav.destination, catalog).kind,
      },
      c5_correctUrlStaleGeneration: {
        description: 'declared destination URL, real catalog at generation 5 vs current 7',
        verdict: verdict(nav.destination, catalog, Number(product.semanticPageGeneration)),
        verdictAtOwnGeneration: verdict(nav.destination, catalog).kind,
      },
      c6_explicitWrongDestinationUrl: {
        description: 'declared destination URL "/", real observed "/results.html"',
        verdict: verdict(
          {
            kind: 'DECLARED',
            url: {
              provenance: 'USER_URL',
              origin: 'http://localhost:4174',
              path: '/',
              rawUrl: 'http://localhost:4174/',
            },
          },
          catalog
        ),
      },
      c7_correctDestinationFresh: {
        description: 'declared destination URL, real catalog at its own generation',
        agentDirected: catalog.agentDirected,
        verdict: verdict(nav.destination, catalog),
        subgoalWouldComplete: decide(nav, catalog).satisfied,
      },
    };
    for (const [k, v] of Object.entries(report.phase7Controls as Record<string, { verdict?: { kind: string }; subgoalWouldComplete?: boolean }>)) {
      log(`CONTROL ${k} -> ${JSON.stringify(v.verdict?.kind ?? { wouldComplete: v.subgoalWouldComplete })}`);
    }

    writeFileSync(join(DIR, 'step9_planning_results.json'), JSON.stringify(report, null, 2) + '\n');
    log('wrote step9_planning_results.json');
  });
});