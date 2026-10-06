#!/usr/bin/env node
/**
 * PHASE 18.8 / A14 — mutation suite (uncertain commit / side-effect idempotency).
 *
 * Each mutant is a way the commit contract could be silently undone: the
 * dispatch gate removed, an unverifiable commit settled as if it were observed,
 * execution success taken as proof, an inconclusive re-perception allowed to
 * close the record, an unobserved page read as a failure, a resolved commit
 * still blocking, and task wording allowed to turn a scroll into an order.
 *
 * A survivor means the focused suite is not pinning the property it claims to.
 *
 * Run: node docs/evidence/post-17-10/audit/a14_mutation_suite.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const CONTRACT = 'extension/src/agent/commitCertainty.ts';
const LOOP = 'extension/src/agent/agentLoop.ts';
const TESTS = ['tests/phase18_8_a14CommitCertainty.test.ts'];

const MUTANTS = [
  {
    id: 'M1',
    file: LOOP,
    name: 'the dispatch gate is removed — an unresolved commit does not block a duplicate',
    find: '      if (!commitGate.allowed && commitGate.blockedBy) {',
    replace: '      if (false && !commitGate.allowed && commitGate.blockedBy) {',
  },
  {
    id: 'M2',
    file: CONTRACT,
    name: 'the effect verifier settles an UNOBSERVED commit as committed',
    find: '  if (effect.effectVerified) {\n    return Object.freeze({\n      ...record,\n      certainty: \'EFFECT_VERIFIED\' as const,',
    replace: '  if (true) {\n    return Object.freeze({\n      ...record,\n      certainty: \'EFFECT_VERIFIED\' as const,',
  },
  {
    id: 'M3',
    file: CONTRACT,
    name: 'execution success is taken as proof of the commit (the original defect)',
    find: "  if (!executionSuccess) {\n    // The call failed. Whether the server acted is unknown.\n    return finish('COMMIT_UNKNOWN', 'EXECUTION_FAILED', 'VERIFY_EXTERNAL', true);\n  }",
    replace:
      "  if (!executionSuccess) {\n    // The call failed. Whether the server acted is unknown.\n    return finish('COMMIT_UNKNOWN', 'EXECUTION_FAILED', 'VERIFY_EXTERNAL', true);\n  }\n  if (true) {\n    return finish('EFFECT_VERIFIED', 'RESOLVED_COMMITTED', 'PROCEED', false);\n  }",
  },
  {
    id: 'M4',
    file: CONTRACT,
    name: 'an inconclusive re-perception is allowed to CLOSE the commit',
    find: '  if (!verification.resolved) {\n    return records.map((r) =>\n      r === open ? Object.freeze({ ...r, certainty: verification.certainty, unresolved: true }) : r\n    );\n  }',
    replace: '  if (false) {\n    return records.map((r) => r);\n  }',
  },
  {
    id: 'M5',
    file: CONTRACT,
    name: 'a page that merely fails to mention the outcome is read as a FAILED commit',
    find: "  const failed = seen(FAILURE_MARKERS);\n  if (failed) {",
    replace:
      "  const failed = seen(FAILURE_MARKERS);\n  if (!failed && markers.length > 0) {\n    return {\n      status: 'NOT_COMMITTED',\n      code: 'FAILURE_OBSERVED',\n      certainty: 'EFFECT_UNVERIFIED',\n      resolved: true,\n      evidence: null,\n    };\n  }\n  if (failed) {",
  },
  {
    id: 'M6',
    file: LOOP,
    name: 'the effect-verifier settlement is not written back (the commit stays open after an observed effect)',
    find: '    this.state.commitRecords = records.map((r) => (r === open ? settled : r));\n    this.state.lastCommit = settled;',
    replace: '    this.state.commitRecords = records;\n    this.state.lastCommit = settled;',
  },
  {
    id: 'M9',
    file: LOOP,
    name: 'a CONFIRMED re-perception is not written back to the commit records',
    find: '    const resolved = resolveCommit(records, open, verification);\n    this.state.commitRecords = resolved;',
    replace: '    const resolved = resolveCommit(records, open, verification);\n    this.state.commitRecords = records;',
  },
  {
    id: 'M7',
    file: CONTRACT,
    name: 'a resolved commit still blocks its class',
    find: '  const open = openCommits.find((c) => c.unresolved && c.actionClass === actionClass);\n  return open ? { allowed: false, blockedBy: open } : { allowed: true };',
    replace: '  const open = openCommits.find((c) => c.actionClass === actionClass);\n  return open ? { allowed: false, blockedBy: open } : { allowed: true };',
  },
  {
    id: 'M8',
    file: CONTRACT,
    name: 'task wording may turn a non-mutating action (a scroll) into a commit',
    find: '  const dispatchesMutation = act === \'click\' || act === \'presskey\' || act === \'type\' || act === \'select\';\n  const wording = dispatchesMutation ? `${target} ${url}` : \'\';\n  const taskWording = act === \'click\' || act === \'presskey\' ? task : \'\';',
    replace: "  const wording = `${target} ${url}`;\n  const taskWording = task;",
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
  phase: '18.8-A14',
  work: 'A14 uncertain commit / side-effect idempotency — mutation suite',
  total: results.length,
  killed,
  survived: survivors,
  notApplied: results.filter((r) => r.outcome === 'NOT_APPLIED').length,
  results,
};
writeFileSync('docs/evidence/post-17-10/audit/a14_mutation_results.json', JSON.stringify(summary, null, 2));
console.log(`A14 MUTATION: ${killed}/${results.length} killed, ${survivors} survivors, ${summary.notApplied} not applied`);
process.exitCode = survivors === 0 && summary.notApplied === 0 ? 0 : 1;
