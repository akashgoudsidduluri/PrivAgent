/**
 * PHASE 18.6 / A10 — §14 REAL-WEB MATRIX DRIVER.
 *
 * Records ONE §14 scenario per run, in REAL Chrome, against the REAL built
 * extension and the REAL dashboard, and turns what was observed into a
 * `A10ScenarioRecord` (the schema `extension/src/telemetry/a10MatrixHarness.ts`
 * grades). It is a RECORDER, not a judge: every field it writes is read out of the
 * run's own service-worker/dashboard logs or its network traffic, and the grading
 * rule lives in the TypeScript harness so it cannot be relaxed from here.
 *
 * PROVIDER HONESTY
 *   The artifact says which gateway answered :8010 for that run. A run against
 *   `scratch/i8a7a8_controlled_provider.py` is labelled CONTROLLED_PROVIDER and
 *   is never presented as a live-model result. The live rows additionally need a
 *   real cloud reasoner and free network egress; when those are absent the run
 *   still produces a truthful record (e.g. PROVIDER_UNAVAILABLE) rather than a
 *   fabricated one.
 *
 * USAGE
 *   node scratch/a10_matrix_run.mjs --list                 # the §14 recipes
 *   node scratch/a10_matrix_run.mjs --execute S9,S10       # run those rows
 *   node scratch/a10_matrix_run.mjs --record S9,S10        # re-record from the
 *                                                          # already-copied raw
 *                                                          # artifact, no browser
 *   node scratch/a10_matrix_run.mjs --execute all
 *
 *   Then grade what was recorded:
 *     npx vite-node scratch/a10_matrix_grade.ts
 *
 * ENV
 *   A10_MATRIX_OUT   output dir (default docs/evidence/post-17-10/audit/a10_18_6)
 *   A10_GATEWAY      gateway base URL (default http://127.0.0.1:8010)
 *   A10_RESTORE_MODE stub mode to restore afterwards (default reads it first)
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { spawnSync } from 'child_process';

const ROOT = process.cwd();
const OUT_DIR = process.env.A10_MATRIX_OUT || 'docs/evidence/post-17-10/audit/a10_18_6';
const RAW_DIR = path.join(ROOT, 'docs', 'evidence', 'post-17-10', 'audit');
const GATEWAY = process.env.A10_GATEWAY || 'http://127.0.0.1:8010';

/* ─────────────────────────────────────────────────────────────────────────────
 * §14 recipes. `provider: LIVE` means the row needs the real reasoner gateway;
 * `CONTROLLED` means the scripted stub is sufficient to exercise the mechanism.
 * ──────────────────────────────────────────────────────────────────────────── */
const FIXTURE = 'http://127.0.0.1:4174';
const BANKING = 'http://127.0.0.1:4175';

