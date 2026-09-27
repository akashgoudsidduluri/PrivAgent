/**
 * PHASE 17.6 (J) — MUTATION HARNESS.
 *
 * Every mutation below deliberately breaks ONE critical invariant. A surviving
 * mutation means a missing test, and the rule for this phase is explicit: do
 * NOT weaken the test, fix the missing invariant.
 *
 * Run a bounded slice:  node scratch/mut17_6.mjs <from> <to>
 * Run everything:       node scratch/mut17_6.mjs
 *
 * CRASH SAFETY. A tool deadline can kill this process at any instant. If it
 * died between writing a mutation and restoring it, a PRODUCTION file would be
 * left broken — the exact class of harm this phase exists to prevent. So the
 * pristine contents are journalled to disk BEFORE any mutation is written, a
 * pre-flight sweep restores anything left by a previously killed run, and a
 * final sweep asserts every mutation anchor is back to its original state.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const REPO = process.cwd();
const MUT = (f) => path.join(REPO, f);
const JOURNAL = path.join(REPO, 'scratch', '.mut17_6_journal.json');
const EVIDENCE = path.join(REPO, 'docs', 'evidence', 'phase17', '17.6-multistep', 'mutation_results.json');

const SUITES = [
  'tests/phase17/phase176ProgressContract.test.ts',
  'tests/phase17/reasonerProviderRobustness.test.ts',
  'tests/phase17/reasonerProviderLoopLevel.test.ts',
  'tests/phase17/securityCriticNavigationScope.test.ts',
  'tests/phase8SecurityCritic.test.ts',
  'tests/agentLoop.test.ts',
  'tests/phase9LongHorizon.test.ts',
  'tests/goalVerifier.test.ts',
  'tests/phase12/containment.test.ts',
  'tests/phase16-remediation/navigationObservation.test.ts',
  'tests/phase16/securityAuthorities.test.ts',
  'tests/staleTargetSafety.test.ts',
  'tests/hierarchicalPlanningAcceptance.test.ts',
  'tests/subgoalGraph.test.ts',
  'tests/securityBoundary.test.ts',
].filter((f) => fs.existsSync(MUT(f)));

function runTests() {
  try {
    const out = execFileSync('npx', ['vitest', 'run', ...SUITES, '--reporter=basic'], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 240_000,
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}\n${e.stderr || ''}` };
  }
}

/*
 * COUNTING FAILURES HONESTLY.
 *
 * The first version of this function matched /(\d+)\s+failed/ anywhere in the
 * output. That is wrong: the agent loop logs the literal string "M6 failed" on
 * every bounded termination, and several test NAMES contain "failed", so the
 * regex reported 6 failing tests for a run in which every single test PASSED.
 * Eleven mutations were reported CAUGHT on the strength of that fiction.
 *
 * Vitest's own SUMMARY lines are the only reliable signal, and the exit code
 * is the authoritative one. Both are used: the exit code decides CAUGHT, and
 * the summary is only used to report how many.
 */
const countFails = (out) => {
  const summaryTests = out.match(/^\s*Tests\s+.*?(\d+)\s+failed/m);
  if (summaryTests) return Number(summaryTests[1]);
  const summaryFiles = out.match(/^\s*Test Files\s+.*?(\d+)\s+failed/m);
  if (summaryFiles) return Number(summaryFiles[1]);
  if (/^\s*FAIL\s/m.test(out)) return 1;
  return 0;
};

// ── crash safety ───────────────────────────────────────────────────────────
function restoreFromJournal() {
  if (!fs.existsSync(JOURNAL)) return 0;
  try {
    const e = JSON.parse(fs.readFileSync(JOURNAL, 'utf8'));
    if (e && e.file && typeof e.original === 'string') {
      fs.writeFileSync(path.join(REPO, e.file), e.original);
      console.log(`[mut17_6] RECOVERED leftover mutation ${e.id} of ${e.file}`);
      return 1;
    }
  } catch { /* corrupt journal */ }
  try { fs.rmSync(JOURNAL, { force: true }); } catch { /* gone */ }
  return 0;
}
const journal = (id, file, original) =>
  fs.writeFileSync(JOURNAL, JSON.stringify({ id, file, original }, null, 2));
