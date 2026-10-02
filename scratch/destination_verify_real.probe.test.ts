/**
 * STEP 5 — execute the REAL production normalizer and the REAL production
 * destination verifier against the observation captured from real Chrome.
 *
 * The observation in `real_observation.json` is genuine browser output from the
 * shipped extension: current URL, world-model generation, and the sanitized
 * semantic page type / confidence / page generation produced by the production
 * classifier in a real tab. Nothing here constructs a `LISTING` observation.
 *
 * The verifier is not wired into the bundle (producers are deliberately
 * unwired), so it cannot be invoked from inside the browser. It is executed
 * here — the real module, verbatim — against the real captured observation.
 * That is stated in the evidence, not hidden.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';

import { normalizeDestination } from '../extension/src/planning/destinationNormalizer';
import { verifyDestination } from '../extension/src/planning/destinationVerifier';
import type { DestinationObservation } from '../extension/src/planning/destinationVerifier';
import type { SemanticPageType } from '../extension/src/semanticUnderstanding/semanticTypes';

const DIR = join(process.cwd(), 'docs', 'evidence', 'post-17-9', 'destination-verifier');
const captured = JSON.parse(readFileSync(join(DIR, 'real_observation.json'), 'utf8')) as {
  inputs: { task: string };
  observations: Array<Record<string, unknown> & { label: string }>;
};

const find = (label: string) => {
  const o = captured.observations.find((x) => x.label === label);
  if (!o) throw new Error(`missing observation: ${label}`);
  return o;
};

/** Build the verifier's narrow observation from REAL captured browser values only. */
const toObservation = (raw: Record<string, unknown>): DestinationObservation => ({
  url: String(raw.url ?? ''),
  pageGeneration: Number(raw.semanticPageGeneration ?? raw.worldModelPageGeneration),
  semantic: {
    pageType: String(raw.semanticPageType) as SemanticPageType,
    confidence: Number(raw.semanticConfidence),
    pageGeneration: Number(raw.semanticPageGeneration),
  },
});

const report: Record<string, unknown> = {
  work: 'POST-17.10 step 5 — real normalizer + real verifier against real Chrome observation',
  provenance: {
    observation: 'PROVEN_REAL — captured from the shipped extension in a real Chrome tab',
    normalizer: 'PROVEN_REAL — production module, executed on the real user task',
    verifier: 'PROVEN_REAL — production module, executed on the real observation',
    caveat:
      'The verifier is not wired into the bundle (producers intentionally unwired), so it is executed in Node ' +
      'against the captured observation rather than inside the browser process. The observation is real; the ' +
      'call site is not yet production.',
  },
  results: {},
};

