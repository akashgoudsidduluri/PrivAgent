#!/usr/bin/env node
/**
 * PHASE 18.8 / B1 — mutation suite.
 *
 * Each mutant is a plausible way the B1 result card could be undone or
 * weakened: the answer dropped, the internal reason rendered, the recovery
 * category ignored, the privacy sweep skipped, or the ledger's VERIFIED filter
 * relaxed. A mutant that survives means the B1 test suite is not pinning the
 * property it claims to pin.
 *
 * Run: node docs/evidence/post-17-10/audit/b1_mutation_suite.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const OUTPUT = 'extension/src/agent/agentOutput.ts';
const LOOP = 'extension/src/agent/agentLoop.ts';
const TESTS = 'tests/phase18_8_b1UserFacingResult.test.ts';

const MUTANTS = [
  {
    id: 'M1',
    file: OUTPUT,
    name: 'FAILED renders the internal reason (the original B1 defect)',
    find: '      body: userSafeFailureExplanation(s),',
    replace: '      body: s.reason ?? userSafeFailureExplanation(s),',
  },
  {
    id: 'M2',
    file: OUTPUT,
    name: 'ANSWER body dropped (an answered task shows nothing)',
    find: "    return { kind: 'ANSWER', headline: FINAL_HEADLINE.ANSWER, body: answer, provenance, remaining: [] };",
    replace: "    return { kind: 'ANSWER', headline: FINAL_HEADLINE.ANSWER, body: null, provenance: null, remaining: [] };",
  },
  {
    id: 'M3',
    file: OUTPUT,
    name: 'egress screening of the result body disabled (privacy bypass)',
    find: '    if (finalResult.body && isTripped(finalResult.body)) {',
    replace: '    if (false) {',
  },
  {
    id: 'M4',
    file: OUTPUT,
    name: 'card headline/remaining no longer structurally checked',
    find: "    o.finalResult?.kind ?? '',\n    o.finalResult?.headline ?? '',\n    ...(o.finalResult?.remaining ?? []),",
    replace: "    o.finalResult?.kind ?? '',",
  },
  {
    id: 'M5',
    file: OUTPUT,
    name: 'recovery-exhausted record lookup disabled (wrong fixed sentence)',
    find: "  if (category === 'RECOVERY_EXHAUSTED') {",
    replace: '  if (false) {',
  },
  {
    id: 'M6',
    file: OUTPUT,
    name: 'information statuses no longer terminal (answered task looks IDLE)',
    find: "    status === 'ANSWER' ||\n    status === 'PARTIAL' ||\n    status === 'CANNOT_VERIFY' ||\n    status === 'NEEDS_INFORMATION'",
    replace: '    false',
  },
  {
    id: 'M7',
    file: LOOP,
    name: 'composed answer accepts UNVERIFIED evidence',
    find: "    if (record.verificationStatus !== 'VERIFIED') continue;",
    replace: "    if (record.verificationStatus === 'QUARANTINED') continue;",
  },
];

const originals = {};
for (const f of new Set(MUTANTS.map((m) => m.file))) originals[f] = readFileSync(f, 'utf8');

const results = [];
for (const mutant of MUTANTS) {
  const original = originals[mutant.file];
  if (!original.includes(mutant.find)) {
    results.push({ ...mutant, verdict: 'NOT_APPLIED', detail: 'anchor text not found' });
    continue;
  }
  const injected = original.replace(mutant.find, mutant.replace);
  writeFileSync(mutant.file, injected);
  let killed = false;
  let detail = '';
  try {
    execFileSync('npx', ['vitest', 'run', '--silent=true', TESTS], { stdio: 'pipe', timeout: 180_000 });
  } catch (err) {
    killed = true;
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    detail = (out.match(/Tests\s+.*/) ?? ['tests failed'])[0].trim();
  }
  results.push({ ...mutant, verdict: killed ? 'KILLED' : 'SURVIVED', detail });
  writeFileSync(mutant.file, original);
}

const killed = results.filter((r) => r.verdict === 'KILLED').length;
const survived = results.filter((r) => r.verdict === 'SURVIVED').length;
const notApplied = results.filter((r) => r.verdict === 'NOT_APPLIED').length;

const report = {
  phase: '18.8-B1',
  work: 'B1 typed user-facing result — mutation suite',
  total: results.length,
  killed,
  survived,
  notApplied,
  results,
};

writeFileSync('docs/evidence/post-17-10/audit/b1_mutation_results.json', JSON.stringify(report, null, 2));
console.log(`B1 MUTATION: ${killed}/${results.length} killed, ${survived} survived, ${notApplied} not applied`);
for (const r of results) console.log(`  ${r.id} ${r.verdict.padEnd(11)} ${r.name}`);
