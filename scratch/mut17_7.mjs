#!/usr/bin/env node
/**
 * PHASE 17.7 — Adversarial mutation audit harness (AUDIT ONLY).
 *
 * Each mutation disables exactly one safeguard in production code, runs the
 * test suite, and records whether the EXISTING suite caught it. No test is
 * modified, relaxed or skipped. Files are always restored afterwards and the
 * restore is verified by hash.
 *
 * Failure detection uses the VITEST EXIT CODE ONLY.
 *   The agent loop logs the literal string "M6 failed" on a clean run
 *   (118 occurrences), so any /(\d+)\s+failed/ regex reports false failures.
 *
 * Crash-safe: the active mutation is journalled BEFORE the write, so a run
 * killed mid-write can be recovered with `node scratch/mut17_7.mjs --recover`.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const JOURNAL = 'scratch/.mut17_7_journal.json';
const RESULTS = 'scratch/.mut17_7_results.json';

const A = 'extension/src/agent/agentLoop.ts';
const CRITIC = 'extension/src/agent/securityCritic.ts';
const EFF = 'extension/src/agent/effectVerifier.ts';
const POL = 'extension/src/agent/privacyPolicy.ts';
const PROV = 'extension/src/agent/providerResponse.ts';
const BACK = 'extension/src/agent/backendAgentProvider.ts';

export const MUTATIONS = [
  {
    id: 'M1',
    name: 'Goal Verification bypass',
    file: A,
    find: 'const res = verifyTaskGoal(task, state, context);',
    replace:
      "const res = { satisfied: true, status: 'SUCCESS' as const, reason: 'MUTATED: goal verifier bypassed' };",
    breaks: 'isTaskGoalSatisfied now reports the goal satisfied from its own authority instead of the sole goal verifier.',
  },
  {
    id: 'M2',
    name: 'M5 privacy/action-validator bypass',
    file: A,
    find: '      if (!validation.allowed) {',
    replace: '      if (false as boolean) {',
    breaks: 'The M5 rejection branch in runTask never runs; a refused action continues to the critic, privacy, risk and dispatch.',
  },
  {
    id: 'M3',
    name: 'Security Critic bypass',
    file: A,
    find: "      if (critic.verdict === 'BLOCK') {",
    replace: "      if (false as boolean) {",
    breaks: 'A Security Critic BLOCK no longer stops the action before the privacy, risk, confirmation and dispatch stages.',
  },
  {
    id: 'M4',
    name: 'Containment bypass at the dispatch boundary',
    file: A,
    find: '        if (!containment.contained) {',
    replace: '        if (false as boolean) {',
    breaks: 'The in-loop containment denial is skipped, so a refused environment no longer terminates the task.',
  },
  {
    id: 'M5',
    name: 'Effect Verification fabrication (unobservable page treated as observable)',
    file: EFF,
    find:
      "  const pageObservable = (post as { pageStateObservable?: boolean }).pageStateObservable !== false;",
    replace:
      "  const pageObservable = (post as { pageStateObservable?: boolean }).pageStateObservable === true ? true : true;",
    breaks:
      'pageStateObservable is no longer honoured, so a snapshot whose page could not be read is compared as if every field were a real reading.',
  },
  {
    id: 'M6',
    name: 'Observation fabrication (unobservable state synthesised)',
    file: A,
    find: `    if (!this.callbacks.getEffectSnapshot) return null;
    try {
      return await this.callbacks.getEffectSnapshot(target);
    } catch (err) {`,
    replace: `    if (!this.callbacks.getEffectSnapshot) return null;
    try {
      return await this.callbacks.getEffectSnapshot(target) ?? ({ url: 'https://example.invalid/', scrollX: 0, scrollY: 0, domElementCount: 1, openModalsCount: 0, activeElementSelector: '', targetValueLength: 0, timestamp: Date.now() } as never);
    } catch (err) {`,
    breaks:
      'A host that cannot observe now yields a fabricated snapshot instead of null, so the fail-closed "could not be observed" path is unreachable.',
  },
  {
    id: 'M7',
    name: 'Stale observation acceptance',
    file: A,
    find: '        if (!isObservationCurrent(expectedIdentity, this.observationIdentityFor(context))) {',
    replace: '        if (false as boolean) {',
    breaks:
      'A provider response computed from a page that no longer exists is accepted; the stale-response refusal never fires.',
  },
  {
    id: 'M8',
    name: 'Prompt-injection acceptance',
    file: CRITIC,
    find: "  if ([...pageDerivedSources, ...modelAuthoredSources].some((t) => t === 'HOSTILE')) {",
    replace: '  if (false as boolean) {',
    breaks:
      'No page-derived or model-relayed content can be classified HOSTILE, so INJECTION_INFLUENCE is never raised from provenance.',
  },
  {
    id: 'M9',
    name: 'Recovery / self-healing authorization',
    file: A,
    find: '          if (healedVal.allowed) {',
    replace: '          if (true as boolean) {',
    breaks:
      'A self-healed target is adopted even when the healed action FAILED re-grounding, so recovery dispatches an unvalidated target.',
  },
  {
    id: 'M10',
    name: 'Subgoal completion fabrication',
    file: A,
    find: '        if (subgoalVerification.satisfied) {',
    replace: '        if (true as boolean) {',
    breaks:
      'Every subgoal completes on dispatch state; the observed-evidence requirement is bypassed and the long-horizon skip engages.',
  },
  {
    id: 'M5b',
    name: 'Effect Verification fabrication (per-field OBSERVED contract weakened)',
    file: EFF,
    find: `  const comparable = (field: keyof SnapshotFieldStates): boolean =>
    preFields[field] === 'OBSERVED' && postFields[field] === 'OBSERVED';`,
    replace: `  const comparable = (field: keyof SnapshotFieldStates): boolean =>
    preFields[field] !== 'UNAVAILABLE' || postFields[field] !== 'UNAVAILABLE';`,
    breaks:
      'A field counts as a real reading when EITHER side merely is not marked UNAVAILABLE, so an unobserved value can be compared as an observed one.',
  },
  {
    id: 'M9b',
    name: 'Recovery / self-healing authorization (healed target trusted without re-gating)',
    file: A,
    find: `          if (healedVal.allowed) {
            action = healingResult.recoveredAction;
            validation = healedVal;`,
    replace: `          if (true as boolean) {
            action = healingResult.recoveredAction;
            validation = { allowed: true, reason: 'MUTATED: self-heal trusts the healed target' };`,
    breaks:
      'A self-healed target is adopted AND marked allowed even when it failed re-grounding, so recovery dispatches a target that M5 never approved.',
  },
  {
    id: 'M11',
    name: 'Privacy egress leak (raw-value firewall disabled)',
    file: POL,
    find: '  if (violations.length > 0) {',
    replace: '  if (false as boolean) {',
    breaks:
      'assertSanitizedContextSafe no longer refuses a context carrying raw sensitive values; the local privacy boundary is a no-op.',
  },
  {
    id: 'M11b',
    name: 'Privacy egress leak (F-08 re-opened: local-only ocr_observation re-attached to the wire)',
    file: BACK,
    find: '      ocr_observation: _ocrObs,',
    replace: '      // MUTATED: local-only ocr_observation re-attached to the wire payload',
    breaks:
      'The local-only OCR provenance object crosses the egress boundary again (the Phase 17.6 F-08 condition).',
  },
  {
    id: 'M12',
    name: 'Provider schema weakening (unknown action fields accepted)',
    file: PROV,
    find: `  for (const key of Object.keys(raw)) {
    if (!shape.required.includes(key) && !shape.optional.includes(key)) {`,
    replace: `  for (const key of Object.keys(raw)) {
    if (false as boolean) {`,
    breaks:
      'A provider may attach arbitrary extra fields to an action; the strict envelope no longer refuses an unexpected field.',
  },
];

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

function readOrNull(p) {
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

function loadJournal() {
  const j = readOrNull(JOURNAL);
  return j ? JSON.parse(j) : null;
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
      `RECOVERY: ${j.file} matches NEITHER the original NOR the mutation. Refusing to overwrite. ` +
        `Inspect it manually (${j.id} ${j.name}).`
    );
    return false;
  }
  writeFileSync(j.file, j.before);
  const after = readFileSync(j.file, 'utf8');
  const ok = after === j.before;
  console.error(`RECOVERY: restored ${j.file} (${ok ? 'ok' : 'FAILED'}).`);
  return ok;
}

function recoverMode() {
  const j = loadJournal();
  if (!j) {
    console.log('No journal. Nothing to recover.');
    return;
  }
  restore(j);
  writeFileSync(JOURNAL, JSON.stringify({ active: false }));
  console.log('Journal cleared.');
}

function runTests(tier, files) {
  const args = ['vitest', 'run', ...files, '--reporter=basic'];
  const r = spawnSync('npx', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: '1' },
  });
  return { caught: r.status !== 0, status: r.status };
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--recover') return recoverMode();

  const all = readFileSync('/tmp/all_tests.txt', 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const targeted = readFileSync('/tmp/targeted.txt', 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const only = argv.filter((a) => /^M\d+b?$/.test(a));
  const list = only.length ? MUTATIONS.filter((m) => only.includes(m.id)) : MUTATIONS;

  const results = readOrNull(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : [];
  const force = argv.includes('--force');
  const done = force ? new Set() : new Set(results.map((r) => r.id));
  if (force) {
    for (let i = results.length - 1; i >= 0; i--) {
      if (only.includes(results[i].id)) results.splice(i, 1);
    }
  }

  for (const m of list) {
    if (done.has(m.id)) {
      console.log(`${m.id} already recorded — skipping.`);
      continue;
    }
    const before = readOrNull(m.file);
    if (before === null) throw new Error(`missing target file ${m.file}`);
    if (!before.includes(m.find)) {
      throw new Error(`ANCHOR MISS ${m.id} in ${m.file}`);
    }
    const mutated = before.replace(m.find, m.replace);
    if (mutated === before) throw new Error(`NO-OP MUTATION ${m.id}`);

    const j = { active: true, id: m.id, file: m.file, before, mutated, name: m.name };
    writeFileSync(JOURNAL, JSON.stringify(j));
    writeFileSync(m.file, mutated);
    console.log(`\n=== ${m.id} ${m.name} :: ${m.file} ===`);

    const full = argv.includes('--full');
    let tier = 'targeted';
    let out = full ? { caught: false, status: 0 } : runTests(tier, targeted);
    if (full) {
      tier = 'full';
      for (const c of chunk(all, 38)) {
        out = runTests(tier, c);
        if (out.caught) break;
      }
    }

    // Restore + verify.
    writeFileSync(m.file, before);
    writeFileSync(JOURNAL, JSON.stringify({ active: false }));
    const restored = readFileSync(m.file, 'utf8') === before;

    const rec = {
      id: m.id,
      name: m.name,
      file: m.file,
      breaks: m.breaks,
      caughtBySuite: out.caught,
      tiersRun: full ? ['full'] : ['targeted'],
      caughtAtTier: out.caught ? tier : null,
      verdict: out.caught ? 'CAUGHT' : `SURVIVED_${tier.toUpperCase()}_SUITE`,
      exitStatus: out.status,
      restored,
      beforeHash: sha(before),
      mutatedHash: sha(mutated),
    };
    results.push(rec);
    writeFileSync(RESULTS, JSON.stringify(results, null, 2));
    console.log(
      `${m.id}: ${out.caught ? 'CAUGHT' : 'SURVIVED'} (tier=${tier}, exit=${out.status}) restored=${restored}`
    );
    if (!restored) throw new Error(`RESTORE FAILED ${m.id}`);
  }

  console.log('\n--- summary ---');
  for (const r of results) {
    console.log(`${r.id}\t${r.caughtBySuite ? 'CAUGHT' : 'SURVIVED'}\t${r.caughtAtTier ?? '-'}\t${r.name}`);
  }
  console.log(`\n${RESULTS}`);
}

// Imported by the Phase 17.8 harness to REUSE the mutation definitions rather
// than duplicate them. `main()` must not run on import in that case, or the
// Phase 17.7 audit would re-execute as a side effect of reading its list.
// The guard cannot change any 17.7 result: unset, this is the original call.
if (process.env.MUT_HARNESS_IMPORTED !== '1') main();
