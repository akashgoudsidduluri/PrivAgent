/**
 * STEP 7 — production planning decision, executed over the REAL Step 7 Chrome
 * capture.
 *
 * This file runs the REAL production `decomposeTask`, the REAL production
 * `GoalProgressTracker.verifySubgoalCondition` and the REAL production
 * `verifyDestination` against the observations captured in
 * `step7_real_chrome_results.json`, which came from the production extension in
 * a real Chrome tab driven by the real configured reasoner.
 *
 * WHAT THIS IS:  the production decision function over a real observation.
 * WHAT THIS IS NOT: an in-browser run. The service worker exposes no read-out
 *   for the planner's internal graph, and the real agent never navigated to the
 *   catalog under its own planning, so no destination subgoal completed inside
 *   the browser. The browser-side evidence is the production `[AgentTrace]`
 *   lines recorded in the capture, and they show the destination subgoal
 *   correctly REFUSING to complete. That distinction is recorded in the
 *   evidence file, not blurred.
 *
 * Nothing here injects a page type, overrides a verdict, or hand-builds an
 * observation. Every observation value comes from the capture file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';

import { decomposeTask, classifyTaskCategory } from '../extension/src/hierarchicalPlanning/taskDecomposer';
import { GoalProgressTracker } from '../extension/src/hierarchicalPlanning/goalProgressTracker';
import { verifyDestination } from '../extension/src/planning/destinationVerifier';
import { normalizeDestination } from '../extension/src/planning/destinationNormalizer';
import type { Subgoal } from '../extension/src/hierarchicalPlanning/hierarchicalTypes';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import type { SemanticPageType } from '../extension/src/semanticUnderstanding/semanticTypes';

const DIR = join(process.cwd(), 'docs', 'evidence', 'post-17-9', 'destination-verifier');
const captured = JSON.parse(readFileSync(join(DIR, 'step7_real_chrome_results.json'), 'utf8')) as {
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

const decide = (subgoal: Subgoal, observation: Record<string, unknown>) => {
  const ctx = contextFrom(observation);
  return GoalProgressTracker.verifySubgoalCondition(subgoal, {
    context: ctx,
    pageGeneration: Number(observation.semanticPageGeneration),
  });
};

const report: Record<string, unknown> = {
  work:
    'POST-17.10 step 7 — production decomposer + production goal tracker + production verifier, over the real Step 7 Chrome capture',
  provenance: {
    observation: 'PROVEN_REAL — captured from the rebuilt production extension in a real Chrome tab, real reasoner',
    decomposer: 'PROVEN_REAL — production module, executed on the real user task',
    tracker: 'PROVEN_REAL — production module, executed on the real captured observation',
    verifier: 'PROVEN_REAL — production module, reached through the tracker',
    inBrowserE2E:
      'PARTIAL. The real agent ran the real loop and the production tracker refused to complete the destination ' +
      'subgoal on the page it actually reached — that part is in-browser and recorded in the capture trace. But the ' +
      'service worker exposes no read-out for the planner graph, and the agent never reached the catalog under its ' +
      'own planning, so no destination subgoal completed inside the browser.',
  },
  environment: captured.environment,
  runs: [],
};

describe('step 7 production decision over real Chrome observations', () => {
  it('runs the production planning path over every captured run', () => {
    for (const run of captured.runs) {
      log(`===== RUN ${run.key} :: ${run.task} =====`);
      const plan = decomposeTask(run.task, { currentUrl: `${String(run.observations[0]?.url ?? '')}` });
      const nav = plan.subgoals.find((s) => s.category === 'NAVIGATE');
      const entry = {
        task: run.task,
        taskCategory: classifyTaskCategory(run.task),
        goalDeclaration: JSON.parse(JSON.stringify(plan.goal.destinationDeclaration)),
        subgoalsPlanned: plan.subgoals.map((s) => ({
          id: s.id,
          category: s.category,
          conditionType: s.verificationCondition?.type ?? null,
          carriesDestination: s.destination !== undefined,
        })),
        destinationSubgoal: nav ? { id: nav.id, conditionType: nav.verificationCondition?.type } : null,
        targetTabProvisionedByProduction: run.targetTab.provisionedBy,
        providerCalls: run.providerCalls,
        productionSubgoalTrace: run.productionTrace.subgoalLines,
      };
      log('category ' + entry.taskCategory);
      log('declaration ' + JSON.stringify(entry.goalDeclaration));
      log('destination subgoal ' + JSON.stringify(entry.destinationSubgoal));
      for (const l of entry.productionSubgoalTrace) log('  IN-BROWSER TRACE | ' + l.slice(0, 200));

      const decisions = run.observations.map((o) => {
        const record: Record<string, unknown> = {
          label: o.label,
          agentDirected: o.agentDirected,
          url: o.url,
          pageType: o.semanticPageType,
          confidence: o.semanticConfidence,
          pageGeneration: o.semanticPageGeneration,
        };
        if (nav) {
          const v = decide(nav, o);
          record.subgoalWouldComplete = v.satisfied;
          record.reason = v.reason;
          log(`  ${o.label} -> satisfied=${v.satisfied}`);
        } else {
          record.note = 'no destination subgoal is planned for this task category';
        }
        return record;
      });

      report.runs!.push({ key: run.key, ...entry, decisions });
    }

    // ── Safety controls over the REAL production observation ───────────────
    const ecom = (report.runs as Array<Record<string, unknown>>).find((r) => r.key === 'ecommerce')!;
    const plan = decomposeTask(ecom.task as string, { currentUrl: 'http://localhost:4174/' });
    const nav = plan.subgoals.find((s) => s.category === 'NAVIGATE')!;
    const realCatalog = captured.runs
      .flatMap((r) => r.observations)
      .find((o) => o.label === 'fixture-catalog-results-html')!;

    const control = (declaration: unknown, observation: Record<string, unknown>) =>
      verifyDestination({
        declaration: declaration as never,
        observation: {
          url: String(observation.url),
          pageGeneration: Number(observation.semanticPageGeneration),
          semantic: {
            pageType: String(observation.semanticPageType) as SemanticPageType,
            confidence: Number(observation.semanticConfidence),
            pageGeneration: Number(observation.semanticPageGeneration),
          },
        },
        currentPageGeneration: Number(observation.semanticPageGeneration),
      });

    const realLanding = captured.runs[0].observations[0];

    const controls = {
      wrongDestination: {
        description: 'Declared CHECKOUT, real observation LISTING @ 0.99',
        declaration: {
          kind: 'DECLARED',
          role: { provenance: 'EXPLICIT_PAGE_ROLE', acceptablePageTypes: ['CHECKOUT'] },
        },
        verdict: control(
          {
            kind: 'DECLARED',
            role: { provenance: 'EXPLICIT_PAGE_ROLE', acceptablePageTypes: ['CHECKOUT'] },
          },
          realCatalog
        ),
      },
      unknownDestination: {
        description: 'Declared LISTING, real observation UNKNOWN @ 0.10',
        declaration: normalizeDestination(
          'open the store catalog at http://localhost:4174 and open the first product listed'
        ),
        verdict: control(
          {
            kind: 'DECLARED',
            role: { provenance: 'EXPLICIT_PAGE_ROLE', acceptablePageTypes: ['LISTING'] },
          },
          realLanding
        ),
      },
      exactUrlMismatch: {
        description: 'Declared destination URL "/" (the entry site), real observation "/results.html"',
        verdict: control(
          {
            kind: 'DECLARED',
            url: { provenance: 'USER_URL', origin: 'http://localhost:4174', path: '/', rawUrl: 'http://localhost:4174/' },
          },
          realCatalog
        ),
      },
      exactUrlMatch: {
        description: 'Declared destination URL "/results.html", real observation "/results.html"',
        verdict: control(
          normalizeDestination('open http://localhost:4174/results.html'),
          realCatalog
        ),
      },
      staleObservation: {
        description: 'The REAL catalog observation (gen 11) checked against the REAL newer generation (gen 13)',
        verdict: verifyDestination({
          declaration: nav.destination!,
          observation: {
            url: String(realCatalog.url),
            pageGeneration: Number(realCatalog.semanticPageGeneration),
            semantic: {
              pageType: String(realCatalog.semanticPageType) as SemanticPageType,
              confidence: Number(realCatalog.semanticConfidence),
              pageGeneration: Number(realCatalog.semanticPageGeneration),
            },
          },
          currentPageGeneration: Number(
            captured.runs
              .flatMap((r) => r.observations)
              .find((o) => o.label === 'fixture-product-html')!.semanticPageGeneration
          ),
        }),
      },
      roleMatchOnRealCatalog: {
        description: 'The production subgoal declaration, on the REAL catalog observation',
        verdict: control(nav.destination!, realCatalog),
      },
      declarationImmutability: (() => {
        const before = JSON.stringify(nav.destination);
        decide(nav, realCatalog);
        return { before: JSON.parse(before), unchanged: before === JSON.stringify(nav.destination) };
      })(),
    };

    for (const [k, v] of Object.entries(controls)) {
      log(`CONTROL ${k} -> ${JSON.stringify((v as { verdict?: { kind: string } }).verdict?.kind ?? (v as Record<string, unknown>))}`);
    }
    report.controls = controls;

    writeFileSync(join(DIR, 'step7_production_decision.json'), JSON.stringify(report, null, 2) + '\n');
    log('wrote step7_production_decision.json');
  });
});