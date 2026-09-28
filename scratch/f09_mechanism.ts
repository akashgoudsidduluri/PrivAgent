/**
 * Mechanism confirmation for the F-09 block.
 *
 * Hypothesis: the refusal is caused by the GOAL naming the product, because
 * the real page context also displays that name, so the model echoes it in
 * its reason. It is not bad luck.
 *
 * Test: same REAL fixture page context (labels include the product name), two
 * goals — one naming the product, one neutral. Only the naming goal should
 * produce a title-cased bigram.
 */
import { BackendAgentProvider } from '../extension/src/agent/backendAgentProvider';
import { ctx, det } from '../evaluation/phase17_8/fixtures';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import type { BrowserAction } from '../extension/src/agent/actionTypes';

const PAGE = 'http://localhost:4291';
// Labels exactly as the real fixture renders them.
const realHomeCtx = (): AgentContextPayload =>
  ctx({
    url: `${PAGE}/`,
    detections: [
      det('nav-catalog', 'link', { label: 'catalog', selector: '#catalog-link' }),
      det('welcome-heading', 'heading', { label: 'WELCOME TO THE FIXTURE STORE' }),
    ],
    total_elements_scanned: 2,
  } as never);

const BIGRAM = /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/;

const cases = [
  ['names-the-product', `Find the Alpha Widget product on the store at ${PAGE} and report the price shown for it.`],
  ['neutral', 'Open the store catalog, open the first product listed, and report the price shown on its product page.'],
];

console.log('\n=== does the GOAL wording drive the bigram? (real home-page context) ===\n');
for (const [label, goal] of cases) {
  let bigrams = 0;
  const reasons = [];
  for (let i = 0; i < 4; i++) {
    const p = new BackendAgentProvider({ timeoutMs: 60000 });
    try {
      const a = (await p.requestAction(goal, realHomeCtx(), [])) as BrowserAction;
      const reason = String((a as unknown as { reason?: string }).reason ?? '');
      reasons.push(reason);
      if (BIGRAM.test(reason)) bigrams++;
    } catch (e) {
      reasons.push(`ERROR: ${String((e as Error).message).slice(0, 90)}`);
    }
  }
  console.log(`[${label}] bigram in ${bigrams}/4 reasons`);
  for (const r of reasons) console.log(`    - ${JSON.stringify(r)}`);
  console.log();
}
