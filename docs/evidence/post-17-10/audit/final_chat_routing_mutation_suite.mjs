#!/usr/bin/env node
/**
 * FINAL PRODUCT ACCEPTANCE AUDIT — mutation suite (normal-chat vs browser
 * routing boundary).
 *
 * Each mutant is a way the routing contract could be silently undone:
 *
 *   M1  everything classified PIPELINE — ordinary chat is thrown back at the
 *       browser pipeline (the pre-audit defect, made total);
 *   M2  everything classified CONVERSATION — browser tasks are answered as
 *       small talk and never reach their gates;
 *   M3  the VAGUE_REFERENCE signal removed — "Tell me about it." is answered
 *       as a general question instead of sent to clarification;
 *   M4  the conversational branch's unconditional early exit removed — a normal
 *       chat message falls through into I-1, target resolution and the loop;
 *   M5  I-1 grants admission to greetings — the intent boundary admits browser
 *       automation for a message that can never need it;
 *   M6  the ordering inverted — a conversational SHAPE is granted before the
 *       browser signals are checked, so "what is the price of this product?"
 *       is answered from static knowledge.
 *
 * A survivor means the focused suites are not pinning the property they claim
 * to. Authorities are never weakened to make a mutant die: the mutants weaken
 * the implementation, the tests stay exactly as they are.
 *
 * Run: node docs/evidence/post-17-10/audit/final_chat_routing_mutation_suite.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ROUTER = 'extension/src/agent/conversationRoute.ts';
const SW = 'extension/src/background/serviceWorker.ts';
const IB = 'extension/src/agent/intentBoundary.ts';
const TESTS = ['tests/finalNormalChatRouting.test.ts', 'tests/phase18_7_i1IntentBoundary.test.ts'];

const GREETING_LINE =
  "  if (isPureGreeting(task)) return { route: 'CONVERSATION', code: 'SMALLTALK' };";

const MUTANTS = [
  // ── The router ─────────────────────────────────────────────────────────────
  {
    id: 'M1',
    file: ROUTER,
    name: 'every message is classified PIPELINE — normal chat is never answered here',
    find: GREETING_LINE,
    replace:
      "  if (true) return { route: 'PIPELINE', code: 'NO_CONVERSATIONAL_SHAPE' };\n" +
      GREETING_LINE,
  },
  {
    id: 'M2',
    file: ROUTER,
    name: 'every message is classified CONVERSATION — browser tasks never reach their gates',
    find: GREETING_LINE,
    replace:
      "  if (true) return { route: 'CONVERSATION', code: 'SMALLTALK' };\n" +
      GREETING_LINE,
  },
  {
    id: 'M3',
    file: ROUTER,
    name: 'the VAGUE_REFERENCE signal is removed — a dangling pronoun is "answered" instead of clarified',
    find: "  if (VAGUE_REFERENCE.test(task)) return { route: 'PIPELINE', code: 'VAGUE_REFERENCE' };\n",
    replace: '',
  },
  {
    id: 'M6',
    file: ROUTER,
    name: 'the ordering is inverted — a definitional shape is granted before browser signals are checked',
    find:
      "  if (UNSUPPORTED_CAPABILITY.test(task)) return { route: 'PIPELINE', code: 'UNSUPPORTED_CAPABILITY' };",
    replace:
      "  if (DEFINITIONAL.test(task)) return { route: 'CONVERSATION', code: 'DEFINITIONAL_KNOWLEDGE' };\n" +
      "  if (UNSUPPORTED_CAPABILITY.test(task)) return { route: 'PIPELINE', code: 'UNSUPPORTED_CAPABILITY' };",
  },
  // ── The dispatcher ─────────────────────────────────────────────────────────
  {
    id: 'M4',
    file: SW,
    name: 'the conversational early exit is removed — a chat message falls through into target resolution',
    // The 6-space `})();` at the end of the chat branch is unique in the file.
    find: '      })();\n      return;',
    replace: '      })();',
  },
  // ── The intent boundary ────────────────────────────────────────────────────
  {
    id: 'M5',
    file: IB,
    name: 'I-1 admits greetings to browser automation — the refusal is silently granted',
    find:
      "      destination: false, evidence: false, admits: false, refusal: 'GREETING_NO_AUTOMATION',",
    replace:
      "      destination: false, evidence: false, admits: true, refusal: 'GREETING_NO_AUTOMATION',",
  },
];

const originals = {};
for (const f of new Set(MUTANTS.map((m) => m.file))) originals[f] = readFileSync(f, 'utf8');

const results = [];
for (const mutant of MUTANTS) {
  const source = originals[mutant.file];
  const mutated = source.replace(mutant.find, mutant.replace);
  if (mutated === source) {
    results.push({ id: mutant.id, name: mutant.name, outcome: 'NOT_APPLIED' });
    console.log(`${mutant.id} NOT_APPLIED ${mutant.name}`);
    continue;
  }
  writeFileSync(mutant.file, mutated);
  let killed = false;
  let detail = '';
  try {
    execFileSync('npx', ['vitest', 'run', '--silent=true', ...TESTS], { stdio: 'pipe' });
  } catch (err) {
    killed = true;
    detail = String(err.stdout || '')
      .split('\n')
      .filter((l) => /FAIL|Tests |×/.test(l))
      .slice(0, 4)
      .join(' | ')
      .slice(0, 500);
  } finally {
    writeFileSync(mutant.file, source);
  }
  results.push({ id: mutant.id, name: mutant.name, outcome: killed ? 'KILLED' : 'SURVIVED', detail });
  console.log(`${mutant.id} ${killed ? 'KILLED' : 'SURVIVED'}      ${mutant.name}`);
}

const killed = results.filter((r) => r.outcome === 'KILLED').length;
const survivors = results.filter((r) => r.outcome === 'SURVIVED').length;
const summary = {
  phase: 'FINAL-ACCEPTANCE-normal-chat-routing',
  work: 'Normal-chat vs browser-task routing boundary — mutation suite',
  tests: TESTS,
  total: results.length,
  killed,
  survived: survivors,
  notApplied: results.filter((r) => r.outcome === 'NOT_APPLIED').length,
  results,
};
writeFileSync(
  'docs/evidence/post-17-10/audit/final_chat_routing_mutation_results.json',
  JSON.stringify(summary, null, 2),
);
console.log(
  `ROUTING MUTATION: ${killed}/${results.length} killed, ${survivors} survivors, ${summary.notApplied} not applied`,
);
process.exitCode = survivors === 0 && summary.notApplied === 0 ? 0 : 1;