const clearJournal = () => { try { fs.rmSync(JOURNAL, { force: true }); } catch { /* gone */ } };

// ── the mutations ──────────────────────────────────────────────────────────
const MUTATIONS = [
  {
    id: 'M1',
    name: 'remove the observation requirement before subgoal success',
    file: 'extension/src/agent/agentLoop.ts',
    from: `        if (subgoalVerification.satisfied) {
          this.subgoalGraph.completeSubgoal(activeSubgoal.id);`,
    to: `        if (true) {
          this.subgoalGraph.completeSubgoal(activeSubgoal.id);`,
  },
  {
    id: 'M2',
    name: 'restore action-success-as-progress (a subgoal completion counts as progress)',
    file: 'extension/src/agent/longHorizon.ts',
    from: `  if (opts.subgoalJustCompleted) signals.push('SUBGOAL_COMPLETED');`,
    to: `  if (opts.subgoalJustCompleted) { signals.push('SUBGOAL_COMPLETED'); observedChange = true; }`,
  },
  {
    id: 'M3',
    name: 'bypass stale-observation rejection',
    file: 'extension/src/agent/agentLoop.ts',
    from: `        if (!isObservationCurrent(expectedIdentity, this.observationIdentityFor(context))) {`,
    to: `        if (false && !isObservationCurrent(expectedIdentity, this.observationIdentityFor(context))) {`,
  },
  {
    id: 'M4',
    name: 'bypass M5: force the action allowed',
    file: 'extension/src/agent/agentLoop.ts',
    from: `      let validation = validateAction(action, context);`,
    to: `      let validation = validateAction(action, context);
      if (validation) validation = { ...validation, allowed: true };`,
  },
  {
    id: 'M5',
    name: 'bypass the Security Critic verdict',
    file: 'extension/src/agent/agentLoop.ts',
    from: `      const critic: SecurityCriticResult = reviewProposedAction({`,
    to: `      const critic: SecurityCriticResult = { verdict: 'ALLOW', code: 'NO_OBJECTION', findings: [], reasoning: 'mutated' };
      void reviewProposedAction({`,
  },
  {
    id: 'M6',
    name: 'allow a containment escape',
    file: 'extension/src/agent/agentLoop.ts',
    from: `        if (!containment.contained) {`,
    to: `        if (false) {`,
  },
  {
    id: 'M7',
    name: 'make repeated no-effect actions count as meaningful progress',
    file: 'extension/src/agent/longHorizon.ts',
    from: `  let observedChange = false;`,
    to: `  let observedChange = true;`,
  },
  {
    id: 'M8',
    name: 're-admit the navigationDestination shortcut so a REQUESTED url can prove a research goal',
    file: 'extension/src/agent/goalVerifier.ts',
    from: `      if (step.url) observedUrls.add(step.url);`,
    to: `      if (step.url) observedUrls.add(step.url);
      if (step.navigationDestination) observedUrls.add(step.navigationDestination);`,
  },
  {
    id: 'M9',
    name: 'make the subgoal verifier FAIL OPEN (no condition ⇒ satisfied)',
    file: 'extension/src/hierarchicalPlanning/goalProgressTracker.ts',
    from: `      return verdict(
        false,
        \`Subgoal \${subgoal.id} declares no verification condition, so its completion cannot be proven from observation.\`
      );`,
    to: `      return verdict(true, 'mutated fail open');`,
  },
  {
    id: 'M10',
    name: 'subgoal lifecycle short-circuit: complete a PENDING subgoal by direct assignment',
    file: 'extension/src/agent/longHorizon.ts',
    from: `    if (subgoal.state === 'COMPLETED' && tracked.status !== 'COMPLETED') {
      // A tracker subgoal that is still PENDING`,
    to: `    if (subgoal.state === 'COMPLETED' && tracked.status === 'PENDING') {
      tracked.status = 'COMPLETED';
    } else if (subgoal.state === 'COMPLETED' && tracked.status !== 'COMPLETED') {
      // A tracker subgoal that is still PENDING`,
  },
  {
    id: 'M11',
    name: 'forward local ocr_observation provenance to the reasoner (the 17.6 P0)',
    file: 'extension/src/agent/backendAgentProvider.ts',
    from: `      ocr_observation: _ocrObs,`,
    to: `      ocr_observation: context.ocr_observation,`,
  },
];

