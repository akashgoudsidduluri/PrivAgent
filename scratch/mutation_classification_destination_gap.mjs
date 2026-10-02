/**
 * MUTATION PROBES — classification → destination subgoal gap (POST-17.10 Step 8).
 *
 * Each mutant reintroduces one specific way the Step 8 fix could fail: planning
 * a destination without a declaration, planning it from the category or from
 * observation instead of from the user's words, duplicating it, resolving an
 * ambiguity by guessing, or letting a destination MATCH assert task success.
 *
 * A mutant is KILLED only when the test suite fails. A mutant whose anchor no
 * longer matches is reported INVALID and is never counted as a kill; neither is
 * a compile error.
 * Run with `node scratch/mutation_classification_destination_gap.mjs`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const DECOMPOSER = 'extension/src/hierarchicalPlanning/taskDecomposer.ts';
const TRACKER = 'extension/src/hierarchicalPlanning/goalProgressTracker.ts';
const TYPES = 'extension/src/hierarchicalPlanning/hierarchicalTypes.ts';
const SUITE = [
  'tests/classificationDestinationGap.test.ts',
  'tests/destinationProducerWiring.test.ts',
  'tests/affordanceAvailableContract.test.ts',
  'tests/taskDecomposer.test.ts',
];

const ORIGINALS = new Map([
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

const MUTANTS = [
  {
    id: 'M1',
    name: 'plan a destination subgoal even with NO declaration',
    edit: () =>
      mutate(
        DECOMPOSER,
        `    if (!declaredDestination) return '';`,
        `    if (false) return '';`
      ),
  },
  {
    id: 'M2',
    name: 'create a destination subgoal whenever the category is GENERIC_INTERACTION',
    edit: () =>
      mutate(
        DECOMPOSER,
        `    if (!declaredDestination) return '';`,
        `    if (false) return '';
    if (destinationDeclaration.kind !== 'DECLARED') {
      return addSubgoal('NAVIGATE', 'Reach the destination declared in the user request', 'navigate', [],
        { type: 'DESTINATION_VERIFIED', description: 'Declared destination is observed' });
    }`
      ),
  },
  {
    id: 'M3',
    name: 'create a destination subgoal whenever the category is ECOMMERCE',
    edit: () =>
      mutate(
        DECOMPOSER,
        `    if (!declaredDestination) return '';`,
        `    if (false) return '';
    if (taskCategory === 'ECOMMERCE_SEARCH') {
      return addSubgoal('NAVIGATE', 'Reach the destination declared in the user request', 'navigate', [],
        { type: 'DESTINATION_VERIFIED', description: 'Declared destination is observed' });
    }`
      ),
  },
  {
    id: 'M4',
    name: 'carry the destination in targetEntity instead of the typed field',
    edit: () =>
      mutate(
        DECOMPOSER,
        `      undefined,
      declaredDestination
    );`,
        `      (declaredDestination as { role?: { acceptablePageTypes: string[] } }).role?.acceptablePageTypes.join(','),
      undefined
    );`
      ),
  },
  {
    id: 'M5',
    name: 'satisfy the destination subgoal from affordance existence',
    edit: () =>
      mutate(
        TRACKER,
        `        const declaration = subgoal.destination;`,
        `        if ((ctx.semantic_context?.affordances ?? []).length > 0) {
          return verdict(true, 'Completed: affordances exist.');
        }
        const declaration = subgoal.destination;`
      ),
  },
  {
    id: 'M6',
    name: 'create the destination from the OBSERVED page type',
    edit: () =>
      mutate(
        TRACKER,
        `        if (!declaration || declaration.kind !== 'DECLARED') {`,
        `        const observedOnly = { kind: 'DECLARED' as const, role: { provenance: 'EXPLICIT_PAGE_ROLE' as const, acceptablePageTypes: [classificationOf(ctx)] } };
        if (!declaration || declaration.kind !== 'DECLARED') {
          declaration = observedOnly as never;
        }
        if (false) {`
      ),
  },
  {
    id: 'M7',
    name: 'create the destination from a requested action.url',
    edit: () =>
      mutate(
        TRACKER,
        `        if (!declaration || declaration.kind !== 'DECLARED') {`,
        `        const requestedUrl = (subgoal as unknown as { action?: { url?: string } }).action?.url;
        if (!declaration && requestedUrl) {
          return verdict(true, \`Completed on requested url \${requestedUrl}.\`);
        }
        if (false) {`
      ),
  },
  {
    id: 'M8',
    name: 'duplicate the destination subgoal',
    edit: () =>
      mutate(
        DECOMPOSER,
        `    return addSubgoal(
      'NAVIGATE',
      'Reach the destination declared in the user request',`,
        `    addSubgoal('NAVIGATE', 'Reach the destination declared in the user request', 'navigate', [],
      { type: 'DESTINATION_VERIFIED', description: 'Declared destination is observed' }, undefined, declaredDestination);
    return addSubgoal(
      'NAVIGATE',
      'Reach the destination declared in the user request',`
      ),
  },
  {
    id: 'M9',
    name: 'resolve AMBIGUOUS into LISTING',
    edit: () =>
      mutate(
        DECOMPOSER,
        `  const declaredDestination =
    destinationDeclaration.kind === 'DECLARED' ? destinationDeclaration : undefined;`,
        `  const declaredDestination =
    destinationDeclaration.kind === 'DECLARED'
      ? destinationDeclaration
      : (destinationDeclaration.kind === 'AMBIGUOUS'
          ? { kind: 'DECLARED' as const, role: { provenance: 'EXPLICIT_PAGE_ROLE' as const, acceptablePageTypes: [destinationDeclaration.candidates[0]![0]!] } }
          : undefined);`
      ),
  },
  {
    id: 'M10',
    name: 'turn UNSUPPORTED into a destination subgoal',
    edit: () =>
      mutate(
        DECOMPOSER,
        `  const declaredDestination =
    destinationDeclaration.kind === 'DECLARED' ? destinationDeclaration : undefined;`,
        `  const declaredDestination =
    destinationDeclaration.kind === 'UNSUPPORTED'
      ? { kind: 'DECLARED' as const, url: { provenance: 'USER_URL' as const, origin: 'http://guessed.invalid', path: '/', rawUrl: 'http://guessed.invalid' } }
      : destinationDeclaration.kind === 'DECLARED' ? destinationDeclaration : undefined;`
      ),
  },
  {
    id: 'M11',
    name: 'derive the declaration from the OBSERVED current URL',
    edit: () =>
      mutate(
        DECOMPOSER,
        `  const destinationDeclaration = normalizeDestination(userPrompt);`,
        `  const destinationDeclaration = normalizeDestination(userPrompt + (currentUrl ? ' ' + currentUrl : ''));`
      ),
  },
  {
    id: 'M12',
    name: 'a planned destination subgoal marks the whole task SUCCESS',
    edit: () =>
      mutate(
        DECOMPOSER,
        `    if (!declaredDestination) return '';`,
        `    if (!declaredDestination) return '';
    highLevelGoal.status = 'COMPLETED';`
      ),
  },
  {
    id: 'M14',
    name: 'let a destination MATCH set the GOAL status, overriding goal verification',
    edit: () =>
      mutate(
        TRACKER,
        `          result.kind === 'MATCH',
          result.kind === 'MATCH'
            ? result.reason
            : \`Subgoal \${subgoal.id} destination not confirmed (\${result.kind}): \${result.reason}\``,
        `          result.kind === 'MATCH',
          result.kind === 'MATCH'
            ? ((subgoal as unknown as { goalStatus?: string }).goalStatus = 'SUCCESS') && result.reason
            : \`Subgoal \${subgoal.id} destination not confirmed (\${result.kind}): \${result.reason}\``
      ),
  },
  {
    id: 'M13',
    name: 'use AFFORDANCE_AVAILABLE instead of the typed DESTINATION_VERIFIED condition',
    edit: () =>
      mutate(
        DECOMPOSER,
        `      { type: 'DESTINATION_VERIFIED', description: 'Declared destination is observed' },
      undefined,
      declaredDestination
    );`,
        `      { type: 'AFFORDANCE_AVAILABLE', expectedValue: 'SCROLL', description: 'Declared destination is observed' },
      undefined,
      declaredDestination
    );`
      ),
  },
];

/** Helper injected only for mutant M6, so the mutation stays a real source edit. */
const M6_HELPER = `function classificationOf(c: AgentContextPayload): SemanticPageType {
  return (c.semantic_context?.pageType ?? 'UNKNOWN') as SemanticPageType;
}
`;

