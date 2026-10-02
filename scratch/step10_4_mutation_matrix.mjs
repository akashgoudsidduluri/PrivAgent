#!/usr/bin/env node
/**
 * STEP 10.4 Part 6 — adversarial mutation matrix for the text-safety firewall.
 *
 * Every mutation is a specific attempt to WEAKEN the firewall (M1-M15).
 * A mutation is KILLED when the focused suites fail. A mutation that
 * survives means the remediation does not actually defend what it claims.
 *
 * Restore discipline: a durable backup is taken, each mutation is applied
 * with a single exact-string replacement, the file is restored afterwards and
 * byte-verified with `cmp -s`. The backup directory is removed at the end.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] ?? '.');
const OUT = path.join(ROOT, 'docs/evidence/post-17-10/audit/mutation_matrix_step10_4.json');
const BACKUP = path.join(ROOT, 'scratch/.step104_backup');

const TS = 'backend/app/text_safety.py';
const MODELS = 'backend/app/models.py';

const PY_TESTS = [
  'tests/test_step10_4_text_safety_p1.py',
  'tests/test_text_safety.py',
  'tests/test_step10_3_declaration_vs_observation.py',
  'tests/test_step10_2_destination_trust_boundary.py',
  'tests/test_step10_declared_destination.py',
].join(' ');

const PY = path.join(ROOT, 'backend/.venv/bin/python');

/** @type {{id:string,gap:string,file:string,intent:string,old:string,new:string,expectEquivalent?:boolean}[]} */
const MUTATIONS = [
  {
    id: 'M1', gap: 'P1', file: TS,
    intent: 'disable REASON_NAME_PATTERN (it never matches anything)',
    old: 'REASON_NAME_PATTERN = re.compile(r"\\b[A-Z][a-z]+\\s+[A-Z][a-z]+\\b")',
    new: 'REASON_NAME_PATTERN = re.compile(r"(?!x)x")',
  },
  {
    id: 'M2', gap: 'P1', file: TS,
    intent: 'remove the person_name rejection from the reason scanner',
    old: `    for m in REASON_NAME_PATTERN.finditer(candidate):
        if _has_person_cue(candidate, m):
            return TextSafetyFinding(rule="person_name", snippet=m.group(0))
        if not _is_ui_label_span(candidate, m):
            return TextSafetyFinding(rule="person_name", snippet=m.group(0))`,
    new: `    for m in REASON_NAME_PATTERN.finditer(candidate):
        pass`,
  },
  {
    id: 'M3', gap: 'P1', file: TS,
    intent: 'allow all TitleCase phrases (N1 matches any token)',
    old: '    if any(t in NAME_IMPOSSIBLE_TOKENS for t in tokens):',
    new: '    if tokens:',
  },
  {
    id: 'M4', gap: 'P1', file: TS,
    intent: 'allow all two-word capitalized phrases (_is_ui_label_span always True)',
    old: `    if tokens_before_span := _tokens_before(candidate, match.start()):
        introducer = tokens_before_span[-1]
        introduced_by = introducer in REASON_DETERMINERS or introducer in REASON_ACTION_VERBS
        if introduced_by and _next_token(candidate, match.end()) in REASON_UI_HEAD_NOUNS:
            return True

    return False`,
    new: `    return True`,
  },
  {
    id: 'M5', gap: 'P1', file: TS,
    intent: 'whitelist the fixture string "Browse Catalog"',
    old: '    if any(t in NAME_IMPOSSIBLE_TOKENS for t in tokens):',
    new: '    if span == "Browse Catalog":\n        return True\n    if any(t in NAME_IMPOSSIBLE_TOKENS for t in tokens):',
  },
  {
    id: 'M6', gap: 'P1', file: TS,
    intent: 'whitelist all fixture UI labels',
    old: '    if any(t in NAME_IMPOSSIBLE_TOKENS for t in tokens):',
    new: '    if span in ("Browse Catalog", "Search Products", "ApexCart", "Sign In to Shop"):\n        return True\n    if any(t in NAME_IMPOSSIBLE_TOKENS for t in tokens):',
  },
  {
    id: 'M7', gap: 'P1', file: TS,
    intent: 'allow reason text whenever the action is a navigation',
    old: '    for m in REASON_NAME_PATTERN.finditer(candidate):',
    new: '    if "navigat" in candidate.lower():\n        return None\n    for m in REASON_NAME_PATTERN.finditer(candidate):',
  },
  {
    id: 'M8', gap: 'P1', file: TS,
    intent: 'allow reason text whenever the destination role is LISTING',
    old: '    for m in REASON_NAME_PATTERN.finditer(candidate):',
    new: '    if "catalog" in candidate.lower() or "listing" in candidate.lower():\n        return None\n    for m in REASON_NAME_PATTERN.finditer(candidate):',
  },
  {
    id: 'M9', gap: 'P1', file: TS,
    intent: 'skip scanning model-generated reasons entirely',
    old: `    finding = _scan_structured(candidate)
    if finding:
        return finding

    for m in REASON_NAME_PATTERN.finditer(candidate):`,
    new: `    if True:
        return None

    finding = _scan_structured(candidate)
    if finding:
        return finding

    for m in REASON_NAME_PATTERN.finditer(candidate):`,
  },
  {
    id: 'M10', gap: 'P1', file: TS,
    intent: 'accept a model-provided "safe" marker as an exoneration token',
    old: '    "us", "is", "are", "was", "were", "be", "been", "being", "there", "here",\n})',
    new: '    "us", "is", "are", "was", "were", "be", "been", "being", "there", "here",\n    "safe", "sanitize", "sanitized", "provenance", "clean", "ok",\n})',
  },
  {
    id: 'M11', gap: 'P1', file: TS,
    intent: 'strip capital letters before scanning',
    old: '    for m in REASON_NAME_PATTERN.finditer(candidate):',
    new: '    candidate = candidate.lower()\n    for m in REASON_NAME_PATTERN.finditer(candidate):',
  },
  {
    id: 'M12', gap: 'P1', file: TS,
    intent: 'scan only the first sentence',
    old: '    for m in REASON_NAME_PATTERN.finditer(candidate):',
    new: '    candidate = candidate.split(".")[0]\n    for m in REASON_NAME_PATTERN.finditer(candidate):',
  },
  {
    id: 'M13', gap: 'P1', file: TS,
    intent: 'scan only the first 40 characters',
    old: '    for m in REASON_NAME_PATTERN.finditer(candidate):',
    new: '    candidate = candidate[:40]\n    for m in REASON_NAME_PATTERN.finditer(candidate):',
  },
  {
    id: 'M14', gap: 'P1', file: TS,
    intent: 'remove embedded-name detection (the P1 honorific / role-noun / name-label checks)',
    // PROVEN EQUIVALENT by differential testing: with the fail-closed
    // default in place, a span carrying one of those cues is already blocked
    // because no exoneration rule can rescue it. Equivalence is asserted by
    // TestPersonCueBranchIsRedundantWithFailClosed::test_req_m14_equivalence_proof,
    // which re-computes every verdict in a 55+ string corpus with this branch
    // disabled and requires byte-identical findings. The POSSESSIVE half of
    // P1 is NOT part of M14 and IS load-bearing — it is killed separately.
    expectEquivalent: true,
    old: `    if before:
        if before[-1] in PERSON_HONORIFICS:
            return True
        window = set(before[-PERSON_CUE_LOOKBEHIND_TOKENS:])
        if window & PERSON_ROLE_NOUNS:
            return True

    return bool(PERSON_LABEL_PATTERN.search(candidate[:match.start()].rstrip() + " "))`,
    new: `    return False`,
  },
  {
    id: 'M14b', gap: 'P1', file: TS,
    intent: 'remove the possessive half of P1 (the load-bearing part)',
    old: `    if after[:2] in _POSSESSIVE_TAIL:
        return True

    # Possessive on a capitalized token following the span, e.g. the span
    # "Opened Rahul" in "Opened Rahul Sharma's profile."
    if POSSESSIVE_SUFFIX_PATTERN.match(after):
        return True`,
    new: `    if False:
        return True`,
  },
  {
    id: 'M16', gap: 'P1', file: TS,
    intent: 'narrow N3 back to determiner-only (drops the interaction-verb branch)',
    old: '        introduced_by = introducer in REASON_DETERMINERS or introducer in REASON_ACTION_VERBS',
    new: '        introduced_by = introducer in REASON_DETERMINERS',
  },
  {
    id: 'M17', gap: 'P1', file: TS,
    intent: 'drop the N3 UI head-noun gate (introducer alone exonerates)',
    old: '        if introduced_by and _next_token(candidate, match.end()) in REASON_UI_HEAD_NOUNS:',
    new: '        if introduced_by:',
  },
  {
    id: 'M18', gap: 'P1', file: TS,
    intent: 'let N3 reach across a preposition (verb branch without the boundary)',
    old: `    if tokens_before_span := _tokens_before(candidate, match.start()):
        introducer = tokens_before_span[-1]`,
    new: `    if tokens_before_span := _tokens_before(candidate, match.start()):
        introducer = next((t for t in reversed(tokens_before_span)
                           if t in REASON_ACTION_VERBS), tokens_before_span[-1])`,
  },
  {
    id: 'M15', gap: 'P1', file: MODELS,
    intent: 'bypass text_safety for backend action validation',
    old: '            finding = scan_reason_text(self.reason)',
    new: '            finding = None',
  },
];

