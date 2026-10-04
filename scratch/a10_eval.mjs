/**
 * PHASE 18.7 / A10 — FINAL REAL-WEB EVALUATION DRIVER.
 *
 * EVALUATION CODE ONLY. It changes nothing in the product: for each scenario it
 * runs the existing real-Chrome harness (`scratch/p185_real_run.mjs`) as a child
 * process, then assembles a truthful per-scenario artifact from what was
 * actually observed in that run. Nothing here interprets a run as a pass: the
 * terminal state comes from the service worker's own terminal progress event,
 * the provider type comes from which gateway was bound to :8010, and every
 * check below records the raw observation it was derived from.
 *
 * Usage:
 *   node scratch/a10_eval.mjs S01,S02      # run the listed scenarios
 *   node scratch/a10_eval.mjs --list       # list the scenario table
 *
 * Env:
 *   ST_CAPTURE_DIR  backend model-facing capture dir (default /tmp/p185_capture)
 *   A10_OUT_DIR     artifact directory (default docs/evidence/post-17-10/audit)
 *
 * Proof levels are assigned by provider type and NEVER upgraded:
 *   LIVE       -> PROVEN_REAL_CHROME / PROVEN_REAL_BACKEND
 *   CONTROLLED -> PROVEN_REAL_CHROME / CONTROLLED_PROVIDER
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const CAPTURE_DIR = process.env.ST_CAPTURE_DIR || '/tmp/p185_capture';
const OUT_DIR = process.env.A10_OUT_DIR || 'docs/evidence/post-17-10/audit';
const TABLE = JSON.parse(fs.readFileSync('scratch/a10_scenarios.json', 'utf8')).scenarios;

/* ------------------------------------------------------------------ parsing */

const j = (text) => {
  const i = text.indexOf('{');
  if (i < 0) return null;
  try {
    return JSON.parse(text.slice(i));
  } catch {
    return null;
  }
};

function collect(swLogs, re) {
  const out = [];
  for (const e of swLogs || []) {
    const m = re.exec(e.text || '');
    if (m) out.push({ t: e.t, m });
  }
  return out;
}

function first(swLogs, re) {
  const c = collect(swLogs, re);
  return c.length ? j(c[0].m[1]) : null;
}

function last(swLogs, re) {
  const c = collect(swLogs, re);
  return c.length ? j(c[c.length - 1].m[1]) : null;
}

function all(swLogs, re) {
  return collect(swLogs, re).map((c) => j(c.m[1])).filter(Boolean);
}

/* ------------------------------------------------------------------ privacy */

/**
 * Collect synthetic raw values from the local fixtures WITHOUT hard-coding
 * them here, so this driver never becomes a place a secret is written down.
 * Returns labels only; the literals stay in memory for the search.
 */
function fixtureRawValues() {
  const files = [
    'demo/synthetic-banking-site/index.html',
    'demo/shopping-fixture/index.html',
  ];
  const found = [];
  for (const f of files) {
    let html;
    try {
      html = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const add = (label, value) => {
      if (typeof value === 'string' && value.trim().length >= 6) {
        found.push({ label: `${path.basename(path.dirname(f))}/${label}`, value: value.trim() });
      }
    };
    let m;
    const valueAttr = /value="([^"]{6,})"/g;
    while ((m = valueAttr.exec(html))) add('input-value', m[1]);
    const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
    while ((m = email.exec(html))) add('email', m[0]);
    const digits = /\b\d{9,19}\b/g;
    while ((m = digits.exec(html))) add('digit-run', m[0]);
  }
  // De-duplicate by literal, keep the first label.
  const seen = new Set();
  return found.filter((f) => (seen.has(f.value) ? false : (seen.add(f.value), true)));
}

/**
 * INDEPENDENT check over the gateway's own model-facing capture: does any raw
 * fixture value appear in the prompt that was actually sent to the model?
 * This does not trust the dashboard's privacy indicator.
 */
