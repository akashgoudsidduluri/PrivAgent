/**
 * MUTATION PROBES — role-only propagation + already-at-destination
 * (POST-17.10 Step 10).
 *
 * Each mutant reintroduces one SPECIFIC way this step's work could fail:
 *
 *   M1–M12  a non-user source (observation, page type, affordance, targetEntity,
 *           model output, action url, fixture route, entry url, category, an
 *           execution result) is allowed to create or rewrite the declaration,
 *           or the declaration is simply dropped on the way to the reasoner.
 *
 *   M13–M20 the already-at-destination shortcut is taken without evidence:
 *           an unchanged URL is called success, an execution result is called
 *           destination satisfaction, the pre-existing page is reused instead of
 *           a fresh observation, a stale observation is accepted, UNKNOWN or
 *           MISMATCH is treated as MATCH, or recovery / the model is allowed to
 *           declare the destination satisfied.
 *
 * CLASSIFICATION RULES (never violated):
 *   KILLED     the suite fails.
 *   SURVIVED   the suite passes. Reported, never hidden.
 *   INVALID    the anchor did not apply, or the mutant does not compile. NEVER
 *              counted as a kill.
 *
 * PHASE 9 SAFETY. This runner keeps the Step 9 crash-safe architecture intact
 * and unchanged in substance:
 *
 *   • the pristine content of every mutated file is persisted to disk BEFORE
 *     the first mutation, so recovery never depends on this process still
 *     existing (SIGKILL and SIGABRT cannot be trapped at all);
 *   • `recoverInterruptedRun()` runs on startup, so residue from a previous
 *     killed run is healed before anything new is applied;
 *   • the backup survives the WHOLE run and is removed only on graceful exit;
 *   • `runSuite()` uses async `spawn` + `await`, NOT `spawnSync`, because
 *     `spawnSync` blocks the event loop and makes the signal handlers dead code.
 *
 * `scratch/mutation_restore.mjs` performs the same recovery on demand.
 *
 * Run with `node scratch/mutation_destination_propagation.mjs`.
 */

import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const BUILDER = 'extension/src/hierarchicalPlanning/plannerContextBuilder.ts';
const TYPES = 'extension/src/hierarchicalPlanning/hierarchicalTypes.ts';
const LOOP = 'extension/src/agent/agentLoop.ts';
const TRACKER = 'extension/src/hierarchicalPlanning/goalProgressTracker.ts';
const DECOMPOSER = 'extension/src/hierarchicalPlanning/taskDecomposer.ts';
const EFFECT = 'extension/src/agent/effectVerifier.ts';
const REASONER = 'backend/app/reasoner.py';

const SUITE = [
  'tests/destinationPropagationAndAlreadySatisfied.test.ts',
  'tests/destinationNavigationIntent.test.ts',
  'tests/destinationProducerWiring.test.ts',
  'tests/classificationDestinationGap.test.ts',
];

const PY_TESTS = ['tests/test_step10_declared_destination.py'];

// ── Durable backup ─────────────────────────────────────────────────────────
const BACKUP_DIR = path.resolve(process.cwd(), 'scratch/.mutation_backup');
const BACKUP_MANIFEST = path.join(BACKUP_DIR, 'manifest.json');

const MUTATED_FILES = [BUILDER, TYPES, LOOP, TRACKER, DECOMPOSER, EFFECT, REASONER];

function backupPathFor(file) {
  return path.join(BACKUP_DIR, `${file.replace(/[\\/]/g, '__')}.bak`);
}

/** Restore residue left by any previous interrupted run. */
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
  for (const file of MUTATED_FILES) {
    const dest = backupPathFor(file);
    writeFileSync(dest, readFileSync(file, 'utf8'));
    manifest[path.resolve(process.cwd(), file)] = dest;
  }
  writeFileSync(BACKUP_MANIFEST, JSON.stringify(manifest, null, 2));
}

const ORIGINALS = new Map(MUTATED_FILES.map((f) => [f, readFileSync(f, 'utf8')]));

function mutate(file, from, to) {
  const original = ORIGINALS.get(file);
  const count = original.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`anchor appears ${count}x in ${file}: ${JSON.stringify(from.slice(0, 80))}`);
  }
  writeFileSync(file, original.replace(from, to));
}

/**
 * Apply an additional edit ON TOP of an already-applied mutant.
 *
 * `mutate()` always rebuilds from the pristine original, so a second call would
 * silently discard the first. A mutant that needs two coordinated edits uses
 * this instead, and is still validated for a unique anchor.
 */
