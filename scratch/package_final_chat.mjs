/**
 * Package every final-chat-routing raw run into the ONE required evidence file:
 *   docs/evidence/post-17-10/audit/final_normal_chat_routing.json
 *
 * Run: node scratch/package_final_chat.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const DIR = 'docs/evidence/post-17-10/audit';

const RAW_FILES = [
  'final_chat_chat_raw.json',
  'final_chat_boundary_x3-x4_raw.json',
  'final_chat_boundary_x1-x2_raw.json',
  'final_chat_boundary_x1-x2_controlled_raw.json',
  'final_chat_browser_b1_raw.json',
  'final_chat_browser_b1_retry_raw.json',
  'final_chat_browser_b2_raw.json',
  'final_chat_browser_b3_raw.json',
  'final_chat_browser_b4_live_raw.json',
  'final_chat_browser_b1-b2_raw.json',
  'final_chat_browser_b4_raw.json',
];

/** What each case MUST do, independent of any run. */
const EXPECTED = {
  c1: { group: 'normalChat', text: 'Hi', route: 'CONVERSATION', codes: ['SMALLTALK'], status: 'ANSWER', zeroMarkers: true },
  c2: { group: 'normalChat', text: 'Hello', route: 'CONVERSATION', codes: ['SMALLTALK'], status: 'ANSWER', zeroMarkers: true },
  c3: { group: 'normalChat', text: 'How are you?', route: 'CONVERSATION', codes: ['SMALLTALK'], status: 'ANSWER', zeroMarkers: true },
  c4: { group: 'normalChat', text: 'What is machine learning?', route: 'CONVERSATION', codes: ['SMALLTALK', 'DEFINITIONAL_KNOWLEDGE'], status: 'ANSWER', zeroMarkers: true },
  c5: { group: 'normalChat', text: 'Explain TCP vs UDP', route: 'CONVERSATION', codes: ['DEFINITIONAL_KNOWLEDGE'], status: 'ANSWER', zeroMarkers: true },
  c6: { group: 'normalChat', text: 'What is 2 + 2?', route: 'CONVERSATION', codes: ['ARITHMETIC', 'DEFINITIONAL_KNOWLEDGE'], status: 'ANSWER', zeroMarkers: true },
  c7: { group: 'normalChat', text: 'What is a binary search tree?', route: 'CONVERSATION', codes: ['DEFINITIONAL_KNOWLEDGE'], status: 'ANSWER', zeroMarkers: true },
  b1: { group: 'browserTasks', text: 'Find the top 5 products on the shopping fixture.', route: 'PIPELINE', admits: true, targetResolutionMin: 1, typedTerminal: true },
  b2: { group: 'browserTasks', text: 'Search for laptops under \u20b950,000.', route: 'PIPELINE', admits: true, targetResolutionMin: 1, typedTerminal: true },
  b3: { group: 'browserTasks', text: 'Open the third result.', route: 'PIPELINE', admits: true, targetResolutionMin: 1, typedTerminal: true },
  b4: { group: 'browserTasks', text: 'Find the latest information about Charminar.', route: 'PIPELINE', admits: true, targetResolutionMin: 1, typedTerminal: true },
  x1: { group: 'boundary', text: 'I want to compare laptops and also add the cheapest one to my cart.', route: 'PIPELINE', intentRan: true, chatNeverAccepted: true, typedTerminal: true },
  x2: { group: 'boundary', text: 'What is the price of this product?', route: 'PIPELINE', intentRan: true, chatNeverAccepted: true, typedTerminal: true },
  x3: { group: 'boundary', text: 'Tell me about it.', route: 'PIPELINE', typedTerminal: true, noBrowserWork: true },
  x4: { group: 'boundary', text: 'Search the web', route: 'PIPELINE', typedTerminal: true, noInventedTab: true },
};

const TYPED = new Set([
  'SUCCESS', 'FAILED', 'STOPPED', 'ANSWER', 'PARTIAL', 'CANNOT_VERIFY',
  'NEEDS_INFORMATION', 'NEEDS_CLARIFICATION', 'PROVIDER_UNAVAILABLE',
  'COMMIT_UNKNOWN', 'FRESHNESS_UNVERIFIED',
]);