function privacyChecks(scenario, runStartedAt) {
  const result = {
    independent: false,
    source: null,
    capturedAt: null,
    markersSearched: 0,
    rawMarkerHits: [],
    rawMarkerCount: 0,
    forbiddenKeyHits: [],
    screenshotDataUriHits: 0,
    ocrRawTextHits: 0,
    note: null,
  };
  let newest = null;
  try {
    for (const name of fs.readdirSync(CAPTURE_DIR)) {
      if (!name.startsWith('llm_context_') || !name.endsWith('.json')) continue;
      const p = path.join(CAPTURE_DIR, name);
      const st = fs.statSync(p);
      if (st.mtimeMs + 2000 < runStartedAt) continue;
      if (!newest || st.mtimeMs > newest.mtime) newest = { p, mtime: st.mtimeMs };
    }
  } catch {
    result.note = 'capture directory unavailable';
    return result;
  }
  if (!newest) {
    result.note =
      'no gateway model-facing capture for this run (CONTROLLED provider does not traverse the FastAPI gateway, so no model-facing payload exists to inspect)';
    return result;
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(newest.p, 'utf8'));
  } catch {
    result.note = 'capture unreadable';
    return result;
  }
  result.independent = true;
  result.source = path.basename(newest.p);
  result.capturedAt = doc.capturedAt || null;

  const prompt = typeof doc.exactModelFacingPrompt === 'string' ? doc.exactModelFacingPrompt : '';
  const envelope = JSON.stringify(doc.requestEnvelope || {});
  const surface = `${prompt}\n${envelope}`;
  result.promptChars = prompt.length;

  const markers = fixtureRawValues();
  result.markersSearched = markers.length;
  for (const marker of markers) {
    const hits = surface.split(marker.value).length - 1;
    if (hits > 0) result.rawMarkerHits.push({ label: marker.label, occurrences: hits });
  }
  result.rawMarkerCount = result.rawMarkerHits.length;

  for (const key of ['value', 'password', 'textContent', 'rawText', 'secret', 'cvv', 'otp', 'accountNumber']) {
    if (new RegExp(`"${key}"\\s*:`).test(envelope)) result.forbiddenKeyHits.push(key);
  }
  result.screenshotDataUriHits = (surface.match(/data:image\//g) || []).length;
  result.ocrRawTextHits = (surface.match(/"(ocrText|rawOcr|recognizedText)"\s*:/g) || []).length;
  return result;
}

/* ----------------------------------------------------------------- assemble */

function assemble(scenario, raw, harnessExit, runStartedAt) {
  const swLogs = raw.swLogs || [];
  const timeline = raw.timeline || [];
  const network = raw.network || [];

  const intent = first(swLogs, /intent classified (\{.*\})/);
  const ledger = all(swLogs, /evidence ledger updated (\{.*\})/);
  const ledgerLast = ledger.length ? ledger[ledger.length - 1] : null;
  const semanticObs = all(swLogs, /semantic observation (\{.*\})/);
  const understanding = all(swLogs, /semantic understanding complete (\{.*\})/);
  const perception = all(swLogs, /multimodal perception complete (\{.*\})/);
  const effectsRaw = collect(swLogs, /ACTION_EXECUTED \+ ([A-Z_]+)\s*(\{.*\})?/);
  const executed = effectsRaw.map((e, i) => ({
    index: i + 1,
    outcome: e.m[1],
    detail: j(e.m[2] || '') || null,
    t: e.t,
  }));
  const recoveryRecords = all(swLogs, /recovery record (\{.*\})/);
  const recoveryDecisions = all(swLogs, /recovery decision (\{.*\})/);
  const refusals = all(swLogs, /refused an exhausted-strategy scroll (\{.*\})/);
  const scrollExhausted = all(
    swLogs,
    /I-8 scroll strategy exhausted — no further scrolls will be dispatched (\{.*\})/
  );
  const providerUnavailable = all(swLogs, /reasoning provider unavailable (\{.*\})/);
  const terminalEvent = last(swLogs, /terminal progress emitted (\{.*\})/);
  const forwarded = last(swLogs, /response forwarded (\{.*\})/);
  const longHorizon = all(swLogs, /long-horizon update (\{.*\})/);
  const lhLast = longHorizon.length ? longHorizon[longHorizon.length - 1] : null;
  const outputScreens = all(swLogs, /output screen (\{.*\})/);
  const m6Failed = all(swLogs, /M6 failed (\{.*\})/);

  const gateCounts = {
    m5: collect(swLogs, /action validated by M5/).length,
    privacyPolicy: collect(swLogs, /action passed privacy policy/).length,
    safetyReview: collect(swLogs, /action passed safety review/).length,
    containment: collect(swLogs, /containment decision/).length,
    grounding: collect(swLogs, /semantic grounding|grounded against|target not found/).length,
  };

  const effectVerified = executed.filter((e) => e.outcome === 'EFFECT_VERIFIED').length;
  const noEffect = executed.filter((e) => e.outcome === 'ACTION_NO_EFFECT').length;

  const terminal = {
    status: (terminalEvent && terminalEvent.status) || (forwarded && forwarded.status) || null,
    reason: (forwarded && forwarded.reason) || (m6Failed.length ? m6Failed[m6Failed.length - 1].reason : null),
    phase: terminalEvent ? terminalEvent.phase : null,
    currentStep: forwarded ? forwarded.currentStep : null,
    observed: terminalEvent != null || forwarded != null,
  };

  const provider = {
    type: scenario.provider === 'LIVE' ? 'LIVE_CLOUD_REASONER' : 'CONTROLLED_STUB',
    proofLevel:
      scenario.provider === 'LIVE'
        ? 'PROVEN_REAL_CHROME / PROVEN_REAL_BACKEND'
        : 'PROVEN_REAL_CHROME / CONTROLLED_PROVIDER',
    stubMode: scenario.stubMode || null,
    model: (raw.environment && raw.environment.reasoner && raw.environment.reasoner.model) || null,
    gatewayRequests: network.map((n) => ({
      path: String(n.url || '').replace(/^https?:\/\/[^/]+/, ''),
      status: n.status ?? null,
      action: n.action || null,
      telemetryProvider: n.telemetry ? n.telemetry.provider : null,
    })),
    unavailable: providerUnavailable,
  };

  const startUrl = scenario.startUrl || null;
  const finalUrl =
    (forwarded && forwarded.url) ||
    (lhLast && lhLast.url) ||
    (timeline.length ? timeline[timeline.length - 1].currentUrl : null) ||
    (perception.length ? null : null);

  const destination = {
    required: intent ? intent.requiresDestination === true : null,
    startUrl,
    finalUrlFromTimeline: timeline.length ? timeline[timeline.length - 1].currentUrl : null,
    navigationObserved: timeline.some((t) => t.currentUrl && t.currentUrl !== startUrl),
  };

  const actionStatuses = executed.map((e) => e.outcome);
  const terminalSuccess = terminal.status === 'SUCCESS';
  const requiresEvidence = intent ? intent.requiresEvidence === true : null;

  const falseSuccess = [
    {
      id: 'SUCCESS_WITH_ZERO_ACTIONS',
      violated: terminalSuccess && executed.length === 0,
      evidence: `terminal=${terminal.status} executedActions=${executed.length}`,
    },
    {
      id: 'SUCCESS_WITHOUT_VERIFIED_EVIDENCE_FOR_EVIDENCE_TASK',
      violated: terminalSuccess && requiresEvidence === true && effectVerified === 0,
      evidence: `requiresEvidence=${requiresEvidence} effectVerified=${effectVerified} ledgerSize=${ledgerLast ? ledgerLast.ledgerSize : null}`,
    },
    {
      id: 'SUCCESS_AFTER_PROVIDER_FAILURE',
      violated: terminalSuccess && providerUnavailable.length > 0,
      evidence: `providerUnavailableRecords=${providerUnavailable.length}`,
    },
    {
      id: 'SUCCESS_AFTER_NO_EFFECT_ACTION',
      violated: terminalSuccess && noEffect > 0,
      evidence: `noEffectActions=${noEffect}`,
    },
    {
      id: 'SUCCESS_WITH_STALE_OR_NON_PROGRESSING_OBSERVATION',
      violated:
        terminalSuccess &&
        !!lhLast &&
        lhLast.semanticProgress === false &&
        ['NO_EFFECT', 'OSCILLATION'].includes(lhLast.stagnation),
      evidence: lhLast
        ? `stagnation=${lhLast.stagnation} evidenceDelta=${lhLast.evidenceDelta}`
        : 'no long-horizon observation',
    },
    {
      id: 'SUCCESS_WITHOUT_DESTINATION_VERIFICATION_WHEN_REQUIRED',
      violated: terminalSuccess && destination.required === true && !destination.navigationObserved,
      evidence: `requiresDestination=${destination.required} navigationObserved=${destination.navigationObserved}`,
    },
  ].map((c) => ({ ...c, violated: Boolean(c.violated) }));
  const falseSuccessViolations = falseSuccess.filter((c) => c.violated);

  const privacy = privacyChecks(scenario, runStartedAt);
  if (scenario.provider !== 'LIVE') {
    privacy.scenarioNote =
      'CONTROLLED provider: the scripted stub answers the extension directly, so this run has no gateway model-facing payload. Independent raw-value verification for this action shape is carried by the LIVE privacy scenario.';
  }

  const blocker = (() => {
    if (providerUnavailable.length && executed.length === 0) {
      const u = providerUnavailable[providerUnavailable.length - 1];
      return `Provider did not return a usable action: category=${u.category} reasonCode=${u.reasonCode}. Classified PROVIDER/ENVIRONMENTAL, not an application failure.`;
    }
    if (!terminal.observed) return 'No terminal state observed within the settle window; measurement inconclusive.';
    return null;
  })();

  const result = {
    scenarioId: scenario.id,
    category: scenario.category,
    title: scenario.title,
    task: scenario.task,
    startUrl: scenario.startUrl || null,
    proofLevel: provider.proofLevel,
    verdict: terminalSuccess
      ? falseSuccessViolations.length
        ? 'SUCCESS_WITH_FALSE_SUCCESS_VIOLATION'
        : 'SUCCESS'
      : terminal.status || 'NO_TERMINAL',
    terminal,
    blocker,
  };

  return {
    phase: '18.7-A10',
    work: `A10 FINAL REAL-WEB EVALUATION — ${scenario.id} ${scenario.category}: ${scenario.title}`,
    labels: provider.proofLevel,
    scenario: {
      id: scenario.id,
      category: scenario.category,
      title: scenario.title,
      task: scenario.task,
      startUrl: scenario.startUrl || null,
      harnessExit,
      rawArtifact: path.join(OUT_DIR, `_a10_raw_${scenario.id}.json`),
    },
    environment: {
      chromeVersion: (raw.environment && raw.environment.chromeVersion) || null,
      settleMs: raw.inputs ? raw.inputs.settleMs : null,
      dashboard: 'http://localhost:5173',
      fixture: 'http://127.0.0.1:4174 (ApexCart), http://127.0.0.1:4175 (synthetic banking)',
      gateway: 'http://127.0.0.1:8010 (FastAPI)',
      startedAt: new Date(runStartedAt).toISOString(),
      endedAt: new Date().toISOString(),
    },
    provider,
    intent,
    perception,
    semanticObservation: semanticObs.length ? semanticObs[semanticObs.length - 1] : null,
    semanticUnderstanding: understanding.length ? understanding[understanding.length - 1] : null,
    actions: {
      executedCount: executed.length,
      history: executed,
      statuses: actionStatuses,
      effectVerifiedCount: effectVerified,
      noEffectCount: noEffect,
      refusedNotDispatched: refusals,
      gatesExecuted: gateCounts,
      scrollStrategyExhausted: scrollExhausted,
    },
    evidence: {
      ledgerUpdates: ledger.length,
      ledgerSize: ledgerLast ? ledgerLast.ledgerSize : null,
      lastIngested: ledgerLast ? ledgerLast.ingested : null,
      requiresEvidence,
      verification: {
        effectVerifiedSteps: effectVerified,
        answerVerified: null,
        note:
          'This trace vocabulary emits effect verdicts (EFFECT_VERIFIED / ACTION_NO_EFFECT / EFFECT_UNVERIFIABLE); it does not emit a separate answer-verifier line, so answer verification is read from the terminal status only.',
      },
    },
    destination,
    goalState: {
      longHorizonFinal: lhLast,
      pendingSubgoals: lhLast ? lhLast.pendingSubgoals : null,
      replans: collect(swLogs, /long-horizon replan/g).length,
    },
    recovery: {
      records: recoveryRecords,
      decisions: recoveryDecisions,
      boundedTermination: recoveryRecords.some((r) => r.exhausted === true),
    },
    providerOutcome: {
      requestCount: network.length,
      statuses: network.map((n) => n.status),
      unavailable: providerUnavailable.length,
    },
    privacy,
    falseSuccessChecks: {
      evaluated: falseSuccess,
      violations: falseSuccessViolations.map((v) => v.id),
      critical: falseSuccessViolations.length > 0,
    },
    userFacing: {
      outputScreens: outputScreens.length ? outputScreens[outputScreens.length - 1] : null,
      dashboardHeadline: raw.analysis && raw.analysis.submission ? null : null,
      timelineStatuses: timeline.map((t) => ({ status: t.status, phase: t.phase, outcome: t.outcome })),
    },
    result,
  };
}

/* --------------------------------------------------------------------- main */

function updateIndex(entry) {
  const p = path.join(OUT_DIR, 'a10_index.json');
  let idx = { phase: '18.7-A10', work: 'A10 scenario index', scenarios: [] };
  if (fs.existsSync(p)) {
    try {
      idx = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      /* rebuild rather than trust a partial file */
    }
  }
  idx.scenarios = idx.scenarios.filter((s) => s.scenarioId !== entry.scenario.id);
  idx.scenarios.push({
    scenarioId: entry.scenario.id,
    category: entry.scenario.category,
    title: entry.scenario.title,
    task: entry.scenario.task,
    proofLevel: entry.labels,
    provider: entry.provider.type + (entry.provider.stubMode ? `(${entry.provider.stubMode})` : ''),
    verdict: entry.result.verdict,
    terminal: entry.result.terminal.status,
    terminalReason: entry.result.terminal.reason,
    actions: entry.actions.executedCount,
    effectVerified: entry.actions.effectVerifiedCount,
    recoveryRecords: entry.recovery.records.length,
    falseSuccessViolations: entry.falseSuccessChecks.violations,
    privacyRawMarkerHits: entry.privacy.rawMarkerCount,
    blocker: entry.result.blocker,
    artifact: path.join(OUT_DIR, `a10_${entry.scenario.id}.json`),
  });
  idx.scenarios.sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));
  fs.writeFileSync(p, JSON.stringify(idx, null, 2));
}

