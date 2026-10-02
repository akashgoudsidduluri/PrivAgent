/**
 * POST-17.10 Step 10.2 (G2/G3/G4) — targeted mutation runner.
 *
 * Every mutation here weakens a security or semantic contract that Step 10.2
 * exists to enforce. A mutant is KILLED only when the FOCUSED suite (the
 * Step 10.2 matrix plus every pre-existing destination suite) fails, and the
 * reason it fails is captured so "killed by an unrelated test" can be spotted.
 *
 * Durable backup, auto-restore, byte-verified restore, then the backup dir is
 * removed. Run `node scratch/mutation_restore.mjs` afterwards if this is
 * interrupted.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP = join(REPO_ROOT, 'scratch/.mutation_backup_step102');
const OUT = join(REPO_ROOT, 'docs/evidence/post-17-10/audit/mutation_matrix_step10_2.json');

const EXT_SUITE = [
  'tests/step10_2_destinationTrustBoundary.test.ts',
  'tests/destinationPropagationAndAlreadySatisfied.test.ts',
  'tests/destinationNormalizer.test.ts',
  'tests/destinationProducerWiring.test.ts',
  'tests/destinationVerifier.test.ts',
  'tests/classificationDestinationGap.test.ts',
  'tests/destinationNavigationIntent.test.ts',
  'tests/contextMinimizer.test.ts',
  'tests/taskDecomposer.test.ts',
].join(' ');

const PY_TESTS = 'tests/test_step10_2_destination_trust_boundary.py tests/test_step10_declared_destination.py';

const FILES = [
  'extension/src/planning/destinationNormalizer.ts',
  'extension/src/planning/destinationVerifier.ts',
  'extension/src/hierarchicalPlanning/plannerContextBuilder.ts',
  'extension/src/privacy/contextMinimizer.ts',
  'backend/app/reasoner.py',
];

// ── mutations ───────────────────────────────────────────────────────────────
// `find` MUST be a unique, exact substring of the live file.

const MUTATIONS = [
  // ── G2: model-facing propagation ────────────────────────────────────────
  {
    id: 'G2-01',
    gap: 'G2',
    file: 'extension/src/privacy/contextMinimizer.ts',
    intent: 'remove the declaration from the model-facing projection',
    find: '        declaredDestination: payload.semantic_context.declaredDestination,',
    replace: '        declaredDestination: undefined,',
  },
  {
    id: 'G2-02',
    gap: 'G2',
    file: 'extension/src/privacy/contextMinimizer.ts',
    intent: 'model-facing view substitutes the ENTRY url for the destination',
    find: '        declaredDestination: payload.semantic_context.declaredDestination,',
    replace:
      '        declaredDestination: payload.semantic_context.declaredDestination && payload.semantic_context.declaredDestination.entryUrl\n          ? { ...payload.semantic_context.declaredDestination, destinationUrl: payload.semantic_context.declaredDestination.entryUrl, entryUrl: undefined }\n          : payload.semantic_context.declaredDestination,',
  },
  {
    id: 'G2-03',
    gap: 'G2',
    file: 'extension/src/privacy/contextMinimizer.ts',
    intent: 'model-facing view drops the role channel',
    find: '        declaredDestination: payload.semantic_context.declaredDestination,',
    replace:
      '        declaredDestination: payload.semantic_context.declaredDestination && { provenance: payload.semantic_context.declaredDestination.provenance },',
  },
  {
    id: 'G2-04',
    gap: 'G2',
    file: 'extension/src/privacy/contextMinimizer.ts',
    intent: 'minimization stops forwarding semantic_context wholesale (production path regression)',
    find: "    ...(payload.semantic_context ? { semantic_context: payload.semantic_context } : {}),",
    replace: '    // MUTANT: semantic_context dropped from the minimized payload',
  },
  {
    id: 'G2-05',
    gap: 'G2',
    file: 'extension/src/hierarchicalPlanning/plannerContextBuilder.ts',
    intent: 'planner stops injecting the declaration into the model-facing context',
    find: '    const declaredDestination = toDeclaredDestinationConstraint(\n      goal.destinationDeclaration ?? activeSubgoal?.destination\n    );',
    replace: '    const declaredDestination = undefined;',
  },
  {
    id: 'G2-06',
    gap: 'G2',
    file: 'extension/src/hierarchicalPlanning/plannerContextBuilder.ts',
    intent: 'declaration synthesised for a subgoal that has none (undeclared task becomes declared)',
    find: '    const declaredDestination = toDeclaredDestinationConstraint(\n      goal.destinationDeclaration ?? activeSubgoal?.destination\n    );',
    replace:
      "    const declaredDestination = toDeclaredDestinationConstraint(\n      goal.destinationDeclaration ?? activeSubgoal?.destination\n    ) ?? { provenance: 'USER_DECLARED_DESTINATION' as const, role: ['LISTING'] as const };",
  },

  // ── G3: entry url vs destination url ────────────────────────────────────
  {
    id: 'G3-01',
    gap: 'G3',
    file: 'extension/src/hierarchicalPlanning/plannerContextBuilder.ts',
    intent: 'destinationUrl → entryUrl (the user URL lands in the wrong field)',
    find: '    ...(declaration.url ? { destinationUrl: `${declaration.url.origin}${declaration.url.path}` } : {}),',
    replace: '    ...(declaration.url ? { entryUrl: `${declaration.url.origin}${declaration.url.path}` } : {}),',
  },
  {
    id: 'G3-02',
    gap: 'G3',
    file: 'extension/src/hierarchicalPlanning/plannerContextBuilder.ts',
    intent: 'entryUrl → destinationUrl',
    find: '    ...(declaration.entryUrl ? { entryUrl: `${declaration.entryUrl.origin}${declaration.entryUrl.path}` } : {}),',
    replace: '    ...(declaration.entryUrl ? { destinationUrl: `${declaration.entryUrl.origin}${declaration.entryUrl.path}` } : {}),',
  },
  {
    id: 'G3-03',
    gap: 'G3',
    file: 'extension/src/hierarchicalPlanning/plannerContextBuilder.ts',
    intent: 'drop destinationUrl entirely during serialization',
    find: '    ...(declaration.url ? { destinationUrl: `${declaration.url.origin}${declaration.url.path}` } : {}),',
    replace: '    // MUTANT: destinationUrl dropped',
  },
  {
    id: 'G3-04',
    gap: 'G3',
    file: 'extension/src/hierarchicalPlanning/plannerContextBuilder.ts',
    intent: 'destinationUrl replaced by the CURRENT page url',
    find: '    ...(declaration.url ? { destinationUrl: `${declaration.url.origin}${declaration.url.path}` } : {}),',
    replace:
      '    ...(true ? { destinationUrl: (() => { try { const u = new URL(baseContext.url); return `${u.origin}${u.pathname}`.replace(/\\/+$/, \'\') || u.origin; } catch { return \'\'; } })() } : {}),',
  },
  {
    id: 'G3-05',
    gap: 'G3',
    file: 'extension/src/hierarchicalPlanning/plannerContextBuilder.ts',
    intent: 'a role-only declaration acquires a fabricated URL',
    find: '    ...(declaration.url ? { destinationUrl: `${declaration.url.origin}${declaration.url.path}` } : {}),',
    replace:
      '    ...(declaration.url ? { destinationUrl: `${declaration.url.origin}${declaration.url.path}` } : declaration.role ? { destinationUrl: `${baseContext.origin ?? \'http://localhost:4174\'}/results.html` } : {}),',
  },
  {
    id: 'G3-06',
    gap: 'G3',
    file: 'extension/src/planning/destinationNormalizer.ts',
    intent: 'the URL is re-bound to the first role construct (the Step 10.2 regression itself)',
    find: "    if (tokens[i + verbLen] === URL_PLACEHOLDER) {",
    replace: '    if (false && tokens[i + verbLen] === URL_PLACEHOLDER) {',
  },
  {
    id: 'G3-07',
    gap: 'G3',
    file: 'extension/src/planning/destinationNormalizer.ts',
    intent: 'a URL claimed as a destination is ALSO attached as an entry url',
    find: '  if (urlClaimedAsDestination) return out;',
    replace: '  if (false && urlClaimedAsDestination) return out;',
  },
  {
    id: 'G3-08',
    gap: 'G3',
    file: 'extension/src/planning/destinationVerifier.ts',
    intent: 'URL comparison weakened to SUBSTRING',
    find: '  const same = observed.origin === declared.origin && observed.path === declared.path;',
    replace:
      '  const same = `${observed.origin}${observed.path}`.includes(`${declared.origin}${declared.path}`) || `${declared.origin}${declared.path}`.includes(`${observed.origin}${observed.path}`);',
  },
  {
    id: 'G3-09',
    gap: 'G3',
    file: 'extension/src/planning/destinationVerifier.ts',
    intent: 'URL comparison weakened to HOSTNAME-ONLY',
    find: '  const same = observed.origin === declared.origin && observed.path === declared.path;',
    replace:
      "  const same = (() => { try { return new URL(observed.origin).hostname === new URL(declared.origin).hostname; } catch { return false; } })();",
  },
  {
    id: 'G3-10',
    gap: 'G3',
    file: 'extension/src/planning/destinationVerifier.ts',
    intent: 'URL comparison weakened to PATH-PREFIX',
    find: '  const same = observed.origin === declared.origin && observed.path === declared.path;',
    replace:
      '  const same = observed.origin === declared.origin && (observed.path === declared.path || observed.path.startsWith(declared.path));',
  },
  {
    id: 'G3-11',
    gap: 'G3',
    file: 'extension/src/planning/destinationVerifier.ts',
    intent: 'entryUrl becomes a verifiable destination channel',
    find: '  const url = declaration.url ? verifyUrl(declaration.url, input) : null;',
    replace:
      '  const url = declaration.url\n    ? verifyUrl(declaration.url, input)\n    : declaration.entryUrl\n      ? verifyUrl(declaration.entryUrl, input)\n      : null;',
  },

  // ── G4: backend trust boundary ──────────────────────────────────────────
  {
    id: 'G4-01',
    gap: 'G4',
    file: 'backend/app/reasoner.py',
    intent: 'remove provenance validation entirely',
    find: '    if declared.get("provenance") != USER_DECLARED_DESTINATION:\n        return None\n',
    replace: '    # MUTANT: provenance not validated\n',
  },
  {
    id: 'G4-02',
    gap: 'G4',
    file: 'backend/app/reasoner.py',
    intent: 'accept ANY provenance literal',
    find: '    if declared.get("provenance") != USER_DECLARED_DESTINATION:\n        return None\n',
    replace: '    if declared.get("provenance") is None:\n        return None\n',
  },
  {
    id: 'G4-03',
    gap: 'G4',
    file: 'backend/app/reasoner.py',
    intent: 'accept any provenance that merely CONTAINS the token (case/prefix escape)',
    find: '    if declared.get("provenance") != USER_DECLARED_DESTINATION:\n        return None\n',
    replace:
      '    _p = declared.get("provenance")\n    if not isinstance(_p, str) or USER_DECLARED_DESTINATION.lower() not in _p.lower():\n        return None\n',
  },
  {
    id: 'G4-04',
    gap: 'G4',
    file: 'backend/app/reasoner.py',
    intent: 'drop the closed-key allowlist (declaration may carry arbitrary fields)',
    find: '    if not set(declared.keys()).issubset(ALLOWED_DECLARED_DESTINATION_KEYS):\n        return None\n',
    replace: '    # MUTANT: key allowlist removed\n',
  },
  {
    id: 'G4-05',
    gap: 'G4',
    file: 'backend/app/reasoner.py',
    intent: 'drop the closed role vocabulary',
    find: '        if any(not isinstance(r, str) or r not in DECLARABLE_PAGE_TYPES for r in role):\n            return None\n',
    replace: '        if any(not isinstance(r, str) for r in role):\n            return None\n',
  },
  {
    id: 'G4-06',
    gap: 'G4',
    file: 'backend/app/reasoner.py',
    intent: 'drop URL attestation against the trusted channel',
    find: '    normalized = _normalize_declared_url(raw)\n    if normalized is None:\n        return False\n    return normalized in _urls_typed_by_user(task)',
    replace: '    return _normalize_declared_url(raw) is not None',
  },
  {
    id: 'G4-07',
    gap: 'G4',
    file: 'backend/app/reasoner.py',
    intent: 'drop the marker-POSITION check (page channels may carry a declaration)',
    find: '    if walk(semantic_context, True, True):\n        return True\n    return walk(history, False, False)',
    replace: '    return False',
  },
  {
    id: 'G4-08',
    gap: 'G4',
    file: 'backend/app/reasoner.py',
    intent: 'accept ERROR/UNKNOWN as declarable page roles',
    find: 'DECLARABLE_PAGE_TYPES: frozenset[str] = frozenset(\n    {"SEARCH", "LOGIN", "ARTICLE", "LISTING", "FORM", "CHECKOUT", "SETTINGS", "DASHBOARD"}\n)',
    replace:
      'DECLARABLE_PAGE_TYPES: frozenset[str] = frozenset(\n    {"SEARCH", "LOGIN", "ARTICLE", "LISTING", "FORM", "CHECKOUT", "SETTINGS", "DASHBOARD", "ERROR", "UNKNOWN", "ANYTHING"}\n)',
  },
  {
    id: 'G4-09',
    gap: 'G4',
    file: 'backend/app/reasoner.py',
    intent: 'alias the caller\'s objects instead of copying (rewritable after validation)',
    find: '        out["role"] = list(role)',
    replace: '        out["role"] = role',
  },
  {
    id: 'G4-10',
    gap: 'G4',
    file: 'backend/app/reasoner.py',
    intent: 'drop the "must assert something" rule (empty declaration rendered)',
    find: '    if "role" not in out and "destinationUrl" not in out:\n        return None\n',
    replace: '    # MUTANT: empty declaration allowed\n',
  },
  {
    id: 'G4-11',
    gap: 'G4',
    file: 'backend/app/reasoner.py',
    intent: 'URL query/fragment stripped instead of refused (identity smuggling)',
    find: '    if "?" in raw or "#" in raw or "@" in raw:\n        return None\n',
    replace: '    if "@" in raw:\n        return None\n',
  },
  {
    id: 'G4-12',
    gap: 'G4',
    file: 'backend/app/reasoner.py',
    intent: 'URL attestation degrades to a PREFIX containment check',
    find: '    return normalized in _urls_typed_by_user(task)',
    replace:
      '    return any(t.startswith(normalized) or normalized.startswith(t) for t in _urls_typed_by_user(task))',
  },
];

// ── runner ──────────────────────────────────────────────────────────────────

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

function reasonOf(output) {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  const fails = lines.filter((l) => /^(FAIL|AssertionError|✗|×|E\s)/.test(l) || /AssertionError/.test(l));
  return (fails[0] || lines[lines.length - 1] || '').slice(0, 300);
}

async function main() {
  // durable backup
  rmSync(BACKUP, { recursive: true, force: true });
  mkdirSync(BACKUP, { recursive: true });
  for (const f of FILES) {
    const dest = join(BACKUP, f);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(join(REPO_ROOT, f)));
  }

  const results = [];
  for (const m of MUTATIONS) {
    const abs = join(REPO_ROOT, m.file);
    const original = readFileSync(abs, 'utf8');
    const occurrences = original.split(m.find).length - 1;
    if (occurrences !== 1) {
      results.push({ ...m, verdict: 'INVALID', detail: `find string occurs ${occurrences} times` });
      continue;
    }
    writeFileSync(abs, original.replace(m.find, m.replace));

    const isPy = m.file.endsWith('.py');
    const { code, out } = isPy
      ? await run('./.venv/bin/python', ['-m', 'pytest', ...PY_TESTS.split(' '), '-q', '--no-header'], join(REPO_ROOT, 'backend'))
      : await run('npx', ['vitest', 'run', '--silent=true', ...EXT_SUITE.split(' ')], REPO_ROOT);

    writeFileSync(abs, original);
    results.push({
      ...m,
      verdict: code === 0 ? 'SURVIVED' : 'KILLED',
      detail: reasonOf(out),
    });
    console.log(`${results[results.length - 1].verdict.padEnd(9)} ${m.id}  ${m.intent}`);
  }

  // byte-verify restore
  const { execSync } = await import('node:child_process');
  let clean = true;
  for (const f of FILES) {
    try {
      execSync(`cmp -s "${join(BACKUP, f)}" "${join(REPO_ROOT, f)}"`, { stdio: 'ignore' });
    } catch {
      clean = false;
      console.error('RESTORE MISMATCH', f);
    }
  }
  console.log('\nrestore byte-identical:', clean);
  if (clean) rmSync(BACKUP, { recursive: true, force: true });

  const tally = results.reduce((acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] || 0) + 1 }), {});
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        work: 'POST-17.10 STEP 10.2 — G2/G3/G4 targeted mutation matrix',
        labels: 'PROVEN_UNIT_ONLY (extension suites + in-process backend suites)',
        focusedExtensionSuites: EXT_SUITE.split(' '),
        focusedBackendTests: PY_TESTS.split(' '),
        tally,
        results: results.map(({ find, replace, ...rest }) => rest),
      },
      null,
      2
    )
  );
  console.log(JSON.stringify(tally));
}

main();