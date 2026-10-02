/**
 * MUTATION PROBES — destination navigation intent (POST-17.10 Step 9).
 *
 * Each mutant reintroduces one specific way the Step 9 navigation fix could
 * fail: dropping the destination from the proposal input, substituting a
 * non-user source for it, or turning completion into something that is not an
 * observed MATCH.
 *
 * A mutant is KILLED only when the suite fails. An unmatched anchor is INVALID
 * and is never counted as a kill; neither is a compile error.
 *
 * PHASE 8 SAFETY: this runner restores production source on EVERY exit path,
 * including SIGTERM and abnormal termination. That is not theoretical — a Step 8
 * run was killed mid-mutation and left `result.kind === 'MATCH' ||
 * result.kind === 'MISMATCH'` committed to disk. See scratch/mutation_runner_safety_test.mjs.
 *
 * Run with `node scratch/mutation_destination_navigation_intent.mjs`.
 */
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const PLANNER = 'extension/src/hierarchicalPlanning/oneActionPlanner.ts';
const LOOP = 'extension/src/agent/agentLoop.ts';
const TRACKER = 'extension/src/hierarchicalPlanning/goalProgressTracker.ts';
const SUITE = [
  'tests/destinationNavigationIntent.test.ts',
  'tests/destinationProducerWiring.test.ts',
  'tests/classificationDestinationGap.test.ts',
  'tests/affordanceAvailableContract.test.ts',
];

// ── Durable backup ─────────────────────────────────────────────────────────
//
// Signal handlers alone are NOT sufficient. SIGKILL cannot be trapped, so a
// runner that mutates production source in place can ALWAYS be killed inside the
// mutation window and leave residue — that is exactly what happened in Step 8,
// and what the Phase 8 safety test reproduced.
//
// The only way to bound that residual is to persist the pristine content to
// disk BEFORE the first mutation, so recovery does not depend on the killed
// process still existing. On startup the runner recovers from any previous
// interrupted run, and `scratch/mutation_restore.mjs` does the same on demand.
const BACKUP_DIR = path.resolve(process.cwd(), 'scratch/.mutation_backup');
const BACKUP_MANIFEST = path.join(BACKUP_DIR, 'manifest.json');

function backupPathFor(file) {
  return path.join(BACKUP_DIR, `${file.replace(/[\\/]/g, '__')}.bak`);
}

/** Restore any residue left by a previous interrupted run, if a backup exists. */
export function recoverInterruptedRun() {
  if (!existsSync(BACKUP_MANIFEST)) return null;
  try {
    const manifest = JSON.parse(readFileSync(BACKUP_MANIFEST, 'utf8'));
    const restoredFiles = [];
    for (const [file, bkp] of Object.entries(manifest)) {
      if (existsSync(bkp)) {
        writeFileSync(file, readFileSync(bkp, 'utf8'));
        restoredFiles.push(file);
      }
    }
    rmSync(BACKUP_DIR, { recursive: true, force: true });
    return restoredFiles;
  } catch {
    rmSync(BACKUP_DIR, { recursive: true, force: true });
    return null;
  }
}

recoverInterruptedRun();

function persistBackup() {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const manifest = {};
  for (const file of [PLANNER, LOOP, TRACKER]) {
    const dest = backupPathFor(file);
    writeFileSync(dest, readFileSync(file, 'utf8'));
    manifest[path.resolve(process.cwd(), file)] = dest;
  }
  writeFileSync(BACKUP_MANIFEST, JSON.stringify(manifest, null, 2));
}

const ORIGINALS = new Map([
  [PLANNER, readFileSync(PLANNER, 'utf8')],
  [LOOP, readFileSync(LOOP, 'utf8')],
  [TRACKER, readFileSync(TRACKER, 'utf8')],
]);

function mutate(file, from, to) {
  const original = ORIGINALS.get(file);
  const count = original.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`anchor appears ${count}x in ${file}: ${JSON.stringify(from.slice(0, 70))}`);
  }
  writeFileSync(file, original.replace(from, to));
}

