/**
 * MUTATION PROBES — entry URL vs destination URL (POST-17.10 Step 6).
 *
 * Each mutant reintroduces one specific way the Step 6 separation could fail:
 * conflating the two URLs, discarding the entry site, letting observed state
 * rewrite the declaration, or making the exact URL comparison slack again.
 *
 * A mutant is KILLED only when the destination test suite fails. A mutant whose
 * anchor no longer matches is reported INVALID and is never counted as a kill.
 * Run with `node scratch/mutation_destination_entry_url.mjs`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const NORMALIZER = 'extension/src/planning/destinationNormalizer.ts';
const VERIFIER = 'extension/src/planning/destinationVerifier.ts';
const SUITE = [
  'tests/destinationNormalizer.test.ts',
  'tests/destinationVerifier.test.ts',
];

const ORIGINALS = new Map([
  [NORMALIZER, readFileSync(NORMALIZER, 'utf8')],
  [VERIFIER, readFileSync(VERIFIER, 'utf8')],
]);

function mutate(file, from, to) {
  const original = ORIGINALS.get(file);
  const count = original.split(from).length - 1;
  if (count !== 1) throw new Error(`anchor appears ${count}x in ${file}: ${JSON.stringify(from.slice(0, 70))}`);
  writeFileSync(file, original.replace(from, to));
}

function restoreAll() {
  for (const [file, content] of ORIGINALS) writeFileSync(file, content);
}

const MUTANTS = [
  {
    id: 'M1',
    name: 'treat entryUrl AS the destinationUrl (re-conflate the two)',
    file: NORMALIZER,
    edit: () =>
      mutate(
        NORMALIZER,
        `    out[firstRole] = { ...existing, entryUrl };`,
        `    out[firstRole] = { ...existing, url: { provenance: 'USER_URL', origin: entryUrl.origin, path: entryUrl.path, rawUrl: entryUrl.rawUrl } };`
      ),
  },
  {
    id: 'M2',
    name: 'discard the entryUrl entirely',
    file: NORMALIZER,
    edit: () =>
      mutate(
        NORMALIZER,
        `    out[firstRole] = { ...existing, entryUrl };`,
        `    out[firstRole] = { ...existing };`
      ),
  },
  {
    id: 'M3',
    name: 'swallow trailing punctuation again, losing the URL on a real sentence',
    file: NORMALIZER,
    edit: () =>
      mutate(
        NORMALIZER,
        `  const urlRaw = urlMatch?.[0]?.replace(URL_TRAILING_PUNCTUATION, '');`,
        `  const urlRaw = urlMatch?.[0];`
      ),
  },
  {
    id: 'M4',
    name: 'strip only the FIRST URL, letting a later URL pollute the noun slot',
    file: NORMALIZER,
    edit: () =>
      mutate(
        NORMALIZER,
        `  const tokens = tokenize(task.replace(EXPLICIT_URL_GLOBAL, ' '));`,
        `  const tokens = tokenize(task.replace(EXPLICIT_URL, ' '));`
      ),
  },
  {
    id: 'M5',
    name: 'the OBSERVED URL overwrites the declaration (evidence laundering)',
    file: VERIFIER,
    edit: () =>
      mutate(
        VERIFIER,
        `export function verifyDestination(input: DestinationVerificationInput): DestinationVerdict {
  const { declaration } = input;`,
        `export function verifyDestination(input: DestinationVerificationInput): DestinationVerdict {
  const { declaration } = input;
  const _observed = normalizeDestinationUrl(input.observation?.url ?? 'http://x.invalid/');
  if (_observed && declaration.kind === 'DECLARED') {
    (declaration as { url?: unknown }).url = {
      provenance: 'USER_URL',
      origin: _observed.origin,
      path: _observed.path,
      rawUrl: _observed.origin + _observed.path,
    };
  }`
      ),
  },
  {
    id: 'M6',
    name: 'make "/" match any path (the exact Step 5 failure, reintroduced)',
    file: VERIFIER,
    edit: () =>
      mutate(
        VERIFIER,
        `  const same = observed.origin === declared.origin && observed.path === declared.path;`,
        `  const same =
    observed.origin === declared.origin &&
    (declared.path === '/' || observed.path.startsWith(declared.path));`
      ),
  },
  {
    id: 'M7',
    name: 'ignore the explicit destination URL channel entirely',
    file: VERIFIER,
    edit: () =>
      mutate(
        VERIFIER,
        `  const url = declaration.url ? verifyUrl(declaration.url, input) : null;`,
        `  const url = null;`
      ),
  },
  {
    id: 'M8',
    name: 'fall back to entryUrl when there is no destinationUrl',
    file: VERIFIER,
    edit: () =>
      mutate(
        VERIFIER,
        `  const url = declaration.url ? verifyUrl(declaration.url, input) : null;`,
        `  const comparable = declaration.url ?? declaration.entryUrl;
  const url = comparable ? verifyUrl(comparable, input) : null;`
      ),
  },
  {
    id: 'M9',
    name: 'ignore the page-role constraint',
    file: VERIFIER,
    edit: () =>
      mutate(
        VERIFIER,
        `  const pageRole = declaration.role
    ? verifyPageRole(declaration.role.acceptablePageTypes, input)
    : null;`,
        `  const pageRole = null;`
      ),
  },
  {
    id: 'M10',
    name: 'bypass the stale-observation refusal in the URL channel',
    file: VERIFIER,
    edit: () =>
      mutate(
        VERIFIER,
        `      channel: 'url',
      kind: 'UNKNOWN',
      reason: \`Observation belongs to page generation \${obs.pageGeneration} but verification is running at generation \${input.currentPageGeneration}.\`,`,
        `      channel: 'url',
      kind: 'MATCH',
      reason: \`Observation belongs to page generation \${obs.pageGeneration} but verification is running at generation \${input.currentPageGeneration}.\`,`
      ),
  },
  {
    id: 'M11',
    name: 'turn an UNKNOWN channel into a MATCH',
    file: VERIFIER,
    edit: () =>
      mutate(
        VERIFIER,
        `  const allMatch = declared.every((c) => c.kind === 'MATCH');`,
        `  const allMatch = declared.every((c) => c.kind !== 'MISMATCH');`
      ),
  },
];

function runSuite() {
  const r = spawnSync('npx', ['vitest', 'run', '--silent=true', ...SUITE], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const m = out.match(/Tests\s+(?:(\d+) failed \| )?(\d+) passed/);
  const failed = m && m[1] ? Number(m[1]) : 0;
  const passed = m ? Number(m[2]) : 0;
  return { failed, passed, ok: r.status === 0 };
}

let killed = 0;
let survived = 0;
let invalid = 0;

for (const mutant of MUTANTS) {
  restoreAll();
  try {
    mutant.edit();
  } catch (err) {
    invalid += 1;
    console.log(`\n${mutant.id}  INVALID  ${mutant.name}\n      ${err.message}`);
    continue;
  }
  const res = runSuite();
  restoreAll();
  if (res.ok && res.failed === 0) {
    survived += 1;
    console.log(`\n${mutant.id}  SURVIVED  ${mutant.name}\n      ${res.passed} passed`);
  } else {
    killed += 1;
    console.log(`\n${mutant.id}  KILLED  ${mutant.name}\n      ${res.failed} failed | ${res.passed} passed`);
  }
}

restoreAll();
console.log(`\n== ${killed} killed, ${survived} survived, ${invalid} invalid of ${MUTANTS.length} ==`);