function mutateCurrent(file, from, to) {
  const current = readFileSync(file, 'utf8');
  const count = current.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`anchor appears ${count}x in ${file}: ${JSON.stringify(from.slice(0, 80))}`);
  }
  writeFileSync(file, current.replace(from, to));
}

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

// ── Anchors ────────────────────────────────────────────────────────────────

const A_ROLE = `    ...(role && role.length > 0 ? { role: [...role] } : {}),`;
const A_DEST_URL = "    ...(declaration.url ? { destinationUrl: `${declaration.url.origin}${declaration.url.path}` } : {}),";
const A_ENTRY_URL =
  '    ...(declaration.entryUrl ? { entryUrl: `${declaration.entryUrl.origin}${declaration.entryUrl.path}` } : {}),';
const A_DECLARED = '    const declaredDestination = toDeclaredDestinationConstraint(activeSubgoal?.destination);';
const A_ADD_DEST = `  const addDestinationSubgoal = (): string => {
    if (!declaredDestination) return '';`;
const A_ECOM_CONDITION = `          declaredDestination
            ? {
                type: 'DESTINATION_VERIFIED' as const,
                description: 'Declared destination is observed',
              }`;
const A_TRACK_DECL = `        const declaration = subgoal.destination;`;
const A_TRACK_MATCH = `        return verdict(
          result.kind === 'MATCH',`;
const A_LOOP_BRANCH = `        if (activeSubgoal?.destination && this.subgoalGraph) {`;
const A_LOOP_REPERCEIVE =
  '            const fresh = this.normalizePerceptionResult(await this.callbacks.perceivePage());';
const A_LOOP_VERIFY = `            const destinationCheck = GoalProgressTracker.verifySubgoalCondition(activeSubgoal, {
              context: freshContext,
              pageGeneration: this.state.currentPageGeneration ?? 0,
            });`;
const A_LOOP_MODEL = '          action = await this.requestActionWithBoundedRetry(task, context);';
const A_LOOP_REPLAN = `            trigger: 'ACTION_NO_EFFECT',`;
const A_LOOP_COMPLETE = '              this.subgoalGraph.completeSubgoal(activeSubgoal.id);';
const A_EFFECT_NAV = `    case 'navigate': {
      if (urlChanged) {`;
const A_PY_RENDER =
  '        if isinstance(declared, dict) and declared.get("provenance") == "USER_DECLARED_DESTINATION":';
const A_PY_PROMPT = `   POST-17.10 Step 10 — DECLARED DESTINATION (read-only data, non-authoritative):
   \`declaredDestination\` is extracted deterministically from the user's own request by the local extension.
   When present it names the page identity the user asked to REACH ("role", and/or an explicit
   "destinationUrl"). Treat it as the target to navigate TOWARDS, never as proof you have arrived:
   the local destination verifier decides satisfaction from a fresh page observation, not you.
   You may propose any route or affordance action that plausibly reaches it (clicking a catalog link,
   submitting a search) — but you MUST NOT invent a URL from a role, never treat "entryUrl" as the
   destination, and never declare the task or the destination complete. A bare role is not a URL.`;

// ── Mutants ────────────────────────────────────────────────────────────────

