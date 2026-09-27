/**
 * PHASE 17.5A mutation harness.
 *
 * Two mutations, in OPPOSITE directions. A one-sided suite would pass both:
 *   A1 reverts the fix  → the false positive must come back and FAIL.
 *   A2 over-broadens it → navigation from a read-only goal must slip through
 *                         and FAIL, proving the suite is not merely
 *                         "allow-all-navigation" shaped.
 */
import fs from 'fs';
import { execSync } from 'child_process';

const F = 'extension/src/agent/securityCritic.ts';
const backup = fs.readFileSync(F, 'utf8');
const restore = () => fs.writeFileSync(F, backup);

const MUTATIONS = [
  {
    id: 'A1',
    name: 'revert the fix (read-only goal blocks its own navigation again)',
    find: '      if (goalIsReadOnly && !goalExplicitlyNavigates) return true;',
    repl: '      if (goalIsReadOnly) return true;',
  },
  {
    id: 'A2',
    name: 'over-broaden: never treat navigation as a mismatch at all',
    find: '      if (goalIsReadOnly && !goalExplicitlyNavigates) return true;',
    repl: '      if (false) return true;',
  },
];

const SUITES =
  'tests/phase17/securityCriticNavigationScope.test.ts tests/phase8SecurityCritic.test.ts';

function run() {
  try {
    execSync(`npx vitest run ${SUITES}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { pass: true, out: '' };
  } catch (e) {
    return { pass: false, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

const results = [];
for (const m of MUTATIONS) {
  restore();
  const src = fs.readFileSync(F, 'utf8');
  const n = src.split(m.find).length - 1;
  if (n !== 1) {
    results.push({ ...m, status: 'ANCHOR_NOT_FOUND', matches: n });
    console.log(`${m.id}: ANCHOR_NOT_FOUND (${n})`);
    continue;
  }
  fs.writeFileSync(F, src.replace(m.find, m.repl));
  const { pass, out } = run();
  const failed = (out.match(/×/g) || []).length;
  results.push({ ...m, status: pass ? 'SURVIVED' : 'CAUGHT', failedTests: failed });
  console.log(`${m.id} ${m.name}: ${pass ? 'SURVIVED ***' : `CAUGHT (${failed} failing)`}`);
}
restore();

let clean = fs.readFileSync(F, 'utf8') === backup;
console.log('\ntree restored clean:', clean);
const caught = results.filter((r) => r.status === 'CAUGHT').length;
console.log('mutations caught:', caught, '/', MUTATIONS.length);
if (caught !== MUTATIONS.length) process.exitCode = 1;
