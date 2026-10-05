#!/usr/bin/env node
/**
 * PHASE 18.8 / B2 + A13 + A15 — mutation suite.
 *
 * Each mutant is a plausible way this work could be undone or weakened:
 * unbounded growth, inherited context without an anchor, a raw value entering
 * identity, resolution that always guesses, an ordinal that clamps, identity
 * taken from a page-local DOM id, a stale identity accepted, a different entity
 * silently substituted, and the privacy screen removed.
 *
 * A survivor means the focused suite is not pinning the property it claims to.
 *
 * Run: node docs/evidence/post-17-10/audit/b2a13a15_mutation_suite.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const CONTEXT = 'extension/src/agent/conversationContext.ts';
const RESOLVER = 'extension/src/agent/referenceResolver.ts';
const IDENTITY = 'extension/src/agent/entityIdentity.ts';
const PERSIST = 'extension/src/agent/conversationPersistence.ts';
const TESTS = [
  'tests/phase18_8_b2ConversationContext.test.ts',
  'tests/phase18_8_a13ReferenceResolution.test.ts',
  'tests/phase18_8_a15EntityIdentity.test.ts',
];

const MUTANTS = [
  {
    id: 'M1',
    file: CONTEXT,
    name: 'conversation turns grow without bound',
    find: 'const turns = [...ctx.turns, next].slice(-MAX_CONVERSATION_TURNS).map((t, i) =>',
    replace: 'const turns = [...ctx.turns, next].map((t, i) =>',
  },
  {
    id: 'M2',
    file: RESOLVER,
    name: 'a reference continues a conversation even with nothing to refer to',
    find: 'if (!hasReference || !hasAnchor) {',
    replace: 'if (!hasReference) {',
  },
  {
    id: 'M3',
    file: CONTEXT,
    name: 'sensitive attributes are kept (identity carries raw values)',
    find: "    if (tripsPrivacy(text)) continue;\n    out[normalizedKey] = text;",
    replace: '    out[normalizedKey] = text;',
  },
  {
    id: 'M4',
    file: PERSIST,
    name: 'persistence writes without screening the context',
    find: 'return conversationPrivacyViolations(context).length === 0;',
    replace: 'return true;',
  },
  {
    id: 'M5',
    file: RESOLVER,
    name: 'reference resolution removed entirely (every turn is "not a reference")',
    find: "  if (!ctx) return clarification('NO_CANDIDATES', reference, 'NEEDS_INFORMATION');",
    replace: "  return { outcome: 'NOT_A_REFERENCE', reference: null, candidate: null, identity: null, clarificationCode: null, question: null, basis: 'NONE' };\n  if (!ctx) return clarification('NO_CANDIDATES', reference, 'NEEDS_INFORMATION');",
  },
  {
    id: 'M6',
    file: RESOLVER,
    name: 'always resolve: ambiguity answered by picking the first candidate',
    find: "  return clarification('AMBIGUOUS_REFERENCE', reference, 'NEEDS_CLARIFICATION');",
    replace: "  return { outcome: 'RESOLVED', reference, candidate: live[0], identity: live[0].identity, clarificationCode: null, question: null, basis: 'UNIQUE_CANDIDATE' };",
  },
  {
    id: 'M7',
    file: RESOLVER,
    name: 'an out-of-range ordinal is clamped to the last candidate',
    find: "    if (!target) return clarification('OUT_OF_RANGE_ORDINAL', reference, 'NEEDS_CLARIFICATION');",
    replace: '    if (!target) return { outcome: \'RESOLVED\', reference, candidate: live[live.length - 1], identity: live[live.length - 1].identity, clarificationCode: null, question: null, basis: \'ORDINAL\' };',
  },
  {
    id: 'M8',
    file: IDENTITY,
    name: 'identity taken from the page-local DOM detection id',
    find: '      title: entity.title,',
    replace: '      title: entity.title,\n      productId: entity.id,',
  },
  {
    id: 'M9',
    file: IDENTITY,
    name: 'a stale identity is accepted without re-establishing it',
    // Anchored on the FINAL fallback of `revalidateAgainstRecorded` (the
    // identical string in `revalidateSelection` is left alone), because this
    // mutant is about the cross-page revalidation path.
    find: "  return { verdict: 'NOT_FOUND', identity: null, ordinal: null, code: 'IDENTITY_ABSENT' };\n}",
    replace: "  return { verdict: 'REVALIDATED', identity: recorded, ordinal: recordedOrdinal, code: 'TITLE_AND_ID_MATCH' };\n}",
  },
  {
    id: 'M10',
    file: IDENTITY,
    name: 'cross-entity substitution: any observed entity stands in for the selection',
    find: '  const titleMatches = observed.filter(',
    replace: "  if (observed.length > 0) {\n    return { verdict: 'REVALIDATED', identity: observed[0].identity, ordinal: observed[0].ordinal, code: 'IDENTITY_KEY_MATCH' };\n  }\n  const titleMatches = observed.filter(",
  },
  {
    id: 'M11',
    file: CONTEXT,
    name: 'titles admitted without the raw-value screen',
    find: '  if (tripsPrivacy(collapsed)) return null;\n  return collapsed;',
    replace: '  return collapsed;',
  },
  {
    //
    // M12/M13 cover the REAL-CHROME defect: `data-product-id="3"` is coerced to
    // the NUMBER 3 by the DOM reader, and only string identifiers were read —
    // so every catalog candidate carried no product id and identity had nothing
    // to re-establish itself with on the detail page.
    //
    id: 'M12',
    file: CONTEXT,
    name: 'numeric attributes accepted without the raw-value screen (a card number becomes an identity attribute)',
    find: '      if (digits.replace(/[-.]/g, \'\').length > MAX_NUMERIC_ATTRIBUTE_DIGITS) continue;\n      if (tripsPrivacy(digits)) continue;',
    replace: '      if (digits.replace(/[-.]/g, \'\').length > MAX_NUMERIC_ATTRIBUTE_DIGITS) continue;',
  },
  {
    id: 'M13',
    file: CONTEXT,
    name: 'numeric catalog identifiers ignored again (identity cannot cross a navigation)',
    find: `          : typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1e15
            ? String(value)
            : '';`,
    replace: "          : '';",
  },
];

const originals = {};
for (const f of new Set(MUTANTS.map((m) => m.file))) originals[f] = readFileSync(f, 'utf8');

const results = [];
for (const mutant of MUTANTS) {
  const original = originals[mutant.file];
  if (!original.includes(mutant.find)) {
    results.push({ ...mutant, verdict: 'NOT_APPLIED', detail: 'anchor text not found' });
    continue;
  }
  writeFileSync(mutant.file, original.replace(mutant.find, mutant.replace));
  let killed = false;
  let detail = '';
  try {
    execFileSync('npx', ['vitest', 'run', '--silent=true', ...TESTS], { stdio: 'pipe', timeout: 240_000 });
  } catch (err) {
    killed = true;
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    detail = (out.match(/Tests\s+.*/) ?? ['tests failed'])[0].trim();
  }
  results.push({ ...mutant, verdict: killed ? 'KILLED' : 'SURVIVED', detail });
  writeFileSync(mutant.file, original);
}

const killed = results.filter((r) => r.verdict === 'KILLED').length;
const survived = results.filter((r) => r.verdict === 'SURVIVED').length;
const notApplied = results.filter((r) => r.verdict === 'NOT_APPLIED').length;

const report = {
  phase: '18.8-B2/A13/A15',
  work: 'B2 conversation context, A13 reference resolution, A15 entity identity — mutation suite',
  total: results.length,
  killed,
  survived,
  notApplied,
  results,
};

writeFileSync(
  'docs/evidence/post-17-10/audit/b2a13a15_mutation_results.json',
  JSON.stringify(report, null, 2)
);
console.log(`B2/A13/A15 MUTATION: ${killed}/${results.length} killed, ${survived} survived, ${notApplied} not applied`);
for (const r of results) console.log(`  ${r.id} ${r.verdict.padEnd(11)} ${r.name}`);