describe('real Chrome destination verification', () => {
  it('runs the real modules over the real observation', () => {
    const task = captured.inputs.task;
    const declaration = normalizeDestination(task);
    report.declaration = JSON.parse(JSON.stringify(declaration));
    log('DECLARATION ' + JSON.stringify(declaration));

    // ── Obs 1: the page the agent actually reached ──────────────────────────
    const obs1 = find('agent-reached-page');
    const o1 = toObservation(obs1);
    const v1 = verifyDestination({ declaration, observation: o1, currentPageGeneration: o1.pageGeneration });
    log('OBS1 ' + JSON.stringify({ url: o1.url, gen: o1.pageGeneration, pageType: o1.semantic?.pageType, verdict: v1.kind, reason: v1.reason }));
    report.results.agentReachedPage = { observation: obs1, verdict: v1 };

    // ── Obs 2: the catalog, reached by a real browser navigation ───────────
    const obs2 = find('catalog-results-html');
    const o2 = toObservation(obs2);
    const v2 = verifyDestination({ declaration, observation: o2, currentPageGeneration: o2.pageGeneration });
    log('OBS2 ' + JSON.stringify({ url: o2.url, gen: o2.pageGeneration, pageType: o2.semantic?.pageType, verdict: v2.kind, reason: v2.reason }));
    report.results.catalogPage = {
      observation: obs2,
      verdict: v2,
      channels: {
        pageRole: v2.channels.pageRole,
        url: v2.channels.url,
      },
    };

    // Channel isolation: the same real observation against the page role alone.
    const roleOnly = { kind: 'DECLARED' as const, role: declaration.kind === 'DECLARED' ? declaration.role : undefined };
    const v2role = verifyDestination({ declaration: roleOnly, observation: o2, currentPageGeneration: o2.pageGeneration });
    log('OBS2-ROLE-ONLY ' + JSON.stringify({ verdict: v2role.kind, reason: v2role.reason }));
    report.results.catalogPage_roleOnly = { verdict: v2role };

    // ── Negative control: real LISTING observation vs DECLARED[CHECKOUT] ───
    const negative = {
      kind: 'DECLARED' as const,
      role: { provenance: 'EXPLICIT_PAGE_ROLE' as const, acceptablePageTypes: ['CHECKOUT'] as SemanticPageType[] },
    };
    const vNeg = verifyDestination({ declaration: negative, observation: o2, currentPageGeneration: o2.pageGeneration });
    log('NEG-CONTROL ' + JSON.stringify({ verdict: vNeg.kind, reason: vNeg.reason }));
    report.results.negativeControl_checkoutVsRealListing = { verdict: vNeg };

    // Negative control 2: the real UNKNOWN landing page vs the same role claim.
    const vNegUnknown = verifyDestination({ declaration: roleOnly, observation: o1, currentPageGeneration: o1.pageGeneration });
    log('NEG-CONTROL-UNKNOWN ' + JSON.stringify({ verdict: vNegUnknown.kind, reason: vNegUnknown.reason }));
    report.results.negativeControl_realUnknownLanding = { verdict: vNegUnknown };

    // ── Staleness control: the REAL older observation, after a real newer page ─
    const obs3 = find('product-html');
    const o3 = toObservation(obs3);
    const vStale = verifyDestination({
      declaration: roleOnly,
      observation: o2, // the genuinely older LISTING observation
      currentPageGeneration: o3.pageGeneration, // but verification now runs at the newer generation
    });
    log('STALENESS ' + JSON.stringify({ staleGen: o2.pageGeneration, currentGen: o3.pageGeneration, verdict: vStale.kind, reason: vStale.reason }));
    report.results.staleness = {
      staleObservation: obs2,
      currentObservation: obs3,
      verdict: vStale,
    };

    // ── Scope checks on the real call boundary ─────────────────────────────
    const forbidden = ['action', 'executionSuccess', 'previousActions', 'navigationDestination', 'detections', 'entities', 'text'];
    report.boundary = {
      observationKeys: Object.keys(o2).sort(),
      semanticKeys: Object.keys(o2.semantic ?? {}).sort(),
      carriesForbiddenField: forbidden.filter(
        (f) => f in (o2 as Record<string, unknown>) || f in ((o2.semantic ?? {}) as Record<string, unknown>)
      ),
      declarationKeys: Object.keys(declaration as Record<string, unknown>).sort(),
      roleIsMetadataOnly:
        declaration.kind === 'DECLARED' && declaration.role
          ? declaration.role.acceptablePageTypes.every((t: string) => /^[A-Z_]+$/.test(t))
          : null,
      verdictReasonLengths: {
        catalog: v2.reason.length,
        negative: vNeg.reason.length,
        staleness: vStale.reason.length,
      },
      verdictCarriesPageText: [v2.reason, vNeg.reason, vStale.reason].some((r) => /product card|baggy|widget/i.test(r)),
    };
    log('BOUNDARY ' + JSON.stringify(report.boundary));

    writeFileSync(join(DIR, 'real_verification_results.json'), JSON.stringify(report, null, 2) + '\n');
  });
});

function log(s: string) {
  console.log(s);
}