function runSuite() {
  const r = spawnSync('npx', ['vitest', 'run', '--silent=true', ...SUITE], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const m = out.match(/Tests\s+(?:(\d+) failed \| )?(\d+) passed/);
  const failed = m && m[1] ? Number(m[1]) : 0;
  const passed = m ? Number(m[2]) : 0;
  const compiled = !/Cannot find name|error TS|Transform failed|SyntaxError/.test(out);
  return { failed, passed, ok: r.status === 0 && compiled, compiled, out };
}

let killed = 0;
let survived = 0;
let invalid = 0;

for (const mutant of MUTANTS) {
  restoreAll();
  // M6 needs a helper so the mutant stays a source-level change rather than a
  // call into an undefined symbol (which would be a compile error, not a kill).
  const originalTracker = ORIGINALS.get(TRACKER);
  if (mutant.id === 'M6') {
    writeFileSync(
      TRACKER,
      originalTracker.replace(
        `const verdict = (satisfied: boolean, reason: string) => ({ satisfied, reason });`,
        `const verdict = (satisfied: boolean, reason: string) => ({ satisfied, reason });\n\n${M6_HELPER}`
      )
    );
  }
  try {
    mutant.edit();
  } catch (err) {
    invalid += 1;
    console.log(`\n${mutant.id}  INVALID  ${mutant.name}\n      ${err.message}`);
    restoreAll();
    continue;
  }
  const res = runSuite();
  restoreAll();
  if (res.ok && res.failed === 0) {
    survived += 1;
    console.log(`\n${mutant.id}  SURVIVED  ${mutant.name}\n      ${res.passed} passed`);
  } else if (!res.compiled) {
    invalid += 1;
    console.log(`\n${mutant.id}  INVALID-COMPILE  ${mutant.name}  (not counted as a kill)`);
  } else {
    killed += 1;
    console.log(`\n${mutant.id}  KILLED  ${mutant.name}\n      ${res.failed} failed | ${res.passed} passed`);
  }
}

restoreAll();
console.log(`\n== ${killed} killed, ${survived} survived, ${invalid} invalid of ${MUTANTS.length} ==`);