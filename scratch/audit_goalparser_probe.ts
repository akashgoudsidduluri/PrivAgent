/**
 * AUDIT PROBE (scratch, not production) — isolates two suspected defects in
 * extension/src/agent/goalParser.ts using the EXACT task from the real run.
 *
 * No provider budget, no browser, no network.
 */
import { parseUserGoal } from '../extension/src/agent/goalParser';

const TASK = 'open the store catalog at http://localhost:4174 and open the first product listed';

function show(label: string, task: string) {
  const p = parseUserGoal(task);
  console.log(`\n--- ${label} ---`);
  console.log('  task          :', JSON.stringify(task));
  console.log('  actionIntent  :', p.actionIntent);
  console.log('  normalizedGoal:', JSON.stringify(p.normalizedGoal));
  console.log('  constraints   :', JSON.stringify(p.constraints));
  console.log('  subgoals      :', p.subgoals.map((s) => `${s.expectedActionType}:${s.description}`).join(' || '));
}

console.log('=== the exact task from the real-browser run ===');
show('REAL TASK', TASK);

// ── D1: does a bare "rs" substring fabricate a currency? ───────────────────
console.log('\n=== D1 probe: currency extractor substring matching ===');
for (const w of ['first', 'rs', 'shirt', 'various', 'cart']) {
  console.log(`  "${w}".includes('rs') =`, w.toLowerCase().includes('rs'));
}
console.log('  REAL TASK lowercase contains "rs"? ->', TASK.toLowerCase().includes('rs'));
console.log('  where? ->', TASK.toLowerCase().indexOf('rs'), 'in', JSON.stringify(TASK.toLowerCase().slice(18, 28)));
show('SAME TASK with "first" removed', 'open the store catalog at http://localhost:4174 and open the product listed');

// ── D2: does a bare "product" token force the shopping search-flow? ─────────
console.log('\n=== D2 probe: shopping intent trigger is a bare substring ===');
show('NO "product" token', 'open the store catalog at http://localhost:4174 and open the first item listed');
show('bare mention, unrelated to shopping', 'open http://localhost:4174 and report the product page title');
