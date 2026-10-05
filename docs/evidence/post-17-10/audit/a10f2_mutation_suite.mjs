#!/usr/bin/env node
/**
 * PHASE 18.8 / A10-F2 — mutation suite.
 *
 * Each mutant is a plausible way this fix could be undone or weakened. The two
 * that matter most are M1 (the original unmapped code) and M3 (the safety
 * property: an unknown effect must never re-dispatch).
 *
 * Run: node docs/evidence/post-17-10/audit/a10f2_mutation_suite.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const RECOVERY = 'extension/src/agent/recoveryEngine.ts';
const LOOP = 'extension/src/agent/agentLoop.ts';
const TESTS = 'tests/phase18_8_a10f2EffectUnverifiable.test.ts';

const MUTANTS = [
  {
    id: 'M1',
    file: RECOVERY,
    name: 'EFFECT_UNVERIFIABLE unmapped again (the original defect)',
    find: "  EFFECT_UNVERIFIABLE: 'REPERCEIVE',\n\n  // ── Grounding",
    replace: "\n  // ── Grounding",
  },
  {
    id: 'M2',
    file: RECOVERY,
    name: 'category folded back into NO_EFFECT (truthfulness regression)',
    find: "  if (input.effectStatus === 'EFFECT_UNVERIFIABLE') return 'EFFECT_UNVERIFIABLE';",
    replace: "  if (input.effectStatus === 'EFFECT_UNVERIFIABLE') return 'NO_EFFECT';",
  },
  {
    id: 'M3',
    file: RECOVERY,
    name: 'unknown effect may reach CHANGE_STRATEGY (blind re-dispatch)',
    find: "    EFFECT_UNVERIFIABLE: Object.freeze(['RE_PERCEIVE'] as const),",
    replace: "    EFFECT_UNVERIFIABLE: Object.freeze(['RE_PERCEIVE', 'CHANGE_STRATEGY'] as const),",
  },
  {
    id: 'M4',
    file: RECOVERY,
    name: 'budget raised so the retry is no longer bounded to one',
    find: '  EFFECT_UNVERIFIABLE: 1,',
    replace: '  EFFECT_UNVERIFIABLE: 5,',
  },
  {
    id: 'M5',
    file: RECOVERY,
    name: 'strategy degrades to REPERCEIVE without requiring fresh perception',
    find: "  EFFECT_UNVERIFIABLE: 'REPERCEIVE',\n\n  // ── Grounding",
    replace: "  EFFECT_UNVERIFIABLE: 'ABORT',\n\n  // ── Grounding",
  },
  {
    id: 'M6',
    file: LOOP,
    name: 'loop falls back to the blind maxRetries bound (repeat an unknown effect)',
    // ALL occurrences: there are two unobservable-effect sites in the loop, and
    // a mutant that only reaches one of them measures nothing.
    all: true,
    find: "= this.planRecoveryForLastStep('EFFECT_UNVERIFIABLE');",
    replace: "= { exhausted: this.state.retryCount > this.maxRetries } as never;",
  },
  {
    id: 'M7',
    file: LOOP,
    name: 'loop re-emits the internal engine string as the user-facing reason',
    all: true,
    find: '"I couldn\'t verify whether the action took effect, so I stopped without repeating it.";',
    replace: '`Effect verification unavailable repeatedly: ${unobservableRecord.reason}`;',
  },
  {
    id: 'M8',
    file: LOOP,
    name: 'verifier verdict downgraded to NO_EFFECT at the effect-verifier site',
    find: "          effectResult.status === 'EFFECT_UNVERIFIABLE'\n            ? 'EFFECT_UNVERIFIABLE'\n            : this.longHorizon.semanticProgressVerdict().stagnation === 'OSCILLATION'\n              ? 'OSCILLATION'\n              : 'NO_EFFECT'",
    replace: "          this.longHorizon.semanticProgressVerdict().stagnation === 'OSCILLATION' ? 'OSCILLATION' : 'NO_EFFECT'",
  },
  {
    id: 'M9',
    file: LOOP,
    name: 'exhausted EFFECT_UNVERIFIABLE falls back to the internal engine string',
    find: `            exhaustedCategory === 'EFFECT_UNVERIFIABLE'\n              ? "I couldn't verify whether the action took effect, so I stopped without repeating it."\n              : exhaustedRecord.reason;`,
    replace: `            exhaustedRecord.reason;`,
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
  const injected = mutant.all
    ? original.split(mutant.find).join(mutant.replace)
    : original.replace(mutant.find, mutant.replace);
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
  phase: '18.8-A10-F2',
  work: 'A10-F2 EFFECT_UNVERIFIABLE typed recovery — mutation suite',
  total: results.length,
  killed,
  survived,
  notApplied,
  results,
};

writeFileSync('docs/evidence/post-17-10/audit/a10f2_mutation_results.json', JSON.stringify(report, null, 2));
console.log(`A10-F2 MUTATION: ${killed}/${results.length} killed, ${survived} survived, ${notApplied} not applied`);
for (const r of results) console.log(`  ${r.id} ${r.verdict.padEnd(11)} ${r.name}`);
process.exit(survived > 0 || notApplied > 0 ? 1 : 0);