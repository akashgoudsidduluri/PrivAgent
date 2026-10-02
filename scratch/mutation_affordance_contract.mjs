/**
 * MUTATION PROBES — POST-17.10 AFFORDANCE_AVAILABLE contract.
 *
 * Each mutant reintroduces one specific unsafe behaviour. A mutant is KILLED
 * only if a test in tests/affordanceAvailableContract.test.ts (plus the
 * pre-existing 17.6 contract suite) fails. Equivalent mutants are classified
 * honestly rather than counted as kills.
 *
 * Every mutation is applied by exact-string replacement with an assertion on
 * the replacement count, and every file is restored from a byte snapshot.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const TRACKER = 'extension/src/hierarchicalPlanning/goalProgressTracker.ts';
const DECOMPOSER = 'extension/src/hierarchicalPlanning/taskDecomposer.ts';

const snapshots = new Map();
function snap(p) {
  if (!snapshots.has(p)) snapshots.set(p, readFileSync(p, 'utf8'));
}
function restore() {
  for (const [p, s] of snapshots) writeFileSync(p, s);
  snapshots.clear();
}

function mutate(path, from, to) {
  snap(path);
  const src = readFileSync(path, 'utf8');
  const count = src.split(from).length - 1;
  if (count !== 1) throw new Error(`anchor appears ${count}x in ${path}: ${JSON.stringify(from.slice(0, 70))}`);
  writeFileSync(path, src.replace(from, to));
}

const NAME_PREDICATE = `        const found = affordances.some(
          (a) => a.type === want || mentions(a.description ?? '', want) || a.targetElementId === want
        );`;

const MUTANTS = [
  {
    id: 'M1',
    name: 'restore unconditional true for a missing expectedValue',
    edit: () =>
      mutate(
        TRACKER,
        `        if (!want) {
          return verdict(
            false,
            \`Subgoal \${subgoal.id} declares AFFORDANCE_AVAILABLE with no named affordance, so no specific affordance can be shown present.\`
          );
        }`,
        `        if (!want) {
          return verdict(true, \`Affordance "any" is available in the observed affordance set.\`);
        }`
      ),
  },
  {
    id: 'M2',
    name: 'replace the named check with affordances.length > 0',
    edit: () =>
      mutate(
        TRACKER,
        NAME_PREDICATE,
        `        const found = affordances.length > 0;`
      ),
  },
  {
    id: 'M3',
    name: 'ignore expectedValue entirely',
    edit: () =>
      mutate(
        TRACKER,
        NAME_PREDICATE,
        `        const found = affordances.length > 0 && affordances.every((a) => Boolean(a.type));`
      ),
  },
  {
    id: 'M4',
    name: 'use action.url / requested navigation as the evidence',
    edit: () =>
      mutate(
        TRACKER,
        `        const found = affordances.some(
          (a) => a.type === want || mentions(a.description ?? '', want) || a.targetElementId === want
        );`,
        `        const claimed = String((subgoal as { action?: { url?: string } }).action?.url ?? '');
        const found = Boolean(claimed) || affordances.some(
          (a) => a.type === want || mentions(a.description ?? '', want) || a.targetElementId === want
        );`
      ),
  },
  {
    id: 'M5',
    name: 'use executionSuccess as the evidence',
    edit: () =>
      mutate(
        TRACKER,
        NAME_PREDICATE,
        `        const found =
          Boolean((subgoal as { executionSuccess?: boolean }).executionSuccess) ||
          affordances.some(
            (a) => a.type === want || mentions(a.description ?? '', want) || a.targetElementId === want
          );`
      ),
  },
  {
    id: 'M6',
    name: 'use previousActions as the evidence',
    edit: () =>
      mutate(
        TRACKER,
        NAME_PREDICATE,
        `        const prior = (observation as { context?: { previous_actions?: unknown[] } }).context
          ?.previous_actions;
        const found =
          Array.isArray(prior) &&
          prior.length > 0 &&
          affordances.some(
            (a) => a.type === want || mentions(a.description ?? '', want) || a.targetElementId === want
          );`
      ),
  },
  {
    id: 'M7',
    name: 're-wire the two blocked producers to SCROLL (the vacuous truth)',
    edit: () =>
      mutate(
        DECOMPOSER,
        `{ type: 'AFFORDANCE_AVAILABLE', description: 'Store catalog reachable' }`,
        `{ type: 'AFFORDANCE_AVAILABLE', expectedValue: 'SCROLL', description: 'Store catalog reachable' }`
      ),
  },
  {
    id: 'M8',
    name: 'drop the ENTER_QUERY name from both SEARCH producers',
    edit: () =>
      mutate(
        DECOMPOSER,
        `{ type: 'AFFORDANCE_AVAILABLE', expectedValue: 'ENTER_QUERY', description: 'Search query input available on the observed page' }`,
        `{ type: 'AFFORDANCE_AVAILABLE', description: 'Query results displayed' }`
      ),
  },
  {
    id: 'M9',
    name: 'reinterpret targetEntity as destination identity',
    edit: () =>
      mutate(
        DECOMPOSER,
        `      const productQuery = targetEntities[0] || 'requested item';`,
        `      const productQuery = String(userPrompt).match(/https?:\\/\\/[^\\s]+/)?.[0] || targetEntities[0] || 'requested item';`
      ),
  },
];

const SUITES = [
  'tests/affordanceAvailableContract.test.ts',
  'tests/phase17/phase176ProgressContract.test.ts',
];

async function runSuite() {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('npx', ['vitest', 'run', '--silent=true', ...SUITES], {
    encoding: 'utf8',
    timeout: 300_000,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const m = out.match(/Tests\s+(.*)/);
  return { failed: /\bFAIL\b/.test(out) || (r.status ?? 1) !== 0, summary: m ? m[1].trim() : out.slice(-400) };
}

const base = await runSuite();
console.log(`BASELINE  ${base.failed ? 'FAILING (investigate before mutating)' : 'clean'}  ${base.summary}`);

const results = [];
for (const mut of MUTANTS) {
  restore();
  try {
    mut.edit();
  } catch (e) {
    results.push({ ...mut, verdict: 'INVALID', why: String(e.message) });
    continue;
  }
  const r = await runSuite();
  results.push({
    ...mut,
    verdict: r.failed ? 'KILLED' : 'SURVIVED',
    why: r.summary,
  });
}
restore();

let killed = 0;
let survived = 0;
let invalid = 0;
for (const r of results) {
  if (r.verdict === 'KILLED') killed += 1;
  else if (r.verdict === 'SURVIVED') survived += 1;
  else invalid += 1;
  console.log(`\n${r.id}  ${r.verdict}  ${r.name}\n      ${r.why}`);
}
console.log(`\n== ${killed} killed, ${survived} survived, ${invalid} invalid of ${MUTANTS.length} ==`);
