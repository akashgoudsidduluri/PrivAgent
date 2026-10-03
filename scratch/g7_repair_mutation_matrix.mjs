#!/usr/bin/env node
/**
 * G7 REPAIR MUTATION MATRIX.
 *
 * Because production behaviour changed (Repair 1 + Repair 2), the relevant
 * mutation matrix is re-run.
 *
 * The property under test is the SECURITY-RELEVANT one: nothing except a real
 * `DestinationVerifier` MATCH on a FRESH observation of a DECLARED destination
 * may complete a destination subgoal.
 *
 * Each mutation is applied to a production file, the focused suites are run,
 * and the file is restored with a SHA-256 verification so a failed run can
 * never leave the tree modified.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const TARGETS = [
  'extension/src/agent/agentLoop.ts',
  'extension/src/hierarchicalPlanning/goalProgressTracker.ts',
  'extension/src/planning/destinationVerifier.ts',
  'extension/src/hierarchicalPlanning/subgoalSelector.ts',
];

const snapshot = new Map();
for (const f of TARGETS) {
  const buf = readFileSync(f);
  snapshot.set(f, { text: buf.toString('utf8'), sha: createHash('sha256').update(buf).digest('hex') });
}

function restoreAll() {
  for (const [f, s] of snapshot) {
    writeFileSync(f, s.text);
    const now = createHash('sha256').update(readFileSync(f)).digest('hex');
    if (now !== s.sha) {
      console.error(`FATAL: restore of ${f} failed sha verification`);
      process.exit(2);
    }
  }
}

function apply(file, from, to) {
  const src = snapshot.get(file).text;
  if (!src.includes(from)) return null;
  const mutated = src.replace(from, to);
  writeFileSync(file, mutated);
  return true;
}

const SUITES = [
  'tests/step10_7_g7DestinationRevisit.test.ts',
  'tests/step10_7_g7SemanticFallback.test.ts',
  'tests/step10_6_g7DestinationGoalVerifier.test.ts',
  'tests/step10_5_g7NegativeControls.test.ts',
  'tests/destinationVerifier.test.ts',
  'tests/subgoalSelector.test.ts',
  'tests/subgoalGraph.test.ts',
];

function runSuites() {
  try {
    execFileSync(
      'npx',
      ['vitest', 'run', '--silent=true', ...SUITES],
      { cwd: ROOT, stdio: 'pipe', timeout: 300000 }
    );
    return 'PASS';
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    const m = /Tests\s+(\d+ failed)/.exec(out) || /(\d+) failed/.exec(out);
    return m ? `KILLED (${m[1]} failed)` : 'KILLED';
  }
}

/** id, description, file, from, to, expectation */
const MUTATIONS = [
  {
    id: 'M1',
    desc: 'executionSuccess alone completes the destination (dispatch→complete shortcut)',
    file: 'extension/src/agent/agentLoop.ts',
    from: `if (execResult.success && activeSubgoal && this.subgoalGraph) {
        const subgoalVerification = GoalProgressTracker.verifySubgoalCondition(activeSubgoal, {`,
    to: `if (execResult.success && activeSubgoal && this.subgoalGraph) {
        if (activeSubgoal.verificationCondition?.type === 'DESTINATION_VERIFIED') { this.subgoalGraph.completeSubgoal(activeSubgoal.id); this.state.subgoalGraphData = this.subgoalGraph.toData(); }
        const subgoalVerification = GoalProgressTracker.verifySubgoalCondition(activeSubgoal, {`,
    expect: 'KILLED',
  },
  {
    id: 'M2',
    desc: 'action URL matching the destination completes the subgoal',
    file: 'extension/src/agent/agentLoop.ts',
    from: `if (destinationRevisitSubgoal && this.subgoalGraph) {`,
    to: `if (destinationRevisitSubgoal && this.subgoalGraph) {
        {
          const prevUrl = String(((this.state.previousActions[this.state.previousActions.length - 1] as { url?: string } | undefined)?.url) ?? '');
          if (prevUrl.includes('results')) { this.subgoalGraph.completeSubgoal(destinationRevisitSubgoal.id); this.state.subgoalGraphData = this.subgoalGraph.toData(); }
        }`,
    expect: 'KILLED',
  },
  {
    id: 'M3',
    desc: 'stale observation accepted (freshness check removed)',
    file: 'extension/src/planning/destinationVerifier.ts',
    from: `if (input.currentPageGeneration !== undefined && input.currentPageGeneration !== obs.pageGeneration) {
    return fail(
      \`Observation belongs to page generation \${obs.pageGeneration} but verification is running at generation \${input.currentPageGeneration}; a stale document cannot verify a destination.\`
    );
  }`,
    to: `if (false) {
    return fail('mutant: staleness gate removed');
  }`,
    expect: 'KILLED',
  },
  {
    id: 'M4',
    desc: 'UNKNOWN classification treated as satisfying',
    file: 'extension/src/hierarchicalPlanning/goalProgressTracker.ts',
    from: "result.kind === 'MATCH',",
    to: "result.kind !== 'MISMATCH',",
    expect: 'KILLED',
  },
  {
    id: 'M5',
    desc: 'MISMATCH classification treated as satisfying',
    file: 'extension/src/hierarchicalPlanning/goalProgressTracker.ts',
    from: "result.kind === 'MATCH',",
    to: "true,",
    expect: 'KILLED',
  },
  {
    id: 'M6',
    desc: 'missing destination declaration no longer fails closed',
    file: 'extension/src/hierarchicalPlanning/goalProgressTracker.ts',
    from: "if (!declaration || declaration.kind !== 'DECLARED') {",
    to: "if (false) {",
    expect: 'KILLED',
  },
  {
    id: 'M7',
    desc: 'wrong page role accepted (page-role channel ignored)',
    file: 'extension/src/planning/destinationVerifier.ts',
    from: '? verifyPageRole(declaration.role.acceptablePageTypes, input)',
    to: "? { kind: 'MATCH', reason: 'mutant: page role ignored', decisiveChannel: 'pageRole', channels: { pageRole: { status: 'MATCH', confidence: 0.99, reason: 'mutant' }, url: null } } as any",
    expect: 'KILLED',
  },
  {
    id: 'M8',
    desc: 'low-confidence page role accepted (confidence gate removed)',
    file: 'extension/src/planning/destinationVerifier.ts',
    from: 'MIN_PAGE_CLASSIFICATION_CONFIDENCE',
    to: '0',
    expect: 'KILLED',
  },
  {
    id: 'M9',
    desc: 'Repair 1 removed — the destination subgoal is never re-verified',
    file: 'extension/src/agent/agentLoop.ts',
    from: 'if (destinationRevisitSubgoal && this.subgoalGraph) {',
    to: 'if (false && destinationRevisitSubgoal && this.subgoalGraph) {',
    expect: 'KILLED',
  },
  {
    id: 'M11',
    desc: 'revisit completes without consulting the verifier (eligibility alone completes)',
    file: 'extension/src/agent/agentLoop.ts',
    from: `if (revisitVerification.satisfied) {
          this.subgoalGraph.completeSubgoal(destinationRevisitSubgoal.id);`,
    to: `if (true) {
          this.subgoalGraph.completeSubgoal(destinationRevisitSubgoal.id);`,
    expect: 'KILLED',
  },
  {
    id: 'M12',
    desc: 'stale observation accepted by the revisit path (pageGeneration forced to observed)',
    file: 'extension/src/agent/agentLoop.ts',
    from: `            pageGeneration: this.state.currentPageGeneration ?? 0,
            userConfirmedActionIds: this.state.confirmedActionIds ?? [],
          }
        );
        if (revisitVerification.satisfied) {`,
    to: `            pageGeneration: semanticContext?.pageGeneration ?? 0,
            userConfirmedActionIds: this.state.confirmedActionIds ?? [],
          }
        );
        if (revisitVerification.satisfied) {`,
    expect: 'EQUIVALENT',
    equivalenceProof:
      'The two expressions can only differ when `semanticContext` is undefined. ' +
      'When a worldModel IS present, agentLoop.ts:799 sets ' +
      '`state.currentPageGeneration = worldModel.page.pageGeneration`, and ' +
      'normalizePerceptionResult (agentLoop.ts:3026-3033) has already rejected any ' +
      'perception whose `semanticContext.pageGeneration !== worldModel.pageGeneration`. ' +
      'So the two are provably equal, and nothing between line 799 and the revisit ' +
      'block mutates the counter. When `semanticContext` is undefined (the `else` ' +
      'branch at agentLoop.ts:844), `verifySubgoalCondition` hits its ' +
      '`if (!classification) return verdict(false, ...)` branch and refuses, ' +
      'regardless of the generation number passed. No behaviour differs.',
  },
  {
    id: 'M10',
    desc: 'Repair 1 widened — ANY IN_PROGRESS subgoal becomes revisitable',
    file: 'extension/src/hierarchicalPlanning/subgoalSelector.ts',
    from: "sg.verificationCondition?.type === 'DESTINATION_VERIFIED'",
    to: "true",
    expect: 'KILLED',
  },
];

