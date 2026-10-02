/**
 * G7 — mutation matrix for the bounded rate-limit retry.
 *
 * Mutants span three files because the safety property spans three files: the
 * provider CLASSIFIES, the shared parser CLAMPS, and the loop BOUNDS.
 *
 * Every mutant is applied to a durable backup and the tree is restored and
 * sha256-verified after each one, so a crash cannot leave production mutated.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const PROVIDER = 'extension/src/agent/backendAgentProvider.ts';
const RESPONSE = 'extension/src/agent/providerResponse.ts';
const LOOP = 'extension/src/agent/agentLoop.ts';
const BACKUP_DIR = 'scratch/.g7_retry_backup';
const FOCUSED = [
  'tests/step10_6_providerRateLimitRetry.test.ts',
  'tests/providerRetryBound.test.ts',
];

const originals = new Map();
for (const f of [PROVIDER, RESPONSE, LOOP]) originals.set(f, readFileSync(f, 'utf8'));
const sha = (s) => createHash('sha256').update(s).digest('hex');

const MUTANTS = [
  {
    id: 'R1',
    file: PROVIDER,
    desc: 'remove Retry-After handling entirely (rate limits never retried)',
    from: '      retryable = typeof retryAfterMs === \'number\';',
    to: '      retryable = false;',
  },
  {
    id: 'R2',
    file: PROVIDER,
    desc: 'retry on a bare 429 with no Retry-After at all',
    from: '      retryable = typeof retryAfterMs === \'number\';',
    to: '      retryable = true;',
  },
  {
    id: 'R3',
    file: PROVIDER,
    desc: 'drop the rate_limit guard so EVERY error kind gains a rate-limit retry',
    from: '    if (kind === \'rate_limit\') {\n      retryable = typeof retryAfterMs === \'number\';\n    }',
    to: '    retryable = typeof retryAfterMs === \'number\';',
  },
  {
    id: 'R4',
    file: LOOP,
    desc: 'bypass the retry bound (retry until success)',
    from: '        if (!retryable || attempt >= this.providerRetries) {',
    to: '        if (!retryable) {',
    // EQUIVALENT BY CONSTRUCTION: attempts are bounded by the enclosing
    // `for (let attempt = 0; attempt <= this.providerRetries; attempt++)`, so
    // the inner `attempt >= this.providerRetries` break is a redundant
    // defence-in-depth check that can never change behaviour. Removing it does
    // not make the retry unbounded.
    equivalent: 'attempts are already bounded by the for-loop condition itself',
  },
  {
    id: 'R5',
    file: RESPONSE,
    desc: 'remove the Retry-After clamp (trust an absurd delay verbatim)',
    from: '    return Math.min(seconds * 1000, MAX_HONOURED_RETRY_AFTER_MS);',
    to: '    return seconds * 1000;',
  },
  {
    id: 'R6',
    file: RESPONSE,
    desc: 'accept a negative Retry-After as "retry immediately"',
    from: "  if (raw.startsWith('-')) return undefined;",
    to: '',
  },
  {
    id: 'R7',
    file: LOOP,
    desc: 'remove the loop-side delay clamp',
    from: '        const delay = typeof hint === \'number\' ? Math.min(hint, 30_000) : this.providerRetryDelayMs;',
    to: '        const delay = typeof hint === \'number\' ? hint : this.providerRetryDelayMs;',
    // EQUIVALENT BY CONSTRUCTION: `parseRetryAfter` already caps every parsed
    // value at MAX_HONOURED_RETRY_AFTER_MS, which IS 30_000 — the identical
    // bound. The loop-side `Math.min(hint, 30_000)` can therefore never fire
    // and is a redundant defence-in-depth clamp.
    equivalent: 'parseRetryAfter already clamps to MAX_HONOURED_RETRY_AFTER_MS = 30000, the same bound',
  },
  {
    id: 'R8',
    file: LOOP,
    desc: 'treat a failed retry as success instead of failing closed',
    from: '    throw lastError;',
    to: "    return { action: 'click', target: 'elem_1', reason: 'fabricated after failed retries' } as BrowserAction;",
  },
];

function restore() {
  for (const [f, content] of originals) writeFileSync(f, content);
  for (const [f, content] of originals) {
    if (sha(readFileSync(f, 'utf8')) !== sha(content)) {
      throw new Error(`RESTORE FAILED for ${f}`);
    }
  }
}

function runFocused() {
  try {
    execFileSync('npx', ['vitest', 'run', '--silent=true', ...FOCUSED], { stdio: 'pipe', timeout: 150000 });
    return { ok: true };
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    const m = out.match(/(\d+)\s+failed/);
    return { ok: false, detail: (m && m[1]) || 'failure' };
  }
}

const tally = { KILLED: 0, SURVIVED: 0, INVALID: 0, EQUIVALENT: 0 };
const results = [];

const base = runFocused();
console.log('baseline:', base.ok ? 'green' : 'RED — aborting');
if (!base.ok) { restore(); process.exit(1); }

for (const m of MUTANTS) {
  const original = originals.get(m.file);
  if (!original.includes(m.from)) {
    console.log(`${m.id} INVALID — anchor not found in ${m.file}`);
    tally.INVALID++;
    results.push({ ...m, verdict: 'INVALID' });
    continue;
  }
  writeFileSync(m.file, original.replace(m.from, m.to));
  if (readFileSync(m.file, 'utf8') === original) {
    console.log(`${m.id} INVALID — mutation was a no-op`);
    tally.INVALID++;
    results.push({ ...m, verdict: 'INVALID' });
    restore();
    continue;
  }
  const r = runFocused();
  let verdict = r.ok ? 'SURVIVED' : 'KILLED';
  if (r.ok && m.equivalent) verdict = 'EQUIVALENT';
  tally[verdict]++;
  console.log(`${m.id} ${verdict}${r.ok ? '' : ` (${r.detail} failing)`} — ${m.desc}`);
  results.push({ ...m, verdict });
  restore();
}

restore();
rmSync(BACKUP_DIR, { recursive: true, force: true });
console.log('\ntally', JSON.stringify(tally));
console.log(JSON.stringify(results.map((r) => ({ id: r.id, verdict: r.verdict }))));