const RECIPES = {
  S1: {
    number: 1,
    title: 'Wikipedia information lookup',
    provider: 'LIVE',
    //
    // The task MUST carry the page requirement. "tell me about charminar" is
    // routed CONVERSATION / DEFINITIONAL_KNOWLEDGE by the product, answered from
    // the model with 0 tabs, 0 actions and an empty ledger — so it measures the
    // conversation route, not "an end-to-end information task" (§14 row 1). The
    // first S1 run did exactly that, which is finding F5 in the report.
    //
    task: 'open wikipedia and tell me about charminar',
    startUrl: 'https://en.wikipedia.org/wiki/Charminar',
    settleMs: 75000,
  },
  S2: {
    number: 2,
    title: 'Search → result → information',
    provider: 'LIVE',
    // PHASE 18.8 / A10 — the row is authored for a LIVE provider. Until the
    // FastAPI gateway owns :8010 again, it is executed with
    // `A10_PROVIDER=CONTROLLED A10_STUB_MODE=act_then_answer`, and the record
    // then says CONTROLLED_PROVIDER. Never relabel such a run as live.
    stubMode: 'act_then_answer',
    task: 'search for cats on wikipedia',
    startUrl: 'https://en.wikipedia.org/wiki/Main_Page',
    settleMs: 60000,
  },
  S3: {
    number: 3,
    title: 'Multi-page information',
    provider: 'LIVE',
    // Executed as CONTROLLED_PROVIDER while :8010 is the controlled stub (see S2).
    stubMode: 'act_then_answer',
    task: 'open wikipedia and find information about charminar',
    startUrl: `${FIXTURE}/index.html`,
    settleMs: 60000,
  },
  S4: {
    number: 4,
    title: 'Information requiring scrolling',
    provider: 'CONTROLLED',
    // PHASE 18.8 / A10 — RECIPE CORRECTION (was `scroll_down`).
    //
    // The row asks whether the agent scrolled to reveal content and then
    // reported what it could support. `scroll_down` proposes an ACTION for every
    // cycle and NEVER a terminal state, so the run could only ever end on a
    // bound — it measured bound exhaustion, not this row. `act_then_answer`
    // reproduces the shape the row describes: gather by scrolling, then propose
    // a terminal backed by the ledger.
    stubMode: 'act_then_answer',
    task: 'scroll down to find more products',
    startUrl: `${FIXTURE}/lazy-scroll.html`,
    settleMs: 70000,
  },
  S5: {
    number: 5,
    title: 'Missing information',
    provider: 'LIVE',
    // Executed as CONTROLLED_PROVIDER while :8010 is the controlled stub (see S2).
    stubMode: 'act_then_answer',
    task: 'what is the warranty period of the golden necklace shown on this page',
    startUrl: `${FIXTURE}/index.html`,
    settleMs: 60000,
  },
  S6: {
    number: 6,
    title: 'Stale evidence',
    provider: 'CONTROLLED',
    stubMode: 'freshness_demo',
    task: 'click the product link and tell me the price on the page you land on',
    startUrl: `${FIXTURE}/freshness.html`,
    settleMs: 70000,
  },
  S7: {
    number: 7,
    title: 'Sensitive-data page',
    provider: 'CONTROLLED',
    // PHASE 18.8 / A10 — RECIPE CORRECTION (was `scroll_down`): see S4. A mode
    // that can never propose a terminal cannot measure what this row asserts;
    // the privacy property is measured on the delivered artifact either way.
    stubMode: 'act_then_answer',
    // Must be a task the I-1 intent boundary ADMITS, or the run never reaches the
    // page: "scroll down through the account page" is refused as a bare phrase and
    // produced NEEDS_CLARIFICATION with zero perception of the sensitive fixture.
    task: 'find the account balance shown on this page',
    startUrl: `${BANKING}/`,
    settleMs: 60000,
  },
  S8: {
    number: 8,
    title: 'Navigation + information',
    provider: 'LIVE',
    // Executed as CONTROLLED_PROVIDER while :8010 is the controlled stub (see S2).
    stubMode: 'act_then_answer',
    task: 'open wikipedia and tell me about charminar',
    startUrl: `${FIXTURE}/index.html`,
    settleMs: 60000,
  },
  S9: {
    number: 9,
    title: 'Ambiguous request',
    provider: 'CONTROLLED',
    stubMode: null,
    task: 'Open it.',
    startUrl: `${FIXTURE}/index.html`,
    settleMs: 30000,
  },
  S10: {
    number: 10,
    title: 'Provider failure',
    provider: 'CONTROLLED',
    stubMode: 'server_503',
    task: 'open the shopping site and find the winter jackets',
    startUrl: `${FIXTURE}/index.html`,
    settleMs: 55000,
  },
};

const IDS = Object.keys(RECIPES);
const CDP_BASE = Number(process.env.A10_CDP_BASE || 9870);

/* ─────────────────────────────────────────────────────────────────────────────
 * helpers
 * ──────────────────────────────────────────────────────────────────────────── */

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let raw = '';
      res.on('data', (d) => (raw += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve({ raw });
        }
      });
    });
    req.on('error', reject);
  });
}

function jsonFrom(text) {
  const i = String(text).indexOf('{');
  if (i < 0) return null;
  try {
    return JSON.parse(String(text).slice(i));
  } catch {
    return null;
  }
}

