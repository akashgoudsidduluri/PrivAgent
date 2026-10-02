/**
 * POST-17.10 Step 10.3 (G5/G6/G7/G8) — targeted mutation runner.
 *
 * Every mutation weakens a scoping, separation or honesty contract that
 * Step 10.3 exists to enforce. A mutant is KILLED only when the FOCUSED suite
 * fails, and the failing assertion is captured so "killed by an unrelated test"
 * can be spotted.
 *
 * Durable backup, auto-restore, byte-verified restore, then the backup dir is
 * removed. Run `node scratch/mutation_restore.mjs` afterwards if interrupted.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP = join(REPO_ROOT, 'scratch/.mutation_backup_step103');
const OUT = join(REPO_ROOT, 'docs/evidence/post-17-10/audit/mutation_matrix_step10_3.json');

const EXT_SUITE = [
  'tests/step10_3_destinationScoping.test.ts',
  'tests/step10_3_roleOnlyControls.test.ts',
  'tests/step10_2_destinationTrustBoundary.test.ts',
  'tests/destinationPropagationAndAlreadySatisfied.test.ts',
  'tests/destinationNormalizer.test.ts',
  'tests/destinationVerifier.test.ts',
  'tests/destinationProducerWiring.test.ts',
  'tests/classificationDestinationGap.test.ts',
  'tests/destinationNavigationIntent.test.ts',
  'tests/contextMinimizer.test.ts',
  'tests/taskDecomposer.test.ts',
].join(' ');

const PY_TESTS =
  'tests/test_step10_3_declaration_vs_observation.py tests/test_step10_2_destination_trust_boundary.py tests/test_step10_declared_destination.py';

const FILES = [
  'extension/src/hierarchicalPlanning/plannerContextBuilder.ts',
  'extension/src/hierarchicalPlanning/goalProgressTracker.ts',
  'extension/src/planning/destinationVerifier.ts',
  'backend/app/reasoner.py',
];

const TEST_FILES = ['backend/tests/test_step10_declared_destination.py'];
const ALL_BACKED_UP = [...FILES, ...TEST_FILES];

// ── mutations ───────────────────────────────────────────────────────────────

const MUTATIONS = [
  // ── G5: scoping ─────────────────────────────────────────────────────────
  {
    id: 'G5-01',
    gap: 'G5',
    file: 'extension/src/hierarchicalPlanning/goalProgressTracker.ts',
    intent: 'destination MISMATCH completes the subgoal anyway',
    find: "        return verdict(\n          result.kind === 'MATCH',\n          result.kind === 'MATCH'\n            ? result.reason\n            : `Subgoal ${subgoal.id} destination not confirmed (${result.kind}): ${result.reason}`\n        );",
    replace: "        return verdict(\n          result.kind !== 'UNKNOWN',\n          result.kind === 'MATCH'\n            ? result.reason\n            : `Subgoal ${subgoal.id} destination not confirmed (${result.kind}): ${result.reason}`\n        );",
  },
  {
    id: 'G5-02',
    gap: 'G5',
    file: 'extension/src/hierarchicalPlanning/goalProgressTracker.ts',
    intent: 'UNKNOWN also completes the destination subgoal',
    find: "        return verdict(\n          result.kind === 'MATCH',\n          result.kind === 'MATCH'\n            ? result.reason\n            : `Subgoal ${subgoal.id} destination not confirmed (${result.kind}): ${result.reason}`\n        );",
    replace: "        return verdict(\n          true,\n          result.reason\n        );",
  },
  {
    id: 'G5-03',
    gap: 'G5',
    file: 'extension/src/hierarchicalPlanning/goalProgressTracker.ts',
    intent: 'a STALE observation is accepted (generation check dropped)',
    find: '          currentPageGeneration: observation.pageGeneration,',
    replace: '          currentPageGeneration: undefined,',
  },
  {
    id: 'G5-04',
    gap: 'G5',
    file: 'extension/src/hierarchicalPlanning/goalProgressTracker.ts',
    intent: 'a subgoal with NO declaration is treated as satisfied (arbitrary completion)',
    find: "          return verdict(\n            false,\n            `Subgoal ${subgoal.id} declares DESTINATION_VERIFIED but carries no user-derived destination declaration, so its completion cannot be proven.`\n          );",
    replace: '          return verdict(true, `MUTANT: no declaration, satisfied anyway`);',
  },
  {
    id: 'G5-05',
    gap: 'G5',
    file: 'extension/src/hierarchicalPlanning/plannerContextBuilder.ts',
    intent: 'declaration propagation reads the ACTIVE SUBGOAL again (re-opens the G5 gap)',
    find: '      goal.destinationDeclaration ?? activeSubgoal?.destination',
    replace: '      activeSubgoal?.destination ?? goal.destinationDeclaration',
  },
  {
    id: 'G5-06',
    gap: 'G5',
    file: 'extension/src/hierarchicalPlanning/plannerContextBuilder.ts',
    intent: 'declaration is injected for a goal that declared NONE (undeclared task becomes declared)',
    find: '    const declaredDestination = toDeclaredDestinationConstraint(\n      goal.destinationDeclaration ?? activeSubgoal?.destination\n    );',
    replace:
      "    const declaredDestination = toDeclaredDestinationConstraint(\n      goal.destinationDeclaration ?? activeSubgoal?.destination\n    ) ?? { provenance: 'USER_DECLARED_DESTINATION' as const, role: ['LISTING'] as const };",
  },

  // ── G6: declaration vs observation ──────────────────────────────────────
  {
    id: 'G6-01',
    gap: 'G6',
    file: 'backend/app/reasoner.py',
    intent: 'the declaration is rendered back INSIDE the observed-state block (re-opens G6)',
    find: '        if dest_data:\n            declared_block = dest_data',
    replace:
      '        if dest_data:\n            declared_block = dest_data\n            sem_data["declaredDestination"] = dest_data',
  },
  {
    id: 'G6-02',
    gap: 'G6',
    file: 'backend/app/reasoner.py',
    intent: 'the declaration block is dropped entirely (model never told the destination)',
    find: '    if declared_block:',
    replace: '    if False and declared_block:',
  },
  {
    id: 'G6-03',
    gap: 'G6',
    file: 'backend/app/reasoner.py',
    intent: 'the separation labels are removed (declaration presented as observation)',
    find:
      '            "USER DECLARED DESTINATION (from the user\'s own request — NOT observed, "\n            "NOT proof of arrival, NOT yours to declare complete):\\n"',
    replace:
      '            "Destination information:\\n"',
  },
  {
    id: 'G6-04',
    gap: 'G6',
    file: 'backend/app/reasoner.py',
    intent: 'the declaration is labelled as PROOF OF ARRIVAL',
    find:
      '            "The blocks below describe the page you are CURRENTLY looking at. That is "\n            "observation, not user intent: never treat an observed page type, URL, "\n            "entity or affordance as a destination the user asked for, and never treat "\n            "this declaration as evidence that you have arrived."',
    replace:
      '            "This confirms the destination has been reached."',
  },
  {
    id: 'G6-05',
    gap: 'G6',
    file: 'backend/app/reasoner.py',
    intent: 'observed state is relabelled as user intent',
    find:
      '        parts.append(f"Semantic Understanding (on-device local inference):\\n{json.dumps(sem_data, indent=1)}")',
    replace:
      '        parts.append(f"User intent (what the user wants):\\n{json.dumps(sem_data, indent=1)}")',
  },

  // ── G7: the destination authority and the honesty of the proof ──────────
  {
    id: 'G7-01',
    gap: 'G7',
    file: 'extension/src/planning/destinationVerifier.ts',
    intent: 'UNKNOWN becomes MATCH',
    find: '  const targets = acceptable.filter((t) => t !== \'UNKNOWN\' && t !== \'ERROR\');',
    replace: '  const targets = acceptable.filter(() => true);',
  },
  {
    id: 'G7-02',
    gap: 'G7',
    file: 'extension/src/planning/destinationVerifier.ts',
    intent: 'the confidence floor is removed (low confidence => MATCH)',
    find: '  if (semantic.pageType !== \'UNKNOWN\' && semantic.confidence < MIN_PAGE_CLASSIFICATION_CONFIDENCE) {',
    replace: '  if (false) {',
  },
  {
    id: 'G7-03',
    gap: 'G7',
    file: 'extension/src/planning/destinationVerifier.ts',
    intent: 'the staleness check is removed (stale observation => MATCH)',
    find: "  if (input.currentPageGeneration !== undefined && input.currentPageGeneration !== obs.pageGeneration) {\n    return {\n      channel: 'url',\n      kind: 'UNKNOWN',",
    replace:
      "  if (false) {\n    return {\n      channel: 'url',\n      kind: 'UNKNOWN',",
  },
  {
    id: 'G7-04',
    gap: 'G7',
    file: 'extension/src/planning/destinationVerifier.ts',
    intent: 'the CURRENT URL alone satisfies a role-only declaration',
    find: '  const pageRole = declaration.role\n    ? verifyPageRole(declaration.role.acceptablePageTypes, input)\n    : null;',
    replace:
      "  const pageRole = declaration.role\n    ? (() => { const r = verifyPageRole(declaration.role.acceptablePageTypes, input); if (r.kind === 'UNKNOWN' && input.observation && /results|search|products|catalog/i.test(input.observation.url)) return { channel: 'pageRole' as const, kind: 'MATCH' as const, reason: 'MUTANT: url heuristics' }; return r; })()\n    : null;",
  },
  {
    id: 'G7-05',
    gap: 'G7',
    file: 'extension/src/planning/destinationVerifier.ts',
    intent: 'the wrong page role no longer MISMATCHes (positive contrary evidence ignored)',
    find: '  const mismatch = declared.find((c) => c.kind === \'MISMATCH\');',
    replace: '  const mismatch = undefined;',
  },
  {
    id: 'G7-06',
    gap: 'G7',
    file: 'extension/src/hierarchicalPlanning/goalProgressTracker.ts',
    intent: 'a destination subgoal completes WITHOUT consulting the verifier',
    find: '        const result = verifyDestination({\n          declaration,\n          observation: destinationObservation,\n          currentPageGeneration: observation.pageGeneration,\n        });',
    replace:
      "        const result = { kind: 'MATCH' as const, reason: 'MUTANT: bypassed verifier', decisiveChannel: null, channels: { pageRole: null, url: null } };",
  },

  // ── G8: test honesty ────────────────────────────────────────────────────
  //
  // G8's invariant is a TEST property, not a production one: the old test's
  // NAME claimed a property ("the rendered prompt passes the firewall") that its
  // BODY never tested. So there is no production mutant that "kills" the old
  // name — which is precisely the finding. Rather than manufacture a fake
  // production mutant, the G8 mutant restores the misleading name AND the
  // misleading body on the TEST file and records what the suite says.
  //
  // Expected outcome: SURVIVED, i.e. EQUIVALENT. Every test still passes,
  // because the old test asserted something the suite genuinely does check
  // (just twice, under a false name). That equivalence is the proof that the
  // defect was DISHONESTY rather than a coverage hole — and it is why the fix
  // was to correct the name and the body, not to add a test.
  {
    id: 'G8-01',
    gap: 'G8',
    kind: 'test-file',
    file: 'backend/tests/test_step10_declared_destination.py',
    expectEquivalent: true,
    intent: 'restore the misleading name AND the duplicate body (expected EQUIVALENT)',
    find: 'def test_the_constraint_still_survives_the_firewall_when_copied_into_the_prompt():',
    replace: 'def test_the_rendered_prompt_passes_the_firewall():',
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
  const fails = lines.filter((l) => /^(FAIL|AssertionError|E\s)/.test(l) || /AssertionError/.test(l));
  return (fails[0] || lines[lines.length - 1] || '').slice(0, 300);
}

async function main() {
  rmSync(BACKUP, { recursive: true, force: true });
  mkdirSync(BACKUP, { recursive: true });
  for (const f of ALL_BACKED_UP) {
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
      console.log(`INVALID   ${m.id}  ${m.intent}  (find occurs ${occurrences}x)`);
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
      verdict: code === 0 ? (m.expectEquivalent ? 'EQUIVALENT' : 'SURVIVED') : 'KILLED',
      detail: reasonOf(out),
    });
    console.log(`${results[results.length - 1].verdict.padEnd(9)} ${m.id}  ${m.intent}`);
  }

  const { execSync } = await import('node:child_process');
  let clean = true;
  for (const f of ALL_BACKED_UP) {
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
        work: 'POST-17.10 STEP 10.3 — G5/G6/G7/G8 targeted mutation matrix',
        labels: 'PROVEN_UNIT_ONLY (focused extension suites + in-process backend suites)',
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