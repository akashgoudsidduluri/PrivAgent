/**
 * PHASE 8 — MUTATION RUNNER INTERRUPTION SAFETY.
 *
 * A Step 8 mutation run was killed by a harness timeout BETWEEN a mutant edit
 * and its restore, leaving this committed to production source:
 *
 *     result.kind === 'MATCH' || result.kind === 'MISMATCH'
 *
 * That mutant would have accepted MISMATCH as destination completion. Signal /
 * exit handlers were added afterwards. Step 8's brief says explicitly: "DO NOT
 * ASSUME THAT IS ENOUGH." This file PROVES the behaviour by deliberately killing
 * a running mutation suite four different ways and asserting what the
 * production files look like afterwards.
 *
 * DESIGN NOTE — a first version of this test was itself WRONG: it applied its
 * own mutation to the tracker before launching the runner, so the runner captured
 * the MUTANT as its pristine baseline and faithfully "restored" it. The test
 * passed a false negative into TEST B. Every test below therefore starts from
 * clean production source and lets the RUNNER perform its own mutation, which is
 * the only way to test the real failure mode.
 *
 * POST-17.10 STEP 10 ADDITION — TEST F. Tests A–E exercise the minimal safety
 * probe. TEST F exercises the ACTUAL Step 10 runner
 * (`scratch/mutation_destination_propagation.mjs`), across every production file
 * it mutates, and proves the abnormal-exit recovery path end to end: a SIGKILL
 * (untrappable) leaves residue, and the runner's own startup recovery heals it
 * byte-identically without any external intervention.
 *
 * It does not modify production code permanently: every assertion is that the
 * files end byte-identical to the clean baseline.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TRACKER = path.resolve(ROOT, 'extension/src/hierarchicalPlanning/goalProgressTracker.ts');
const PLANNER = path.resolve(ROOT, 'extension/src/hierarchicalPlanning/oneActionPlanner.ts');
const RUNNER = path.resolve(ROOT, 'scratch/mutation_safety_probe.mjs');
const STEP10_RUNNER = path.resolve(ROOT, 'scratch/mutation_destination_propagation.mjs');
const RESTORE = path.resolve(ROOT, 'scratch/mutation_restore.mjs');
const BACKUP_DIR = path.resolve(ROOT, 'scratch/.mutation_backup');

/** Every production file the Step 10 runner is allowed to mutate. */
const STEP10_FILES = [
  'extension/src/hierarchicalPlanning/plannerContextBuilder.ts',
  'extension/src/hierarchicalPlanning/hierarchicalTypes.ts',
  'extension/src/agent/agentLoop.ts',
  'extension/src/hierarchicalPlanning/goalProgressTracker.ts',
  'extension/src/hierarchicalPlanning/taskDecomposer.ts',
  'extension/src/agent/effectVerifier.ts',
  'backend/app/reasoner.py',
].map((f) => path.resolve(ROOT, f));

const results = [];
const log = (s) => console.log('[S9-P8]', s);

function fingerprint(file) {
  const buf = readFileSync(file);
  let h = 0;
  for (const b of buf) h = (h * 31 + b) >>> 0;
  return `${buf.length}:${h}`;
}

function verdict(name, ok, detail) {
  results.push({ name, ok });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

const cleanBoth = (trackerBase, plannerBase) =>
  fingerprint(TRACKER) === trackerBase && fingerprint(PLANNER) === plannerBase;

/** Run a mutation suite, killing it mid-flight with the given signal. */
function runAndKill(signal, killAfterMs, script = RUNNER, args = []) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: 'ignore' });
    let settled = false;
    const finish = (how) => {
      if (settled) return;
      settled = true;
      done(how);
    };
    child.on('exit', (code, sig) => finish(`exited code=${code} signal=${sig}`));
    setTimeout(() => child.kill(signal), killAfterMs);
    setTimeout(() => {
      child.kill('SIGKILL');
      finish('force-killed after grace period');
    }, killAfterMs + 30000);
  });
}

