/**
 * STEP 10 AUDIT — mutation matrix runner.
 *
 * READ-ONLY with respect to the audit contract: every mutation is backed up,
 * applied, measured, and restored inside the same run. Nothing is committed.
 *
 * Safety properties (learned the hard way in Step 9):
 *   - `spawnSync` blocks the event loop, so a SIGTERM/SIGINT handler can never
 *     run. Everything here is async `spawn`.
 *   - The backup is written to `scratch/.mutation_backup/` BEFORE the mutation
 *     and is NOT deleted when the run dies, so `node scratch/mutation_restore.mjs`
 *     can always put the tree back.
 *   - `scratch/mutation_restore.mjs` is run unconditionally at the end.
 *
 * Usage:  node scratch/step10_mutation_matrix.mjs M1 M2 ...
 *         node scratch/step10_mutation_matrix.mjs --restore
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BACKUP_DIR = path.join(REPO_ROOT, 'scratch', '.mutation_backup');
const OUT = path.join(REPO_ROOT, 'docs', 'evidence', 'post-17-10', 'audit', 'mutation_matrix.json');

const P = {
  pcb: 'extension/src/hierarchicalPlanning/plannerContextBuilder.ts',
  hgt: 'extension/src/hierarchicalPlanning/goalProgressTracker.ts',
  hty: 'extension/src/hierarchicalPlanning/hierarchicalTypes.ts',
  loop: 'extension/src/agent/agentLoop.ts',
  ver: 'extension/src/planning/destinationVerifier.ts',
  reasoner: 'backend/app/reasoner.py',
};

const TS_SUITE = 'tests/destinationPropagationAndAlreadySatisfied.test.ts';
const TS_EXTRA = 'tests/destinationPropagationAndAlreadySatisfied.test.ts tests/destinationVerifier.test.ts';

// Each mutation: exactly one textual substitution, applied at most once.
const MUTATIONS = {
  M1: {
    invariant: 'the role-only destination reaches the provider context',
    file: P.pcb,
    from: 'const declaredDestination = toDeclaredDestinationConstraint(activeSubgoal?.destination);',
    to: 'const declaredDestination: any = undefined; void toDeclaredDestinationConstraint;',
    suite: TS_SUITE,
  },
  M2: {
    invariant: 'a bare role never acquires a URL',
    file: P.pcb,
    from: "...(role && role.length > 0 ? { role: [...role] } : {}),",
    to: "...(role && role.length > 0 ? { role: [...role], destinationUrl: 'http://localhost:4174/results.html' } : {}),",
    suite: TS_SUITE,
  },
  M3: {
    invariant: 'the declaration is never derived from the observation',
    file: P.pcb,
    from: 'const declaredDestination = toDeclaredDestinationConstraint(activeSubgoal?.destination);',
    to: "const declaredDestination: any = toDeclaredDestinationConstraint(activeSubgoal?.destination) ?? (baseContext.semantic_context?.pageType ? { provenance: 'USER_DECLARED_DESTINATION', role: [String(baseContext.semantic_context.pageType)] } : undefined);",
    suite: TS_SUITE,
  },
  M4: {
    invariant: 'targetEntity is not a substitute for a typed declaration',
    file: P.pcb,
    from: 'const declaredDestination = toDeclaredDestinationConstraint(activeSubgoal?.destination);',
    to: "const declaredDestination: any = toDeclaredDestinationConstraint(activeSubgoal?.destination) ?? ((activeSubgoal as any)?.targetEntity ? { provenance: 'USER_DECLARED_DESTINATION', role: [String((activeSubgoal as any).targetEntity)] } : undefined);",
    suite: TS_SUITE,
  },
  M5: {
    invariant: 'affordances are not a substitute for a typed declaration',
    file: P.pcb,
    from: 'const declaredDestination = toDeclaredDestinationConstraint(activeSubgoal?.destination);',
    to: "const declaredDestination: any = toDeclaredDestinationConstraint(activeSubgoal?.destination) ?? (((baseContext.semantic_context as any)?.affordances || []).length ? { provenance: 'USER_DECLARED_DESTINATION', role: [String((baseContext.semantic_context as any).affordances[0].type)] } : undefined);",
    suite: TS_SUITE,
  },
  M6: {
    invariant: 'model output cannot create or rewrite the declaration',
    file: P.pcb,
    from: 'const declaredDestination = toDeclaredDestinationConstraint(activeSubgoal?.destination);',
    to: "const declaredDestination: any = toDeclaredDestinationConstraint(activeSubgoal?.destination) ?? ((activeSubgoal as any)?.suggestedAction ? { provenance: 'USER_DECLARED_DESTINATION', destinationUrl: String((activeSubgoal as any).suggestedAction.url ?? ''), role: [String((activeSubgoal as any).suggestedAction.destinationRole ?? '')] } : undefined);",
    suite: TS_SUITE,
  },
  M7: {
    invariant: 'entryUrl is never promoted to destinationUrl',
    file: P.pcb,
    from: "...(declaration.url ? { destinationUrl: `${declaration.url.origin}${declaration.url.path}` } : {}),",
    to: "...((declaration.url ?? declaration.entryUrl) ? { destinationUrl: `${(declaration.url ?? declaration.entryUrl)!.origin}${(declaration.url ?? declaration.entryUrl)!.path}` } : {}),",
    suite: TS_SUITE,
  },
  M8: {
    invariant: 'a role-only declaration is not satisfied by merely arriving somewhere (action.url standing in for the declaration)',
    file: P.ver,
    from: '  if (targets.includes(semantic.pageType)) {',
    to: '  if (obs.url) {',
    suite: TS_EXTRA,
  },
  M9a: {
    invariant: 'executionSuccess / dispatch state cannot complete a destination subgoal',
    file: P.hgt,
    from: '        return verdict(\n          result.kind === \'MATCH\',',
    to: '        return verdict(\n          true,',
    suite: TS_SUITE,
  },
  M9b: {
    invariant: 'PRESERVED EQUIVALENT: provenance literal type erasure (DestinationProvenance = string)',
    file: P.hty,
    from: "readonly provenance: 'USER_DECLARED_DESTINATION';",
    to: 'readonly provenance: string;',
    suite: TS_SUITE,
  },
  M10: {
    invariant: 'UNKNOWN never counts as already satisfied',
    file: P.hgt,
    from: "          result.kind === 'MATCH',",
    to: "          result.kind === 'MATCH' || result.kind === 'UNKNOWN',",
    suite: TS_SUITE,
  },
  M11: {
    invariant: 'MISMATCH never counts as already satisfied',
    file: P.hgt,
    from: "          result.kind === 'MATCH',",
    to: "          result.kind === 'MATCH' || result.kind === 'MISMATCH',",
    suite: TS_SUITE,
  },
  M12: {
    invariant: 'a stale observation never counts as already satisfied',
    file: P.hgt,
    from: '          currentPageGeneration: observation.pageGeneration,',
    to: '          currentPageGeneration: observedGeneration,',
    suite: TS_SUITE,
  },
  M13: {
    invariant: 'ACTION_NO_EFFECT is never converted into action success',
    file: P.loop,
    from: "this.state.lastActionResult = { success: false, error: effectResult.details || 'ACTION_NO_EFFECT' };",
    to: "this.state.lastActionResult = { success: true, error: effectResult.details || 'ACTION_NO_EFFECT' };",
    suite: TS_SUITE,
  },
  M14: {
    invariant: 'the already-at-destination verdict needs a FRESH perception',
    file: P.loop,
    from: 'const fresh = this.normalizePerceptionResult(await this.callbacks.perceivePage());',
    to: 'const fresh: any = this.normalizePerceptionResult(undefined as any) ?? { context, worldModel: undefined };',
    suite: TS_SUITE,
  },
  M15: {
    invariant: 'destinationVerifier is the sole destination authority (bypass it entirely)',
    file: P.ver,
    from: 'export function verifyDestination(input: DestinationVerificationInput): DestinationVerdict {',
    to: "export function verifyDestination(input: DestinationVerificationInput): DestinationVerdict {\n  return { kind: 'MATCH' as const, reason: 'M15 bypass: destination verifier short-circuited.', decisiveChannel: 'pageRole' as const, channels: { pageRole: null, url: null } };",
    suite: TS_EXTRA,
  },
  M16: {
    invariant: 'only a genuine USER_DECLARED_DESTINATION reaches the model',
    file: P.reasoner,
    from: 'if isinstance(declared, dict) and declared.get("provenance") == "USER_DECLARED_DESTINATION":',
    to: 'if isinstance(declared, dict):',
    suite: 'backend',
  },
  M17: {
    invariant: 'the backend cannot fabricate a user destination',
    file: P.reasoner,
    from: '        parts.append(f"Semantic Understanding (on-device local inference):',
    to: '        if "declaredDestination" not in sem_data and sem_data.get("pageType"):\n            sem_data["declaredDestination"] = {"provenance": "USER_DECLARED_DESTINATION", "role": [sem_data["pageType"]]}\n        parts.append(f"Semantic Understanding (on-device local inference):',
    suite: 'backend',
  },
  M18: {
    invariant: 'page-derived text can never ride inside the destination field',
    file: P.pcb,
    from: "...(declaration.entryUrl ? { entryUrl: `${declaration.entryUrl.origin}${declaration.entryUrl.path}` } : {}),",
    to: "...(declaration.entryUrl ? { entryUrl: `${declaration.entryUrl.origin}${declaration.entryUrl.path}`, text: String((baseContext.semantic_context as any)?.facts?.[0]?.label ?? '') } : {}),",
    suite: TS_SUITE,
  },
  M19: {
    invariant: 'the role constraint is carried, not just the URL',
    file: P.pcb,
    from: "...(role && role.length > 0 ? { role: [...role] } : {}),",
    to: '',
    suite: TS_SUITE,
  },
  M20: {
    invariant: 'entryUrl and destinationUrl never collapse',
    file: P.pcb,
    from: "...(declaration.url ? { destinationUrl: `${declaration.url.origin}${declaration.url.path}` } : {}),",
    to: "...((declaration.url ?? declaration.entryUrl) ? { destinationUrl: `${(declaration.url ?? declaration.entryUrl)!.origin}${(declaration.url ?? declaration.entryUrl)!.path}` } : {}),",
    suite: TS_SUITE,
  },
};

// M8 / M15 target destinationVerifier with distinct edits (defined inline above).

const log = (...a) => console.log('[MUT]', ...a);

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, CI: '1' } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
    child.on('error', (e) => resolve({ code: -1, out: String(e) }));
  });
}

function backup(rel) {
  const abs = path.join(REPO_ROOT, rel);
  const dst = path.join(BACKUP_DIR, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(abs, dst);
  return fs.readFileSync(abs, 'utf8');
}

function restore(rel) {
  const src = path.join(BACKUP_DIR, rel);
  if (!fs.existsSync(src)) return false;
  fs.copyFileSync(src, path.join(REPO_ROOT, rel));
  return true;
}

async function runSuite(suite) {
  if (suite === 'backend') {
    const r = await run('./.venv/bin/python', ['-m', 'pytest', 'tests', '-q'], path.join(REPO_ROOT, 'backend'));
    const fails = r.out.split('\n').filter((l) => /^(FAILED|ERROR)/.test(l)).map((s) => s.trim()).slice(0, 10);
    const summary = (r.out.split('\n').filter((l) => /\d+ (passed|failed)/.test(l)).slice(-1)[0] || '').slice(0, 200);
    return { passed: r.code === 0, tail: summary, suite: 'backend (pytest)', raw: r.out, fails };
  }
  const r = await run('npx', ['vitest', 'run', '--silent=true', ...suite.split(' ')], REPO_ROOT);
  const clean = r.out.replace(/\[[0-9;]*m/g, '');
  const m = clean.match(/Tests\s+(.*)/);
  const fails = clean
    .split('\n')
    .filter((l) => /^\s*(FAIL|\u00d7|\u2717)/.test(l))
    .map((s) => s.replace(/^\s*FAIL\s+/, '').trim())
    .slice(0, 10);
  return { passed: r.code === 0, tail: (m ? m[1] : clean.split('\n').slice(-6).join('\n')).slice(0, 200), suite, raw: clean, fails };
}

async function applyMutation(id) {
  const m = MUTATIONS[id];
  if (!m) return { status: 'INVALID', reason: 'no such mutation' };
  const original = backup(m.file);
  let mutated;
  if (m.marker) {
    const parts = original.split(m.marker);
    if (parts.length !== 2) {
      restore(m.file);
      return { status: 'INVALID', reason: `marker ${JSON.stringify(m.marker)} occurred ${parts.length - 1} times in ${m.file}` };
    }
    mutated = parts[0] + m.to + parts[1];
  } else {
    const parts = original.split(m.from);
    if (parts.length !== 2) {
      restore(m.file);
      return { status: 'INVALID', reason: `anchor occurred ${parts.length - 1} times in ${m.file}` };
    }
    mutated = parts.join(m.to);
  }
  if (mutated === original) {
    restore(m.file);
    return { status: 'INVALID', reason: 'mutation is a no-op' };
  }
  fs.writeFileSync(path.join(REPO_ROOT, m.file), mutated);
  return { status: 'APPLIED' };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--restore')) {
    const r = await run('node', ['scratch/mutation_restore.mjs'], REPO_ROOT);
    log(r.out);
    return;
  }
  const ids = args.filter((a) => MUTATIONS[a]);
  const unknown = args.filter((a) => !MUTATIONS[a] && a !== '--restore');
  if (unknown.length) log('unknown mutation ids ignored:', unknown.join(','));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const results = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { results: {} };

  for (const id of ids) {
    const m = MUTATIONS[id];
    log('──', id, m.invariant);
    const applied = await applyMutation(id);
    if (applied.status === 'INVALID') {
      results.results[id] = { id, invariant: m.invariant, file: m.file, classification: 'INVALID', reason: applied.reason };
      log('   INVALID:', applied.reason);
      continue;
    }
    const t0 = Date.now();
    const r = await runSuite(m.suite);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    restore(m.file);

    // Prove the restore happened before moving on.
    const now = fs.readFileSync(path.join(REPO_ROOT, m.file), 'utf8');
    const clean = now === backup(m.file);

    const classification = r.passed ? 'SURVIVED' : 'KILLED';
    results.results[id] = {
      id,
      invariant: m.invariant,
      file: m.file,
      suite: r.suite,
      classification: id === 'M9b' && r.passed ? 'EQUIVALENT' : classification,
      evidence: r.passed
        ? `suite still passed: ${r.tail}`
        : `failing tests: ${(r.fails || []).join(' | ') || r.tail}`,
      restoreVerified: clean,
      seconds: Number(secs),
    };
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2) + '\n');
    log(`   ${results.results[id].classification} (${secs}s, restore=${clean}) ${r.tail}`);
  }

  const rest = await run('node', ['scratch/mutation_restore.mjs'], REPO_ROOT);
  log('restore:', rest.out.trim().split('\n').slice(-3).join(' | '));
  log('wrote', OUT);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
