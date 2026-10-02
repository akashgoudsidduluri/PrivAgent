/**
 * MUTATION PROBES — destination declaration PRODUCER WIRING (POST-17.10 Step 7).
 *
 * Each mutant reintroduces one specific way the Step 7 integration could fail:
 * losing the declaration, losing it on the subgoal, trusting the wrong channel,
 * or letting dispatch/model/observation state decide a destination.
 *
 * A mutant is KILLED only when the test suite fails. A mutant whose anchor no
 * longer matches is reported INVALID and is never counted as a kill.
 * Run with `node scratch/mutation_destination_producer_wiring.mjs`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const NORMALIZER = 'extension/src/planning/destinationNormalizer.ts';
const DECOMPOSER = 'extension/src/hierarchicalPlanning/taskDecomposer.ts';
const TRACKER = 'extension/src/hierarchicalPlanning/goalProgressTracker.ts';
const TYPES = 'extension/src/hierarchicalPlanning/hierarchicalTypes.ts';
const SUITE = [
  'tests/destinationProducerWiring.test.ts',
  'tests/affordanceAvailableContract.test.ts',
  'tests/taskDecomposer.test.ts',
];

const ORIGINALS = new Map([
  [NORMALIZER, readFileSync(NORMALIZER, 'utf8')],
  [DECOMPOSER, readFileSync(DECOMPOSER, 'utf8')],
  [TRACKER, readFileSync(TRACKER, 'utf8')],
  [TYPES, readFileSync(TYPES, 'utf8')],
]);

function mutate(file, from, to) {
  const original = ORIGINALS.get(file);
  const count = original.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`anchor appears ${count}x in ${file}: ${JSON.stringify(from.slice(0, 70))}`);
  }
  writeFileSync(file, original.replace(from, to));
}

function restoreAll() {
  for (const [file, content] of ORIGINALS) writeFileSync(file, content);
}

// A mutation runner that is KILLED mid-run leaves the production source mutated.
// This happened for real once: a harness timeout terminated the runner between
// the mutant edit and its restore, and `goalProgressTracker.ts` was left with
// `result.kind === 'MATCH' || result.kind === 'MISMATCH'` committed to disk — a
// shipped bug that would have silently accepted MISMATCH as completion. Every
// subsequent suite then reported its anchors as INVALID, which is how it was
// noticed.
//
// Restore on every exit path, including signals.
let restored = false;
function restoreOnce() {
  if (restored) return;
  restored = true;
  restoreAll();
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
  process.on(sig, () => {
    restoreOnce();
    process.exit(130);
  });
}
process.on('exit', restoreOnce);
process.on('uncaughtException', (e) => {
  restoreOnce();
  console.error(e);
  process.exit(1);
});

const MUTANTS = [
  {
    id: 'M1',
    name: 'remove the destination declaration from HighLevelGoal',
    edit: () =>
      mutate(
        DECOMPOSER,
        `    destinationDeclaration,\n  };`,
        `  };`
      ),
  },
  {
    id: 'M2',
    name: 'drop the destination from the Subgoal',
    edit: () =>
      mutate(
        DECOMPOSER,
        `          undefined,\n          declaredDestination\n        );`,
        `          undefined\n        );`
      ),
  },
  {
    id: 'M3',
    name: 'ignore the destination verifier result (every destination subgoal passes)',
    edit: () =>
      mutate(
        TRACKER,
        `          result.kind === 'MATCH',
          result.kind === 'MATCH'
            ? result.reason
            : \`Subgoal \${subgoal.id} destination not confirmed (\${result.kind}): \${result.reason}\``,
        `          true,
          \`Subgoal \${subgoal.id} destination considered: \${result.kind}\``
      ),
  },
  {
    id: 'M4',
    name: 'treat UNKNOWN as MATCH',
    edit: () =>
      mutate(
        TRACKER,
        `        return verdict(
          result.kind === 'MATCH',`,
        `        return verdict(
          result.kind !== 'MISMATCH',`
      ),
  },
  {
    id: 'M5',
    name: 'treat MISMATCH as MATCH',
    edit: () =>
      mutate(
        TRACKER,
        `        return verdict(
          result.kind === 'MATCH',`,
        `        return verdict(
          result.kind === 'MATCH' || result.kind === 'MISMATCH',`
      ),
  },
  {
    id: 'M6',
    name: 'complete a destination subgoal from executionSuccess',
    edit: () =>
      mutate(
        TRACKER,
        `        const declaration = subgoal.destination;`,
        `        if ((subgoal as unknown as { executionSuccess?: boolean }).executionSuccess) {
          return verdict(true, \`Completed on executionSuccess.\`);
        }
        const declaration = subgoal.destination;`
      ),
  },
  {
    id: 'M7',
    name: 'complete a destination subgoal from action.url',
    edit: () =>
      mutate(
        TRACKER,
        `        const declaration = subgoal.destination;`,
        `        const requested = (subgoal as unknown as { action?: { url?: string } }).action?.url;
        if (requested && currentUrl.includes(new URL(requested).pathname)) {
          return verdict(true, \`Completed on requested action.url \${requested}.\`);
        }
        const declaration = subgoal.destination;`
      ),
  },
  {
    id: 'M8',
    name: 'complete a destination subgoal from affordance existence',
    edit: () =>
      mutate(
        TRACKER,
        `        const classification = semantic;`,
        `        if ((semantic?.affordances ?? []).length > 0) {
          return verdict(true, \`Completed: the page exposes affordances.\`);
        }
        const classification = semantic;`
      ),
  },
  {
    id: 'M9',
    name: 'let the OBSERVED classification rewrite the declaration',
    edit: () =>
      mutate(
        TRACKER,
        `        const result = verifyDestination({
          declaration,`,
        `        const observedPageType = classification.pageType;
        (declaration as { role?: { acceptablePageTypes: string[] } }).role = {
          provenance: 'EXPLICIT_PAGE_ROLE',
          acceptablePageTypes: [observedPageType],
        };
        const result = verifyDestination({
          declaration,`
      ),
  },
  {
    id: 'M10',
    name: 'bypass page-generation freshness (use the current generation as observed)',
    edit: () =>
      mutate(
        TRACKER,
        `        const observedGeneration = Number(classification.pageGeneration);`,
        `        const observedGeneration = Number(observation.pageGeneration ?? classification.pageGeneration);`
      ),
  },
  {
    id: 'M11',
    name: 'treat the entry URL as the destination URL',
    edit: () =>
      mutate(
        TRACKER,
        `          declaration,
          observation: destinationObservation,`,
        `          declaration: (declaration as { url?: unknown }).url
            ? declaration
            : ({ ...declaration, url: declaration.entryUrl } as typeof declaration),
          observation: destinationObservation,`
      ),
  },
  {
    id: 'M12',
    name: 'revert the destination subgoal to an unnamed, vacuously-failing condition',
    edit: () =>
      mutate(
        DECOMPOSER,
        `                type: 'DESTINATION_VERIFIED' as const,`,
        `                type: 'AFFORDANCE_AVAILABLE' as const,`
      ),
  },
  {
    id: 'M13',
    name: 'accept a DESTINATION_VERIFIED subgoal that carries no declaration',
    edit: () =>
      mutate(
        TRACKER,
        `        if (!declaration || declaration.kind !== 'DECLARED') {`,
        `        if (false) {`
      ),
  },
  {
    id: 'M14',
    name: 'accept any page classification, ignoring the confidence floor',
    edit: () =>
      mutate(
        TRACKER,
        `          semantic: {
            pageType: classification.pageType,
            confidence: classification.confidence,`,
        `          semantic: {
            pageType: classification.pageType,
            confidence: 1,`
      ),
  },
];

function runSuite() {
  const r = spawnSync('npx', ['vitest', 'run', '--silent=true', ...SUITE], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const m = out.match(/Tests\s+(?:(\d+) failed \| )?(\d+) passed/);
  const failed = m && m[1] ? Number(m[1]) : 0;
  const passed = m ? Number(m[2]) : 0;
  return { failed, passed, ok: r.status === 0 };
}

let killed = 0;
let survived = 0;
let invalid = 0;

for (const mutant of MUTANTS) {
  restoreAll();
  try {
    mutant.edit();
  } catch (err) {
    invalid += 1;
    console.log(`\n${mutant.id}  INVALID  ${mutant.name}\n      ${err.message}`);
    continue;
  }
  const res = runSuite();
  restoreAll();
  if (res.ok && res.failed === 0) {
    survived += 1;
    console.log(`\n${mutant.id}  SURVIVED  ${mutant.name}\n      ${res.passed} passed`);
  } else {
    killed += 1;
    console.log(
      `\n${mutant.id}  ${res.ok ? 'INVALID-COMPILE' : 'KILLED'}  ${mutant.name}\n      ${res.failed} failed | ${res.passed} passed`
    );
    if (res.ok) invalid += 1;
  }
}

restoreAll();
console.log(`\n== ${killed} killed, ${survived} survived, ${invalid} invalid of ${MUTANTS.length} ==`);