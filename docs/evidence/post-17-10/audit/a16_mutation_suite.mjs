#!/usr/bin/env node
/**
 * PHASE 18.8 / A16 — mutation suite (pre-action state freshness).
 *
 * Each mutant is a way the freshness contract could be silently undone: the
 * dispatch gate removed, the re-perception branch removed, the typed stop
 * reported as a generic failure, the grounded generation never recorded, the
 * non-consequential short-circuit removed, an observed document conflict
 * ignored, the URL conflict ignored, the generation comparison removed, a
 * missing observation rounded up to fresh, a FAILED observation channel no
 * longer distinguished from no channel at all, a conflict downgraded to a
 * refresh, and `mayDispatchStaleView` granted unconditionally.
 *
 * A survivor means the focused suite is not pinning the property it claims to.
 *
 * Run: node docs/evidence/post-17-10/audit/a16_mutation_suite.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const CONTRACT = 'extension/src/agent/actionFreshness.ts';
const LOOP = 'extension/src/agent/agentLoop.ts';
const TESTS = ['tests/phase18_8_a16ActionFreshness.test.ts'];

const MUTANTS = [
  // ── The loop ───────────────────────────────────────────────────────────────
  {
    id: 'M1',
    file: LOOP,
    name: 'the dispatch gate is removed — a moved view is acted on anyway',
    find: "      if (freshness.resolution === 'STOP_AND_ASK') {",
    replace: "      if (false && freshness.resolution === 'STOP_AND_ASK') {",
  },
  {
    id: 'M2',
    file: LOOP,
    name: 'the re-perception branch is removed — an unobserved view is dispatched as if it were fresh',
    find: "      if (freshness.resolution === 'RE_PERCEIVE') {",
    replace: "      if (false && freshness.resolution === 'RE_PERCEIVE') {",
  },
  {
    id: 'M3',
    file: LOOP,
    name: 'the freshness stop is reported as a generic FAILED instead of the typed state',
    find: "        this.state.status = 'FRESHNESS_UNVERIFIED';\n        this.state.goalStatus = 'FRESHNESS_UNVERIFIED';",
    replace: "        this.state.status = 'FAILED';\n        this.state.goalStatus = 'FAILED';",
  },
  {
    id: 'M4',
    file: LOOP,
    name: 'the grounded generation is never recorded — the STALE branch is silently disabled',
    find:
      '      this.state.plannedActionGeneration =\n' +
      '        (action as any).pageGeneration ??\n' +
      '        (action as any).actionPageGeneration ??\n' +
      '        this.state.currentPageGeneration ??\n' +
      '        null;',
    replace: '      this.state.plannedActionGeneration = null;',
  },
  // ── The contract ───────────────────────────────────────────────────────────
  {
    id: 'M5',
    file: CONTRACT,
    name: 'the non-consequential short-circuit is removed — freshness refuses ordinary actions',
    find: '  if (!input.consequential) {',
    replace: '  if (false) {',
  },
  {
    id: 'M6',
    file: CONTRACT,
    name: 'two observed readings that disagree about the DOCUMENT are ignored',
    find: "  if (input.differentDocument === true) {\n    return record('CONFLICT', 'DOCUMENT_REPLACED', 'STOP_AND_ASK');\n  }",
    replace: "  if (false) {\n    return record('CONFLICT', 'DOCUMENT_REPLACED', 'STOP_AND_ASK');\n  }",
  },
  {
    id: 'M7',
    file: CONTRACT,
    name: 'the URL conflict is ignored — the page may move freely without a refusal',
    find: '  if (input.observed && planned !== null && observedUrl !== null && planned !== observedUrl) {',
    replace: '  if (false) {',
  },
  {
    id: 'M8',
    file: CONTRACT,
    name: 'the generation comparison is removed — a stale plan is never recognised',
    find: '  if (plannedGeneration !== null && currentGeneration !== null && plannedGeneration < currentGeneration) {',
    replace: '  if (false) {',
  },
  {
    id: 'M9',
    file: CONTRACT,
    name: 'a MISSING observation falls through to FRESH (the original defect)',
    find: '  if (input.observed !== true) {',
    replace: '  if (false) {',
  },
  {
    id: 'M10',
    file: CONTRACT,
    name: 'an observation channel that FAILED is no longer distinguished from no channel at all',
    find: "      input.observationFailed === true ? 'OBSERVATION_FAILED' : 'NO_CURRENT_OBSERVATION',",
    replace: "      'NO_CURRENT_OBSERVATION',",
  },
  {
    id: 'M11',
    file: CONTRACT,
    name: 'a conflict is downgraded from STOP_AND_ASK to a refresh',
    find: "    return record('CONFLICT', 'URL_CHANGED_SINCE_PLANNING', 'STOP_AND_ASK');",
    replace: "    return record('CONFLICT', 'URL_CHANGED_SINCE_PLANNING', 'RE_PERCEIVE');",
  },
  {
    id: 'M12',
    file: CONTRACT,
    name: 'mayDispatchStaleView is granted unconditionally',
    find: "    mayDispatchStaleView: state === 'FRESH',",
    replace: '    mayDispatchStaleView: true,',
  },
];

const originals = {};
for (const f of new Set(MUTANTS.map((m) => m.file))) originals[f] = readFileSync(f, 'utf8');

const results = [];
for (const mutant of MUTANTS) {
  const source = originals[mutant.file];
  const mutated = source.replace(mutant.find, mutant.replace);
  if (mutated === source) {
    results.push({ id: mutant.id, name: mutant.name, outcome: 'NOT_APPLIED' });
    console.log(`${mutant.id} NOT_APPLIED ${mutant.name}`);
    continue;
  }
  writeFileSync(mutant.file, mutated);
  let killed = false;
  let detail = '';
  try {
    execFileSync('npx', ['vitest', 'run', '--silent=true', ...TESTS], { stdio: 'pipe' });
  } catch (err) {
    killed = true;
    detail = String(err.stdout || '')
      .split('\n')
      .filter((l) => /FAIL|Tests/.test(l))
      .slice(0, 3)
      .join(' | ');
  } finally {
    writeFileSync(mutant.file, source);
  }
  results.push({ id: mutant.id, name: mutant.name, outcome: killed ? 'KILLED' : 'SURVIVED', detail });
  console.log(`${mutant.id} ${killed ? 'KILLED' : 'SURVIVED'}      ${mutant.name}`);
}

const killed = results.filter((r) => r.outcome === 'KILLED').length;
const survivors = results.filter((r) => r.outcome === 'SURVIVED').length;
const summary = {
  phase: '18.8-A16',
  work: 'A16 pre-action state freshness — mutation suite',
  total: results.length,
  killed,
  survived: survivors,
  notApplied: results.filter((r) => r.outcome === 'NOT_APPLIED').length,
  results,
};
writeFileSync('docs/evidence/post-17-10/audit/a16_mutation_results.json', JSON.stringify(summary, null, 2));
console.log(`A16 MUTATION: ${killed}/${results.length} killed, ${survivors} survivors, ${summary.notApplied} not applied`);
process.exitCode = survivors === 0 && summary.notApplied === 0 ? 0 : 1;