console.log('G7 REPAIR MUTATION MATRIX');
console.log('========================');

let killed = 0, survived = 0, equivalent = 0;
const results = [];

for (const m of MUTATIONS) {
  restoreAll();
  const applied = apply(m.file, m.from, m.to);
  if (!applied) {
    console.log(`${m.id}: NOT APPLIED — anchor not found (${m.desc})`);
    results.push({ ...m, applied: false });
    survived += 1;
    continue;
  }
  const outcome = runSuites();
  restoreAll();
  let verdict;
  if (outcome !== 'PASS') {
    verdict = 'KILLED';
    killed += 1;
  } else if (m.expect === 'EQUIVALENT') {
    // A declared-equivalent mutant: it changes an expression whose value is
    // provably identical at this program point, so no test can distinguish it.
    // Accepted as equivalent, NOT counted as a surviving security defect.
    verdict = 'EQUIVALENT';
    equivalent += 1;
  } else {
    verdict = 'SURVIVED';
    survived += 1;
  }
  results.push({ ...m, applied: true, outcome, verdict });
  console.log(`${m.id}: ${verdict.padEnd(9)} ${outcome.padEnd(16)} ${m.desc}`);
}

restoreAll();
console.log('========================');
console.log(`KILLED=${killed}  SURVIVED=${survived}  EQUIVALENT=${equivalent}`);

const out = path => writeFileSync(
  path,
  JSON.stringify({ generatedAt: new Date().toISOString(), suites: SUITES, summary: { killed, survived, equivalent }, results: results.map(r => ({ id: r.id, description: r.desc, file: r.file, expectation: r.expect, applied: r.applied, outcome: r.outcome ?? null, verdict: r.verdict ?? 'NOT_APPLIED', ...(r.equivalenceProof ? { equivalenceProof: r.equivalenceProof } : {}) })) }, null, 2) + '\n'
);
out('docs/evidence/post-17-10/audit/g7_repair_mutation_matrix.json');
console.log('wrote docs/evidence/post-17-10/audit/g7_repair_mutation_matrix.json');
process.exit(survived > 0 ? 1 : 0);