/** Every service-worker log line carrying `literal`, with its payload parsed. */
function payloads(swLogs, literal) {
  const out = [];
  for (const l of swLogs) {
    const text = String(l.text || '');
    const at = text.indexOf(literal);
    if (at < 0) continue;
    const parsed = jsonFrom(text.slice(at + literal.length));
    if (parsed) out.push({ t: l.t, p: parsed });
  }
  return out;
}

const lastOf = (arr) => (arr.length ? arr[arr.length - 1] : null);
const countMatching = (swLogs, re) => swLogs.filter((l) => re.test(String(l.text || ''))).length;

/* ─────────────────────────────────────────────────────────────────────────────
 * extraction — artifact → §14 record
 * ──────────────────────────────────────────────────────────────────────────── */

function extract(id, recipe, raw, rawRelPath, stubModeObserved) {
  const swLogs = raw.swLogs || [];
  const timeline = raw.timeline || [];
  const apiRequests = (raw.network || []).filter(
    (n) => n.kind === 'request' && String(n.url || '').includes('/api/v1/'),
  );

  const intent = lastOf(payloads(swLogs, 'intent classified'));
  const terminalProposals = payloads(swLogs, 'terminal proposal received');
  const terminalEvent = lastOf(payloads(swLogs, 'terminal progress emitted'));
  const forwarded = lastOf(payloads(swLogs, 'response forwarded'));
  const goalVerified = payloads(swLogs, 'goal verification satisfied');
  const screens = payloads(swLogs, 'output screen');
  const ledgerLogs = payloads(swLogs, 'evidence ledger updated');
  const ledger = lastOf(ledgerLogs);
  const understanding = payloads(swLogs, 'semantic understanding complete');
  const unavailable = lastOf(payloads(swLogs, 'reasoning provider unavailable'));

  const timelineTerminal = [...timeline].reverse().find((p) => p.phase === 'TERMINAL');
  const terminalStatus =
    (terminalEvent && terminalEvent.p.status) ||
    (forwarded && forwarded.p.status) ||
    (timelineTerminal && timelineTerminal.status) ||
    null;

  const dispatched = swLogs.filter((l) => /ACTION_EXECUTED \+ [A-Z_]+/.test(String(l.text || ''))).map((l) => ({
    t: l.t,
    outcome: (String(l.text).match(/ACTION_EXECUTED \+ ([A-Z_]+)/) || [])[1],
  }));
  const effectVerifiedCount = dispatched.filter((d) => d.outcome === 'EFFECT_VERIFIED').length;
  const effectNoEffectCount = dispatched.filter((d) => d.outcome === 'ACTION_NO_EFFECT').length;
  const effectUnverifiableCount =
    dispatched.filter((d) => d.outcome === 'EFFECT_UNVERIFIABLE').length +
    countMatching(swLogs, /could not be observed on both sides of the action/);
  const containmentBlocked = countMatching(swLogs, /ACTION_EXECUTED_BLOCKED_BY_CONTAINMENT/);

  const ownershipLossTimes = swLogs
    .filter((l) => /run ownership lost — stopping without dispatch/.test(String(l.text || '')))
    .map((l) => l.t);
  const lastOwnershipLoss = ownershipLossTimes.length ? Math.max(...ownershipLossTimes) : null;
  const lateActionCount =
    lastOwnershipLoss === null ? 0 : dispatched.filter((d) => d.t > lastOwnershipLoss).length;

  const outputScreenFindings = screens.reduce((sum, s) => {
    const m = /\((\d+) finding/.exec(String(s.p.audit || ''));
    return sum + (m ? Number(m[1]) : 0);
  }, 0);
  const privacyRejections = countMatching(swLogs, /Privacy policy rejected action/);
  const lastScreen = lastOf(screens);
  const privacyClean =
    lastScreen !== null && lastScreen.p.verdict === 'CLEAR' && outputScreenFindings === 0 && privacyRejections === 0;

  const generations = understanding
    .map((u) => u.p.pageGeneration)
    .filter((g) => typeof g === 'number');
  const pageGenerations = generations.length ? Math.max(...generations) : undefined;

  //
  // Did this run engage a page at all? A perception cycle that names the URL it
  // perceived, an ingested ledger, or an observed page generation each prove it;
  // a run with none of them (e.g. one answered by the conversation route) never
  // touched a page, and a browser-required row cannot be certified from it.
  //
  const perceivedUrl = payloads(swLogs, 'perception complete').some(
    (p) => typeof p.p.contextUrl === 'string' && p.p.contextUrl.length > 0,
  );
  const pageEngaged = perceivedUrl || ledgerLogs.length > 0 || (pageGenerations ?? 0) > 0;

  const timelineUrls = timeline.map((p) => p.currentUrl).filter((u) => typeof u === 'string' && u.length > 0);
  const distinctUrls = new Set(timelineUrls).size;

  const scrollProposals = apiRequests.filter((n) => n.action === 'scroll').length;
  // PHASE 18.8 / A10-F5 — who actually answered: read from the responses.
  const providerEvidence = [
    ...new Set(
      apiRequests
        .map((n) => n.telemetry && n.telemetry.provider)
        .filter((p) => typeof p === 'string' && p.length > 0),
    ),
  ].map((p) => `response-telemetry=${p}`);
  const scrollExhausted = countMatching(swLogs, /I-8 scroll strategy exhausted/);
  const refusedScrolls = countMatching(swLogs, /refused an exhausted-strategy scroll/);
  const boundsExhausted =
    /bounds exhausted/i.test(String((forwarded && forwarded.p.reason) || '')) ||
    countMatching(swLogs, /Long-horizon bounds exhausted/) > 0;

  const requiresDestination = intent ? intent.p.requiresDestination === true : false;
  const destinationVerified =
    countMatching(swLogs, /destination already satisfied — no transition needed/) > 0 ||
    countMatching(swLogs, /POST_NAVIGATION_URL_VERIFY/) > 0;

  //
  // PROVIDER LABEL FROM THE RUN, NOT FROM THE RECIPE.
  //
  // The proof level is what the run actually used, and it is stamped into the raw
  // artifact's header at run time. Reading it back here means re-recording a run
  // (no browser) can never upgrade a CONTROLLED run to a live one, or the reverse.
  //
  const rawLabels = typeof raw.labels === 'string' ? raw.labels : '';
  const providerFromRun = /CONTROLLED/i.test(rawLabels)
    ? 'CONTROLLED'
    : /REAL_BACKEND|LIVE/i.test(rawLabels)
      ? 'LIVE'
      : null;
  const stubModeFromRun = /stub_mode=([a-z0-9_]+)/i.exec(rawLabels);

  const executed = terminalStatus !== null;
  const proofLevel = providerFromRun ?? recipe.provider;
  const providerMode = executed
    ? proofLevel === 'LIVE'
      ? 'LIVE_PROVIDER'
      : 'CONTROLLED_PROVIDER'
    : 'NOT_RUN';

  //
  // PHASE 18.6 / A10-F3 — WHAT DID THE ANSWER CITE?
  //
  // Two independent paths can put verified ledger records behind a terminal, and
  // each already reports a count (never the claims):
  //   * an accepted terminal proposal logs `supportedRecords` — citations that
  //     resolved, were verified/current, and matched the task subject;
  //   * the GoalVerifier path logs `composedVerifiedRecords` for the answer it
  //     composed from the ledger.
  // Nothing is inferred: if neither count is present the record carries no
  // citation at all, and the row is graded as uncited rather than credited on
  // the strength of its prose.
  //
  const claimTerminals = new Set(['ANSWER', 'PARTIAL', 'SUCCESS']);
  const acceptedProposal = terminalProposals
    .filter((p) => p.p && p.p.status === terminalStatus && typeof p.p.supportedRecords === 'number')
    .pop();
  const composedLog = payloads(swLogs, 'goal verification satisfied')
    .filter((p) => typeof p.p.composedVerifiedRecords === 'number')
    .pop();
  let citation = null;
  //
  // PHASE 18.8 / A10-F3 — the record IDS an accepted terminal was supported by.
  // These are deterministic ledger hashes (`hash(sourceUrl|generation|key)`),
  // never claim text, and they are only present on runs recorded after the
  // instrument landed; absence means "not observable", not "zero".
  //
  let citedEvidenceIds = [];
  let rejectedCodes = [];
  if (claimTerminals.has(terminalStatus)) {
    if (acceptedProposal) {
      citation = {
        citedEvidenceRefs: acceptedProposal.p.supportedRecords,
        citationSource:
          'AgentTrace terminal proposal received {supportedRecords} for the accepted terminal',
      };
      if (Array.isArray(acceptedProposal.p.supportedRecordIds)) {
        citedEvidenceIds = acceptedProposal.p.supportedRecordIds.filter((x) => typeof x === 'string');
      }
      if (Array.isArray(acceptedProposal.p.rejected)) {
        rejectedCodes = acceptedProposal.p.rejected.filter((x) => typeof x === 'string');
      }
      if (rejectedCodes.length) {
        citation.rejectionCodes = rejectedCodes;
      }
    } else if (composedLog) {
      citation = {
        citedEvidenceRefs: composedLog.p.composedVerifiedRecords,
        citationSource: 'AgentTrace goal verification satisfied {composedVerifiedRecords}',
      };
    }
  }

  const notes = [
    `§14 row ${recipe.number} — ${recipe.title}.`,
    `provider=${providerFromRun ?? recipe.provider}${stubModeObserved || stubModeFromRun ? ` stub_mode=${stubModeFromRun ? stubModeFromRun[1] : stubModeObserved}` : ''}; api_requests=${apiRequests.length}.`,
    //
    // PHASE 18.8 / A10-F5 — PROVIDER MODE FROM THE OBSERVED RESPONSE TELEMETRY,
    // not from the recipe. The gateway (live) and the controlled stub both stamp
    // the provider that actually answered this run (`groq` / `openrouter` vs
    // `controlled_stub`), so the artifact can prove the mode independently of the
    // label. Empty means the run made no provider call at all (e.g. §14 row 9).
    //
    `provider_evidence=${providerEvidence.length ? providerEvidence.join(',') : 'none (no provider call in this run)'}.`,
    `observables: intent=${intent ? 'yes' : 'no'} terminal=${terminalEvent ? 'yes' : 'no'} forwarded=${forwarded ? 'yes' : 'no'} output_screen=${screens.length} ledger_updates=${ledgerLogs.length} long_horizon=${payloads(swLogs, 'long-horizon update').length}`,
    `citation=${citation ? `${citation.citedEvidenceRefs} record(s) via ${citation.citationSource}` : 'none observed'}${rejectedCodes.length ? ` rejected=${rejectedCodes.join('+')}` : ''}; citedEvidenceIds=${citedEvidenceIds.length} (record ids are deterministic ledger hashes; a run recorded before the F3 instrument reports 0 ids even when a count is present).`,
    'privacySelfCheck is the execution-side self-check: last output-screen verdict + privacy-policy rejections. Controlled runs bypass the FastAPI gateway, so no independent model-facing capture exists for them; the artifact-level scan is independent of this field.',
    `scrolls proposed=${scrollProposals} strategy_exhausted=${scrollExhausted} refused_after_exhaustion=${refusedScrolls}.`,
    `distinctUrls=${distinctUrls} is the distinct non-null timeline URL count (the ledger log carries no URL).`,
    `pageEngaged=${pageEngaged} (perceivedUrl=${perceivedUrl}, ledgerUpdates=${ledgerLogs.length}, generations=${pageGenerations ?? 0}).`,
    raw.inputs && raw.inputs.startUrl ? `startUrl=${raw.inputs.startUrl}.` : 'no startUrl.',
  ].join(' ');

  return {
    scenarioId: id,
    number: recipe.number,
    task: recipe.task,
    providerMode,
    environmentBlocked: !executed,
    executed,
    terminalStatus: terminalStatus || 'FAILED',
    goalStatus: goalVerified.length ? 'SATISFIED' : executed ? 'NOT_SATISFIED' : 'UNKNOWN',
    actionCount: dispatched.length + containmentBlocked,
    dispatchCount: dispatched.length,
    lateActionCount,
    effectVerifiedCount,
    effectNoEffectCount,
    effectUnverifiableCount,
    destinationStatus: !requiresDestination ? 'NOT_APPLICABLE' : destinationVerified ? 'VERIFIED' : 'UNVERIFIED',
    evidenceLedgerCount: ledger ? ledger.p.ledgerSize : 0,
    evidenceLedgerVerifiedCurrentCount: ledger ? ledger.p.verifiedCurrent : 0,
    citedEvidenceIds,
    // Every reasoning request this run made (action/chat/review), including the
    // ones the provider refused. §14 row 9 requires this to be exactly zero.
    providerCallCount: apiRequests.length,
    ...(citation ?? {}),
    privacySelfCheck: {
      clean: privacyClean,
      rawValueFindings: outputScreenFindings + privacyRejections,
      scannerLines: screens.length,
    },
    artifactPath: rawRelPath,
    notes,
    ...(pageGenerations === undefined ? {} : { pageGenerations }),
    ...(pageEngaged ? { pageEngaged: true } : {}),
    distinctUrls,
    ...(scrollProposals || scrollExhausted || refusedScrolls ? { scrollCount: Math.max(scrollProposals, dispatched.length) } : {}),
    ...(boundsExhausted ? { boundsExhausted: true } : {}),
    ...(unavailable ? { providerFailure: unavailable.p } : {}),
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * execution
 * ──────────────────────────────────────────────────────────────────────────── */

async function setStubMode(mode) {
  if (!mode) return;
  const res = await httpGet(`${GATEWAY}/mode?set=${encodeURIComponent(mode)}`);
  if (!res || res.success !== true) throw new Error(`stub mode switch failed: ${JSON.stringify(res)}`);
  console.log(`[a10] stub mode -> ${res.stub_mode}`);
}

async function readStubMode() {
  try {
    const res = await httpGet(`${GATEWAY}/mode`);
    return res && res.stub_mode ? res.stub_mode : null;
  } catch {
    return null;
  }
}

function executeOne(id, index, recipe) {
  const outName = `_a10_matrix_${id}_raw.json`;
  console.log(`\n[a10] ${id} row ${recipe.number} — ${recipe.title} (${recipe.provider})`);
  const res = spawnSync(process.execPath, ['scratch/p185_real_run.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: recipe.settleMs + 120000,    env: {
        ...process.env,
        ST_TASK: recipe.task,
        ST_START_URL: recipe.startUrl,
        ST_SETTLE_MS: String(recipe.settleMs),
        ST_OUT: outName,
        ST_CDP_PORT: String(CDP_BASE + index),
      ST_PHASE: '18.6-A10',
      ST_WORK: `A10 §14 row ${recipe.number} — ${recipe.title}`,
      ST_LABELS:
        recipe.provider === 'LIVE'
          ? 'PROVEN_REAL_CHROME / REAL_BACKEND_GATEWAY'
          : `PROVEN_REAL_CHROME / CONTROLLED_PROVIDER${recipe.stubMode ? ` (stub_mode=${recipe.stubMode})` : ''}`,
    },
  });
  const tail = String(res.stdout || '')
    .trim()
    .split('\n')
    .slice(-3)
    .join(' | ');
  console.log(`[a10] ${id} harness exit=${res.status}${res.error ? ` error=${res.error.message}` : ''}`);
  if (tail) console.log(`[a10] ${id} tail: ${tail.slice(0, 300)}`);

  const tempPath = path.join(RAW_DIR, outName);
  if (!fs.existsSync(tempPath)) throw new Error(`${id}: no raw artifact at ${tempPath}`);
  fs.mkdirSync(path.join(ROOT, OUT_DIR), { recursive: true });
  const rawRelPath = path.join(OUT_DIR, `raw_${id}.json`);
  fs.copyFileSync(tempPath, path.join(ROOT, rawRelPath));
  fs.unlinkSync(tempPath);
  return { raw: JSON.parse(fs.readFileSync(path.join(ROOT, rawRelPath), 'utf8')), rawRelPath };
}

/**
 * A run may be pointed at the controlled provider explicitly — e.g. to measure a
 * LIVE row's mechanism before a cloud reasoner is reachable. The override is
 * recorded on the record (providerMode + notes), never hidden, and a CONTROLLED
 * record is never presented as a live-model result.
 */
function effectiveRecipe(id) {
  const override = process.env.A10_PROVIDER || null;
  const stubMode = process.env.A10_STUB_MODE;
  return {
    ...RECIPES[id],
    ...(override ? { provider: override } : {}),
    ...(stubMode === undefined ? {} : { stubMode: stubMode === '' ? null : stubMode }),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--list') || argv.length === 0) {
    console.log('§14 A10 matrix recipes:');
    for (const id of IDS) {
      const r = RECIPES[id];
      console.log(
        `  ${id.padEnd(3)} row ${String(r.number).padStart(2)} | ${r.provider.padEnd(10)} | ` +
          `${(r.stubMode || '-').padEnd(16)} | ${r.task}`,
      );
    }
    if (argv.length === 0) {
      console.log('\nRun: node scratch/a10_matrix_run.mjs --execute S9,S10');
      console.log('Then: npx vite-node scratch/a10_matrix_grade.ts');
    }
    return;
  }

  const mode = argv.includes('--execute') ? 'execute' : argv.includes('--record') ? 'record' : null;
  if (!mode) {
    console.error(`unknown arguments: ${argv.join(' ')}`);
    process.exit(2);
  }
  const flag = argv.indexOf(`--${mode}`);
  const requested = argv[flag + 1] === 'all' ? IDS : String(argv[flag + 1] || '').split(',').filter(Boolean);
  for (const id of requested) {
    if (!RECIPES[id]) {
      console.error(`unknown scenario id ${id}`);
      process.exit(2);
    }
  }

  fs.mkdirSync(path.join(ROOT, OUT_DIR), { recursive: true });

  if (mode === 'record') {
    for (const id of requested) {
      const rawRelPath = path.join(OUT_DIR, `raw_${id}.json`);
      const abs = path.join(ROOT, rawRelPath);
      if (!fs.existsSync(abs)) {
        console.error(`[a10] ${id}: no recorded raw artifact at ${rawRelPath}`);
        process.exit(1);
      }
      const record = extract(id, effectiveRecipe(id), JSON.parse(fs.readFileSync(abs, 'utf8')), rawRelPath, effectiveRecipe(id).stubMode);
      fs.writeFileSync(path.join(ROOT, OUT_DIR, `${id}.record.json`), JSON.stringify(record, null, 2));
      console.log(
        `[a10] ${id} re-recorded from ${rawRelPath}: executed=${record.executed} terminal=${record.terminalStatus} ` +
          `evidence=${record.evidenceLedgerVerifiedCurrentCount}/${record.evidenceLedgerCount} privacy_clean=${record.privacySelfCheck.clean}`,
      );
    }
    return;
  }

  const originalMode = await readStubMode();
  console.log(`[a10] gateway ${GATEWAY} stub mode before: ${originalMode}`);

  try {
    for (const [index, id] of requested.entries()) {
      const recipe = effectiveRecipe(id);
      await setStubMode(recipe.stubMode);
      const { raw, rawRelPath } = executeOne(id, index, recipe);
      const record = extract(id, recipe, raw, rawRelPath, recipe.stubMode);
      const recordPath = path.join(ROOT, OUT_DIR, `${id}.record.json`);
      fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
      console.log(
        `[a10] ${id} recorded: executed=${record.executed} terminal=${record.terminalStatus} ` +
          `providers=${record.providerMode} actions=${record.actionCount} evidence=${record.evidenceLedgerVerifiedCurrentCount}/${record.evidenceLedgerCount} ` +
          `privacy_clean=${record.privacySelfCheck.clean}`,
      );
      console.log(`[a10] ${id} record written to ${path.relative(ROOT, recordPath)}`);
    }
  } finally {
    if (process.env.A10_KEEP_STUB_MODE !== '1' && originalMode) {
      await setStubMode(originalMode);
      console.log(`[a10] stub mode restored to ${originalMode}`);
    }
  }
}

main().catch((err) => {
  console.error('[a10] FATAL', err && err.stack ? err.stack : String(err));
  process.exit(1);
});