function sha256(p) {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function runPyTests() {
  try {
    const out = execFileSync(
      PY,
      ['-m', 'pytest', ...PY_TESTS.split(' '), '-q', '--no-header', '-x'],
      { cwd: path.join(ROOT, 'backend'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function main() {
  fs.mkdirSync(BACKUP, { recursive: true });

  // 1. Durable backup of every file a mutation may touch.
  const originals = new Map();
  for (const rel of new Set(MUTATIONS.map((m) => m.file))) {
    const abs = path.join(ROOT, rel);
    const bak = path.join(BACKUP, rel.replace(/[\\/]/g, '__'));
    fs.copyFileSync(abs, bak);
    originals.set(rel, { abs, bak, digest: sha256(abs) });
  }

  // 2. Baseline: the focused suites must be green before mutating.
  const base = runPyTests();
  if (!base.ok) {
    console.error('BASELINE FAILED — refusing to run the matrix.\n' + base.out.slice(-3000));
    process.exit(1);
  }
  const baselineSummary = (base.out.match(/(\d+) passed/) ?? [])[1] ?? '?';
  console.log(`baseline: ${baselineSummary} passed`);

  const results = [];
  for (const mut of MUTATIONS) {
    const { abs, bak, digest } = originals.get(mut.file);
    let src = fs.readFileSync(bak, 'utf8');

    if (!src.includes(mut.old)) {
      results.push({ ...mut, verdict: 'INVALID', detail: `anchor not found in ${mut.file}` });
      console.log(`${mut.id} INVALID (anchor not found)`);
      continue;
    }
    const occurrences = src.split(mut.old).length - 1;
    if (occurrences !== 1) {
      results.push({ ...mut, verdict: 'INVALID', detail: `anchor occurs ${occurrences}x` });
      console.log(`${mut.id} INVALID (anchor ${occurrences}x)`);
      continue;
    }

    fs.writeFileSync(abs, src.replace(mut.old, mut.new), 'utf8');
    const applied = fs.readFileSync(abs, 'utf8');
    if (applied === src) {
      results.push({ ...mut, verdict: 'INVALID', detail: 'mutation was a no-op' });
      console.log(`${mut.id} INVALID (no-op)`);
    } else {
      const res = runPyTests();
      const verdict = res.ok ? 'SURVIVED' : 'KILLED';
      const firstFail = (res.out.match(/^FAILED .*$/m) ?? [''])[0];
      results.push({ ...mut, verdict, detail: res.ok ? 'focused suites still green' : firstFail });
      console.log(`${mut.id} ${verdict}`);
    }

    // 3. Restore + byte-verify.
    fs.copyFileSync(bak, abs);
    if (sha256(abs) !== digest) {
      console.error(`RESTORE FAILED for ${mut.file} — aborting.`);
      process.exit(1);
    }
  }

  // 4. Final restore verification for every touched file.
  for (const [rel, { abs, digest }] of originals) {
    if (sha256(abs) !== digest) {
      console.error(`FINAL RESTORE MISMATCH for ${rel} — aborting.`);
      process.exit(1);
    }
  }
  fs.rmSync(BACKUP, { recursive: true, force: true });

  const tally = { KILLED: 0, SURVIVED: 0, INVALID: 0, EQUIVALENT: 0 };
  for (const r of results) {
    if (r.expectEquivalent && r.verdict === 'SURVIVED') r.verdict = 'EQUIVALENT';
    tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;
  }

  const payload = {
    work: 'POST-17.10 STEP 10.4 — P1 text-safety firewall adversarial mutation matrix',
    labels: 'PROVEN_UNIT_ONLY (focused backend suites, in-process)',
    baselineFocusedTests: Number(baselineSummary),
    focusedBackendTests: PY_TESTS.split(' '),
    restoreDiscipline: 'durable backup -> exact single-anchor replacement -> restore -> sha256 byte-verify per mutation and again for every file at the end',
    tally,
    results: results.map((r) => ({
      id: r.id, gap: r.gap, file: r.file, intent: r.intent, verdict: r.verdict, detail: r.detail,
    })),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));

  console.log('\ntally', JSON.stringify(tally));
  for (const r of results) {
    if (r.verdict !== 'KILLED') console.log(`  ${r.id} ${r.verdict}: ${r.intent}\n     ${r.detail}`);
  }
  process.exit(tally.SURVIVED > 0 || tally.INVALID > 0 ? 2 : 0);
}

main();
