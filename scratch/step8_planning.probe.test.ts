/**
 * STEP 8 — production planning, executed over the REAL Step 8 Chrome capture.
 *
 * Runs the REAL production `decomposeTask` and the REAL production
 * `GoalProgressTracker.verifySubgoalCondition` against the observations in
 * `step8_real_chrome_results.json`, which came from the rebuilt production
 * extension driven by the real configured reasoner.
 *
 * This is the planning half of the evidence. The browser half is the production
 * `[AgentTrace]` line recorded in the capture, which shows the destination
 * subgoal being SELECTED and then correctly REFUSING to complete. Full
 * agent-directed arrival at the catalog did NOT happen and is reported as such.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';

import {
  classifyTaskCategory,
  decomposeTask,
} from '../extension/src/hierarchicalPlanning/taskDecomposer';
import { GoalProgressTracker } from '../extension/src/hierarchicalPlanning/goalProgressTracker';
import { normalizeDestination } from '../extension/src/planning/destinationNormalizer';
import { verifyDestination } from '../extension/src/planning/destinationVerifier';
import type { Subgoal } from '../extension/src/hierarchicalPlanning/hierarchicalTypes';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import type { SemanticPageType } from '../extension/src/semanticUnderstanding/semanticTypes';

const DIR = join(process.cwd(), 'docs', 'evidence', 'post-17-9', 'destination-verifier');
const captured = JSON.parse(readFileSync(join(DIR, 'step8_real_chrome_results.json'), 'utf8')) as {
  environment: Record<string, unknown>;
  runs: Array<{
    key: string;
    task: string;
    targetTab: Record<string, unknown>;
    observations: Array<Record<string, unknown> & { label: string; agentDirected: boolean }>;
    productionTrace: Record<string, string[]>;
    providerCalls: number;
  }>;
};

const log = (s: string) => console.log(s);

/** Build the tracker's context from REAL captured browser values only. */
const contextFrom = (o: Record<string, unknown>): AgentContextPayload =>
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

const decide = (subgoal: Subgoal, observation: Record<string, unknown>) =>
  GoalProgressTracker.verifySubgoalCondition(subgoal, {
    context: contextFrom(observation),
    pageGeneration: Number(observation.semanticPageGeneration),
  });

const report: Record<string, unknown> = {
  work:
    'POST-17.10 step 8 — production decomposer + production goal tracker over the real Step 8 Chrome capture',
  provenance: {
    observation: 'PROVEN_REAL — rebuilt production extension, real Chrome tab, real configured reasoner',
    decomposer: 'PROVEN_REAL — production module, executed on the real user task',
    tracker: 'PROVEN_REAL — production module, executed on the real captured observation',
    inBrowserE2E:
      'PARTIAL. The real agent selected the destination subgoal, executed a real action, and the production ' +
      'tracker correctly refused to complete it on the page it reached. It never reached the catalog, so no ' +
      'in-browser destination MATCH exists.',
  },
  environment: captured.environment,
  planning: {},
  decisions: [],
  controls: {},
};