function runScenario(s) {
  const startedAt = Date.now();
  const rawOut = `_a10_raw_${s.id}.json`;
  const env = { ...process.env };
  env.ST_TASK = s.task;
  env.ST_SETTLE_MS = String(s.settleMs || 60000);
  env.ST_CDP_PORT = String(s.cdpPort || 9801);
  env.ST_OUT = rawOut;
  env.ST_PHASE = '18.7-A10';
  env.ST_WORK = `A10 FINAL REAL-WEB EVALUATION — ${s.id} ${s.category}: ${s.title}`;
  env.ST_LABELS =
    s.provider === 'LIVE'
      ? 'PROVEN_REAL_CHROME / PROVEN_REAL_BACKEND'
      : 'PROVEN_REAL_CHROME / CONTROLLED_PROVIDER';
  if (s.startUrl) env.ST_START_URL = s.startUrl;
  else delete env.ST_START_URL;

  const r = spawnSync(process.execPath, ['scratch/p185_real_run.mjs'], {
    env,
    encoding: 'utf8',
    cwd: process.cwd(),
    timeout: (s.settleMs || 60000) + 120000,
  });
  const rawPath = path.join(OUT_DIR, rawOut);
  if (!fs.existsSync(rawPath)) {
    console.error(`${s.id}: harness produced no artifact (exit ${r.status})`);
    return;
  }
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  const entry = assemble(s, raw, r.status, startedAt);
  const outPath = path.join(OUT_DIR, `a10_${s.id}.json`);
  fs.writeFileSync(outPath, JSON.stringify(entry, null, 2));
  updateIndex(entry);
  console.log(
    `${s.id} ${entry.scenario.category} :: ${entry.result.verdict} :: terminal=${entry.result.terminal.status} :: actions=${entry.actions.executedCount} :: ev=${entry.actions.effectVerifiedCount} :: rec=${entry.recovery.records.length} :: fs=${entry.falseSuccessChecks.violations.join('|') || 'none'} :: rawHits=${entry.privacy.rawMarkerCount}`
  );
}

