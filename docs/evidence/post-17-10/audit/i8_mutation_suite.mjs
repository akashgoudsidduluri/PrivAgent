/**
 * PHASE 18.7 / I-8 — focused mutation suite for SEMANTIC PROGRESS.
 *
 * The whole point of I-8 is that geometry stops counting as progress. A rule
 * that can be removed without any test noticing is not a rule, so each load-
 * bearing clause is removed here in turn and the focused suite must go red.
 *
 * The mutants are chosen to be the ways this rule could rot:
 *   - the evidence delta is ignored,
 *   - a new candidate/entity/fact/affordance stops counting,
 *   - a new document stops counting,
 *   - the same-direction budget is never charged,
 *   - the budget is never compared to its bound,
 *   - oscillation is never detected,
 *   - OSCILLATION is downgraded to NO_EFFECT,
 *   - the loop stops refusing exhausted-strategy scrolls,
 *   - and the pre-existing (non-scroll) progress signals are broken by
 *     over-tightening, which is the failure mode that would make productive
 *     scrolling look stalled.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');
const TEST = 'tests/phase18_7_i8SemanticProgress.test.ts';
const SEMANTIC = path.join(ROOT, 'extension/src/agent/semanticProgress.ts');
const LOOP = path.join(ROOT, 'extension/src/agent/agentLoop.ts');
const HORIZON = path.join(ROOT, 'extension/src/agent/longHorizon.ts');

const SEMANTIC_SRC = fs.readFileSync(SEMANTIC, 'utf8');
const LOOP_SRC = fs.readFileSync(LOOP, 'utf8');
const HORIZON_SRC = fs.readFileSync(HORIZON, 'utf8');

function restore() {
  fs.writeFileSync(SEMANTIC, SEMANTIC_SRC);
  fs.writeFileSync(LOOP, LOOP_SRC);
  fs.writeFileSync(HORIZON, HORIZON_SRC);
}

function apply(source, oldText, newText, label) {
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`[${label}] anchor matched ${count} times, expected 1`);
  return source.replace(oldText, newText);
}

const MUTANTS = [
  {
    id: 'I8-M1',
    criterion: 'new evidence is progress — ignoring the ledger delta restores the scroll loop',
    file: SEMANTIC,
    old: "  if (evidenceDelta > 0) signals.push('EVIDENCE_DELTA');",
    next: "  if (false) signals.push('EVIDENCE_DELTA');",
  },
  {
    id: 'I8-M2',
    criterion: 'a newly discovered interactive candidate is progress',
    file: SEMANTIC,
    old: "  if (hasNewIds(current.candidateIds, previous.candidateIds)) signals.push('NEW_CANDIDATE');",
    next: "  if (false) signals.push('NEW_CANDIDATE');",
  },
  {
    id: 'I8-M3',
    criterion: 'a newly discovered entity is progress',
    file: SEMANTIC,
    old: "  if (hasNewIds(current.entityIds, previous.entityIds)) signals.push('NEW_ENTITY');",
    next: "  if (false) signals.push('NEW_ENTITY');",
  },
  {
    id: 'I8-M4',
    criterion: 'a newly discovered sanitized fact key is progress',
    file: SEMANTIC,
    old: "  if (hasNewIds(current.factIds, previous.factIds)) signals.push('NEW_SEMANTIC_FACT');",
    next: "  if (false) signals.push('NEW_SEMANTIC_FACT');",
  },
  {
    id: 'I8-M5',
    criterion: 'a newly discovered affordance is progress',
    file: SEMANTIC,
    old: "  if (hasNewIds(current.affordanceIds, previous.affordanceIds)) signals.push('NEW_AFFORDANCE');",
    next: "  if (false) signals.push('NEW_AFFORDANCE');",
  },
  {
    id: 'I8-M6',
    criterion: 'a genuinely different document is progress',
    file: SEMANTIC,
    old: "  if (previous.documentIdentity !== current.documentIdentity) signals.push('PAGE_IDENTITY_CHANGED');",
    next: "  if (false) signals.push('PAGE_IDENTITY_CHANGED');",
  },
  {
    id: 'I8-M7',
    criterion: 'a change in the targeted value LENGTH is progress (never its value)',
    file: SEMANTIC,
    old: '  if (previous.targetValueLength !== current.targetValueLength) signals.push(\'TARGET_VALUE_CHANGED\');',
    next: "  if (false) signals.push('TARGET_VALUE_CHANGED');",
  },
  {
    id: 'I8-M8',
    criterion: 'the same-direction scroll budget is charged at all',
    file: SEMANTIC,
    old: '  const sameDirectionRun = last === scrollDirection ? carry.sameDirectionRun + 1 : 1;',
    next: '  const sameDirectionRun = 0;',
  },
  {
    id: 'I8-M9',
    criterion: 'the same-direction budget is compared with its bound',
    file: SEMANTIC,
    old: '  const budgetExhausted = sameDirectionRun >= bounds.maxSameDirectionWithoutProgress;',
    next: '  const budgetExhausted = false;',
  },
  {
    id: 'I8-M10',
    criterion: 'the alternating run is counted (trailingAlternatingRun returns 1)',
    file: SEMANTIC,
    old: 'export function trailingAlternatingRun(sequence: readonly ScrollDirection[]): number {\n  if (sequence.length < 2) return sequence.length;\n  let run = 1;\n  for (let i = sequence.length - 1; i > 0; i--) {\n    if (sequence[i] === sequence[i - 1]) break;\n    run += 1;\n  }\n  return run;\n}',
    next: 'export function trailingAlternatingRun(sequence: readonly ScrollDirection[]): number {\n  return sequence.length === 0 ? 0 : 1;\n}',
  },
  {
    id: 'I8-M11',
    criterion: 'the alternating run is compared with its bound (oscillation is detectable at all)',
    file: SEMANTIC,
    old: '  const oscillation = alternatingRun >= bounds.maxAlternatingWithoutProgress;',
    next: '  const oscillation = false;',
  },
  {
    id: 'I8-M12',
    criterion: 'OSCILLATION is not downgraded to the weaker NO_EFFECT',
    file: SEMANTIC,
    old: "  const stagnation: StagnationKind = oscillation ? 'OSCILLATION' : budgetExhausted ? 'NO_EFFECT' : 'NONE';",
    next: "  const stagnation: StagnationKind = budgetExhausted ? 'NO_EFFECT' : 'NONE';",
  },
  {
    id: 'I8-M13',
    criterion: 'meaningful progress CLEARS the scroll budget (productive scrolling stays productive)',
    file: SEMANTIC,
    old: '      sameDirectionRun: meaningful ? 0 : carry.sameDirectionRun,\n      directionSequence: meaningful ? [] : [...carry.directionSequence],',
    next: '      sameDirectionRun: carry.sameDirectionRun,\n      directionSequence: [...carry.directionSequence],',
  },
  {
    id: 'I8-M14',
    criterion: 'the loop actually refuses a further scroll once the strategy is exhausted',
    file: LOOP,
    old: '        if (this.scrollStrategyExhausted && action.action === \'scroll\') {',
    next: '        if (false && this.scrollStrategyExhausted && action.action === \'scroll\') {',
  },
  {
    id: 'I8-M15',
    criterion: 'the stall detector reports WHICH kind of stagnation, not just that there is one',
    file: HORIZON,
    old: '    const kind = this.semanticProgress.snapshot().stagnation;',
    next: "    const kind: StagnationKind = 'NONE';",
  },
];

// ── Run ─────────────────────────────────────────────────────────────────────

const results = [];
for (const m of MUTANTS) {
  const base = m.file === SEMANTIC ? SEMANTIC_SRC : m.file === LOOP ? LOOP_SRC : HORIZON_SRC;
  let mutated;
  try {
    mutated = apply(base, m.old, m.next, m.id);
  } catch (err) {
    results.push({ id: m.id, criterion: m.criterion, outcome: 'ANCHOR_MISSING', detail: String(err.message) });
    continue;
  }
  fs.writeFileSync(m.file, mutated);
  let outcome;
  let detail = '';
  try {
    execFileSync('npx', ['vitest', 'run', '--silent=true', TEST], { cwd: ROOT, stdio: 'pipe', timeout: 180000 });
    outcome = 'SURVIVED';
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    const failed = /(\d+) failed/.exec(out);
    outcome = 'KILLED';
    detail = failed ? failed[1] + ' failing test(s)' : 'suite failed to run';
    if (/Error: Transform failed|Cannot find|is not exported|has no exported member/.test(out)) {
      outcome = 'KILLED_COMPILE';
    }
  }
  restore();
  results.push({ id: m.id, criterion: m.criterion, outcome, detail });
}

restore();

const killed = results.filter((r) => r.outcome.startsWith('KILLED')).length;
const survived = results.filter((r) => r.outcome === 'SURVIVED').length;
const broken = results.filter((r) => r.outcome === 'ANCHOR_MISSING').length;
const summary = { total: results.length, killed, survived, anchorMissing: broken, results };
console.log(JSON.stringify(summary, null, 2));
process.exit(survived === 0 && broken === 0 ? 0 : 1);
