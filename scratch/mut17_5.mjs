/**
 * PHASE 17.5 mutation harness.
 *
 * Each mutation breaks ONE invariant. A mutation is reported CAUGHT only when a
 * test ACTUALLY FAILS under it. The tree is restored after every run and
 * verified clean at the end.
 *
 * Per-file backups (the 17.4 harness's bug: two edits to one file sharing a
 * single backup path, so restore reinstated the mutation).
 */
import fs from 'fs';
import { execSync } from 'child_process';

const FILES = [
  'extension/src/agent/providerResponse.ts',
  'extension/src/agent/backendAgentProvider.ts',
  'extension/src/agent/openRouterProvider.ts',
  'extension/src/agent/agentLoop.ts',
];

const backups = new Map();
for (const f of FILES) backups.set(f, fs.readFileSync(f, 'utf8'));

function restore() {
  for (const [f, c] of backups) fs.writeFileSync(f, c);
}

const MUTATIONS = [
  {
    id: 'M1',
    name: 'remove schema validation',
    file: 'extension/src/agent/providerResponse.ts',
    find: 'export function validateProviderAction(raw: unknown): BrowserAction {',
    repl:
      'export function validateProviderAction(raw: unknown): BrowserAction {\n  if (raw && typeof raw === "object") return raw as BrowserAction;',
  },
  {
    id: 'M2',
    name: 'allow malformed response to dispatch',
    file: 'extension/src/agent/backendAgentProvider.ts',
    find: '      const validated = validateProviderEnvelope(await readBoundedJsonBody(resp));',
    repl: '      const __e: any = await readBoundedJsonBody(resp);\n      const validated = (__e.action ?? { action: "click", target: "el_0_go" }) as BrowserAction;',
  },
  {
    id: 'M3',
    name: 'remove stale-response rejection',
    file: 'extension/src/agent/agentLoop.ts',
    find: '        if (!isObservationCurrent(expectedIdentity, this.observationIdentityFor(context))) {',
    repl: '        if (false && !isObservationCurrent(expectedIdentity, this.observationIdentityFor(context))) {',
  },
  {
    id: 'M4',
    name: 'remove retry bound (unbounded provider retries)',
    file: 'extension/src/agent/agentLoop.ts',
    find: "    for (let attempt = 0; attempt <= this.providerRetries; attempt++) {",
    repl: '    for (let attempt = 0; attempt <= 9999; attempt++) {',
    second: [
      '        if (!retryable || attempt >= this.providerRetries) {',
      '        if (!retryable) {',
    ],
  },
  {
    id: 'M5',
    name: 'allow provider failure to become SUCCESS',
    file: 'extension/src/agent/agentLoop.ts',
    find: "        this.state.status = 'FAILED';\n        this.state.goalStatus = 'FAILED';\n        this.state.reason = `Agent reasoning failed: ${msg}`;",
    repl: "        this.state.status = 'SUCCESS';\n        this.state.goalStatus = 'SUCCESS';\n        this.state.reason = `Agent reasoning failed: ${msg}`;",
  },
  {
    id: 'M6',
    name: 'allow fallback to bypass a security gate (Security Critic BLOCK skipped)',
    file: 'extension/src/agent/agentLoop.ts',
    find: "      if (critic.verdict === 'BLOCK') {",
    repl: "      if (false) {",
  },
  {
    id: 'M7',
    name: 'allow oversized response through',
    file: 'extension/src/agent/providerResponse.ts',
    find: '    if (raw.length > MAX_RESPONSE_BODY_BYTES) {',
    repl: '    if (false && raw.length > MAX_RESPONSE_BODY_BYTES) {',
  },
  {
    id: 'M8',
    name: 'trust a remote retryable flag for rate limits',
    file: 'extension/src/agent/backendAgentProvider.ts',
    find: "    if (kind === 'rate_limit') {\n      retryable = false;\n    }",
    repl: '    if (kind === "rate_limit") {\n      retryable = true;\n    }',
  },
];

function runTests() {
  try {
    const out = execSync(
      'npx vitest run tests/phase17/reasonerProviderRobustness.test.ts tests/phase17/reasonerProviderLoopLevel.test.ts tests/phase17/longHorizonReliability.test.ts tests/phase17/longHorizonPersistence.test.ts 2>&1',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return { pass: true, out };
  } catch (e) {
    return { pass: false, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

const results = [];
for (const m of MUTATIONS) {
  restore();
  let src = fs.readFileSync(m.file, 'utf8');
  const n = src.split(m.find).length - 1;
  if (n !== 1) {
    results.push({ ...m, status: 'ANCHOR_NOT_FOUND', matches: n });
    continue;
  }
  src = src.replace(m.find, m.repl);
  if (m.second) {
    const n2 = src.split(m.second[0]).length - 1;
    if (n2 !== 1) {
      results.push({ ...m, status: 'SECOND_ANCHOR_NOT_FOUND', matches: n2 });
      restore();
      continue;
    }
    src = src.replace(m.second[0], m.second[1]);
  }
  fs.writeFileSync(m.file, src);
  const { pass, out } = runTests();
  const failed = (out.match(/×/g) || []).length;
  results.push({ ...m, status: pass ? 'SURVIVED' : 'CAUGHT', failedTests: failed });
  console.log(`${m.id} ${m.name}: ${pass ? 'SURVIVED ***' : `CAUGHT (${failed} failing)`}`);
}
restore();

// Verify the tree is byte-identical to the backup.
let clean = true;
for (const [f, c] of backups) {
  if (fs.readFileSync(f, 'utf8') !== c) {
    clean = false;
    console.log('DIRTY:', f);
  }
}
console.log('\ntree restored clean:', clean);
const survived = results.filter((r) => r.status !== 'CAUGHT');
console.log('mutations caught:', results.filter((r) => r.status === 'CAUGHT').length, '/', MUTATIONS.length);
if (survived.length) {
  console.log('\nSURVIVORS / ERRORS:');
  for (const s of survived) console.log(' ', s.id, s.name, s.status, s.matches ?? '');
  process.exitCode = 1;
}
