/**
 * PHASE 18.6 / A10 — §14 MATRIX GRADER.
 *
 * The grading authority is `extension/src/telemetry/a10MatrixHarness.ts`; this
 * file only loads the records a real run wrote and prints what that authority
 * says. It invents nothing: a row with no recorded run is graded as NOT_RUN, and
 * a row whose run cannot satisfy the §14 contract fails with the reason the
 * harness produced.
 *
 * USAGE
 *   npx vite-node scratch/a10_matrix_grade.ts [--require-pass]
 *
 *   without --require-pass the exit code reports whether GRADING ran;
 *   with    --require-pass it also requires every row certified and 10/10 covered.
 *
 * OUTPUT (A10_MATRIX_OUT, default docs/evidence/post-17-10/audit/a10_18_6)
 *   artifact.json — the assembled §14 artifact (records + run metadata)
 *   graded.json   — the evaluation: verdicts, summary, privacy, coverage
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  A10_SCENARIO_MATRIX,
  A10ScenarioId,
  buildEmptyArtifact,
  buildEmptyScenarioRecord,
  evaluateA10Artifact,
  type A10Artifact,
  type A10ScenarioRecord,
} from '../extension/src/telemetry/a10MatrixHarness';

const ROOT = process.cwd();
const OUT_DIR = process.env.A10_MATRIX_OUT || 'docs/evidence/post-17-10/audit/a10_18_6';
const ABS_OUT = path.join(ROOT, OUT_DIR);

const KNOWN_IDS = new Set<string>(A10_SCENARIO_MATRIX.map((d) => d.id as string));

function repositoryHead(): string | null {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return String(r.stdout || '').trim() || null;
}

function loadRecords(): { records: Map<A10ScenarioId, A10ScenarioRecord>; ignored: string[] } {
  const records = new Map<A10ScenarioId, A10ScenarioRecord>();
  const ignored: string[] = [];
  if (!fs.existsSync(ABS_OUT)) return { records, ignored };
  for (const name of fs.readdirSync(ABS_OUT).sort()) {
    if (!name.endsWith('.record.json')) continue;
    const full = path.join(ABS_OUT, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (err) {
      ignored.push(`${name} (unreadable: ${String(err).slice(0, 80)})`);
      continue;
    }
    const id = (parsed as { scenarioId?: unknown }).scenarioId;
    if (typeof id !== 'string' || !KNOWN_IDS.has(id)) {
      ignored.push(`${name} (unknown scenarioId ${JSON.stringify(id)})`);
      continue;
    }
    records.set(id as A10ScenarioId, parsed as A10ScenarioRecord);
  }
  return { records, ignored };
}

function main(): void {
  const requirePass = process.argv.includes('--require-pass');
  const { records, ignored } = loadRecords();

  const startedAt = Date.now();
  const artifact: A10Artifact = buildEmptyArtifact(
    'Phase 18.6 §14 real-web evaluation matrix',
    records.size
      ? `${records.size}/${A10_SCENARIO_MATRIX.length} rows recorded from real-Chrome runs; unrecorded rows are NOT_RUN`
      : 'no scenario has been recorded yet — every row is NOT_RUN by construction',
    repositoryHead(),
    startedAt,
  );
  artifact.scenarios = A10_SCENARIO_MATRIX.map(
    (def) => records.get(def.id) ?? buildEmptyScenarioRecord(def),
  );

  const evaluation = evaluateA10Artifact(artifact);

  fs.mkdirSync(ABS_OUT, { recursive: true });
  fs.writeFileSync(path.join(ABS_OUT, 'artifact.json'), JSON.stringify(artifact, null, 2));
  fs.writeFileSync(
    path.join(ABS_OUT, 'graded.json'),
    JSON.stringify(
      {
        harnessVersion: artifact.harnessVersion,
        gradedAt: Date.now(),
        artifactPath: path.join(OUT_DIR, 'artifact.json'),
        ...evaluation,
      },
      null,
      2,
    ),
  );

  console.log(`A10 §14 matrix — ${OUT_DIR}`);
  console.log(
    `graded ${evaluation.summary.total} row(s): passed=${evaluation.summary.passed} failed=${evaluation.summary.failed} ` +
      `blocked=${evaluation.summary.blocked} notRun=${evaluation.summary.notRun} privacyClean=${evaluation.privacy.clean}`,
  );
  console.log(
    `coverage: ${evaluation.coverage.evaluated}/${evaluation.coverage.required} rows present in the artifact` +
      (evaluation.coverage.missing.length ? `; missing=${evaluation.coverage.missing.join(',')}` : ''),
  );
  const executedRows = artifact.scenarios.filter((s) => s.executed).length;
  console.log(`recorded runs: ${executedRows}/${A10_SCENARIO_MATRIX.length} rows executed in real Chrome`);
  console.log('');
  const byId = new Map(evaluation.verdicts.map((v) => [v.scenarioId as string, v]));
  for (const def of A10_SCENARIO_MATRIX) {
    const verdict = byId.get(def.id as string);
    const kind = verdict ? verdict.kind : 'NOT_RUN';
    console.log(`  ${String(def.id).padEnd(4)} ${String(def.number).padStart(2)} ${kind.padEnd(8)} ${def.title}`);
    console.log(`       ${verdict ? verdict.reason : 'no verdict — row absent from the artifact'}`);
  }
  if (ignored.length) console.log(`ignored files: ${ignored.join('; ')}`);

  const certified = evaluation.pass && executedRows === A10_SCENARIO_MATRIX.length;
  console.log('');
  console.log(certified ? 'CERTIFIED: every §14 row recorded and satisfied' : 'NOT CERTIFIED');
  if (requirePass && !certified) process.exit(1);
}

main();