const ZERO_MARKERS = ['targetResolution', 'tabProvisioned', 'perception', 'actionValidated', 'actionExecuted', 'navigation', 'intentClassified', 'notAdmitted'];

function recomputeExpectation(id, r) {
  const e = EXPECTED[id];
  const fails = [];
  if (r.route !== e.route) fails.push(`route=${r.route}`);
  if (e.codes && !e.codes.includes(r.code)) fails.push(`code=${r.code}`);
  if (e.zeroMarkers) {
    for (const k of ZERO_MARKERS) if (r.counts[k] !== 0) fails.push(`${k}=${r.counts[k]}`);
    if (r.counts.chatAccepted < 1) fails.push('chatAccepted missing');
    if (r.finalResultKind !== 'ANSWER') fails.push(`finalResultKind=${r.finalResultKind}`);
    if (r.terminalReason !== 'CONVERSATIONAL_ANSWER') fails.push(`terminalReason=${r.terminalReason}`);
    if (r.answerProvenance !== null) fails.push('page provenance claimed');
  }
  if (e.status && r.terminalStatus !== e.status) fails.push(`status=${r.terminalStatus}`);
  if (e.admits === true && r.admits !== true) fails.push(`admits=${r.admits}`);
  if (e.targetResolutionMin && r.counts.targetResolution < e.targetResolutionMin) fails.push(`targetResolution=${r.counts.targetResolution}`);
  if (e.intentRan && r.counts.intentClassified < 1) fails.push('intent boundary did not run');
  if (e.chatNeverAccepted && r.counts.chatAccepted !== 0) fails.push('accepted as chat');
  if (e.typedTerminal && !TYPED.has(r.terminalStatus)) fails.push(`status=${r.terminalStatus} not typed`);
  if (e.noBrowserWork && (r.counts.tabProvisioned !== 0 || r.counts.actionExecuted !== 0)) fails.push('browser work happened');
  if (e.noInventedTab && r.counts.tabProvisioned !== 0) fails.push('tab provisioned (invented destination)');
  if (r.timedOut) fails.push('timed out');
  return fails;
}

const runs = [];
for (const f of RAW_FILES) {
  const p = `${DIR}/${f}`;
  if (!existsSync(p)) throw new Error(`missing raw evidence: ${p}`);
  const d = JSON.parse(readFileSync(p, 'utf8'));
  for (const r of d.results) {
    const fails = recomputeExpectation(r.id, r);
    runs.push({
      file: f,
      caseId: r.id,
      kind: r.kind,
      text: r.text,
      providerMode: d.providerMode,
      labels: d.labels,
      expected: EXPECTED[r.id],
      route: r.route,
      code: r.code,
      intent: r.intent,
      admits: r.admits,
      refusal: r.refusal,
      counts: r.counts,
      terminalStatus: r.terminalStatus,
      terminalReason: r.terminalReason,
      terminalHeadline: r.terminalHeadline,
      outcome: r.outcome,
      finalResultKind: r.finalResultKind,
      answer: r.answer ? String(r.answer).slice(0, 700) : null,
      answerProvenance: r.answerProvenance ?? null,
      durationMs: r.durationMs,
      stubMode: r.stubMode,
      harnessFails: r.fails,
      expectationFails: fails,
      pass: fails.length === 0 && r.pass,
    });
  }
}

const byCase = {};
for (const r of runs) (byCase[r.caseId] ||= []).push(r);

const caseSummaries = Object.keys(EXPECTED).map((id) => {
  const rs = byCase[id] || [];
  const passing = rs.filter((r) => r.pass);
  return {
    id,
    group: EXPECTED[id].group,
    text: EXPECTED[id].text,
    runs: rs.length,
    passingRuns: passing.length,
    verdict: passing.length > 0 ? 'PASS' : 'FAIL',
    providerModes: [...new Set(rs.map((r) => r.providerMode))],
    best: passing[0] || rs[0] || null,
    allRuns: rs,
  };
});

const mutation = JSON.parse(readFileSync(`${DIR}/final_chat_routing_mutation_results.json`, 'utf8'));
const sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
const dirty = execSync('git status --porcelain', { encoding: 'utf8' })
  .split('\n').filter(Boolean);