let restored = false;
function restoreAll() {
  for (const [file, content] of ORIGINALS) writeFileSync(file, content);
  restored = true;
}
/**
 * The durable backup must survive for the WHOLE run.
 *
 * An earlier version deleted it inside every `restoreAll()`, which meant it only
 * existed during the milliseconds a single mutant was applied. The Phase 8
 * safety test caught exactly that: a SIGKILL between mutants left residue AND no
 * backup. It is now removed only once, on graceful completion.
 */
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

// Persist the pristine content BEFORE the first mutation, so even an
// untrappable SIGKILL is recoverable without this process.
persistBackup();

const MUTANTS = [
  {
    id: 'M1',
    name: 'drop the destination from action-planning input (propose nothing)',
    edit: () => mutate(PLANNER, `    const declaration = subgoal.destination;`, `    const declaration = undefined;`),
  },
  {
    id: 'M2',
    name: 'replace the declared destination with the CURRENT url',
    edit: () =>
      mutate(
        PLANNER,
        `      url: \`\${declared.origin}\${declared.path}\`,`,
        `      url: \`\${new URL(declared.origin).origin}/\`,`
      ),
  },
  {
    id: 'M3',
    name: 'fabricate a URL from the subgoal targetEntity',
    edit: () =>
      mutate(
        PLANNER,
        `    const declared = declaration.url;
    if (!declared) return null;`,
        `    const declared =
      declaration.url ??
      (subgoal.targetEntity
        ? { origin: 'http://injected.invalid', path: subgoal.targetEntity, rawUrl: '' }
        : undefined);
    if (!declared) return null;`
      ),
  },
  {
    id: 'M4',
    name: 'derive the destination from the OBSERVED page type',
    edit: () =>
      mutate(
        TRACKER,
        `        if (!declaration || declaration.kind !== 'DECLARED') {`,
        `        const observedRole = classification?.pageType;
        if (!declaration && observedRole) {
          return verdict(true, \`Completed from observed page type \${observedRole}.\`);
        }
        if (false) {`
      ),
  },
  {
    id: 'M5',
    name: 'derive the destination from a MODEL-proposed action',
    edit: () =>
      mutate(
        PLANNER,
        `    const declared = declaration.url;
    if (!declared) return null;`,
        `    const modelUrl = (subgoal as unknown as { suggestedAction?: { url?: string } }).suggestedAction?.url;
    if (!declaration?.url && modelUrl) {
      return { action: 'navigate', url: modelUrl, reason: 'Navigating to a model-proposed URL.' };
    }
    const declared = declaration.url;
    if (!declared) return null;`
      ),
  },
  {
    id: 'M6',
    name: 'treat targetEntity as the destination declaration',
    edit: () =>
      mutate(
        PLANNER,
        `    const declaration = subgoal.destination;`,
        `    const declaration = subgoal.destination ?? (subgoal.targetEntity
      ? {
          kind: 'DECLARED' as const,
          url: {
            provenance: 'USER_URL' as const,
            origin: 'http://injected.invalid',
            path: \`/\${subgoal.targetEntity}\`,
            rawUrl: '',
          },
        }
      : undefined);`
      ),
  },
  {
    id: 'M7',
    name: 'complete the destination on UNKNOWN',
    edit: () =>
      mutate(
        TRACKER,
        `        return verdict(
          result.kind === 'MATCH',`,
        `        return verdict(
          result.kind !== 'MISMATCH',`
      ),
  },
  {
    id: 'M8',
    name: 'complete the destination on MISMATCH',
    edit: () =>
      mutate(
        TRACKER,
        `        return verdict(
          result.kind === 'MATCH',`,
        `        return verdict(
          result.kind !== 'UNKNOWN',`
      ),
  },
  {
    id: 'M9',
    name: 'complete the destination from executionSuccess alone',
    edit: () =>
      mutate(
        TRACKER,
        `        const declaration = subgoal.destination;`,
        `        if ((subgoal as unknown as { executionSuccess?: boolean }).executionSuccess) {
          return verdict(true, 'Completed on executionSuccess.');
        }
        const declaration = subgoal.destination;`
      ),
  },
  {
    id: 'M10',
    name: 'complete the destination from affordance existence',
    edit: () =>
      mutate(
        TRACKER,
        `        const declaration = subgoal.destination;`,
        `        if ((ctx.semantic_context?.affordances ?? []).length > 0) {
          return verdict(true, 'Completed: affordances exist.');
        }
        const declaration = subgoal.destination;`
      ),
  },
  {
    id: 'M11',
    name: 'complete the destination from a STALE observation',
    edit: () =>
      mutate(
        TRACKER,
        `        const observedGeneration = Number(classification.pageGeneration);`,
        `        const observedGeneration = Number(observation.pageGeneration ?? classification.pageGeneration);`
      ),
  },
  {
    id: 'M12',
    name: 'let recovery overwrite the declared destination',
    edit: () =>
      mutate(
        TRACKER,
        `        const result = verifyDestination({
          declaration,`,
        `        const overwritten = (subgoal as { destination?: unknown }).destination;
        if (overwritten && overwritten.kind === 'DECLARED' && !overwritten.url) {
          (overwritten as { role?: { acceptablePageTypes: string[] } }).role = {
            provenance: 'EXPLICIT_PAGE_ROLE',
            acceptablePageTypes: [classification.pageType],
          };
        }
        const result = verifyDestination({
          declaration: overwritten,`
      ),
  },
];

