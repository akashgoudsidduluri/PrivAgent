/**
 * PHASE 18.7 / A5 — focused mutation suite for the evidence requirement.
 *
 * A5 adds a SUCCESS path's precondition. A precondition that can be removed
 * without any test noticing is not a precondition, so each one is removed here
 * in turn and the suite must go red.
 *
 * The mutants are chosen to be the ways this rule could rot:
 *   - the intent flag is ignored,
 *   - the verification status is ignored,
 *   - the freshness check is ignored,
 *   - the subject match is dropped,
 *   - a non-success result leaks a rule id,
 *   - and the pre-A5 non-regression is broken by over-tightening.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TEST = 'tests/phase18_7_a5EvidenceCompletion.test.ts';
const VERIFIER = path.join(ROOT, 'extension/src/agent/goalVerifier.ts');
const LOOP = path.join(ROOT, 'extension/src/agent/agentLoop.ts');
const LEDGER = path.join(ROOT, 'extension/src/evidence/evidenceLedger.ts');

const VERIFIER_SRC = fs.readFileSync(VERIFIER, 'utf8');
const LOOP_SRC = fs.readFileSync(LOOP, 'utf8');
const LEDGER_SRC = fs.readFileSync(LEDGER, 'utf8');

function restore() {
  fs.writeFileSync(VERIFIER, VERIFIER_SRC);
  fs.writeFileSync(LOOP, LOOP_SRC);
  fs.writeFileSync(LEDGER, LEDGER_SRC);
}

function apply(file, source, oldText, newText, label) {
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`[${label}] anchor matched ${count} times, expected 1`);
  fs.writeFileSync(file, source.replace(oldText, newText));
}

const MUTANTS = [
  {
    id: 'A5-M1',
    criterion: 'the intent flag is honoured — ignoring it restores the false success',
    file: VERIFIER,
    old: '  const requiresEvidence = state.intentRequiresEvidence === true;',
    next: '  const requiresEvidence = false;',
  },
  {
    id: 'A5-M2',
    criterion: 'the requirement fails closed — no check at all',
    file: VERIFIER,
    old: `  if (requiresEvidence && !evidenceSatisfied) {`,
    next: `  if (false) {`,
  },
  {
    id: 'A5-M3',
    criterion: 'verification status matters — any ledger key counts',
    file: VERIFIER,
    old: '  if (!keys || keys.length === 0) return false;',
    next: '  if (!keys) return true;',
  },
  {
    id: 'A5-M4',
    criterion: 'subject matching matters — any key satisfies the question',
    file: VERIFIER,
    old: '  const terms = subjectTermsFromTask(task);\n  if (terms.length === 0) return false;',
    next: '  const terms = [String(keys[0])];',
  },
  {
    id: 'A5-M5',
    criterion: 'unmet evidence is IN_PROGRESS, never a terminal state',
    file: VERIFIER,
    old: `    return {
      satisfied: false,
      status: 'IN_PROGRESS',
      reason:
        \`Evidence requirement unmet: the intent boundary marked this task as needing \` +`,
    next: `    return {
      satisfied: true,
      status: 'SUCCESS',
      reason:
        \`Evidence requirement unmet: the intent boundary marked this task as needing \` +`,
  },
  {
    id: 'A5-M6',
    criterion: 'the loop refreshes the verified keys before the verdict',
    file: LOOP,
    old: '      this.refreshEvidenceCompletionInputs();\n      if (this.isTaskGoalSatisfied(task, this.state, context)) {',
    next: '      if (this.isTaskGoalSatisfied(task, this.state, context)) {',
  },
  {
    id: 'A5-M7',
    criterion: 'stale records stop counting — the ledger citable() gate holds',
    // The freshness invariant lives in `citable()`, not in the loop. A first
    // pass re-checked it in the loop as well; that clause was dead (citable()
    // already excludes STALE), the mutant survived, and the duplicate was
    // removed rather than the test being weakened. The mutant now targets the
    // one place the rule actually lives.
    file: LEDGER,
    old: "        r.freshness === 'CURRENT' &&",
    next: "        true &&",
    // DOCUMENTED EQUIVALENT MUTANT, not an untested rule.
    //
    // `EvidenceLedger.advance()` sets `freshness: 'STALE'` AND
    // `verificationStatus: 'INVALIDATED'` together, and `verify()` refuses any
    // record whose freshness is not CURRENT. A STALE-but-still-VERIFIED record
    // is therefore unreachable through the public API, so the freshness clause
    // in `citable()` is defence-in-depth against a future code path rather than
    // a rule any current mutation can reach. The clause is KEPT because A2's
    // acceptance criterion 1 (a generation-N record can never satisfy a goal
    // evaluated at generation M) is a stated invariant, not a test artefact.
    //
    // Listing it here keeps the score honest instead of quietly counting a
    // survivor as a kill or padding the suite with a test that cannot fail.
    equivalent: true,
    equivalenceReason:
      'advance() invalidates verificationStatus alongside freshness, and verify() ' +
      'refuses non-CURRENT records, so STALE-but-VERIFIED is unreachable; the clause is defence-in-depth.',
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
    const failures = (out.match(/^\s+×/gm) || []).length;
    return { killed: true, summary: `suite failed (${failures} failing test(s))` };
  }
}

restore();
if (!runTests().killed) {
  console.log('BASELINE: clean suite is green — the run below is meaningful.\n');
} else {
  console.log('BASELINE: FAIL — already red before any mutation.');
  process.exit(1);
}

const results = [];
for (const m of MUTANTS) {
  restore();
  try {
    apply(m.file, fs.readFileSync(m.file, 'utf8'), m.old, m.next, m.id);
    const outcome = runTests();
    const killed = outcome.killed || m.equivalent === true;
    results.push({ ...m, ...outcome, killed });
    const label = outcome.killed ? 'KILLED  ' : m.equivalent ? 'EQUIVAL.' : 'SURVIVED';
    console.log(`${label} ${m.id}  ${m.criterion}\n          ${outcome.summary}`);
    if (m.equivalent && !outcome.killed) {
      console.log(`          documented equivalent mutant: ${m.equivalenceReason}`);
    }
  } catch (err) {
    results.push({ ...m, killed: false, summary: `MUTATION ERROR: ${err.message}` });
    console.log(`ERROR    ${m.id}  ${err.message}`);
  }
}

restore();
const restored = runTests();
const survivors = results.filter((r) => !r.killed);
const equivalents = results.filter((r) => r.equivalent === true);
console.log('');
console.log(`restored baseline: ${restored.killed ? 'RED (a mutant leaked)' : 'green'}`);
console.log(
  `\nA5 mutation score: ${results.length - survivors.length}/${results.length} resolved ` +
  `(${results.length - survivors.length - equivalents.length} killed, ${equivalents.length} documented-equivalent)`
);
for (const s of survivors) console.log(`  SURVIVED ${s.id}  ${s.criterion}\n           ${s.summary}`);
if (restored.killed) process.exit(2);
if (survivors.length > 0) process.exit(3);
console.log('\nEvery A5 mutant was killed or documented as equivalent.');