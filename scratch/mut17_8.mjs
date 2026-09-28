#!/usr/bin/env node
/**
 * PHASE 17.8 — mutation / adversarial validation of the BENCHMARK ITSELF.
 *
 * WHAT THIS ANSWERS
 * ─────────────────
 * Phase 17.7 asked "does the existing suite catch these historical defects?".
 * That is not quite the question Phase 17.8 needs answered. The question here
 * is narrower and more useful:
 *
 *     Does the new 17.8 benchmark, ON ITS OWN, catch these historical defects?
 *
 * A benchmark that scores 97/97 while being unable to tell a correct system
 * from a sabotaged one is not measuring anything. So each mutation is run
 * against `tests/phase17/phase178Benchmark.test.ts` alone, and the result is
 * reported as benchmark detection. The 17.7 full-suite numbers are reused from
 * their recorded evidence rather than re-measured, because re-running fifteen
 * full-suite passes to reproduce numbers that are already on record at the same
 * commit would be expensive and would prove nothing new.
 *
 * REUSE, NOT DUPLICATION
 * ──────────────────────
 * The fifteen mutation definitions are IMPORTED from `scratch/mut17_7.mjs`. They
 * are the ones written against the actual historical defects, they were verified
 * to apply cleanly at this commit, and writing a second copy of them would give
 * the project two subtly different attack sets — the exact failure Phase 17.7
 * was created to stop. Two mutations that 17.7 did not cover are ADDED here,
 * both derived from defects recorded in the 17.2 remediation:
 *
 *   M13  containment is skipped on the confirmation-resume path (F-02)
 *   M14  OCR observation tab identity is not checked (wrong-tab evidence)
 *
 * CRASH SAFETY
 * ────────────
 * Identical convention to 17.7: the active mutation is journalled BEFORE the
 * write, every file is restored afterwards, and the restore is verified by hash.
 * A run killed by a timeout mid-write is recovered with `--recover`.
 *
 * FAILURE DETECTION
 * ─────────────────
 * The vitest EXIT CODE ONLY. The agent loop logs the literal string
 * "M6 failed" on clean runs, so any `/(\d+)\s+failed/` regex reports false
 * failures.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Dynamic, not static: a static ESM import is evaluated before this module's
// body runs, so the guard flag could not be set in time. Setting it here means
// importing the 17.7 harness yields its mutation list WITHOUT re-executing the
// whole 17.7 audit as a side effect.
process.env.MUT_HARNESS_IMPORTED = '1';
const { MUTATIONS: MUTATIONS_17_7 } = await import('./mut17_7.mjs');

const JOURNAL = 'scratch/.mut17_8_journal.json';
const RESULTS = 'scratch/.mut17_8_results.json';

const LOOP = 'extension/src/agent/agentLoop.ts';
const GOAL = 'extension/src/agent/goalVerifier.ts';
const CRITIC = 'extension/src/agent/securityCritic.ts';

/**
 * The two mutations Phase 17.7 did not cover, both traceable to recorded
 * defects rather than invented to inflate the count.
 */
const EXTRA_MUTATIONS = [
  {
    id: 'M13',
    name: 'Containment bypass on the confirmation-resume path (F-02)',
    file: LOOP,
    find: '    if (this.containmentScope) {\n      const confirmedLiveUrl =',
    replace: '    if (false as boolean) {\n      const confirmedLiveUrl =',
    breaks:
      'resumeWithConfirmation dispatches straight to executeAction with no containment evaluation, so a tab that moved while the user answered the prompt is never re-checked.',
  },
  {
    id: 'M14',
    name: 'Wrong-tab OCR observation accepted as goal evidence',
    file: GOAL,
    find: '    if (state.targetTabId && prov.tabId !== state.targetTabId) {',
    replace: '    if (false as boolean) {',
    breaks:
      'An OCR observation captured from a DIFFERENT tab is accepted as evidence for this tab, because only the URL matched.',
  },
];

export const MUTATIONS = [...MUTATIONS_17_7, ...EXTRA_MUTATIONS];

/** The only test file the 17.8 benchmark is judged by. */
const BENCH_TEST = 'tests/phase17/phase178Benchmark.test.ts';

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