/**
 * CRITICAL: this must be ASYNC.
 *
 * The Phase 8 safety test proved that the runner's signal handlers were dead
 * code while it used `spawnSync`: `spawnSync` blocks the event loop, so a
 * SIGTERM delivered mid-suite is queued and never dispatched until the
 * synchronous child has already exited. The runner happily "restored" nothing,
 * the SIGTERM was swallowed, and the test had to SIGKILL it 30s later — by
 * which time production source carried a live mutant.
 *
 * `spawn` + `await` keeps the event loop free, so the restore handler actually
 * runs. Do not "optimise" this back to `spawnSync`.
 */
function runSuite() {
  return new Promise((resolve) => {
    const child = spawn('npx', ['vitest', 'run', '--silent=true', ...SUITE], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', (e) => resolve({ failed: 0, passed: 0, ok: false, compiled: false, out: String(e) }));
    child.on('close', (code) => {
      const m = out.match(/Tests\s+(?:(\d+) failed \| )?(\d+) passed/);
      const failed = m && m[1] ? Number(m[1]) : 0;
      const passed = m ? Number(m[2]) : 0;
      const compiled = !/Cannot find name|error TS|Transform failed|SyntaxError|is not a function/.test(out);
      resolve({ failed, passed, ok: code === 0 && compiled, compiled });
    });
  });
}

async function main() {
  let killed = 0;
  let survived = 0;
  let invalid = 0;

  for (const mutant of MUTANTS) {
    restoreAll();
    restored = false;
    try {
      mutant.edit();
    } catch (err) {
      invalid += 1;
      console.log(`\n${mutant.id}  INVALID  ${mutant.name}\n      ${err.message}`);
      restoreOnce();
      continue;
    }
    const res = await runSuite();
    restoreOnce();
    if (res.ok && res.failed === 0) {
      survived += 1;
      console.log(`\n${mutant.id}  SURVIVED  ${mutant.name}\n      ${res.passed} passed`);
    } else if (!res.compiled) {
      invalid += 1;
      console.log(`\n${mutant.id}  INVALID-COMPILE  ${mutant.name}  (not a kill)`);
    } else {
      killed += 1;
      console.log(`\n${mutant.id}  KILLED  ${mutant.name}\n      ${res.failed} failed | ${res.passed} passed`);
    }
  }

  restoreOnce();
  cleanupBackup();
  console.log(`\n== ${killed} killed, ${survived} survived, ${invalid} invalid of ${MUTANTS.length} ==`);
}

main().catch((e) => {
  restoreOnce();
  console.error(e);
  process.exit(1);
});