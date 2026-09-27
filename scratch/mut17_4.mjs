/**
 * PHASE 17.4 — long-horizon mutation harness.
 *
 * Reintroduces each reliability defect the remediation removed, one at a time.
 * Every anchor must match EXACTLY ONCE or the script aborts before touching a
 * file. `restore` puts every touched file back byte-for-byte.
 *
 *   node scratch/mut17_4.mjs apply  M1|M2|M3|M4|M5|M6
 *   node scratch/mut17_4.mjs restore M1|M2|M3|M4|M5|M6
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';

const LH = 'extension/src/agent/longHorizon.ts';
const LOOP = 'extension/src/agent/agentLoop.ts';

const MUTATIONS = {
  // M1 — disable stagnation detection.
  M1: [
    {
      file: LH,
      find: '  if (consecutiveNoProgress >= bounds.maxConsecutiveNoProgress) {',
      replace: '  if (false && consecutiveNoProgress >= bounds.maxConsecutiveNoProgress) {',
    },
  ],

  // M2 — ignore stale/unobservable observations: decode the absence of a
  // reading as a reading, and drop the observability gate.
  M2: [
    {
      file: LH,
      find: "    const geometryObserved = current.viewportObservable !== false && previous.viewportObservable !== false;",
      replace: '    const geometryObserved = true;',
    },
    {
      file: LH,
      find: "      ? 'geometry:unobservable'",
      replace: "      ? `geometry:${observation.scrollY}:${observation.targetValueLength}`",
    },
  ],

  // M3 — allow a repeated failed action indefinitely: widen the loop bound.
  M3: [
    {
      file: LH,
      find: '  if (occurrences > bounds.maxRepeatedStates) {',
      replace: '  if (occurrences > bounds.maxRepeatedStates * 1000) {',
    },
  ],

  // M4 — convert budget exhaustion into success.
  M4: [
    {
      file: LH,
      find: `  if (counters.actionCount >= bounds.maxTotalActions) {
    return {
      exhausted: true,
      reason: 'ACTION_BUDGET_EXHAUSTED',
      detail: \`Task reached the maximum of \${bounds.maxTotalActions} total actions.\`,
    };
  }`,
      replace: `  if (counters.actionCount >= bounds.maxTotalActions) {
    return {
      exhausted: false,
    };
  }
  if (false) {
    return { exhausted: true, reason: 'ACTION_BUDGET_EXHAUSTED' };
  }`,
    },
  ],

  // M5 — allow recovery to terminate successfully: treat a replan/recovery as
  // meaningful progress again.
  M5: [
    {
      file: LH,
      find: `  if (opts.subgoalJustCompleted) signals.push('SUBGOAL_COMPLETED');`,
      replace: `  if (opts.subgoalJustCompleted) {
    signals.push('SUBGOAL_COMPLETED');
    observedChange = true;
  }`,
    },
  ],

  // M6 — bypass the terminal-state check at the loop's long-horizon wiring, and
  // let dispatch-derived bookkeeping back in as progress.
  M6: [
    {
      file: LOOP,
      find: `      const lhProgress = this.longHorizon.observe(lhObservation, lhLastAction, {`,
      replace: `      const lhProgress = this.longHorizon.observe(lhObservation, lhLastAction, {
        subgoalJustCompleted: this.state.lastActionResult?.success ? 'recovered' : undefined,`,
    },
    {
      file: LOOP,
      find: `      if (lhBounds.exhausted) {`,
      replace: `      if (false && lhBounds.exhausted) {`,
    },
  ],
};

const [, , mode, id] = process.argv;
const edits = MUTATIONS[id];
if (!edits) {
  console.error('usage: mut17_4.mjs apply|restore M1|M2|M3|M4|M5|M6');
  process.exit(2);
}
const bakOf = (f) => `${f}.mutbak`;
// Several mutations touch the SAME file twice. The backup must therefore be
// taken ONCE per file, before any edit, or the second backup overwrites the
// first with an already-mutated copy and `restore` reinstates the mutation.
const files = [...new Set(edits.map((e) => e.file))];

if (mode === 'apply') {
  for (const f of files) {
    if (existsSync(bakOf(f))) {
      console.error(`ABORT: ${bakOf(f)} already exists; restore first`);
      process.exit(1);
    }
  }
  for (const e of edits) {
    const hits = readFileSync(e.file, 'utf8').split(e.find).length - 1;
    if (hits !== 1) {
      console.error(`ABORT: anchor for ${id} in ${e.file} matched ${hits} times, expected exactly 1`);
      process.exit(1);
    }
  }
  for (const f of files) writeFileSync(bakOf(f), readFileSync(f, 'utf8'));
  for (const e of edits) {
    const src = readFileSync(e.file, 'utf8');
    writeFileSync(e.file, src.replace(e.find, e.replace));
  }
  for (const f of files) console.log(`APPLIED ${id} -> ${f}`);
} else if (mode === 'restore') {
  for (const f of files) {
    const bak = bakOf(f);
    if (!existsSync(bak)) {
      console.error(`ABORT: ${bak} missing`);
      process.exit(1);
    }
    writeFileSync(f, readFileSync(bak, 'utf8'));
    unlinkSync(bak);
    console.log(`RESTORED ${f}`);
  }
} else {
  console.error('usage: mut17_4.mjs apply|restore M1|M2|M3|M4|M5|M6');
  process.exit(2);
}