function readOrNull(p) {
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

function restore(j) {
  if (!j) return true;
  const cur = readOrNull(j.file);
  if (cur === null) {
    console.error(`RECOVERY: ${j.file} is missing; cannot auto-restore.`);
    return false;
  }
  if (cur === j.before) {
    console.error(`RECOVERY: ${j.file} already matches the pre-mutation content.`);
    return true;
  }
  if (cur !== j.mutated) {
    console.error(
      `RECOVERY: ${j.file} matches NEITHER the original NOR the mutation. Refusing to overwrite. Inspect manually (${j.id}).`,
    );
    return false;
  }
  writeFileSync(j.file, j.before);
  const ok = readFileSync(j.file, 'utf8') === j.before;
  console.error(`RECOVERY: restored ${j.file} (${ok ? 'ok' : 'FAILED'}).`);
  return ok;
}

function recoverMode() {
  const j = readOrNull(JOURNAL) ? JSON.parse(readOrNull(JOURNAL)) : null;
  if (!j || j.active === false) {
    console.log('No active mutation. Nothing to recover.');
    return;
  }
  restore(j);
  writeFileSync(JOURNAL, JSON.stringify({ active: false }));
  console.log('Journal cleared.');
}

function runBenchmark() {
  const r = spawnSync('npx', ['vitest', 'run', BENCH_TEST, '--reporter=basic'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: '1' },
  });
  // Exit code only. Never parse the output for failure counts.
  return { caught: r.status !== 0, status: r.status };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--recover') return recoverMode();

  const only = argv.filter((a) => /^M\d+b?$/.test(a));
  const list = only.length ? MUTATIONS.filter((m) => only.includes(m.id)) : MUTATIONS;

  const results = [];

  for (const m of list) {
    const before = readOrNull(m.file);
    if (before === null) {
      console.error(`SKIP ${m.id}: ${m.file} not found.`);
      continue;
    }
    if (!before.includes(m.find)) {
      console.error(`SKIP ${m.id}: anchor not found in ${m.file}. The mutation no longer applies.`);
      results.push({
        id: m.id,
        name: m.name,
        file: m.file,
        breaks: m.breaks,
        status: 'ANCHOR_MISSING',
        caughtByBenchmark: null,
        note: 'The production code no longer contains the text this mutation replaces. Re-derive it from the current source rather than forcing it.',
      });
      continue;
    }

    const mutated = before.replace(m.find, m.replace);
    if (mutated === before) {
      console.error(`SKIP ${m.id}: replacement was a no-op.`);
      continue;
    }

    // Journal BEFORE the write, so a timeout mid-write is recoverable.
    writeFileSync(
      JOURNAL,
      JSON.stringify({ active: true, id: m.id, file: m.file, before, mutated }),
      'utf8',
    );
    writeFileSync(m.file, mutated, 'utf8');

    let run;
    try {
      run = runBenchmark();
    } finally {
      const ok = restore(JSON.parse(readOrNull(JOURNAL)));
      writeFileSync(JOURNAL, JSON.stringify({ active: false }));
      if (!ok) process.exit(2);
    }

    results.push({
      id: m.id,
      name: m.name,
      file: m.file,
      breaks: m.breaks,
      status: run.caught ? 'CAUGHT' : 'ESCAPED',
      caughtByBenchmark: run.caught,
      exitStatus: run.status,
      restored: true,
      beforeHash: sha(before),
      mutatedHash: sha(mutated),
    });

    console.error(`${m.id.padEnd(5)} ${run.caught ? 'CAUGHT  ' : 'ESCAPED '} ${m.name}`);

    // Written after EVERY mutation, not at the end. A run killed by the
    // command timeout must not lose the results it already paid for; the
    // journal restores the source file, and this keeps the evidence.
    writeFileSync(
      RESULTS,
      `${JSON.stringify(
        {
          phase: '17.8',
          question: 'Does the Phase 17.8 benchmark, on its own, catch the historical defects?',
          testFile: BENCH_TEST,
          mutationSource:
            '15 definitions imported from scratch/mut17_7.mjs; M13 and M14 added here from recorded 17.2 defects.',
          partial: true,
          results,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  const caught = results.filter((r) => r.status === 'CAUGHT').length;
  const escaped = results.filter((r) => r.status === 'ESCAPED');
  const anchors = results.filter((r) => r.status === 'ANCHOR_MISSING');

  writeFileSync(
    RESULTS,
    `${JSON.stringify(
      {
        phase: '17.8',
        question: 'Does the Phase 17.8 benchmark, on its own, catch the historical defects?',
        testFile: BENCH_TEST,
        mutationsDefined: list.length,
        run: results.length,
        caught,
        escaped: escaped.length,
        anchorMissing: anchors.length,
        mutationSource:
          '15 definitions imported from scratch/mut17_7.mjs; M13 and M14 added here from recorded 17.2 defects.',
        results,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.log(`\n${caught}/${results.length} caught by the 17.8 benchmark.`);
  for (const e of escaped) console.log(`  ESCAPED ${e.id} — ${e.name}`);
  for (const a of anchors) console.log(`  ANCHOR MISSING ${a.id} — ${a.name}`);
}

main();
