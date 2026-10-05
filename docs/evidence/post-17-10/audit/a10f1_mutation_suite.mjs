#!/usr/bin/env node
/**
 * PHASE 18.8 / A10-F1 — mutation suite.
 *
 * Each mutant is a plausible way this fix could be undone or weakened. A mutant
 * that SURVIVES means the suite would not notice, which is the failure mode a
 * mutation suite exists to rule out.
 *
 * Run: node docs/evidence/post-17-10/audit/a10f1_mutation_suite.mjs
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ROUTER = 'extension/src/agent/modelRouter.ts';
const LEDGER = 'extension/src/evidence/evidenceLedger.ts';
const TESTS = 'tests/phase18_8_a10f1AnswerProductionWiring.test.ts';

const MUTANTS = [
  {
    id: 'M1',
    name: 'requestStep removed from ModelRouter (the original defect)',
    find: '  async requestStep(\n    task: string,',
    replace: '  async requestStepDISABLED(\n    task: string,',
  },
  {
    id: 'M2',
    name: 'terminal proposal coerced into an action (ANSWER becomes a dispatch)',
    find: "    return requestStep(task, context, history, role);",
    replace: "    const s = await requestStep(task, context, history, role);\n    return s.kind === 'TERMINAL_PROPOSAL' ? { kind: 'ACTION', action: SCROLL_MUTANT } : s;",
  },
  {
    id: 'M3',
    name: 'router inspects and repairs a malformed backend step',
    find: "    return requestStep(task, context, history, role);",
    replace: "    const s = await requestStep(task, context, history, role);\n    if (s.kind === 'ACTION' && (s.action as { direction?: string }).direction === 'sideways') {\n      return { kind: 'ACTION', action: { action: 'scroll', direction: 'down', amount: 100 } };\n    }\n    return s;",
  },
  {
    id: 'M4',
    name: 'role selection skipped on the step path (router no longer routes)',
    find: "    const requestStep = this.backendProvider.requestStep?.bind(this.backendProvider);\n    if (!requestStep) {",
    replace: "    const requestStep = this.backendProvider.requestStep?.bind(this.backendProvider);\n    if (requestStep) {\n      const direct = await requestStep(task, context, history);\n      this.previousRole = this.previousRole;\n      return direct;\n    }\n    if (!requestStep) {",
  },
  {
    id: 'M5',
    name: 'action-only backends break (fallback path removed)',
    find: "      return { kind: 'ACTION', action: await this.backendProvider.requestAction(task, context, history, role) };",
    replace: "      throw new Error('mutant: no step provider');",
  },
  {
    id: 'M6',
    name: 'escalation bookkeeping no longer recorded on the step path',
    find: '    this.previousRole = role;\n    return role;',
    replace: '    return role;',
  },
  {
    id: 'M7',
    file: 'LEDGER',
    name: 'the verification PROMOTION is removed (records stay UNVERIFIED — the second half of the defect)',
    find: '        this.verify(rec.id);',
    replace: '        void rec;',
  },
  {
    id: 'M8',
    file: 'LEDGER',
    name: 'promotion bypasses the verify() gate (a conflicted record can be marked VERIFIED)',
    find: '        this.verify(rec.id);',
    replace:
      "        const rec2 = this.byIdSafe(rec.id);\n" +
      "        if (rec2) { this.byId.set(rec.id, { ...rec2, verificationStatus: 'VERIFIED' }); this.records = this.records.map((r) => (r.id === rec.id ? this.byId.get(rec.id)! : r)); }",
  },
];

const FILES = { ROUTER, LEDGER };
for (const f of new Set(MUTANTS.map((m) => FILES[m.file] ?? ROUTER))) {
  if (!f.includes('..')) copyFileSync(f, `/tmp/a10f1_mutation_${f.replace(/[^a-z0-9]/gi, '_')}.ts`);
}
const originals = {};
for (const f of new Set(MUTANTS.map((m) => FILES[m.file] ?? ROUTER))) originals[f] = readFileSync(f, 'utf8');
const results = [];

for (const mutant of MUTANTS) {
  const file = FILES[mutant.file] ?? ROUTER;
  const original = originals[file];
  if (!original.includes(mutant.find)) {
    results.push({ ...mutant, verdict: 'NOT_APPLIED', detail: 'anchor text not found' });
    continue;
  }
  // M2/M3 need a constant that does not exist in the file; use a literal instead.
  const injected = original.replace(
    mutant.find,
    mutant.replace.replace(/SCROLL_MUTANT/g, "{ action: 'scroll', direction: 'down', amount: 400 }")
  );
  writeFileSync(file, injected);
  let killed = false;
  let detail = '';
  try {
    execFileSync('npx', ['vitest', 'run', '--silent=true', TESTS], {
      stdio: 'pipe',
      timeout: 180_000,
    });
  } catch (err) {
    killed = true;
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    detail = (out.match(/Tests\s+.*/) ?? ['tests failed'])[0].trim();
  }
  results.push({ ...mutant, verdict: killed ? 'KILLED' : 'SURVIVED', detail });
  writeFileSync(file, original);
}

for (const f of Object.keys(originals)) {
  try { unlinkSync(`/tmp/a10f1_mutation_${f.replace(/[^a-z0-9]/gi, '_')}.ts`); } catch {}
}

const killed = results.filter((r) => r.verdict === 'KILLED').length;
const survived = results.filter((r) => r.verdict === 'SURVIVED').length;
const notApplied = results.filter((r) => r.verdict === 'NOT_APPLIED').length;

const report = {
  phase: '18.8-A10-F1',
  work: 'A10-F1 production ANSWER wiring — mutation suite',
  total: results.length,
  killed,
  survived,
  notApplied,
  results,
};

const outPath = 'docs/evidence/post-17-10/audit/a10f1_mutation_results.json';
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`A10-F1 MUTATION: ${killed}/${results.length} killed, ${survived} survived, ${notApplied} not applied`);
for (const r of results) console.log(`  ${r.id} ${r.verdict.padEnd(11)} ${r.name}`);
process.exit(survived > 0 || notApplied > 0 ? 1 : 0);