describe('step 8 production planning over real Chrome observations', () => {
  it('plans and decides from the real capture', () => {
    const run = captured.runs[0]!;
    const plan = decomposeTask(run.task, { currentUrl: String(run.observations[0]?.url ?? '') });
    const nav = plan.subgoals.find((s) => s.category === 'NAVIGATE');
    if (!nav) throw new Error('no destination subgoal was planned');

    report.planning = {
      task: run.task,
      taskCategory: classifyTaskCategory(run.task),
      goalDeclaration: JSON.parse(JSON.stringify(plan.goal.destinationDeclaration)),
      normalizerAgreement:
        JSON.stringify(plan.goal.destinationDeclaration) === JSON.stringify(normalizeDestination(run.task)),
      subgoals: plan.subgoals.map((s) => ({
        id: s.id,
        category: s.category,
        conditionType: s.verificationCondition?.type ?? null,
        carriesDestination: s.destination !== undefined,
        state: s.state,
        prerequisites: s.prerequisites,
      })),
      destinationSubgoal: {
        id: nav.id,
        category: nav.category,
        conditionType: nav.verificationCondition!.type,
        state: nav.state,
        destination: JSON.parse(JSON.stringify(nav.destination)),
        targetEntity: nav.targetEntity ?? null,
        expectedValue: nav.verificationCondition!.expectedValue ?? null,
      },
      targetTabProvisionedBy: run.targetTab.provisionedBy,
      providerCalls: run.providerCalls,
      productionSubgoalTrace: run.productionTrace.subgoalLines,
    };
    log('category ' + (report.planning as Record<string, unknown>).taskCategory);
    log('subgoals ' + JSON.stringify((report.planning as Record<string, unknown>).subgoals));
    for (const l of run.productionTrace.subgoalLines) log('IN-BROWSER TRACE | ' + l.slice(0, 200));

    for (const o of run.observations) {
      const v = decide(nav, o);
      const record = {
        label: o.label,
        agentDirected: o.agentDirected,
        url: o.url,
        pageType: o.semanticPageType,
        confidence: o.semanticConfidence,
        pageGeneration: o.semanticPageGeneration,
        subgoalWouldComplete: v.satisfied,
        reason: v.reason,
      };
      log(`  ${o.label} -> satisfied=${v.satisfied}`);
      report.decisions.push(record);
    }

    // ── Safety controls on the REAL observations ───────────────────────────
    const catalog = run.observations.find((o) => o.label === 'fixture-catalog-results-html')!;
    const product = run.observations.find((o) => o.label === 'fixture-product-html')!;
    const landing = run.observations.find((o) => o.agentDirected)!;

    const verdict = (declaration: unknown, o: Record<string, unknown>, currentGen?: number) =>
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

    const wrongRole = {
      kind: 'DECLARED',
      role: { provenance: 'EXPLICIT_PAGE_ROLE', acceptablePageTypes: ['CHECKOUT'] },
    };

    report.controls = {
      wrongDestination: {
        description: 'declared CHECKOUT vs the REAL catalog observation',
        verdict: verdict(wrongRole, catalog),
      },
      unknownDestination: {
        description: 'declared LISTING vs the REAL agent-reached page',
        verdict: verdict(nav.destination, landing),
      },
      exactUrlMismatch: {
        description: 'declared destination URL "/" vs the REAL /results.html',
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
      staleObservation: {
        description: 'the REAL catalog observation (gen 11) verified at the REAL current generation (gen 13)',
        verdict: verdict(nav.destination, catalog, Number(product.semanticPageGeneration)),
      },
      productionDeclarationOnRealCatalog: {
        description: 'the production subgoal declaration vs the REAL catalog observation',
        verdict: verdict(nav.destination, catalog),
      },
      declarationImmutability: (() => {
        const before = JSON.stringify(nav.destination);
        decide(nav, catalog);
        return { unchanged: before === JSON.stringify(nav.destination) };
      })(),
      entryUrlIsNotADestinationConstraint: {
        description:
          'the declaration carries entryUrl "/"; the REAL catalog is "/results.html" and still matches on ROLE',
        declarationHasUrl: (nav.destination as { url?: unknown }).url !== undefined,
        declarationHasEntryUrl: (nav.destination as { entryUrl?: unknown }).entryUrl !== undefined,
      },
    };
    for (const [k, v] of Object.entries(report.controls as Record<string, { verdict?: { kind: string } }>)) {
      log(`CONTROL ${k} -> ${JSON.stringify(v.verdict?.kind ?? v)}`);
    }

    writeFileSync(join(DIR, 'step8_planning_results.json'), JSON.stringify(report, null, 2) + '\n');
    log('wrote step8_planning_results.json');
  });
});