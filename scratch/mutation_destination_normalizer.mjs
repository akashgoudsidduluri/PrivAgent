/**
 * MUTATION PROBES — destination normalizer (POST-17.10 DECLARATION channel).
 *
 * Each mutant reintroduces one specific way the declaration could become unsafe:
 * a keyword matcher, a category default, a model/page-controllable path, or an
 * over-reaching guess. A mutant is KILLED only when
 * `tests/destinationNormalizer.test.ts` fails.
 *
 * Every mutation is applied by exact-string replacement with an assertion on
 * the replacement count, and the source file is restored from a byte snapshot
 * afterwards. Run with `node scratch/mutation_destination_normalizer.mjs`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const SRC = 'extension/src/planning/destinationNormalizer.ts';
const SUITE = 'tests/destinationNormalizer.test.ts';

const ORIGINAL = readFileSync(SRC, 'utf8');

function mutate(from, to) {
  const count = ORIGINAL.split(from).length - 1;
  if (count !== 1) throw new Error(`anchor appears ${count}x: ${JSON.stringify(from.slice(0, 70))}`);
  writeFileSync(SRC, ORIGINAL.replace(from, to));
}

function restore() {
  writeFileSync(SRC, ORIGINAL);
}

const MUTANTS = [
  {
    id: 'M1',
    name: 'substring-match the whole task instead of gating on a destination verb',
    edit: () =>
      mutate(
        `    const verbLen = matchVerb(tokens, i);
    if (verbLen === 0) continue;`,
        `    const verbLen = PAGE_ROLE_TABLE.has(tokens[i] ?? '') ? 1 : 0;
    if (verbLen === 0) continue;`
      ),
  },
  {
    id: 'M2',
    name: 'accept any noun that looks like a page type, ignoring the verb gate',
    edit: () =>
      mutate(
        `    const verbLen = matchVerb(tokens, i);
    if (verbLen === 0) continue;`,
        `    const verbLen = matchVerb(tokens, i);
    if (verbLen === 0 && !PAGE_ROLE_TABLE.has(tokens[i] ?? '')) continue;`
      ),
  },
  {
    id: 'M3',
    name: 'infer a destination from the first page-role noun anywhere in the prompt',
    edit: () =>
      mutate(
        `  const out: DestinationDeclaration[] = [];`,
        `  const out: DestinationDeclaration[] = [];
  {
    const bare = [...PAGE_ROLE_TABLE.keys()].find((k) => !k.includes(' ') && tokens.includes(k));
    if (bare && !DESTINATION_VERBS_ONE.has(tokens[0] ?? '')) {
      out.push({ kind: 'DECLARED', role: { provenance: 'EXPLICIT_PAGE_ROLE', acceptablePageTypes: PAGE_ROLE_TABLE.get(bare)![0] } });
    }
  }`
      ),
  },
  {
    id: 'M4',
    name: 'infer a destination from the task category instead of the verb',
    edit: () =>
      mutate(
        `    const verbLen = matchVerb(tokens, i);
    if (verbLen === 0) continue;`,
        `    let verbLen = matchVerb(tokens, i);
    if (verbLen === 0) {
      if (/shop|store|product|buy|cart/i.test(task)) verbLen = 1;
      else continue;
    }`
      ),
  },
  {
    id: 'M5',
    name: 'collapse AMBIGUOUS into a DECLARED pick',
    edit: () =>
      mutate(
        `    } else if (readings.length > 1) {
      // N9 — real ambiguity, never silently resolved.
      out.push({ kind: 'AMBIGUOUS', candidates: readings, provenance: 'EXPLICIT_PAGE_ROLE' });`,
        `    } else if (readings.length > 1) {
      out.push({
        kind: 'DECLARED',
        role: { provenance: 'EXPLICIT_PAGE_ROLE', acceptablePageTypes: readings[0] },
      });`
      ),
  },
  {
    id: 'M6',
    name: 'coerce an unmappable head into LISTING instead of UNSUPPORTED',
    edit: () =>
      mutate(
        `    if (!readings) {
      // N3 — an unmappable head is UNSUPPORTED, never a guess.
      out.push({
        kind: 'UNSUPPORTED',
        unmappedHead: resolution.head,
        provenance: 'EXPLICIT_PAGE_ROLE',
      });`,
        `    if (!readings) {
      out.push({
        kind: 'DECLARED',
        role: { provenance: 'EXPLICIT_PAGE_ROLE', acceptablePageTypes: ['LISTING'] },
      });`
      ),
  },
  {
    id: 'M7',
    name: 'drop the N10 filter so UNKNOWN can be declared',
    edit: () =>
      mutate(
        `      const types = readings[0]!.filter((t) => t !== 'UNKNOWN');`,
        `      const types = readings[0]!;`
      ),
  },
  {
    id: 'M8',
    name: 'remove the already-opened non-authority rule (N8)',
    edit: () =>
      mutate(
        `    if (NON_AUTHORIZING_VERBS.has(tokens[i]!) || (i > 0 && NON_AUTHORIZING_PREV.has(tokens[i - 1]!))) {`,
        `    if (false) {`
      ),
  },
  {
    id: 'M9',
    name: 'ignore provenance (N13)',
    edit: () =>
      mutate(
        `export type DestinationProvenance = 'USER_URL' | 'EXPLICIT_PAGE_ROLE';`,
        `export type DestinationProvenance = string;`
      ),
  },
  {
    id: 'M10',
    name: 'remove the modifier bound (N12)',
    edit: () =>
      mutate(
        `  const modifiers = trimmed.slice(0, -1);
  if (modifiers.length > MAX_MODIFIERS) return { ok: false, reason: 'BOUND_EXCEEDED' };`,
        `  const modifiers = trimmed.slice(0, -1);`
      ),
  },
  {
    id: 'M11',
    name: 'let a URL substring act as identity instead of exact origin+path (N14)',
    edit: () =>
      mutate(
        `    path: (parsed.pathname || '/').replace(/\\/+$/, '').toLowerCase() || '/',`,
        `    path: ((parsed.pathname || '/') + (parsed.search || '')).toLowerCase(),`
      ),
  },
  {
    id: 'M12',
    name: 'let the clause boundary be ignored so a later noun becomes the head',
    edit: () => mutate(`    if (SLOT_TERMINATORS.has(t)) {
      hitBoundary = true;`, `    if (false) {
      hitBoundary = true;`),
  },
  {
    id: 'M13',
    name: 'make the boundary extension read the continuation as the head (minSpan 1)',
    edit: () =>
      mutate(
        `    const hit = trySource([...collected, ...afterBoundary.slice(0, extra)], 2);`,
        `    const hit = trySource([...collected, ...afterBoundary.slice(0, extra)], 1);`
      ),
  },
  {
    id: 'M14',
    name: 'try the one-token verb before the two-token verb',
    edit: () =>
      mutate(
        `  const two = i + 1 < tokens.length ? \`\${tokens[i]} \${tokens[i + 1]}\` : undefined;
  if (two !== undefined && DESTINATION_VERBS_TWO.has(two)) return 2;
  const one = tokens[i];
  if (one !== undefined && DESTINATION_VERBS_ONE.has(one)) return 1;
  return 0;`,
        `  const one = tokens[i];
  if (one !== undefined && DESTINATION_VERBS_ONE.has(one)) return 1;
  const two = i + 1 < tokens.length ? \`\${tokens[i]} \${tokens[i + 1]}\` : undefined;
  if (two !== undefined && DESTINATION_VERBS_TWO.has(two)) return 2;
  return 0;`
      ),
  },
  {
    id: 'M15',
    name: 'drop the URL stripping so URL tokens pollute the noun slot',
    edit: () =>
      mutate(
        `  const tokens = tokenize(task.replace(EXPLICIT_URL_GLOBAL, ' '));`,
        `  const tokens = tokenize(task);`
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