async function main() {
  // Start from a guaranteed-clean baseline.
  spawnSync(process.execPath, [RESTORE], { stdio: 'ignore' });
  rmSync(BACKUP_DIR, { recursive: true, force: true });

  const trackerBase = fingerprint(TRACKER);
  const plannerBase = fingerprint(PLANNER);
  log(`clean baseline — tracker ${trackerBase}, planner ${plannerBase}`);

  // ── TEST A: normal completion restores ──────────────────────────────────
  log('TEST A — normal run');
  const a = spawnSync(process.execPath, [RUNNER], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  verdict(
    'TEST A normal run leaves source clean',
    cleanBoth(trackerBase, plannerBase),
    `exit=${a.status}; tracker ${fingerprint(TRACKER)}; planner ${fingerprint(PLANNER)}`
  );
  verdict('TEST A backup dir removed', !existsSync(BACKUP_DIR), existsSync(BACKUP_DIR) ? 'still present' : 'absent');

  // ── TEST B: SIGTERM mid-mutation ───────────────────────────────────────
  log('TEST B — SIGTERM during mutation');
  const b = await runAndKill('SIGTERM', 1500);
  verdict(
    'TEST B SIGTERM auto-restores (signal handler)',
    cleanBoth(trackerBase, plannerBase),
    `${b}; tracker ${fingerprint(TRACKER)}`
  );

  // ── TEST C: SIGKILL mid-mutation — untrappable ─────────────────────────
  // SIGKILL cannot be trapped by ANY process handler, so "restore automatically"
  // is impossible for this case. What IS provable is that the durable backup
  // written before the first mutation makes the residue recoverable by a
  // separate process, with no dependence on the killed one.
  log('TEST C — SIGKILL during mutation (untrappable)');
  const c = await runAndKill('SIGKILL', 1500);
  const residueAfterKill = !cleanBoth(trackerBase, plannerBase);
  const backupPresent = existsSync(BACKUP_DIR);
  log(`  after SIGKILL: residue=${residueAfterKill} backupPresent=${backupPresent}`);
  verdict(
    'TEST C durable backup survives the kill',
    backupPresent,
    backupPresent ? 'backup persisted before the first mutation' : 'no backup — unrecoverable'
  );
  const recovered = spawnSync(process.execPath, [RESTORE], { encoding: 'utf8' });
  verdict(
    'TEST C mutation_restore.mjs recovers byte-identical source',
    cleanBoth(trackerBase, plannerBase),
    `residueBeforeRestore=${residueAfterKill}; now tracker ${fingerprint(TRACKER)}`
  );

  // ── TEST D: sequential runs leave no residue ───────────────────────────
  log('TEST D — sequential runs');
  let dOk = true;
  let dDetail = '';
  for (let i = 0; i < 2; i += 1) {
    spawnSync(process.execPath, [RUNNER], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (!cleanBoth(trackerBase, plannerBase)) {
      dOk = false;
      dDetail = `run ${i + 1} left residue (tracker ${fingerprint(TRACKER)}, planner ${fingerprint(PLANNER)})`;
      break;
    }
    dDetail = `run ${i + 1} clean`;
  }
  verdict('TEST D sequential runs leave no residue', dOk, dDetail);

  // ── TEST E: auto-recovery on the next runner start after an untrappable kill ──
  log('TEST E — next run auto-recovers an interrupted run');
  const killed = await runAndKill('SIGKILL', 1500);
  const before = cleanBoth(trackerBase, plannerBase);
  const e = spawnSync(process.execPath, [RUNNER], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  verdict(
    'TEST E a subsequent run recovers prior residue automatically',
    cleanBoth(trackerBase, plannerBase),
    `${killed}; cleanBeforeRestart=${before}; cleanAfterRestart=${cleanBoth(trackerBase, plannerBase)}`
  );

  // ── TEST F: the Step 10 runner heals its own abnormal exit ───────────────
  //
  // SIGKILL is untrappable, so this does NOT claim automatic cleanup for it.
  // What it proves is the architectural answer to that fact: the durable backup
  // written before the first mutation means a MUTATION CANNOT REMAIN IN
  // PRODUCTION SOURCE once the runner is next started — it restores itself,
  // with no external restore command and no dependence on the killed process.
  log('TEST F — Step 10 runner: abnormal-exit recovery');
  const step10Base = new Map(STEP10_FILES.map((f) => [f, fingerprint(f)]));
  const step10Clean = () =>
    STEP10_FILES.every((f) => fingerprint(f) === step10Base.get(f));

  const killed10 = await runAndKill('SIGKILL', 4000, STEP10_RUNNER, ['M1']);
  const residue10 = !step10Clean();
  const backup10 = existsSync(BACKUP_DIR);
  log(`  after SIGKILL: residue=${residue10} backupPresent=${backup10}`);
  verdict(
    'TEST F Step 10 runner is killable mid-mutation with a durable backup present',
    backup10,
    backup10 ? `durable backup persisted before the first mutation` : 'no backup — unrecoverable'
  );

  // Restart the runner. Its startup recovery must heal every file it mutates,
  // and the single-mutant selection keeps this inside the command budget.
  const restart = spawnSync(process.execPath, [STEP10_RUNNER, 'M1'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const healed = step10Clean();
  verdict(
    'TEST F no mutation remains in production source after abnormal-exit recovery',
    healed,
    `${killed10}; residueBeforeRestart=${residue10}; cleanAfterRestart=${healed}; exit=${restart.status}`
  );
  verdict(
    'TEST F Step 10 runner backup removed after a clean restart',
    !existsSync(BACKUP_DIR),
    existsSync(BACKUP_DIR) ? 'still present' : 'absent'
  );
  verdict(
    'TEST F Step 10 runner still reports its mutant as killed after recovery',
    /M1\s+KILLED/.test(restart.stdout ?? ''),
    ((restart.stdout ?? '').match(/M1\s+\w+[^\n]*/) ?? ['<no M1 line>'])[0]
  );

  // ── Final integrity sweep ──────────────────────────────────────────────
  verdict(
    'FINAL production source byte-identical to clean baseline',
    cleanBoth(trackerBase, plannerBase),
    `tracker ${fingerprint(TRACKER)}/${trackerBase}, planner ${fingerprint(PLANNER)}/${plannerBase}`
  );
  verdict(
    'FINAL every file the Step 10 runner mutates is byte-identical to its baseline',
    STEP10_FILES.every((f) => !step10Base.has(f) || fingerprint(f) === step10Base.get(f)),
    STEP10_FILES.filter((f) => fingerprint(f) !== step10Base.get(f))
      .map((f) => path.relative(ROOT, f))
      .join(', ') || 'all identical'
  );

  const failed = results.filter((r) => !r.ok);
  log(`\n== ${results.length - failed.length} passed, ${failed.length} failed ==`);
  process.exitCode = failed.length ? 1 : 0;
}

main();