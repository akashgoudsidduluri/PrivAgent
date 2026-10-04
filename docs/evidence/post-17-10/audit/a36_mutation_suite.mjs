/**
 * PHASE 18.7 / A3 + A6 — focused mutation suite.
 *
 * A passing test file proves nothing about whether the tests can FAIL. This
 * suite breaks one load-bearing behaviour of A3/A6 at a time and asserts the
 * suite goes red. A surviving mutant is reported as SURVIVED and fails the run,
 * because a green suite that cannot detect the defect it targets is the exact
 * failure mode the architecture audit exists to prevent.
 *
 * Each mutant targets a property the plan states as an acceptance criterion:
 *   A3 — decision state is an allowlist; internal security state stays local;
 *        intent is carried; criteria and evidence are bounded; observation
 *        states never collapse.
 *   A6 — dispatch is derived from gating, effect from an observed verdict, and
 *        the two never merge.
 *
 * Every mutant is reverted and the clean run is re-verified at the end, so a
 * run cannot report a kill that was actually caused by a leftover mutant.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TEST = 'tests/phase18_7_a3a6DecisionStateHistory.test.ts';
const HISTORY = path.join(ROOT, 'extension/src/agent/actionHistory.ts');
const DECISION = path.join(ROOT, 'extension/src/agent/decisionState.ts');

const HISTORY_SRC = fs.readFileSync(HISTORY, 'utf8');
const DECISION_SRC = fs.readFileSync(DECISION, 'utf8');

function restore() {
  fs.writeFileSync(HISTORY, HISTORY_SRC);
  fs.writeFileSync(DECISION, DECISION_SRC);
}

/** Apply a mutation, requiring the anchor to be present exactly once. */
function mutate(file, source, oldText, newText, label) {
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`[${label}] anchor matched ${count} times, expected 1`);
  fs.writeFileSync(file, source.replace(oldText, newText));
}

const MUTANTS = [
  {
    id: 'A6-M1',
    criterion: 'A6 — a gate refusal is POLICY_BLOCKED, never DISPATCHED',
    file: HISTORY,
    old: "  if (!step.validationAllowed) return 'POLICY_BLOCKED';",
    next: "  if (!step.validationAllowed) return 'DISPATCHED';",
  },
  {
    id: 'A6-M2',
    criterion: 'A6 — dispatch is NOT inferred from a successful execution',
    file: HISTORY,
    old: "  if (!step.executionSuccess) return 'EXECUTION_FAILED';",
    next: "  if (!step.executionSuccess) return 'DISPATCHED';",
  },
  {
    id: 'A6-M3',
    criterion: 'A6 — an unobserved effect is EFFECT_UNVERIFIABLE, never verified',
    file: HISTORY,
    old: "  if (!step.effectVerified && !step.effectStatus) return 'EFFECT_UNVERIFIABLE';",
    next: "  if (!step.effectVerified && !step.effectStatus) return 'EFFECT_VERIFIED';",
  },
  {
    id: 'A6-M4',
    criterion: 'A6 — dispatch and effect do not collapse: no dispatch means no effect',
    file: HISTORY,
    old: `  if (dispatchStatus === 'POLICY_BLOCKED' || dispatchStatus === 'NOT_DISPATCHED') {
    return 'NOT_APPLICABLE';
  }`,
    next: `  if (dispatchStatus === 'NOT_APPLICABLE' as never) {
    return 'NOT_APPLICABLE';
  }`,
  },
  {
    id: 'A6-M5',
    criterion: 'A6 — assertTruthfulHistory refuses to emit a lying history',
    file: HISTORY,
    old: `  const violations = findHistoryTruthfulnessViolations(entries);
  if (violations.length > 0) {`,
    next: `  const violations: string[] = [];
  if (violations.length > 0) {`,
  },
  {
    id: 'A3-M1',
    criterion: 'A3 — observation state defaults to UNKNOWN, never to OBSERVED',
    file: DECISION,
    old: "      observationState: input.pageObservationState ?? 'UNKNOWN',",
    next: "      observationState: input.pageObservationState ?? 'OBSERVED',",
  },
  {
    id: 'A3-M2',
    criterion: 'A3 — the goal projection is an ALLOWLIST; internal state stays local',
    file: DECISION,
    old: 'export function projectDecisionStateForModel(',
    // Replaced below with a body that spreads the whole input through.
    next: null,
  },
  {
    id: 'A3-M3',
    criterion: 'A3 — goal status defaults to PENDING, never SATISFIED',
    file: DECISION,
    old: "    goal: { status: input.goalStatus ?? 'PENDING' },",
    next: "    goal: { status: input.goalStatus ?? 'SATISFIED' },",
  },
  {
    id: 'A3-M4',
    criterion: 'A3 — the rendered state reports COUNTS, not raw criterion text',
    file: DECISION,
    old: "  lines.push(`Pending criteria: ${state.pendingCriteria.length}`);",
    next: "  lines.push(`Pending criteria: ${state.pendingCriteria.join(', ')}`);",
  },
  {
    id: 'A3-M5',
    criterion: 'A3 — evidence references are bounded',
    file: DECISION,
    old: 'export const MAX_EVIDENCE_REFERENCES = 20;',
    next: 'export const MAX_EVIDENCE_REFERENCES = 100000;',
  },
  {
    id: 'A3-M6',
    criterion: 'A3 — criteria are bounded',
    file: DECISION,
    old: 'export const MAX_CRITERIA = 20;',
    next: 'export const MAX_CRITERIA = 100000;',
  },
];

