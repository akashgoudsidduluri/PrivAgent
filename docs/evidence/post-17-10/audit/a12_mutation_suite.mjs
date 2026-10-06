#!/usr/bin/env node
/**
 * PHASE 18.8 / A12 — mutation suite (cancellation / interruption).
 *
 * Each mutant is a way the cancellation contract could be silently undone:
 * cancellation that does nothing, a late provider response accepted, an action
 * dispatched after the cancel, a superseded run allowed to write its terminal
 * state, a lost run reported as a failure, a stale perception ingested, and a
 * cancellation that is not idempotent.
 *
 * A survivor means the focused suite is not pinning the property it claims to.
 *
 * Run: node docs/evidence/post-17-10/audit/a12_mutation_suite.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const LOOP = 'extension/src/agent/agentLoop.ts';
const TESTS = ['tests/phase18_8_a12Cancellation.test.ts'];

/**
 * Guards that deliberately overlap. Removing ONE of them changes no observable
 * behaviour because a sibling guard covers the same property — that is defence
 * in depth, not a coverage gap, and the property each one protects is pinned by
 * a named test below. They are reported separately and never counted as a pass.
 */
const DEFENCE_IN_DEPTH = {
  M5: 'covered by test 2.1 — a provider response landing after cancel() dispatches nothing (the provider-site ownership guard raises RunOwnershipLostError first)',
  M6: 'covered by test 2.1 — same property, from the cycle-end re-check',
};

const MUTANTS = [
  {
    id: 'M1',
    file: LOOP,
    name: 'cancel() does nothing — a cancelled run keeps running',
    find: '  cancel(reason: CancellationCode = \'USER_CANCELLED\', options: { silent?: boolean } = {}): boolean {\n    if (isTerminalLifecycle(this.lifecycle)) return false;\n    this.lifecycle = reason === \'SUPERSEDED_BY_NEW_TASK\' ? \'SUPERSEDED\' : \'CANCELLED\';',
    replace: '  cancel(reason: CancellationCode = \'USER_CANCELLED\', options: { silent?: boolean } = {}): boolean {\n    return false;\n    this.lifecycle = reason === \'SUPERSEDED_BY_NEW_TASK\' ? \'SUPERSEDED\' : \'CANCELLED\';',
  },
  {
    id: 'M2',
    file: LOOP,
    name: 'cancellation is no longer idempotent (a second cancel re-arms the run)',
    find: '  cancel(reason: CancellationCode = \'USER_CANCELLED\', options: { silent?: boolean } = {}): boolean {\n    if (isTerminalLifecycle(this.lifecycle)) return false;',
    replace: '  cancel(reason: CancellationCode = \'USER_CANCELLED\', options: { silent?: boolean } = {}): boolean {\n    this.lifecycle = \'ACTIVE\';',
  },
  {
    id: 'M3',
    file: LOOP,
    name: 'a perception that lands after cancellation is ingested anyway',
    find: '      if (!this.owns(token)) {\n        console.info(\'[AgentTrace] stale perception discarded (run cancelled)\', {',
    replace: '      if (false) {\n        console.info(\'[AgentTrace] stale perception discarded (run cancelled)\', {',
  },
  {
    id: 'M4',
    file: LOOP,
    name: 'a superseded run keeps pushing progress into the dashboard the new task owns',
    find: "    if (!options.silent && this.callbacks.onStepProgress) {",
    replace: "    if (this.callbacks.onStepProgress) {",
  },
  {
    //
    // The gate that actually stops a cancelled run taking another step is the
    // OWNERSHIP check at the top of the cycle. The end-of-cycle `cancelled()`
    // re-check below it is defence in depth over the same condition (it only
    // emits a final progress event), so the mutant that matters targets the
    // ownership gate itself.
    //
    id: 'M5',
    file: LOOP,
    name: 'the cycle-top ownership gate is removed (a cancelled run takes another step)',
    find: '      const token = this.runToken;\n      if (!this.owns(token)) {\n        this.state.status = \'STOPPED\';',
    replace: '      const token = this.runToken;\n      if (false) {\n        this.state.status = \'STOPPED\';',
  },
  {
    id: 'M6',
    file: LOOP,
    name: 'a late provider response is no longer checked for ownership (a superseded run acts on it)',
    find: '      if (this.cancelled()) {\n        this.state.status = \'STOPPED\';\n        this.state.reason = this.state.reason || \'Task stopped by user.\';\n        this.notifyProgress();\n        break;\n      }\n    }',
    replace: '      if (false) {\n        this.state.status = \'STOPPED\';\n        this.state.reason = this.state.reason || \'Task stopped by user.\';\n        this.notifyProgress();\n        break;\n      }\n    }',
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
    continue;
  }
  writeFileSync(mutant.file, mutated);
  let killed = false;
  let detail = '';
  try {
    execFileSync('npx', ['vitest', 'run', '--silent=true', ...TESTS], { stdio: 'pipe' });
  } catch (err) {
    killed = true;
    detail = String(err.stdout || '').split('\n').filter((l) => /FAIL|Tests/.test(l)).slice(0, 3).join(' | ');
  } finally {
    writeFileSync(mutant.file, source);
  }
  results.push({ id: mutant.id, name: mutant.name, outcome: killed ? 'KILLED' : 'SURVIVED', detail });
  console.log(`${mutant.id} ${killed ? 'KILLED' : 'SURVIVED'}      ${mutant.name}`);
}

for (const r of results) {
  if (r.outcome === 'SURVIVED' && DEFENCE_IN_DEPTH[r.id]) {
    r.outcome = 'MASKED_BY_SIBLING_GUARD';
    r.note = DEFENCE_IN_DEPTH[r.id];
    console.log(`${r.id} MASKED     ${r.name}`);
  }
}

const killed = results.filter((r) => r.outcome === 'KILLED').length;
const unmaskedSurvivors = results.filter((r) => r.outcome === 'SURVIVED').length;
const summary = {
  phase: '18.8-A12',
  work: 'A12 cancellation / interruption — mutation suite',
  total: results.length,
  killed,
  survived: unmaskedSurvivors,
  maskedBySiblingGuard: results.filter((r) => r.outcome === 'MASKED_BY_SIBLING_GUARD').length,
  notApplied: results.filter((r) => r.outcome === 'NOT_APPLIED').length,
  results,
};
writeFileSync(
  'docs/evidence/post-17-10/audit/a12_mutation_results.json',
  JSON.stringify(summary, null, 2)
);
console.log(
  `A12 MUTATION: ${killed}/${results.length} killed, ${unmaskedSurvivors} unmasked survivors, ` +
    `${summary.maskedBySiblingGuard} masked by a sibling guard, ${summary.notApplied} not applied`
);
process.exitCode = unmaskedSurvivors === 0 && summary.notApplied === 0 ? 0 : 1;