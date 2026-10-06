#!/usr/bin/env node
/**
 * DYNAMIC TASK-AWARE UI — mutation suite for the critical invariants.
 *
 *   M1  "Always render browser activity" — the conversation branch of the
 *       projection is disabled, so every message gets the browser surface.
 *   M2  "Always render Step 1 of 10" — the compact activity count is replaced
 *       with the fabricated fixed step counter the audit forbids.
 *   M3  "Conversation route still displays browser timeline" — the workspace's
 *       conversation branch renders the full browser task card instead.
 *
 * A survivor means the focused suite is not pinning the property it claims
 * to. Authorities outside this UI layer are never touched.
 *
 * Run: node docs/evidence/dynamic-ui/ui_mutation_suite.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const PROJECTION = 'frontend/src/ui/uiProjection.ts';
const WORKSPACE = 'frontend/src/components/agentWorkspace.ts';
const TESTS = ['tests/dynamicUi.test.ts'];

const MUTANTS = [
  {
    id: 'M1',
    file: PROJECTION,
    name: 'always render browser activity — the conversation branch is dead',
    find: '  if (isConversational(state)) {',
    replace: '  if (false && isConversational(state)) {',
  },
  {
    id: 'M2',
    file: WORKSPACE,
    name: 'always render "Step 1 of 10" — the fabricated step counter returns',
    find: '${ui.activityCount} ${ui.activityCount === 1 ? \'activity\' : \'activities\'}',
    replace: 'Step 1 of 10',
  },
  {
    id: 'M3',
    file: WORKSPACE,
    name: 'conversation route displays the browser timeline / task card',
    find: '${this.renderConversationResponse(state, ui)}',
    replace: '${this.renderBrowserTaskCard(state, ui)}',
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
      .filter((l) => /FAIL|Tests |×/.test(l))
      .slice(0, 4)
      .join(' | ')
      .slice(0, 500);
  } finally {
    writeFileSync(mutant.file, source);
  }
  results.push({ id: mutant.id, name: mutant.name, outcome: killed ? 'KILLED' : 'SURVIVED', detail });
  console.log(`${mutant.id} ${killed ? 'KILLED' : 'SURVIVED'}      ${mutant.name}`);
}

const killed = results.filter((r) => r.outcome === 'KILLED').length;
const survivors = results.filter((r) => r.outcome === 'SURVIVED').length;
const summary = {
  phase: 'DYNAMIC-TASK-AWARE-UI',
  work: 'Dynamic UI critical invariants — mutation suite',
  tests: TESTS,
  total: results.length,
  killed,
  survived: survivors,
  notApplied: results.filter((r) => r.outcome === 'NOT_APPLIED').length,
  results,
};
writeFileSync('docs/evidence/dynamic-ui/ui_mutation_results.json', JSON.stringify(summary, null, 2));
console.log(`DYNAMIC UI MUTATION: ${killed}/${results.length} killed, ${survivors} survivors, ${summary.notApplied} not applied`);
process.exitCode = survivors === 0 && summary.notApplied === 0 ? 0 : 1;
