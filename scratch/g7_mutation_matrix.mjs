/**
 * G7 — mutation matrix for the declared-destination GoalVerifier branch.
 *
 * Every mutation is a real semantic change to `extension/src/agent/goalVerifier.ts`.
 * A mutation is KILLED when the focused suite goes red. The file is backed up
 * before the run and restored byte-for-byte after every mutant, verified with
 * sha256, so a crashed run can never leave production mutated.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const TARGET = 'extension/src/agent/goalVerifier.ts';
const BACKUP = 'scratch/.g7_mut_backup.ts';
const FOCUSED = ['tests/step10_6_g7DestinationGoalVerifier.test.ts'];

const original = readFileSync(TARGET, 'utf8');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const ORIGINAL_SHA = sha(original);
copyFileSync(TARGET, BACKUP);

const BRANCH_CALL = `  const destinationGoal = verifyDeclaredDestinationGoal(state, context);
  if (destinationGoal) {
    return destinationGoal;
  }
`;
const STATE_CHECK = `  if (destinationSubgoal.state !== 'COMPLETED') {`;
const RECHECK_IF = `  if (!recheck.satisfied) {`;
const OUTSTANDING_IF = `  if (outstanding.length > 0) {`;
const EXCLUSION = `  if (cond.type === 'STATE_CHANGED') return false;
  return true;`;

const MUTANTS = [
  {
    id: 'M1',
    desc: 'remove the declared-destination GoalVerifier branch entirely',
    from: BRANCH_CALL,
    to: '',
  },
  {
    id: 'M2',
    desc: 'a declared destination alone produces SUCCESS (ignore state and re-verification)',
    from: `  if (destinationSubgoal.state !== 'COMPLETED') {`,
    to: `  if (false) {`,
    anchorReplace: true,
  },
  {
    id: 'M3',
    desc: 'allow a PENDING / IN_PROGRESS destination subgoal to count as reached',
    from: STATE_CHECK,
    to: `  if (destinationSubgoal.state === 'FAILED') {`,
  },
  {
    id: 'M4',
    desc: 'allow UNKNOWN / MISMATCH destination re-verification to certify success',
    from: RECHECK_IF,
    to: `  if (recheck.satisfied) {`,
  },
  {
    id: 'M5',
    desc: 'bypass the destination verification path: trust the COMPLETED flag alone',
    from: `  if (!recheck.satisfied) {
    return notYet(
      \`Declared destination not confirmed on the current observation: \${recheck.reason}\`
    );
  }`,
    to: `  if (false) {
    return notYet('bypassed');
  }`,
  },
  {
    id: 'M6',
    desc: 'let a model/action claim certify success without a completed destination subgoal',
    from: STATE_CHECK,
    to: `  if (false) {`,
  },
  {
    id: 'M7',
    desc: 'remove the consequential-subgoal protection',
    from: OUTSTANDING_IF,
    to: `  if (false) {`,
  },
  {
    id: 'M8',
    desc: 'bypass GoalProgressTracker: match the destination locally in GoalVerifier',
    from: RECHECK_IF,
    to: `  if (((context.semantic_context as any)?.pageType ?? '') !== String(destinationSubgoal.destination?.role?.acceptablePageTypes?.[0] ?? '')) {`,
  },
  {
    id: 'M9',
    desc: "treat the decomposer's KNOWN-UNVERIFIABLE scaffolding as a requirement",
    from: EXCLUSION,
    to: `  return true;`,
  },
];

function runFocused() {
  try {
    execFileSync('npx', ['vitest', 'run', '--silent=true', ...FOCUSED], {
      stdio: 'pipe',
      timeout: 120000,
    });
    return { ok: true };
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    const m = out.match(/Tests\s+(?:(\d+) failed|.*?(\d+) failed)/);
    return { ok: false, detail: (m && (m[1] || m[2])) || 'failure' };
  }
}

const tally = { KILLED: 0, SURVIVED: 0, INVALID: 0, EQUIVALENT: 0 };
const results = [];

// Baseline must be green before any mutation means anything.
const base = runFocused();
console.log('baseline:', base.ok ? 'green' : 'RED — aborting');
if (!base.ok) {
  restore();
  process.exit(1);
}

for (const m of MUTANTS) {
  if (!original.includes(m.from)) {
    console.log(`${m.id} INVALID — anchor not found`);
    tally.INVALID++;
    results.push({ ...m, verdict: 'INVALID' });
    restore();
    continue;
  }
  writeFileSync(TARGET, original.replace(m.from, m.to));
  if (readFileSync(TARGET, 'utf8') === original) {
    console.log(`${m.id} INVALID — mutation was a no-op`);
    tally.INVALID++;
    results.push({ ...m, verdict: 'INVALID' });
    restore();
    continue;
  }
  const r = runFocused();
  const verdict = r.ok ? 'SURVIVED' : 'KILLED';
  tally[verdict]++;
  console.log(`${m.id} ${verdict}${r.ok ? '' : ` (${r.detail} failing)`} — ${m.desc}`);
  results.push({ ...m, verdict });
  restore();
}

function restore() {
  copyFileSync(BACKUP, TARGET);
  const now = sha(readFileSync(TARGET, 'utf8'));
  if (now !== ORIGINAL_SHA) {
    throw new Error('RESTORE FAILED — target is not byte-identical to the original');
  }
}

restore();
rmSync(BACKUP, { force: true });
console.log('\ntally', JSON.stringify(tally));
