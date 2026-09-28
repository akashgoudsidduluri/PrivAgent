/**
 * Decisive test for the F-09 `person_name` blocker.
 *
 * The backend text-safety heuristic rejects a MODEL reason containing a
 * title-cased bigram ("Alpha Widget"). The question this answers: can the
 * real model complete the task at all, or does naming the product make the
 * request structurally impossible?
 *
 * We ask the real reasoner, for the REAL catalog context, whether a
 * NEUTRAL goal produces a NEUTRAL reason. No gate is touched. If the model
 * still names the product, F-09 blocks this task regardless of wording and
 * that is the honest finding.
 */
import { BackendAgentProvider } from '../extension/src/agent/backendAgentProvider';
import { ctx, det } from '../evaluation/phase17_8/fixtures';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import type { BrowserAction } from '../extension/src/agent/actionTypes';

const PAGE = 'http://localhost:4291';

function catCtx(url: string): AgentContextPayload {
  return ctx({
    url,
    detections: [
      det('alpha-widget-link', 'link', { label: 'View Alpha Widget', selector: '#alpha-widget-link' }),
      det('beta-gizmo-link', 'link', { label: 'View Beta Gizmo', selector: '#beta-gizmo-link' }),
      det('catalog-heading', 'heading', { label: 'Catalog' }),
    ],
    total_elements_scanned: 3,
  } as never);
}

const GOALS = {
  'names-the-product': 'Open the product page for the widget priced at 24 and report the price shown.',
  'neutral-first-item': 'Open the store catalog, open the first product listed, and report the price shown on its product page.',
  'neutral-lowest-price': 'Open the store catalog, open the cheapest product listed, and report the price shown on its product page.',
};

const BIGRAM = /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/;

console.log('\n=== catalog-page decisions (real reasoner) ===\n');
for (const [label, goal] of Object.entries(GOALS)) {
  const p = new BackendAgentProvider({ timeoutMs: 60000 });
  const t0 = Date.now();
  try {
    const a = (await p.requestAction(goal, catCtx(`${PAGE}/catalog`), [])) as BrowserAction;
    const reason = String((a as unknown as { reason?: string }).reason ?? '');
    const hit = BIGRAM.test(reason);
    console.log(`[${label}] OK ${Date.now() - t0}ms`);
    console.log(`   action  = ${a.action} ${(a as unknown as {target?:string}).target ?? ''}`);
    console.log(`   reason  = ${JSON.stringify(reason)}`);
    console.log(`   F-09 would fire? ${hit ? 'YES -> 503' : 'no'}\n`);
  } catch (e) {
    const m = String((e as Error).message);
    console.log(`[${label}] FAILED ${Date.now() - t0}ms`);
    console.log(`   ${m.slice(0, 160)}\n`);
  }
}