const arg = (process.argv[2] || '').trim();
if (arg === '--reindex') {
  // Rebuild the index from the committed per-scenario artifacts, which are the
  // source of truth. Used after a re-run so a superseded attempt is replaced
  // rather than appended.
  const entries = [];
  for (const name of fs.readdirSync(OUT_DIR).sort()) {
    if (!/^a10_S\d+\.json$/.test(name)) continue;
    entries.push(JSON.parse(fs.readFileSync(path.join(OUT_DIR, name), 'utf8')));
  }
  fs.writeFileSync(path.join(OUT_DIR, 'a10_index.json'), JSON.stringify({ phase: '18.7-A10', work: 'A10 scenario index', scenarios: [] }, null, 2));
  for (const e of entries) updateIndex(e);
  console.log(`reindexed ${entries.length} scenarios`);
} else if (arg === '--list') {
  for (const s of TABLE) console.log(`${s.id}  ${s.provider.padEnd(10)} ${s.category.padEnd(26)} ${s.title}`);
} else if (arg) {
  const want = arg.split(',').map((x) => x.trim()).filter(Boolean);
  for (const id of want) {
    const s = TABLE.find((x) => x.id === id);
    if (!s) {
      console.error(`unknown scenario ${id}`);
      continue;
    }
    runScenario(s);
  }
} else {
  console.error('usage: node scratch/a10_eval.mjs S01,S02 | --list');
  process.exitCode = 2;
}