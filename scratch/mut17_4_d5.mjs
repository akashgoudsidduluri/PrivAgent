/**
 * PHASE 17.4 D5 — persistence mutation harness.
 *
 * Reintroduces each persistence defect the remediation removed, one at a time.
 * Every anchor must match EXACTLY ONCE or the script aborts before touching a
 * file. Backups are taken ONCE PER FILE (several mutations touch the same file
 * twice — a shared backup path would make `restore` reinstate the mutation).
 *
 *   node scratch/mut17_4_d5.mjs apply  M1|M2|M3|M4|M5
 *   node scratch/mut17_4_d5.mjs restore M1|M2|M3|M4|M5
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';

const P = 'extension/src/agent/longHorizonPersistence.ts';
const LH = 'extension/src/agent/longHorizon.ts';

const MUTATIONS = {
  // M1 — disable restore entirely: the record validates, but a FRESH tracker is
  // used anyway, so a restart silently regains a full budget.
  M1: [
    {
      file: P,
      find: "    return { tracker: restoreTracker(v.record, bounds), status: 'RESTORED', persistenceAvailable: true };",
      replace: "    return { tracker: new LongHorizonTracker(bounds), status: 'RESTORED', persistenceAvailable: true };",
    },
  ],

  // M2 — restore regardless of which task the record belongs to.
  M2: [{ file: P, find: "  if (r.runId !== runId) {", replace: "  if (false) {" }],

  // M3 — treat a malformed / wrong-schema record as a fresh task and CONTINUE
  // as though nothing were wrong, instead of refusing it and clearing it.
  M3: [
    {
      file: P,
      find: "  if (raw === null || raw === undefined) {\n    return { ok: false, status: 'REJECTED_MALFORMED', detail: 'no record' };\n  }",
      replace: "  if (raw === null || raw === undefined) {\n    return { ok: false, status: 'REJECTED_MALFORMED', detail: 'no record' };\n  }\n  if (raw === 'GARBAGE' || raw === 42 || Array.isArray(raw)) {\n    return { ok: true, record: raw };\n  }",
    },
    {
      file: P,
      find: "  if (r.schemaVersion !== LONG_HORIZON_SCHEMA_VERSION) {",
      replace: "  if (false) {",
    },
  ],

  // M4 — stop persisting the repetition / stagnation counters, so a restart
  // silently regains a full budget.
  M4: [
    {
      file: P,
      find: '    actionCount: tracker.actionCount,\n    recoveryCount: tracker.recoveryCount,\n    consecutiveNoProgress: tracker.consecutiveNoProgress,\n    totalNoProgress: tracker.totalNoProgress,',
      replace: '    actionCount: 0,\n    recoveryCount: 0,\n    consecutiveNoProgress: 0,\n    totalNoProgress: 0,',
    },
    {
      file: P,
      find: '    fingerprints: tracker.getRecentFingerprints().slice(-bounds.fingerprintWindow),',
      replace: '    fingerprints: [],',
    },
  ],

  // M5 — let old tracker state leak into a NEW task: key the record only on the
  // goal text, so a second run of the same task inherits the first run's budget.
  M5: [
    { file: P, find: "  if (r.runId !== runId) {", replace: "  if (false) {" },
    {
      file: P,
      find: "  if (typeof r.goalDigest !== 'string' || r.goalDigest !== stableHash(goalText)) {",
      replace: "  if (typeof r.goalDigest !== 'string') {",
    },
  ],
};

const [, , mode, id] = process.argv;
const edits = MUTATIONS[id];
if (!edits) {
  console.error('usage: mut17_4_d5.mjs apply|restore M1|M2|M3|M4|M5');
  process.exit(2);
}
const bakOf = (f) => `${f}.mutbak`;
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
  for (const e of edits) writeFileSync(e.file, readFileSync(e.file, 'utf8').replace(e.find, e.replace));
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
  console.error('usage: mut17_4_d5.mjs apply|restore M1|M2|M3|M4|M5');
  process.exit(2);
}
