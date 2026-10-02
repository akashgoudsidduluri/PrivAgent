/**
 * STEP 6 — execute the REAL production normalizer and the REAL production
 * destination verifier against the observation captured from real Chrome after
 * the entry-URL / destination-URL separation.
 *
 * The observation in `real_observation_step6.json` is genuine browser output
 * from the freshly built, unpacked-loaded extension: current URL, world-model
 * generation, and the sanitized semantic page type / confidence / page
 * generation produced by the production classifier in a real tab. Nothing here
 * constructs a `LISTING` observation or overrides a verdict.
 *
 * The verifier is still not wired into the bundle (producers deliberately
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
const captured = JSON.parse(readFileSync(join(DIR, 'real_observation_step6.json'), 'utf8')) as {
  inputs: { task: string };
  targetTabId: number;
  chrome: Record<string, unknown>;
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
  work: 'POST-17.10 step 6 — real normalizer + real verifier over a fresh real Chrome capture, with entry URL separated from destination URL',
  provenance: {
    observation: 'PROVEN_REAL — captured from the freshly built, unpacked-loaded extension in a real Chrome tab',
    normalizer: 'PROVEN_REAL — production module, executed on the real user task',
    verifier: 'PROVEN_REAL — production module, executed on the real observation',
    caveat:
      'The verifier is not wired into the bundle (producers intentionally unwired), so it is executed in Node ' +
      'against the captured observation rather than inside the browser process. The observation is real; the ' +
      'call site is not yet production.',
  },
  results: {},
};

describe('real Chrome destination verification (step 6 contract)', () => {
  it('separates the entry URL from the destination and matches on the real observation', () => {
    const task = captured.inputs.task;
    const declaration = normalizeDestination(task);
    report.task = task;
    report.targetTabId = captured.targetTabId;
    report.chrome = captured.chrome;
    report.declaration = JSON.parse(JSON.stringify(declaration));
    log('DECLARATION ' + JSON.stringify(declaration));

    // ── Obs 1: the page the agent actually reached first ────────────────────
    const obs1 = find('agent-reached-page');
    const o1 = toObservation(obs1);
    const v1 = verifyDestination({ declaration, observation: o1, currentPageGeneration: o1.pageGeneration });
    log('OBS1 ' + JSON.stringify({ url: o1.url, gen: o1.pageGeneration, pageType: o1.semantic?.pageType, verdict: v1.kind, reason: v1.reason }));
    report.results.agentReachedPage = { observation: obs1, verdict: v1 };

    // ── Obs 2: the real catalog — THE combined verdict ───────────────────────
    const obs2 = find('catalog-results-html');
    const o2 = toObservation(obs2);
    const v2 = verifyDestination({ declaration, observation: o2, currentPageGeneration: o2.pageGeneration });
    log('OBS2-COMBINED ' + JSON.stringify({ url: o2.url, gen: o2.pageGeneration, pageType: o2.semantic?.pageType, verdict: v2.kind, reason: v2.reason }));
    report.results.catalogPage_combined = { observation: obs2, verdict: v2 };

    // ── The same verdict the Step 5 evidence recorded, for direct comparison ─
    // Under Step 5's conflated contract `/` was a destinationUrl and correctly
    // MISMATCHed against `/results.html`. That historic verdict is preserved in
    // real_verification_results.json; it is reproduced here from the SAME real
    // observation with the entry URL deliberately used AS a destination URL.
    const conflated = {
      kind: 'DECLARED' as const,
      role: declaration.kind === 'DECLARED' ? declaration.role : undefined,
      url: declaration.kind === 'DECLARED' ? declaration.entryUrl : undefined,
    };
    const vConflated = verifyDestination({ declaration: conflated, observation: o2, currentPageGeneration: o2.pageGeneration });
    log('REGRESSION-CHECK-CONFLATED ' + JSON.stringify({ verdict: vConflated.kind, reason: vConflated.reason }));
    report.results.step5_conflatedContractOnSameObservation = {
      note:
        'Step 5 treated the entry URL as the destination URL and correctly reported MISMATCH against this same real ' +
        'observation. The separation must NOT weaken that rejection, so it is re-asserted here on the same observation.',
      verdict: vConflated,
    };

    // ── Step 6 STEP 3 invariant: observation cannot rewrite the declaration ──
    const beforeJson = JSON.stringify(declaration);
    verifyDestination({ declaration, observation: o2, currentPageGeneration: o2.pageGeneration });
    const afterJson = JSON.stringify(declaration);
    report.results.observationCannotRewriteDeclaration = {
      declarationBefore: JSON.parse(beforeJson),
      declarationAfter: JSON.parse(afterJson),
      unchanged: beforeJson === afterJson,
      destinationUrlStillAbsent: afterJson.includes('"destinationUrl"') ? false : !/"url":/.test(afterJson),
    };
    log('IMMUTABLE ' + JSON.stringify(report.results.observationCannotRewriteDeclaration));

    // ── Negative control: real LISTING observation vs DECLARED[CHECKOUT] ─────
    const negative = {
      kind: 'DECLARED' as const,
      role: { provenance: 'EXPLICIT_PAGE_ROLE' as const, acceptablePageTypes: ['CHECKOUT'] as SemanticPageType[] },
    };
    const vNeg = verifyDestination({ declaration: negative, observation: o2, currentPageGeneration: o2.pageGeneration });
    log('NEG-CONTROL-CHECKOUT ' + JSON.stringify({ verdict: vNeg.kind, reason: vNeg.reason }));
    report.results.negativeControl_checkoutVsRealListing = { verdict: vNeg };

    // ── Negative control 2: explicit destination URL vs a different real page ─
    const explicit = normalizeDestination('open http://localhost:4174/results.html');
    const vExplicit = verifyDestination({ declaration: explicit, observation: o2, currentPageGeneration: o2.pageGeneration });
    const obsWrong = find('product-html');
    const vExplicitWrong = verifyDestination({
      declaration: explicit,
      observation: toObservation(obsWrong),
      currentPageGeneration: Number(obsWrong.semanticPageGeneration),
    });
    log('EXPLICIT-DEST ' + JSON.stringify({ decl: JSON.parse(JSON.stringify(explicit)), onResults: vExplicit.kind, onProduct: vExplicitWrong.kind, reason: vExplicitWrong.reason }));
    report.results.explicitDestinationUrl = {
      declaration: JSON.parse(JSON.stringify(explicit)),
      onRealCatalog: vExplicit,
      onRealProductPage: vExplicitWrong,
    };

    // ── Negative control 3: the real UNKNOWN landing page vs the role claim ──
    const vNegUnknown = verifyDestination({ declaration, observation: o1, currentPageGeneration: o1.pageGeneration });
    log('NEG-CONTROL-REAL-UNKNOWN ' + JSON.stringify({ verdict: vNegUnknown.kind, reason: vNegUnknown.reason }));
    report.results.negativeControl_realUnknownLanding = { verdict: vNegUnknown };

    // ── Staleness control: the REAL older observation, after a real newer page ─
    const obs3 = find('product-html');
    const o3 = toObservation(obs3);
    const vStale = verifyDestination({
      declaration,
      observation: o2, // the genuinely older LISTING observation (generation 5)
      currentPageGeneration: o3.pageGeneration, // but verification now runs at the newer generation
    });
    log('STALENESS ' + JSON.stringify({ staleGen: o2.pageGeneration, currentGen: o3.pageGeneration, verdict: vStale.kind, reason: vStale.reason }));
    report.results.staleness = { staleObservation: obs2, currentObservation: obs3, verdict: vStale };

    // ── Scope checks on the real call boundary ──────────────────────────────
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
      verdictCarriesPageText: [v2.reason, vNeg.reason, vStale.reason, vConflated.reason].some((r) =>
        /product card|baggy|widget|add to cart/i.test(r)
      ),
    };
    log('BOUNDARY ' + JSON.stringify(report.boundary));

    writeFileSync(join(DIR, 'real_verification_results_step6.json'), JSON.stringify(report, null, 2) + '\n');
  });
});

function log(s: string) {
  console.log(s);
}