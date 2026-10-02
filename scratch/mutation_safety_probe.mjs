/**
 * A MINIMAL mutation runner used only by the Phase 8 interruption-safety test.
 *
 * It carries the identical restore/backup semantics as the real suites but runs
 * two mutants against a single fast test file, so a full pass takes seconds
 * instead of a minute. The safety harness needs to kill it many times; using the
 * real suite made the harness exceed the command timeout, and an over-long
 * safety test is a safety test that never reports.
 *
 * Do NOT use this to measure mutation coverage. Use
 * scratch/mutation_destination_navigation_intent.mjs for that.
 */
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const PLANNER = 'extension/src/hierarchicalPlanning/oneActionPlanner.ts';
const TRACKER = 'extension/src/hierarchicalPlanning/goalProgressTracker.ts';
const FILES = [PLANNER, TRACKER];
const SUITE = ['tests/destinationNavigationIntent.test.ts'];

const BACKUP_DIR = path.resolve(process.cwd(), 'scratch/.mutation_backup');
const BACKUP_MANIFEST = path.join(BACKUP_DIR, 'manifest.json');

// Recover residue from any previously interrupted run before capturing a baseline.
if (existsSync(BACKUP_MANIFEST)) {
  const manifest = JSON.parse(readFileSync(BACKUP_MANIFEST, 'utf8'));
  for (const [file, bkp] of Object.entries(manifest)) {
    if (existsSync(bkp)) writeFileSync(file, readFileSync(bkp, 'utf8'));
  }
  rmSync(BACKUP_DIR, { recursive: true, force: true });
}

function persistBackup() {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const manifest = {};
  for (const file of FILES) {
    const dest = path.join(BACKUP_DIR, `${file.replace(/[\\/]/g, '__')}.bak`);
    writeFileSync(dest, readFileSync(file, 'utf8'));
    manifest[path.resolve(process.cwd(), file)] = dest;
  }
  writeFileSync(BACKUP_MANIFEST, JSON.stringify(manifest, null, 2));
}

const ORIGINALS = new Map(FILES.map((f) => [f, readFileSync(f, 'utf8')]));

let restored = false;
function restoreAll() {
  for (const [file, content] of ORIGINALS) writeFileSync(file, content);
  restored = true;
}
function cleanupBackup() {
  rmSync(BACKUP_DIR, { recursive: true, force: true });
}
function restoreOnce() {
  if (restored) return;
  restored = true;
  restoreAll();
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
  process.on(sig, () => {
    restoreOnce();
    cleanupBackup();
    process.exit(130);
  });
}
process.on('exit', () => {
  restoreOnce();
  cleanupBackup();
});
process.on('uncaughtException', (e) => {
  restoreOnce();
  cleanupBackup();
  console.error(e);
  process.exit(1);
});

persistBackup();

const MUTANTS = [
  {
    id: 'S1',
    edit: () => {
      const from = '    const declaration = subgoal.destination;';
      const to = '    const declaration = undefined;';
      const src = ORIGINALS.get(PLANNER);
      writeFileSync(PLANNER, src.replace(from, to));
    },
  },
  {
    id: 'S2',
    edit: () => {
      const from = '          result.kind === \'MATCH\',';
      const to = '          result.kind !== \'UNKNOWN\',';
      const src = ORIGINALS.get(TRACKER);
      writeFileSync(TRACKER, src.replace(from, to));
    },
  },
];

// Async on purpose: `spawnSync` blocks the event loop, so signal handlers would
// never run and the safety test would be testing dead code.
function runSuite() {
  return new Promise((resolve) => {
    const child = spawn('npx', ['vitest', 'run', '--silent=true', ...SUITE], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('close', () => resolve(out));
  });
}

async function main() {
  for (const mutant of MUTANTS) {
    restoreAll();
    restored = false;
    mutant.edit();
    const out = await runSuite();
    const killed = /failed \|/.test(out);
    console.log(`${mutant.id} ${killed ? 'KILLED' : 'SURVIVED'}`);
    restoreOnce();
    restored = false;
  }
  restoreOnce();
  cleanupBackup();
  console.log('safety-probe complete');
}

main().catch((e) => {
  restoreOnce();
  cleanupBackup();
  console.error(e);
  process.exit(1);
});