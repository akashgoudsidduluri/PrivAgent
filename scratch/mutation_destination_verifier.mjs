/**
 * MUTATION PROBES — destination verifier (POST-17.10 VERIFICATION channel).
 *
 * Each mutant reintroduces one specific way the verifier could become unsafe:
 * turning absence into a match, letting stale or low-confidence evidence
 * through, using requested state as evidence, weakening URL comparison to a
 * substring, or silently dropping one of the two independent constraints.
 *
 * KILLED = `tests/destinationVerifier.test.ts` fails. Survivors are reported
 * honestly, never scored optimistically.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const SRC = 'extension/src/planning/destinationVerifier.ts';
const SUITE = 'tests/destinationVerifier.test.ts';
const ORIGINAL = readFileSync(SRC, 'utf8');

function mutate(from, to) {
  const count = ORIGINAL.split(from).length - 1;
  if (count !== 1) throw new Error(`anchor appears ${count}x: ${JSON.stringify(from.slice(0, 70))}`);
  writeFileSync(SRC, ORIGINAL.replace(from, to));
}
const restore = () => writeFileSync(SRC, ORIGINAL);

const MUTANTS = [
  {
    id: 'M1',
    name: 'UNKNOWN observation → MATCH',
    edit: () =>
      mutate(
        `  if (semantic.pageType === 'UNKNOWN') {
    return unknown(
      \`The page is not classified (UNKNOWN at confidence \${semantic.confidence}); an unclassified page cannot confirm or deny a destination.\`
    );
  }`,
        `  if (semantic.pageType === 'UNKNOWN') {
    return {
      channel: 'pageRole',
      kind: 'MATCH',
      reason: 'mutant: unclassified page treated as a match',
    };
  }`
      ),
  },
  {
    id: 'M2',
    name: 'low confidence → MATCH (drop the shared floor check)',
    edit: () =>
      mutate(
        `  if (semantic.pageType !== 'UNKNOWN' && semantic.confidence < MIN_PAGE_CLASSIFICATION_CONFIDENCE) {`,
        `  if (false) {`
      ),
  },
  {
    id: 'M3',
    name: 'stale page generation → accepted',
    edit: () =>
      mutate(
        `  if (input.currentPageGeneration !== undefined && input.currentPageGeneration !== obs.pageGeneration) {
    return fail(
      \`Observation belongs to page generation \${obs.pageGeneration} but verification is running at generation \${input.currentPageGeneration}; a stale document cannot verify a destination.\`
    );
  }`,
        `  if (false) {
  }`
      ),
  },
  {
    id: 'M4',
    name: 'requested URL used as evidence',
    edit: () =>
      mutate(
        `  const same = observed.origin === declared.origin && observed.path === declared.path;`,
        `  const requested = input.declaration.kind === 'DECLARED' ? input.declaration.url?.rawUrl ?? '' : '';
  const same =
    observed.origin === declared.origin && observed.path === declared.path ||
    (Boolean(requested) && normalizeDestinationUrl(requested) !== null);`
      ),
  },
  {
    id: 'M5',
    name: 'URL substring comparison instead of exact',
    edit: () =>
      mutate(
        `  const same = observed.origin === declared.origin && observed.path === declared.path;`,
        `  const same = \`\${observed.origin}\${observed.path}\`.includes(\`\${declared.origin}\${declared.path}\`);`
      ),
  },
  {
    id: 'M6',
    name: 'MISMATCH from a missing observation',
    edit: () =>
      mutate(
        `  const obs = input.observation;
  const unknown = (reason: string) => ({ channel: 'pageRole' as const, kind: 'UNKNOWN' as const, reason });`,
        `  const obs = input.observation;
  const unknown = (reason: string) => ({ channel: 'pageRole' as const, kind: 'MISMATCH' as const, reason });`
      ),
  },
  {
    id: 'M7',
    name: 'page-role constraint silently ignored',
    edit: () =>
      mutate(
        `  const pageRole = declaration.role
    ? verifyPageRole(declaration.role.acceptablePageTypes, input)
    : null;`,
        `  const pageRole = null;`
      ),
  },
  {
    id: 'M8',
    name: 'URL constraint silently ignored',
    edit: () => mutate(`  const url = declaration.url ? verifyUrl(declaration.url, input) : null;`, `  const url = null;`),
  },
  {
    id: 'M9',
    name: 'UNKNOWN allowed as an acceptable page type (drop the N10 filter)',
    edit: () =>
      mutate(
        `  const targets = acceptable.filter((t) => t !== 'UNKNOWN' && t !== 'ERROR');`,
        `  const targets = acceptable;`
      ),
  },
  {
    id: 'M10',
    name: 'classification stamped to a different document is accepted',
    edit: () =>
      mutate(
        `  if (semantic.pageGeneration !== obs.pageGeneration) {`,
        `  if (false) {`
      ),
  },
  {
    id: 'M11',
    name: 'UNSUPPORTED / AMBIGUOUS declarations collapse into a declared role',
    edit: () =>
      mutate(
        `  if (declaration.kind !== 'DECLARED') {`,
        `  if (false) {`
      ),
  },
  {
    id: 'M12',
    name: 'MISMATCH no longer dominates UNKNOWN in the combination',
    edit: () =>
      mutate(
        `  const mismatch = declared.find((c) => c.kind === 'MISMATCH');
  if (mismatch) {`,
        `  const mismatch = declared.length === 1 ? declared.find((c) => c.kind === 'MISMATCH') : undefined;
  if (mismatch) {`
      ),
  },
];

function runSuite() {
  const r = spawnSync('npx', ['vitest', 'run', '--silent=true', SUITE], {
    encoding: 'utf8',
    timeout: 300_000,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const m = out.match(/Tests\s+(.*)/);
  return { failed: /\bFAIL\b/.test(out) || (r.status ?? 1) !== 0, summary: m ? m[1].trim() : out.slice(-300) };
}

const baseline = runSuite();
console.log(`BASELINE  ${baseline.failed ? 'FAILING — investigate before mutating' : 'clean'}  ${baseline.summary}`);

const results = [];
for (const m of MUTANTS) {
  restore();
  try {
    m.edit();
  } catch (e) {
    results.push({ ...m, verdict: 'INVALID', why: String(e.message) });
    continue;
  }
  const r = runSuite();
  results.push({ ...m, verdict: r.failed ? 'KILLED' : 'SURVIVED', why: r.summary });
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
