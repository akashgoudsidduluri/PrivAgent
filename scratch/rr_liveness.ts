/**
 * Liveness + behaviour probe for the REAL reasoner.
 *
 * Uses the PRODUCTION BackendAgentProvider (not a hand-rolled fetch), so the
 * egress firewall, payload shape and strict response validation all apply.
 * Read-only: no state, no gates, no loop. This only answers two questions
 *   1. Is the provider reachable RIGHT NOW?
 *   2. What does it actually propose for a catalog-style goal?
 * before any multi-step harness is built.
 */
import { BackendAgentProvider } from '../extension/src/agent/backendAgentProvider';
import { ctx, det, scope } from '../evaluation/phase17_8/fixtures';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import type { BrowserAction } from '../extension/src/agent/actionTypes';

const PAGE = 'http://127.0.0.1:8791/';

// A catalog home page. Neutral, lowercase-label affordances so the run is not
// decided by the backend person_name heuristic (F-09) — that limitation is
// documented, not worked around.
const context: AgentContextPayload = ctx({
  url: PAGE,
  detections: [
    det('nav-catalog', 'link', { label: 'catalog', selector: '#catalog-link' }),
    det('h1-title', 'heading', { label: 'welcome' }),
  ],
  total_elements_scanned: 2,
} as never);

const GOAL = 'Open the catalog, open a product, and verify the product page shows the expected price.';

async function once(label: string, goal: string, c: AgentContextPayload) {
  const p = new BackendAgentProvider({ timeoutMs: 60000 });
  const t0 = Date.now();
  try {
    const a = (await p.requestAction(goal, c, [])) as BrowserAction;
    const rtt = Date.now() - t0;
    console.log(`\n[${label}] OK in ${rtt}ms`);
    console.log(`   action  = ${JSON.stringify(a, null, 0)}`);
    return { label, ok: true, rttMs: rtt, action: a as unknown as Record<string, unknown> };
  } catch (e) {
    const rtt = Date.now() - t0;
    console.log(`\n[${label}] FAILED in ${rtt}ms`);
    console.log(`   ${(e as Error).message}`);
    return { label, ok: false, rttMs: rtt, error: (e as Error).message };
  }
}

const results = [];
results.push(await once('catalog-goal', GOAL, context));
// Neutral wording control: the same page, wording with no title-cased bigram.
results.push(
  await once(
    'neutral-wording',
    'open the catalog, open a product, and check the product page shows the expected price',
    context
  )
);

console.log('\n=== summary ===');
for (const r of results) {
  console.log(`  ${r.ok ? 'OK  ' : 'FAIL'}  ${r.label.padEnd(16)} ${String(r.rttMs).padStart(6)}ms  ${r.ok ? JSON.stringify(r.action) : r.error}`);
}
console.log(`\nanySuccess=${results.some((r) => r.ok)}`);
void scope;
