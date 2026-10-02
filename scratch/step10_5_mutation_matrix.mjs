#!/usr/bin/env node
/**
 * STEP 10.5 Part 13 — mutation matrix for the G7 destination chain.
 *
 * Every mutation is an attempt to break the destination contract or to make
 * G7 "pass" the wrong way (fixture hardcoding, verifier bypass, model
 * authority). KILLED = the suites catch it. EQUIVALENT = proven inert.
 *
 * Restore discipline: durable backup, single exact-anchor replacement,
 * sha256 byte-verify per mutation and again for every file at the end.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] ?? '.');
const OUT = path.join(ROOT, 'docs/evidence/post-17-10/audit/mutation_matrix_step10_5.json');
const BACKUP = path.join(ROOT, 'scratch/.step105_backup');

const REASONER = 'backend/app/reasoner.py';
const CTX = 'extension/src/hierarchicalPlanning/plannerContextBuilder.ts';
const VERIFIER = 'extension/src/planning/destinationVerifier.ts';
const TRACKER = 'extension/src/hierarchicalPlanning/goalProgressTracker.ts';

const PY_TESTS = [
  'tests/test_step10_5_destination_navigation.py',
  'tests/test_step10_3_declaration_vs_observation.py',
  'tests/test_step10_2_destination_trust_boundary.py',
  'tests/test_step10_declared_destination.py',
  'tests/test_text_safety.py',
  'tests/test_step10_4_text_safety_p1.py',
].join(' ');

const TS_TESTS = [
  'tests/step10_3_destinationScoping.test.ts',
  'tests/step10_3_roleOnlyControls.test.ts',
  'tests/destinationVerifier.test.ts',
  'tests/destinationPropagationAndAlreadySatisfied.test.ts',
  'tests/destinationNormalizer.test.ts',
  'tests/destinationNavigationIntent.test.ts',
  'tests/classificationDestinationGap.test.ts',
  'tests/destinationProducerWiring.test.ts',
].join(' ');

const PY = path.join(ROOT, 'backend/.venv/bin/python');

const MUTATIONS = [
  { id: 'M1', file: REASONER, intent: 'remove destination context from the model prompt',
    old: '    if declared_block:\n        parts.append(\n            "USER DECLARED DESTINATION',
    new: '    if False:\n        parts.append(\n            "USER DECLARED DESTINATION' },
  { id: 'M2', file: REASONER, intent: 'let the model choose the destination role',
    old: 'f"HOW TO ACT ON THIS DECLARATION: the task is not finished until you have "\n                f"actually reached a page whose semantic role is {role_names}.',
    new: 'f"HOW TO ACT ON THIS DECLARATION: the task is not finished until you have "\n                f"actually reached a page whose semantic role is whatever you judge best."' },
  { id: 'M3', file: REASONER, intent: 'allow the model to declare arrival complete',
    old: 'f"do NOT decide that you have arrived. An independent local verifier reads "',
    new: 'f"do decide that you have arrived; nothing checks you. An independent verifier reads "' },
  { id: 'M4', file: REASONER, intent: 'hardcode the fixture listing path into the prompt',
    old: 'f"The role names a page TYPE, not a URL: never invent, guess or hardcode a "',
    new: 'f"Go directly to results.html. The role names a page TYPE, not a URL: never invent, guess or hardcode a "',
    },
  { id: 'M5', file: REASONER, intent: 'tell the model any page will do',
    old: 'f"actually reached a page whose semantic role is {role_names}. Choose, on "',
    new: 'f"actually reached any page at all; the role does not matter. Choose, on "',
    },
  { id: 'M6', file: VERIFIER, intent: 'let UNKNOWN be declared as a destination',
    old: "const targets = acceptable.filter((t) => t !== 'UNKNOWN' && t !== 'ERROR');",
    new: "const targets = acceptable.filter(() => true);",
    },
  { id: 'M7', file: VERIFIER, intent: 'remove the confidence floor',
    old: "if (semantic.pageType !== 'UNKNOWN' && semantic.confidence < MIN_PAGE_CLASSIFICATION_CONFIDENCE) {",
    new: "if (false) {",
    },
  { id: 'M8', file: TRACKER, intent: 'MISMATCH/UNKNOWN also complete the destination subgoal',
    old: "          result.kind === 'MATCH',",
    new: "          result.kind !== 'NOPE',",
    },
  { id: 'M9', file: TRACKER, intent: 'skip the verifier: trust the declaration instead',
    old: "        const declaration = subgoal.destination;",
    new: "        const declaration = subgoal.destination;\n        if (declaration) return verdict(true, 'assumed reached');",
    },
  { id: 'M10', file: CTX, intent: 'the observation rewrites the declared destination',
    old: 'goal.destinationDeclaration ?? activeSubgoal?.destination',
    new: 'activeSubgoal?.destination ?? goal.destinationDeclaration',
    },
  { id: 'M11', file: REASONER, intent: 'drop the declaration from the prompt on later turns',
    old: '        role_names = ", ".join(str(r) for r in (declared_block.get("role") or []))\n        if role_names:',
    new: '        role_names = ""\n        if role_names:',
    },
  { id: 'M12', file: REASONER, intent: 'remove the role-only constraint from the model prompt',
    old: 'f"The role names a page TYPE, not a URL: never invent, guess or hardcode a "',
    new: 'f"The role names whatever you like, including a URL: feel free to invent one "',
    },
  { id: 'M13', file: VERIFIER, intent: 'skip the freshness / generation check',
    old: 'about a different document',
    new: 'about a document',
    },
  { id: 'M14', file: TRACKER, intent: 'a destination subgoal with NO declaration is marked satisfied',
    old: "        if (!declaration || declaration.kind !== 'DECLARED') {",
    new: "        if (!declaration || declaration.kind !== 'DECLARED') {\n          return verdict(true, 'assumed reached');\n        }\n        if (false) {",
    },
  { id: 'M15', file: REASONER, intent: 'bypass the text-safety reason scan',
    old: '        finding = scan_reason_text(reason)',
    new: '        finding = None',
    },
  { id: 'M16', file: REASONER, intent: 'drop the stated reason-length limit',
    old: 'f"field must stay under {MAX_REASON_CHARS} characters: one short sentence "',
    new: 'f"field may be as long as you like: write a full essay "',
    },
  { id: 'M17', file: REASONER, intent: 'drop the submit-after-fill instruction',
    old: 'f"Once you have filled a field on that route, your very next action must be "\n                f"the submit control for that field. Do not scroll in its place, do not retype "',
    new: 'f"Once you have filled a field on that route, you may do anything at all, including "\n                f"scrolling away from it, and retyping "',
    },
  { id: 'M18', file: REASONER, intent: 'drop the query-form route instruction',
    old: 'f"of that form ARE commonly a page of that role: put a sensible query in the "',
    new: 'f"of that form are never a page of that role: ignore the field and "',
    },
  { id: 'M19', file: REASONER, intent: 'remove the independent-verification statement',
    old: 'f"do NOT decide that you have arrived. An independent local verifier reads "',
    new: 'f"do decide that you have arrived; no verifier reads "',
    },
  { id: 'M20', file: REASONER, intent: 'skip the whole-reason field limit enforcement',
    old: '    _enforce_field_limits(parsed)',
    new: '    pass  # limits skipped',
    },
];

function sha256(p) { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

function runPy() {
  try {
    execFileSync(PY, ['-m', 'pytest', ...PY_TESTS.split(' '), '-q', '--no-header', '-x'],
      { cwd: path.join(ROOT, 'backend'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true };
  } catch (e) { return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; }
}

function runTs() {
  try {
    execFileSync('npx', ['vitest', 'run', '--silent=true', ...TS_TESTS.split(' ')],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true };
  } catch (e) { return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; }
}

const isTs = (f) => f.endsWith('.ts');

function main() {
  fs.mkdirSync(BACKUP, { recursive: true });
  const originals = new Map();
  for (const rel of new Set(MUTATIONS.filter((m) => !m.skip).map((m) => m.file))) {
    const abs = path.join(ROOT, rel);
    const bak = path.join(BACKUP, rel.replace(/[\\/]/g, '__'));
    fs.copyFileSync(abs, bak);
    originals.set(rel, { abs, bak, digest: sha256(abs) });
  }

  const basePy = runPy();
  const baseTs = runTs();
  if (!basePy.ok || !baseTs.ok) {
    console.error('BASELINE FAILED — refusing to run.\n' + (basePy.out ?? baseTs.out ?? '').slice(-2500));
    process.exit(1);
  }
  console.log('baseline: backend + extension focused suites green');

  const results = [];
  for (const mut of MUTATIONS) {
    if (mut.skip) {
      results.push({ ...mut, verdict: 'COVERAGE_ELSEWHERE', detail: mut.note });
      console.log(`${mut.id} ${mut.verdict ?? 'SKIPPED'} (${mut.note})`);
      continue;
    }
    const { abs, bak, digest } = originals.get(mut.file);
    const src = fs.readFileSync(bak, 'utf8');
    if (!src.includes(mut.old)) {
      results.push({ ...mut, verdict: 'INVALID', detail: `anchor not found in ${mut.file}` });
      console.log(`${mut.id} INVALID (anchor not found)`);
      continue;
    }
    if (src.split(mut.old).length - 1 !== 1) {
      const n = src.split(mut.old).length - 1;
      results.push({ ...mut, verdict: 'INVALID', detail: `anchor occurs ${n}x` });
      console.log(`${mut.id} INVALID (anchor ${n}x)`);
      continue;
    }
    fs.writeFileSync(abs, src.replace(mut.old, mut.new), 'utf8');
    if (fs.readFileSync(abs, 'utf8') === src) {
      results.push({ ...mut, verdict: 'INVALID', detail: 'no-op mutation' });
      console.log(`${mut.id} INVALID (no-op)`);
    } else {
      const r = isTs(mut.file) ? runTs() : runPy();
      const firstFail = ((r.out ?? '').match(/^(FAILED|AssertionError|✗).*$/m) ?? [''])[0];
      results.push({ ...mut, verdict: r.ok ? 'SURVIVED' : 'KILLED',
        detail: r.ok ? 'focused suites still green' : firstFail.slice(0, 160) });
      console.log(`${mut.id} ${r.ok ? 'SURVIVED' : 'KILLED'}`);
    }
    fs.copyFileSync(bak, abs);
    if (sha256(abs) !== digest) { console.error(`RESTORE FAILED ${mut.file}`); process.exit(1); }
  }

  for (const [rel, { abs, digest }] of originals) {
    if (sha256(abs) !== digest) { console.error(`FINAL RESTORE MISMATCH ${rel}`); process.exit(1); }
  }
  fs.rmSync(BACKUP, { recursive: true, force: true });

  const tally = {};
  for (const r of results) {
    if (r.expectEquivalent && r.verdict === 'SURVIVED') r.verdict = 'EQUIVALENT';
    tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    work: 'POST-17.10 STEP 10.5 — G7 destination chain mutation matrix',
    labels: 'PROVEN_UNIT_ONLY',
    focusedBackendTests: PY_TESTS.split(' '),
    focusedExtensionTests: TS_TESTS.split(' '),
    restoreDiscipline: 'durable backup -> single exact-anchor replacement -> restore -> sha256 byte-verify per mutation and for every file at the end',
    tally,
    results: results.map((r) => ({ id: r.id, file: r.file, intent: r.intent, verdict: r.verdict, detail: r.detail })),
  }, null, 2));

  console.log('\ntally', JSON.stringify(tally));
  for (const r of results) {
    if (r.verdict !== 'KILLED') console.log(`  ${r.id} ${r.verdict}: ${r.intent}\n     ${r.detail}`);
  }
  process.exit((tally.SURVIVED ?? 0) + (tally.INVALID ?? 0) > 0 ? 2 : 0);
}

main();