const MUTANTS = [
  // ── ROLE-ONLY ───────────────────────────────────────────────────────────
  {
    id: 'M1',
    name: 'drop the role before the reasoner',
    edit: () => mutate(BUILDER, A_ROLE, `    ...(false && role ? { role: [...role] } : {}),`),
  },
  {
    id: 'M2',
    name: 'replace the role with targetEntity',
    edit: () =>
      mutate(
        BUILDER,
        A_DECLARED,
        `    const declaredDestination =
      toDeclaredDestinationConstraint(activeSubgoal?.destination) ??
      (activeSubgoal?.targetEntity
        ? ({
            provenance: 'USER_DECLARED_DESTINATION',
            role: [activeSubgoal.targetEntity],
          } as unknown as ReturnType<typeof toDeclaredDestinationConstraint>)
        : undefined);`
      ),
  },
  {
    id: 'M3',
    name: 'replace the role with an observed affordance',
    edit: () =>
      mutate(
        BUILDER,
        A_DECLARED,
        `    const declaredDestination =
      toDeclaredDestinationConstraint(activeSubgoal?.destination) ??
      (((semanticContext?.affordances ?? []).length > 0
        ? {
            provenance: 'USER_DECLARED_DESTINATION',
            role: ['LISTING'],
          }
        : undefined) as unknown as ReturnType<typeof toDeclaredDestinationConstraint>);`
      ),
  },
  {
    id: 'M4',
    name: 'derive the role from the OBSERVED page classification',
    edit: () =>
      mutate(
        BUILDER,
        A_DECLARED,
        `    const declaredDestination =
      toDeclaredDestinationConstraint(activeSubgoal?.destination) ??
      (semanticContext && semanticContext.pageType && semanticContext.pageType !== 'UNKNOWN'
        ? ({
            provenance: 'USER_DECLARED_DESTINATION',
            role: [String(semanticContext.pageType)],
          } as unknown as ReturnType<typeof toDeclaredDestinationConstraint>)
        : undefined);`
      ),
  },
  {
    id: 'M5',
    name: 'derive the role from MODEL output (the subgoal\'s suggested action)',
    edit: () =>
      mutate(
        BUILDER,
        A_DECLARED,
        `    const modelRole = (activeSubgoal?.suggestedAction as unknown as { destinationRole?: string })
      ?.destinationRole;
    const declaredDestination =
      toDeclaredDestinationConstraint(activeSubgoal?.destination) ??
      (modelRole
        ? ({
            provenance: 'USER_DECLARED_DESTINATION',
            role: [modelRole],
          } as unknown as ReturnType<typeof toDeclaredDestinationConstraint>)
        : undefined);`
      ),
  },
  {
    id: 'M6',
    name: 'invent a destination URL from the page ROLE',
    edit: () =>
      mutate(
        BUILDER,
        A_DEST_URL,
        `    ...(declaration.url
      ? { destinationUrl: \`\${declaration.url.origin}\${declaration.url.path}\` }
      : declaration.entryUrl && role && role.includes('LISTING')
        ? { destinationUrl: \`\${declaration.entryUrl.origin}/listing\` }
        : {}),`
      ),
  },
  {
    id: 'M7',
    name: 'invent a destination URL from the fixture route',
    edit: () =>
      mutate(
        BUILDER,
        A_DEST_URL,
        `    ...(declaration.url
      ? { destinationUrl: \`\${declaration.url.origin}\${declaration.url.path}\` }
      : declaration.entryUrl && role
        ? { destinationUrl: \`\${declaration.entryUrl.origin}/results.html\` }
        : {}),`
      ),
  },
  {
    id: 'M8',
    name: 'use entryUrl as the destination URL',
    edit: () =>
      mutate(
        BUILDER,
        A_ENTRY_URL,
        `    ...(declaration.entryUrl
      ? {
          entryUrl: \`\${declaration.entryUrl.origin}\${declaration.entryUrl.path}\`,
          destinationUrl:
            declaration.url ? undefined : \`\${declaration.entryUrl.origin}\${declaration.entryUrl.path}\`,
        }
      : {}),`
      ),
  },
  {
    id: 'M9',
    name: 'let a previous action.url rewrite the destination',
    edit: () =>
      mutate(
        BUILDER,
        A_DECLARED,
        `    const lastNavigate = [...(baseContext.previous_actions ?? [])]
      .reverse()
      .find((a) => a.action === 'navigate') as { url?: string } | undefined;
    const declaredDestination =
      toDeclaredDestinationConstraint(activeSubgoal?.destination) ??
      (lastNavigate?.url
        ? ({
            provenance: 'USER_DECLARED_DESTINATION',
            destinationUrl: lastNavigate.url,
          } as unknown as ReturnType<typeof toDeclaredDestinationConstraint>)
        : undefined);`
      ),
  },
  {
    id: 'M10',
    name: 'let a successful execution rewrite the declaration',
    edit: () =>
      mutate(
        LOOP,
        A_LOOP_BRANCH,
        `        if (activeSubgoal?.destination && this.subgoalGraph) {
          if (execResult.success && (action as { url?: string }).url && activeSubgoal.destination.kind === 'DECLARED') {
            (activeSubgoal.destination as { url?: unknown }).url = {
              provenance: 'USER_URL',
              origin: new URL((action as { url: string }).url).origin,
              path: new URL((action as { url: string }).url).pathname,
              rawUrl: (action as { url: string }).url,
            };
          }`
      ),
  },
  {
    id: 'M11',
    name: 'let GENERIC category alone create a destination subgoal',
    edit: () =>
      mutate(
        DECOMPOSER,
        A_ADD_DEST,
        `  const addDestinationSubgoal = (): string => {
    if (!declaredDestination && taskCategory !== 'GENERIC_INTERACTION') return '';`
      ),
  },
  {
    id: 'M12',
    name: 'let ECOMMERCE category alone make the destination subgoal verifiable',
    // NOTE: the first attempt at this mutant edited `addDestinationSubgoal`,
    // which the ECOMMERCE_SEARCH branch never calls — it builds its own
    // NAVIGATE subgoal. That mutation was a no-op for ECOMMERCE and would
    // have been a misleading survivor, so it targets the branch that actually
    // decides the ECOMMERCE destination condition.
    edit: () =>
      mutate(
        DECOMPOSER,
        A_ECOM_CONDITION,
        `          declaredDestination || taskCategory === 'ECOMMERCE_SEARCH'
            ? {
                type: 'DESTINATION_VERIFIED' as const,
                description: 'Declared destination is observed',
              }`
      ),
  },

  // ── ALREADY-AT-DESTINATION ──────────────────────────────────────────────
  {
    id: 'M13',
    name: 'treat an unchanged URL as a successful navigate',
    edit: () => mutate(EFFECT, A_EFFECT_NAV, `    case 'navigate': {
      if (urlChanged || pre.url === action.url) {`),
  },
  {
    id: 'M14',
    name: 'treat executionSuccess as destination satisfaction',
    edit: () =>
      mutate(
        TRACKER,
        A_TRACK_DECL,
        `        const declaration = subgoal.destination;
        if ((observation as unknown as { executionSuccess?: boolean })?.executionSuccess) {
          return verdict(true, 'Completed on executionSuccess alone.');
        }`
      ),
  },
  {
    id: 'M15',
    name: 'satisfy the destination from the CURRENT url, without a fresh observation',
    edit: () =>
      mutate(
        LOOP,
        A_LOOP_REPERCEIVE,
        '            const fresh = undefined; // no re-perception: reuse the current context'
      ),
  },
  {
    id: 'M16',
    name: 'accept a STALE observation',
    edit: () =>
      mutate(
        LOOP,
        A_LOOP_VERIFY,
        `            const destinationCheck = GoalProgressTracker.verifySubgoalCondition(activeSubgoal, {
              context: freshContext,
              pageGeneration: freshContext.semantic_context?.pageGeneration ?? this.state.currentPageGeneration ?? 0,
            });`
      ),
  },
  {
    id: 'M17',
    name: 'treat UNKNOWN as MATCH',
    edit: () => mutate(TRACKER, A_TRACK_MATCH, `        return verdict(
          result.kind !== 'MISMATCH',`),
  },
  {
    id: 'M18',
    name: 'treat MISMATCH as MATCH',
    edit: () => mutate(TRACKER, A_TRACK_MATCH, `        return verdict(
          result.kind !== 'UNKNOWN',`),
  },
  {
    id: 'M19',
    name: 'let RECOVERY declare the destination satisfied',
    edit: () => {
      mutate(LOOP, A_LOOP_REPLAN, `            trigger: 'ACTION_NO_EFFECT',`);
      mutateCurrent(
        LOOP,
        `            replanCount: this.state.recoveryCount,
          });`,
        `            replanCount: this.state.recoveryCount,
          });
          if (activeSubgoal?.destination && this.subgoalGraph) {
            this.subgoalGraph.completeSubgoal(activeSubgoal.id);
            this.state.subgoalGraphData = this.subgoalGraph.toData();
          }`
      );
    },
  },
  {
    id: 'M20',
    name: 'let the MODEL declare the destination satisfied',
    edit: () =>
      mutate(
        LOOP,
        A_LOOP_MODEL,
        `${A_LOOP_MODEL}
          if (activeSubgoal?.destination && this.subgoalGraph && (action as { url?: string }).url) {
            this.subgoalGraph.completeSubgoal(activeSubgoal.id);
            this.state.subgoalGraphData = this.subgoalGraph.toData();
          }`
      ),
  },

  // ── backend render ─────────────────────────────────────────────────────
  {
    id: 'M21',
    name: 'backend: render the declaration without checking provenance',
    edit: () => mutate(REASONER, A_PY_RENDER, '        if isinstance(declared, dict):'),
    py: true,
  },
  {
    id: 'M22',
    name: 'backend: drop the read-only, non-authoritative system-prompt clause',
    edit: () =>
      mutate(REASONER, A_PY_PROMPT, '   `declaredDestination` is a suggestion.'),
    py: true,
  },
];

