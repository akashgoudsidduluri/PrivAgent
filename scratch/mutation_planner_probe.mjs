/**
 * MUTATION PROBES — the two planner fact-fabrication fixes.
 *
 * Each mutation reverts exactly ONE new decision branch, then runs the focused
 * suite. A mutation is KILLED only if a genuine test fails.
 *
 * Honesty rules applied:
 *  - A compile/transform error is NOT a kill (INVALID mutant).
 *  - A mutation that no assertion can distinguish is reported as SURVIVED and
 *    classified honestly (equivalent vs. a real test gap).
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const ROOT = process.cwd();
const DECOMP = path.join(ROOT, 'extension/src/hierarchicalPlanning/taskDecomposer.ts');
const PARSER = path.join(ROOT, 'extension/src/agent/goalParser.ts');
const SUITE = 'tests/plannerFactFabrication.test.ts';

const backup = (p) => fs.readFileSync(p, 'utf8');

const MUTATIONS = [
  {
    id: 'M1',
    file: DECOMP,
    name: 'remove the URL-strip branch (F1 reverted)',
    from: ".replace(/https?:\\/\\/\\S+/gi, ' ')\n      ",
    to: '',
  },
  {
    id: 'M2',
    file: DECOMP,
    name: 'strip URLs AFTER tokenising (ordering matters, not presence)',
    from: ".replace(/https?:\\/\\/\\S+/gi, ' ')\n      .replace(/[^\\w\\s-]/g, '')",
    to: ".replace(/[^\\w\\s-]/g, '')\n      .replace(/https?:\\/\\/\\S+/gi, ' ')",
  },
  {
    id: 'M3',
    file: DECOMP,
    name: 'strip only http:// (https leaks through)',
    from: '/https?:\\/\\/\\S+/gi',
    to: '/http:\\/\\/\\S+/gi',
  },
  {
    id: 'M4',
    file: PARSER,
    name: 'remove the word boundary on rs (F3 reverted)',
    from: '/\\brs\\b/.test(lower)',
    to: "lower.includes('rs')",
  },
  {
    id: 'M5',
    file: PARSER,
    name: 'drop the ₹ branch entirely',
    from: "if (task.includes('₹') || /\\brs\\b/.test(lower) || lower.includes('inr')) {",
    to: "if (task.includes('₹') || lower.includes('inr')) {",
  },
];

function runSuite() {
  const r = spawnSync('npx', ['vitest', 'run', '--silent=true', SUITE], {
    cwd: ROOT, encoding: 'utf8', timeout: 170000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (/Transform failed|SyntaxError|Unexpected token|error TS\d+/.test(out)) {
    return { kind: 'INVALID', out };
  }
  const m = out.match(/Tests\s+(\d+)\s+failed\s*\|\s*(\d+)\s+passed/);
  if (m) return { kind: 'KILLED', failed: Number(m[1]), out };
  const p = out.match(/Tests\s+(\d+)\s+passed/);
  if (p) return { kind: 'SURVIVED', out };
  return { kind: 'ERROR', out };
}

const results = [];
for (const mut of MUTATIONS) {
  const original = backup(mut.file);
  if (!original.includes(mut.from)) {
    results.push({ ...mut, verdict: 'INVALID_MUTANT', note: 'anchor not found — patch does not apply' });
    continue;
  }
  fs.writeFileSync(mut.file, original.replace(mut.from, mut.to));
  const res = runSuite();
  fs.writeFileSync(mut.file, original);
  results.push({ id: mut.id, name: mut.name, verdict: res.kind, failedTests: res.failed ?? 0 });
  console.log(`${mut.id}  ${res.kind.padEnd(9)} ${mut.name}${res.failed ? ` (${res.failed} test(s) failed)` : ''}`);
}

// Confirm the working tree is restored byte-for-byte.
const clean = MUTATIONS.every((m) => backup(m.file) === fs.readFileSync(m.file, 'utf8'));
console.log(`\nsource files restored: ${clean}`);

const invalid = results.filter((r) => r.verdict.startsWith('INVALID'));
const killed = results.filter((r) => r.verdict === 'KILLED');
const survived = results.filter((r) => r.verdict === 'SURVIVED');
console.log(`SUMMARY  killed=${killed.length}/${MUTATIONS.length}  survived=${survived.length}  invalid=${invalid.length}`);
for (const s of survived) console.log(`  SURVIVED: ${s.id} — ${s.name}`);
for (const s of invalid) console.log(`  INVALID : ${s.id} — ${s.note}`);