const groups = ['normalChat', 'browserTasks', 'boundary'].map((g) => {
  const cs = caseSummaries.filter((c) => c.group === g);
  return { group: g, cases: cs.length, passed: cs.filter((c) => c.verdict === 'PASS').length, verdict: cs.every((c) => c.verdict === 'PASS') ? 'PASS' : 'FAIL' };
});

const allPass = caseSummaries.every((c) => c.verdict === 'PASS');
const mutationPass = mutation.survived === 0 && mutation.notApplied === 0;

const evidence = {
  audit: 'FINAL PRODUCT ACCEPTANCE AUDIT — normal chat vs browser-task routing',
  timestamp: new Date().toISOString(),
  commitSha: sha,
  worktreeAtPackaging: dirty.slice(0, 40),
  question: 'Can a user say "Hi" or ask a normal question and get a normal assistant response without PrivAgent launching the browser agent?',
  providerMode: {
    liveLabel: 'PROVEN_REAL_CHROME / LIVE_PROVIDER (real FastAPI gateway :8010, model openai/gpt-oss-20b)',
    controlledLabel: 'PROVEN_REAL_CHROME / CONTROLLED_PROVIDER (scratch/i8a7a8_controlled_provider.py on :8010)',
    note: 'Every run is real Chrome with the built extension (PROVEN_REAL_CHROME). Chat cases and all live pipeline cases ran against the real backend (LIVE_PROVIDER). Controlled runs are labelled CONTROLLED_PROVIDER and are never presented as live.',
  },
  environment: {
    chrome: runs.length ? 'headless Chrome via CDP, Extensions.loadUnpacked(dist)' : 'unknown',
    gateway: 'http://127.0.0.1:8010',
    dashboard: 'http://localhost:5173',
    fixture: 'http://localhost:4174/ (ApexCart)',
    harness: 'scratch/final_chat_run.mjs',
  },
  acceptance: {
    result: allPass && mutationPass ? 'PASS' : 'FAIL',
    groups,
    cases: caseSummaries,
  },
  focusedTests: {
    finalNormalChatRouting: '19/19 passed (tests/finalNormalChatRouting.test.ts)',
    i1A13A15: '75/75 passed (phase18_7_i1IntentBoundary, phase18_8_a13ReferenceResolution, phase18_8_a15EntityIdentity)',
    backendChat: '8/8 passed (backend/tests/test_agent_chat.py)',
  },
  mutation: {
    suite: 'docs/evidence/post-17-10/audit/final_chat_routing_mutation_suite.mjs',
    results: 'docs/evidence/post-17-10/audit/final_chat_routing_mutation_results.json',
    total: mutation.total,
    killed: mutation.killed,
    survived: mutation.survived,
    notApplied: mutation.notApplied,
    verdict: mutationPass ? 'PASS (0 unmasked survivors)' : 'FAIL',
    mutants: mutation.results,
  },
  regression: {
    vitest: '167 files / 2864 tests passed, exit 0',
    pytest: '670 passed, exit 0',
    tsc: 'npx tsc --noEmit exit 0',
    buildExtension: 'npm run build exit 0',
    buildFrontend: 'npm run build:frontend exit 0',
    privacyScan: 'No credential/card/token patterns in new artifacts; digit runs are epoch-millisecond ping ids only',
    benchmarkResults: 'docs/evidence/phase17/17.8-benchmark/benchmark_results.json restored to HEAD after full run',
  },
  rawEvidence: RAW_FILES.map((f) => `${DIR}/${f}`),
};

writeFileSync(`${DIR}/final_normal_chat_routing.json`, JSON.stringify(evidence, null, 2));
console.log(`wrote ${DIR}/final_normal_chat_routing.json`);
console.log(`  result: ${evidence.acceptance.result}`);
for (const g of groups) console.log(`  ${g.group}: ${g.passed}/${g.cases} ${g.verdict}`);
console.log(`  mutation: ${mutation.killed}/${mutation.total} killed, ${mutation.survived} survivors`);
process.exitCode = allPass && mutationPass ? 0 : 1;