// ── Suite execution ────────────────────────────────────────────────────────

function runSuite(py) {
  return new Promise((resolve) => {
    const cmd = py ? 'pytest' : 'vitest';
    const args = py
      ? ['-m', 'pytest', '-q', ...PY_TESTS]
      : ['vitest', 'run', '--silent=true', ...SUITE];
    const opts = py
      ? { cwd: path.resolve(process.cwd(), 'backend'), stdio: ['ignore', 'pipe', 'pipe'] }
      : { stdio: ['ignore', 'pipe', 'pipe'] };
    const bin = py ? path.resolve(process.cwd(), 'backend/.venv/bin/python') : 'npx';
    const child = spawn(bin, args, opts);
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', (e) =>
      resolve({ failed: 0, passed: 0, ok: false, compiled: false, out: String(e) })
    );
    child.on('close', (code) => {
      const vitest = out.match(/Tests\s+(?:(\d+) failed \| )?(\d+) passed/);
      const pytest = out.match(/(\d+) failed/);
      const pytestPassed = out.match(/(\d+) passed/);
      let failed = 0;
      let passed = 0;
      if (cmd === 'pytest') {
        failed = pytest ? Number(pytest[1]) : 0;
        passed = pytestPassed ? Number(pytestPassed[1]) : 0;
        if (!pytest && !pytestPassed) {
          resolve({ failed: 0, passed: 0, ok: false, compiled: false, out });
          return;
        }
      } else {
        failed = vitest && vitest[1] ? Number(vitest[1]) : 0;
        passed = vitest ? Number(vitest[2]) : 0;
      }
      const compiled = !/Cannot find name|error TS|Transform failed|SyntaxError|is not a function|IndentationError|ModuleNotFoundError/.test(
        out
      );
      resolve({ failed, passed, ok: code === 0 && compiled, compiled, out });
    });
  });
}