function runTests() {
  try {
    execFileSync('npx', ['vitest', 'run', '--silent=true', TEST], {
      cwd: ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return { killed: false, summary: 'suite passed' };
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    const m = out.match(/Tests\s+(?:(\d+) failed[^\n]*?\|\s*)?(\d+) passed/);
    const failures = (out.match(/^\s+×/gm) || []).length;
    return {
      killed: true,
      summary: `suite failed (${failures} failing assertion block(s)${m ? `, ${m[1] ?? 0} test(s) failed` : ''})`,
    };
  }
}

// The two behavioural rewrites that need more than a one-line swap.
function applyA3M2(source) {
  const start = source.indexOf('export function projectDecisionStateForModel(');
  if (start === -1) throw new Error('[A3-M2] projection not found');
  const marker = '\n}\n';
  const end = source.indexOf(marker, start);
  if (end === -1) throw new Error('[A3-M2] projection body end not found');
  // Replace the whole function with a permissive one that forwards everything,
  // including any authority field a caller smuggled in.
  return (
    source.slice(0, start) +
    'export function projectDecisionStateForModel(input: ModelFacingDecisionState): ModelFacingDecisionState {\n' +
    '  return { ...input } as ModelFacingDecisionState;\n' +
    source.slice(end)
  );
}

restore();
const baseline = runTests();
if (!baseline.killed) {
  console.log('BASELINE: clean suite is green — good, the run below is meaningful.');
} else {
  console.log('BASELINE: FAIL — the suite is already red before any mutation.');
  process.exit(1);
}

const results = [];
for (const mutant of MUTANTS) {
  restore();
  try {
    if (mutant.id === 'A3-M2') {
      fs.writeFileSync(mutant.file, applyA3M2(DECISION_SRC));
    } else if (mutant.next === null) {
      throw new Error('mutant has no replacement');
    } else {
      mutate(mutant.file, fs.readFileSync(mutant.file, 'utf8'), mutant.old, mutant.next, mutant.id);
    }
    const outcome = runTests();
    results.push({ ...mutant, ...outcome });
    console.log(
      `${outcome.killed ? 'KILLED  ' : 'SURVIVED'} ${mutant.id}  ${mutant.criterion}\n` +
      `          ${outcome.summary}`
    );
  } catch (err) {
    results.push({ ...mutant, killed: false, summary: `MUTATION ERROR: ${err.message}` });
    console.log(`ERROR    ${mutant.id}  ${err.message}`);
  }
}

restore();
const restored = runTests();
console.log('');
console.log(
  `restored baseline: ${restored.killed ? 'RED (a mutant leaked through — results are invalid)' : 'green'}`
);

const survivors = results.filter((r) => !r.killed);
const killed = results.length - survivors.length;
console.log(`\nA3/A6 mutation score: ${killed}/${results.length} killed`);

if (survivors.length > 0) {
  console.log('\nSURVIVORS (each needs either a test or an explicit equivalence argument):');
  for (const s of survivors) console.log(`  ${s.id}  ${s.criterion}\n           ${s.summary}`);
}
if (restored.killed) process.exit(2);
if (survivors.length > 0) process.exit(3);
console.log('\nEvery A3/A6 mutant was killed.');