// ── pre-flight ─────────────────────────────────────────────────────────────
restoreFromJournal();

const FROM = Number(process.argv[2] ?? 0);
const TO = Number(process.argv[3] ?? MUTATIONS.length);
const selected = MUTATIONS.slice(FROM, TO);

// Assert every anchor is in its PRISTINE state before touching anything, so a
// previously interrupted run can never be silently compounded.
let pristine = true;
for (const m of MUTATIONS) {
  if (!fs.existsSync(MUT(m.file))) continue;
  const src = fs.readFileSync(MUT(m.file), 'utf8');
  if (!src.includes(m.from)) {
    console.log(`[mut17_6] PREFLIGHT WARNING: ${m.id} anchor not found in ${m.file} — the file may be dirty`);
    pristine = false;
  }
}
console.log(`[mut17_6] suites: ${SUITES.length} | slice [${FROM},${TO}) of ${MUTATIONS.length} | pristine=${pristine}`);

const results = [];
for (const m of selected) {
  const p = MUT(m.file);
  const original = fs.readFileSync(p, 'utf8');
  if (!original.includes(m.from)) {
    results.push({ id: m.id, name: m.name, file: m.file, status: 'ANCHOR_MISSING', failingTests: null });
    console.log(`[mut17_6] ${m.id} ANCHOR_MISSING — ${m.name}`);
    continue;
  }
  const mutated = original.replace(m.from, m.to);
  journal(m.id, m.file, original);
  fs.writeFileSync(p, mutated);
  let r;
  try {
    r = runTests();
  } finally {
    fs.writeFileSync(p, original);
    clearJournal();
  }
  const fails = countFails(r.out);
  // The EXIT CODE is authoritative: vitest exits non-zero iff a test failed.
  const caught = !r.ok;
  results.push({ id: m.id, name: m.name, file: m.file, status: caught ? 'CAUGHT' : 'SURVIVED', failingTests: fails });
  console.log(`[mut17_6] ${m.id} ${caught ? 'CAUGHT' : '*** SURVIVED ***'} (${fails} failing) — ${m.name}`);
}

// ── post-flight: prove every file is byte-identical to its pre-run state ────
let dirty = [];
for (const m of MUTATIONS) {
  const p = MUT(m.file);
  if (!fs.existsSync(p)) continue;
  if (!fs.readFileSync(p, 'utf8').includes(m.from)) dirty.push(m.id);
}
if (dirty.length) {
  console.log(`[mut17_6] POSTFLIGHT FAILURE: anchors missing after run: ${dirty.join(', ')}`);
  process.exit(2);
}
console.log('[mut17_6] postflight: every mutation anchor is back to its original state');

// ── merge evidence across slices ───────────────────────────────────────────
let merged = { phase: '17.6', total: 0, caught: 0, survived: 0, brokenAnchors: 0, results: [] };
if (fs.existsSync(EVIDENCE)) {
  try { merged = JSON.parse(fs.readFileSync(EVIDENCE, 'utf8')); } catch { /* fresh */ }
}
const byId = new Map((merged.results || []).map((r) => [r.id, r]));
for (const r of results) byId.set(r.id, r);
const ordered = MUTATIONS.map((m) => byId.get(m.id)).filter(Boolean);
const out = {
  phase: '17.6',
  total: ordered.length,
  caught: ordered.filter((r) => r.status === 'CAUGHT').length,
  survived: ordered.filter((r) => r.status === 'SURVIVED').length,
  brokenAnchors: ordered.filter((r) => r.status === 'ANCHOR_MISSING').length,
  results: ordered,
};
fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
fs.writeFileSync(EVIDENCE, JSON.stringify(out, null, 2));
console.log(`[mut17_6] evidence: ${out.caught}/${out.total} caught (${out.survived} survived, ${out.brokenAnchors} broken anchors)`);
process.exit(out.survived > 0 ? 1 : 0);