/**
 * Optional selector so a long suite can be run in bounded chunks:
 *   node scratch/mutation_destination_propagation.mjs M1-M12
 *   node scratch/mutation_destination_propagation.mjs M13,M21
 * The durable backup and the restore-on-every-exit-path behaviour are
 * unchanged; only the selection differs.
 */
function selectMutants(argv) {
  if (!argv || argv.length === 0) return MUTANTS;
  const wanted = new Set();
  for (const spec of argv) {
    const range = /^M(\d+)-M(\d+)$/i.exec(spec);
    if (range) {
      for (let n = Number(range[1]); n <= Number(range[2]); n += 1) {
        wanted.add(`M${n}`);
      }
    } else {
      for (const part of spec.split(',')) wanted.add(part.trim().toUpperCase());
    }
  }
  const picked = MUTANTS.filter((m) => wanted.has(m.id));
  const missing = [...wanted].filter((id) => !MUTANTS.some((m) => m.id === id));
  if (missing.length) throw new Error(`unknown mutant id(s): ${missing.join(', ')}`);
  return picked;
}

async function main() {
  let killed = 0;
  const survivors = [];
  let invalid = 0;

  for (const mutant of selectMutants(process.argv.slice(2))) {
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
    const res = await runSuite(!!mutant.py);
    restoreOnce();
    if (res.ok && res.failed === 0) {
      survivors.push(mutant.id);
      console.log(`\n${mutant.id}  SURVIVED  ${mutant.name}\n      ${res.passed} passed`);
    } else if (!res.compiled) {
      invalid += 1;
      console.log(
        `\n${mutant.id}  INVALID-COMPILE  ${mutant.name}  (not a kill)\n${res.out.slice(-400)}`
      );
    } else {
      killed += 1;
      console.log(
        `\n${mutant.id}  KILLED  ${mutant.name}\n      ${res.failed} failed | ${res.passed} passed`
      );
    }
  }

  restoreOnce();
  cleanupBackup();
  console.log(
    `\n== ${killed} killed, ${survivors.length} survived, ${invalid} invalid of ${selectMutants(process.argv.slice(2)).length} ==`
  );
  if (survivors.length) console.log(`survivors: ${survivors.join(', ')}`);
}

main().catch((e) => {
  restoreOnce();
  console.error(e);
  process.exit(1);
});
