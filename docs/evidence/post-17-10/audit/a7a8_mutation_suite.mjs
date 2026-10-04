/**
 * PHASE 18.7 / A7 + A8 — focused mutation suite.
 *
 * A7: a recovery bound that can be removed without a test noticing is not a
 *     bound, and a strategy that can repeat forever is not a strategy.
 * A8: a pipeline that can be bypassed without a test noticing is not a gate.
 *
 * The mutants are chosen to be the ways each rule could rot:
 *   - the per-category budget stops being checked,
 *   - the strategy chain stops being followed,
 *   - OSCILLATION is relabelled as plain NO_EFFECT,
 *   - STALE_PERCEPTION stops re-perceiving first,
 *   - the applicability stage is skipped,
 *   - a malformed 200 is coerced instead of refused,
 *   - the retry budget ignores the task class, and
 *   - a provider failure is reported as an ordinary failure again.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');
const TEST = 'tests/phase18_7_a7a8RecoveryProvider.test.ts';
// A mutant in the Python half of the pipeline can only be killed by pytest.
const PY_TEST = 'backend/tests/test_phase18_7_a8_provider_pipeline.py';
const RECOVERY = path.join(ROOT, 'extension/src/agent/recoveryEngine.ts');
const RESPONSE = path.join(ROOT, 'extension/src/agent/providerResponse.ts');
const LOOP = path.join(ROOT, 'extension/src/agent/agentLoop.ts');
const ROUTE = path.join(ROOT, 'backend/app/reasoner.py');

const SRC = {
  recovery: fs.readFileSync(RECOVERY, 'utf8'),
  response: fs.readFileSync(RESPONSE, 'utf8'),
  loop: fs.readFileSync(LOOP, 'utf8'),
  route: fs.readFileSync(ROUTE, 'utf8'),
};

function restore() {
  for (const [key, file] of Object.entries({ recovery: RECOVERY, response: RESPONSE, loop: LOOP, route: ROUTE })) {
    fs.writeFileSync(file, SRC[key]);
  }
}

function apply(source, edits, label) {
  let out = source;
  for (const [oldText, newText] of edits) {
    const count = out.split(oldText).length - 1;
    if (count !== 1) throw new Error(`[${label}] anchor matched ${count} times, expected 1`);
    out = out.replace(oldText, newText);
  }
  return out;
}

const MUTANTS = [
  {
    id: 'A7-M1',
    criterion: 'the per-category retry budget is checked before a strategy is chosen',
    file: RECOVERY,
    key: 'recovery',
    edits: [['    if (retryCount >= max) {', '    if (false) {']],
  },
  {
    id: 'A7-M2',
    criterion: 'the strategy chain is followed — the second NO_EFFECT changes strategy',
    file: RECOVERY,
    key: 'recovery',
    edits: [['      const next = chain[retryCount];', '      const next = chain[0];']],
  },
  {
    id: 'A7-M3',
    criterion: 'OSCILLATION is not relabelled as a weaker category',
    file: RECOVERY,
    key: 'recovery',
    edits: [
      ["    OSCILLATION: Object.freeze(['CHANGE_STRATEGY'] as const),", "    OSCILLATION: Object.freeze(['CHANGE_STRATEGY', 'CHANGE_STRATEGY'] as const),"],
      ['  OSCILLATION: 1,', '  OSCILLATION: 2,'],
    ],
  },
  {
    id: 'A7-M4',
    criterion: 'STALE_PERCEPTION re-perceives BEFORE acting again',
    file: RECOVERY,
    key: 'recovery',
    edits: [["    STALE_PERCEPTION: Object.freeze(['RE_PERCEIVE'] as const),", "    STALE_PERCEPTION: Object.freeze(['CHANGE_STRATEGY'] as const),"]],
  },
  {
    id: 'A7-M5',
    criterion: 'POLICY_BLOCKED gets a budget of one, so a refused proposal is not retried blindly',
    file: RECOVERY,
    key: 'recovery',
    edits: [['  POLICY_BLOCKED: 1,', '  POLICY_BLOCKED: 9,']],
  },
  {
    id: 'A7-M6',
    criterion: 'the explicit transition allowlist is enforced',
    file: RECOVERY,
    key: 'recovery',
    edits: [['    if (!exhausted && !allowed.includes(strategyTo)) {', '    if (false) {']],
  },
  {
    id: 'A7-M7',
    criterion: 'a category\'s strategy is remembered, so a chain cannot restart',
    file: RECOVERY,
    key: 'recovery',
    edits: [["    const strategyFrom = input.strategyFrom ?? this.strategyFor(category);", "    const strategyFrom = input.strategyFrom ?? 'CONTINUE';"]],
  },
  {
    id: 'A7-M8',
    criterion: 'the record ring is bounded',
    file: RECOVERY,
    key: 'recovery',
    edits: [['    if (this.records.length > MAX_RECOVERY_RECORDS) this.records.splice(0, this.records.length - MAX_RECOVERY_RECORDS);', '    // mutant: unbounded record ring']],
  },
  {
    id: 'A7-M9',
    criterion: 'OSCILLATION outranks a weaker effect-derived category',
    file: RECOVERY,
    key: 'recovery',
    edits: [["  if (input.oscillating) return 'OSCILLATION';", "  if (false) return 'OSCILLATION';"]],
  },
  {
    id: 'A8-M1',
    criterion: 'the APPLICABILITY stage runs after the schema stage',
    file: RESPONSE,
    key: 'response',
    edits: [['  return validateStepApplicability(validateProviderStep(data));', '  return validateProviderStep(data);']],
  },
  {
    id: 'A8-M2',
    criterion: 'a terminal proposal declaring ACTION must carry an action',
    file: RESPONSE,
    key: 'response',
    edits: [["    if (!isPlainObject(nested)) {\n      throw inapplicable('Provider terminal proposal declares ACTION but carries no action.');\n    }", "    if (!isPlainObject(nested)) return step;"]],
  },
  {
    id: 'A8-M3',
    criterion: 'ANSWER must carry an answer — a claim with nothing behind it is refused',
    file: RESPONSE,
    key: 'response',
    edits: [["    throw inapplicable(`Provider terminal proposal declares ${kind} but carries no answer.`);", '    // mutant: an ANSWER with no answer is accepted']],
  },
  {
    id: 'A8-M4',
    criterion: 'an unknown proposal kind is refused',
    file: RESPONSE,
    key: 'response',
    edits: [["  if (kind === undefined || !PROPOSAL_KINDS.has(kind)) {\n    throw inapplicable('Provider terminal proposal declares an unknown kind.');\n  }", '  if (kind === undefined) return step;']],
  },
  {
    id: 'A8-M5',
    criterion: 'a malformed successful response is refused, not defaulted',
    file: RESPONSE,
    key: 'response',
    edits: [["        throw new ProviderError(\"Provider action 'scroll' has an invalid 'direction'.\", 'invalid_json', {\n          category: 'SCHEMA_INVALID',\n        });", "        out.direction = direction === 'sideways' ? 'down' : direction;"]],
  },
  {
    id: 'A8-M6',
    criterion: 'an inapplicable field is refused rather than stripped',
    file: RESPONSE,
    key: 'response',
    edits: [["      throw new ProviderError(`Provider action has unexpected field '${key}'.`, 'invalid_json', {\n        category: 'SCHEMA_INVALID',\n      });", '      continue;']],
  },
  {
    id: 'A8-M7',
    criterion: 'an out-of-range scroll amount is refused rather than clamped',
    file: RESPONSE,
    key: 'response',
    edits: [['      if (amount < MIN_SCROLL_AMOUNT || amount > MAX_SCROLL_AMOUNT) {', '      if (false) {']],
  },
  {
    id: 'A8-M8',
    criterion: 'the retry budget is task-class aware — an information task spends less',
    file: RESPONSE,
    key: 'response',
    edits: [['const DETERMINISTIC_BUDGET: Readonly<Record<ProviderTaskClass, number>> = Object.freeze({\n  INFORMATION: 0,', 'const DETERMINISTIC_BUDGET: Readonly<Record<ProviderTaskClass, number>> = Object.freeze({\n  INFORMATION: 3,']],
  },
  {
    id: 'A8-M9',
    criterion: 'a rate limit with no Retry-After is never retried',
    file: RESPONSE,
    key: 'response',
    edits: [["  if (category === 'HTTP_429_RATE_LIMIT' && !transient) return 0;", '  // mutant: a rate limit without a hint is retried']],
  },
  {
    id: 'A8-M10',
    criterion: 'a deterministic failure is not treated as transient',
    file: RESPONSE,
    key: 'response',
    edits: [["  if (NEVER_RETRY_CATEGORIES.has(category)) return false;", '  if (NEVER_RETRY_CATEGORIES.has(category)) return true;']],
  },
  {
    id: 'A8-M11',
    criterion: 'a provider failure is its own truthful terminal state, not a generic failure',
    file: LOOP,
    key: 'loop',
    edits: [["          this.state.status = terminalStateForProviderFailure(category);", "          this.state.status = 'FAILED';"]],
  },
  {
    id: 'A8-M12',
    criterion: 'the bounded retry budget is applied in the loop',
    file: LOOP,
    key: 'loop',
    edits: [['        if (err.retryable !== true || attempt >= budget) break;', '        if (err.retryable !== true || attempt >= this.providerRetries) break;']],
  },
  {
    id: 'A8-M13',
    criterion: 'the backend refuses an inapplicable field instead of dropping it',
    file: ROUTE,
    key: 'route',
    edits: [['    inapplicable = sorted(k for k in provided if k not in _A8_ALLOWED_FIELDS[action])', '    inapplicable = []']],
  },
  {
    id: 'A8-M14',
    criterion: 'the backend refuses a missing required field instead of inventing one',
    file: ROUTE,
    key: 'route',
    edits: [['    missing = sorted(k for k in _A8_REQUIRED_FIELDS[action] if _absent(raw.get(k)))', '    missing = []']],
  },
  {
    id: 'A8-M15',
    criterion: 'the backend refuses an out-of-range scroll amount instead of clamping it',
    file: ROUTE,
    key: 'route',
    edits: [['        if not (1 <= amount <= 5000):', '        if False:']],
  },
];

// ── Run ─────────────────────────────────────────────────────────────────────

const results = [];
for (const m of MUTANTS) {
  let mutated;
  try {
    mutated = apply(SRC[m.key], m.edits, m.id);
  } catch (err) {
    results.push({ id: m.id, criterion: m.criterion, outcome: 'ANCHOR_MISSING', detail: String(err.message) });
    continue;
  }
  fs.writeFileSync(m.file, mutated);
  let outcome;
  let detail = '';
  const isPython = m.key === 'route';
  try {
    if (isPython) {
      execFileSync('./.venv/bin/python', ['-m', 'pytest', PY_TEST, '-q'], {
        cwd: path.join(ROOT, 'backend'),
        stdio: 'pipe',
        timeout: 120000,
      });
    } else {
      execFileSync('npx', ['vitest', 'run', '--silent=true', TEST], { cwd: ROOT, stdio: 'pipe', timeout: 240000 });
    }
    outcome = 'SURVIVED';
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    const failed = /(\d+) failed/.exec(out);
    outcome = 'KILLED';
    detail = failed ? failed[1] + ' failing test(s)' : 'suite failed to run';
    if (!isPython && /Error: Transform failed|Cannot find|is not exported|has no exported member/.test(out)) {
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
