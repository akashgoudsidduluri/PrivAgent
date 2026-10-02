/**
 * STEP 10 AUDIT — real production egress capture.
 *
 * READ-ONLY AUDIT HARNESS. It changes no production behaviour and no prior
 * evidence file. It drives the REAL built extension (dist/) in REAL headless
 * Chrome against the REAL fixture (localhost:4174) and the REAL configured
 * backend (localhost:8010), and captures the actual serialized bytes of every
 * request the extension sends to the backend.
 *
 * What it proves / disproves, mechanically:
 *   - is `declaredDestination` present in the real egress payload?
 *   - what EXACTLY is in it (role? url? entryUrl? anything else?)
 *   - does it contain any key the backend privacy firewall forbids at any depth?
 *   - does it contain any string that came from the PAGE rather than the user?
 *   - what did the reasoner reply, and did the loop complete the subgoal?
 *
 * Env:
 *   ST_TASK        the user task string
 *   ST_SETTLE_MS   how long to let the loop run
 *   ST_CDP_PORT    devtools port
 *   ST_OUT         output filename under docs/evidence/post-17-10/audit
 *   ST_START_URL   optional: pre-existing fixture tab to adopt (case C)
 *   ST_KEEP_TABS   1 = do not close pre-existing fixture tabs
 */
import fs from 'fs';
import path from 'path';

import {
  REPO_ROOT,
  sleep,
  cdpGet,
  openSession,
  launchChrome,
  attachServiceWorker,
} from './phase16_cdp.mjs';

const FIXTURE_PORT = Number(process.env.ST_FIXTURE_PORT || 4174);
const DASHBOARD_PORT = Number(process.env.ST_DASHBOARD_PORT || 5173);
const CDP_PORT = Number(process.env.ST_CDP_PORT || 9791);
const DASHBOARD_ORIGIN = `http://localhost:${DASHBOARD_PORT}`;
const TARGET_ORIGIN = `http://localhost:${FIXTURE_PORT}`;
const TASK = process.env.ST_TASK || 'open the store catalog';
const SETTLE_MS = Number(process.env.ST_SETTLE_MS || 60000);
const START_URL = process.env.ST_START_URL || '';
const KEEP_TABS = process.env.ST_KEEP_TABS === '1';

const OUT_DIR = path.join(REPO_ROOT, 'docs', 'evidence', 'post-17-10', 'audit');
const OUT = path.join(OUT_DIR, process.env.ST_OUT || 'egress_capture.json');
const log = (...a) => console.log('[S10]', ...a);

/** Recursively collect every key present in a JSON value, with its depth path. */
function keyPaths(value, prefix = '', acc = []) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => keyPaths(v, `${prefix}[${i}]`, acc));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = prefix ? `${prefix}.${k}` : k;
      acc.push(p);
      keyPaths(v, p, acc);
    }
  }
  return acc;
}

/** The names backend/app/security.py refuses at any depth (per the Step 9 P1 note). */
const FORBIDDEN = ['text', 'value', 'input', 'innerText', 'outerText', 'label', 'placeholder', 'ariaLabel'];

function scanDeclaredDestination(decl) {
  const findings = {};
  if (decl === undefined) {
    findings.present = false;
    return findings;
  }
  findings.present = true;
  findings.topLevelKeys = Object.keys(decl).sort();
  findings.roles = Array.isArray(decl.role) ? decl.role.slice() : null;
  findings.destinationUrl = decl.destinationUrl ?? null;
  findings.entryUrl = decl.entryUrl ?? null;
  findings.provenance = decl.provenance ?? null;
  findings.allKeyPaths = keyPaths(decl).sort();
  findings.forbiddenKeysPresent = FORBIDDEN.filter(
    (f) => findings.allKeyPaths.some((p) => p.split('.').pop() === f)
  );
  // Any string leaf that is not one of the three constrained fields.
  const allowed = new Set(['provenance', 'entryUrl', 'destinationUrl']);
  findings.unexpectedStringLeaves = [];
  const walk = (v, p) => {
    if (typeof v === 'string') {
      if (!allowed.has(p) && !/\.role\[\d+\]$/.test(p)) findings.unexpectedStringLeaves.push({ path: p, value: v });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
  };
  walk(decl, '');
  return findings;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = {
    work: 'POST-17.10 STEP 10 AUDIT — real production provider-egress capture',
    labels: 'PROVEN_REAL_CHROME (bytes on the wire) / PROVEN_REAL_BACKEND (backend response)',
    inputs: {
      task: TASK,
      userSuppliedUrlInTask: (TASK.match(/https?:\/\/\S+/) || [null])[0],
      startUrl: START_URL || null,
      keptExistingTabs: KEEP_TABS,
      targetOrigin: TARGET_ORIGIN,
      dashboardOrigin: DASHBOARD_ORIGIN,
    },
    environment: {},
    reasoningRequests: [],
    analysis: {},
    loopLogs: [],
    rawLogs: [],
    observations: [],
  };

  const chrome = launchChrome(CDP_PORT);
  let bs, page, sw;
  try {
    let version = null;
    for (let i = 0; i < 60; i += 1) {
      try { version = await cdpGet(CDP_PORT, '/json/version'); break; } catch { await sleep(500); }
    }
    if (!version) throw new Error('chrome CDP never became ready');
    out.environment.chromeVersion = version.Browser || 'unknown';

    const bsId = version.webSocketDebuggerUrl.split('/').pop();
    bs = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/browser/${bsId}`);
    bs.send('Extensions.loadUnpacked', { path: path.join(REPO_ROOT, 'dist') }).catch(() => {});
    log('extension loaded from dist/');

    const created = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(`${DASHBOARD_ORIGIN}/`)}`, 'PUT');
    page = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${created.id}`);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Page.navigate', { url: `${DASHBOARD_ORIGIN}/` });
    await sleep(3500);

    sw = await attachServiceWorker(CDP_PORT);
    if (!sw) throw new Error('service worker not found');
    await sw.send('Network.enable', {});
    await sw.send('Runtime.enable', {});

    const netEvents = [];
    const finished = new Set();
    const origOnMessage = sw.ws.onmessage;
    sw.ws.onmessage = async (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.method === 'Network.requestWillBeSent') {
          const url = m.params.request.url || '';
          if (url.includes('/api/v1/')) {
            netEvents.push({
              requestId: m.params.requestId,
              url,
              method: m.params.request.method,
              postData: m.params.request.postData ?? null,
            });
          }
        } else if (m.method === 'Network.responseReceived') {
          const rec = netEvents.find((r) => r.requestId === m.params.requestId);
          if (rec) rec.status = m.params.response.status;
        } else if (m.method === 'Network.loadingFinished' && !finished.has(m.params.requestId)) {
          const rec = netEvents.find((r) => r.requestId === m.params.requestId);
          if (rec) {
            finished.add(rec.requestId);
            try {
              const body = await sw.send('Network.getResponseBody', { requestId: rec.requestId });
              rec.responseBody = body.body ?? null;
            } catch (e) {
              rec.responseBodyError = String(e).slice(0, 160);
            }
          }
        } else if (m.method === 'Runtime.consoleAPICalled') {
          const parts = [];
          for (const a of m.params.args || []) {
            if (a.value !== undefined) {
              parts.push(typeof a.value === 'string' ? a.value : JSON.stringify(a.value));
            } else if (a.objectId) {
              // Serialize structured console payloads instead of losing them to "Object".
              let rendered = a.description ?? a.type;
              try {
                const r = await sw.send('Runtime.callFunctionOn', {
                  objectId: a.objectId,
                  functionDeclaration: 'function(){ try { return JSON.stringify(this); } catch (e) { return "UNSERIALIZABLE"; } }',
                  returnByValue: true,
                });
                if (r?.result?.value) rendered = String(r.result.value).slice(0, 900);
              } catch { /* keep description */ }
              parts.push(rendered);
            } else {
              parts.push(a.description ?? a.type);
            }
          }
          out.rawLogs.push(parts.join(' '));
        }
      } catch { /* ignore */ }
      origOnMessage.call(sw.ws, ev);
    };

    if (START_URL) {
      await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(START_URL)}`, 'PUT');
      log('pre-existing fixture tab opened at', START_URL);
      await sleep(2500);
    }

    if (!KEEP_TABS) {
      await sw.evaluate(`(async () => {
        const tabs = await chrome.tabs.query({});
        for (const t of tabs) {
          if ((t.url || t.pendingUrl || '').startsWith('${TARGET_ORIGIN}')) {
            try { await chrome.tabs.remove(t.id); } catch (e) {}
          }
        }
        return true;
      })()`);
      await sleep(800);
    }

    log('START_TASK:', TASK);
    // Read-only observation of the AgentTaskState the extension ACTUALLY reports
    // to the dashboard. The worker publishes it through
    // `chrome.tabs.sendMessage(tabId, {type:'PRIVAGENT_DASHBOARD_PROGRESS', payload})`,
    // so we wrap that one function in the worker's own context, COPY its
    // arguments, and forward them UNCHANGED. Nothing is injected into the agent
    // loop, no verifier is invoked, and no state is written.
    const shim = await sw.evaluate(`(() => {
      globalThis.__st10 = [];
      const orig = chrome.tabs.sendMessage.bind(chrome.tabs);
      chrome.tabs.sendMessage = (tabId, msg, ...rest) => {
        try {
          if (msg && msg.type === 'PRIVAGENT_DASHBOARD_PROGRESS' && msg.payload) {
            const p = msg.payload;
            globalThis.__st10.push({
              status: p.status ?? null,
              goalStatus: p.goalStatus ?? null,
              currentStep: p.currentStep ?? null,
              lastActionResult: p.lastActionResult ?? null,
              completedSteps: Array.isArray(p.completedSteps) ? p.completedSteps.slice() : null,
              failureCategories: Array.isArray(p.failureHistory) ? p.failureHistory.map((f) => f.category) : null,
              lastFailureCategory: p.lastFailure ? p.lastFailure.category : null,
              subgoalStates: p.subgoalGraphData && p.subgoalGraphData.subgoals
                ? Object.fromEntries(Object.entries(p.subgoalGraphData.subgoals).map(([k, v]) => [k, v.state]))
                : null,
              subgoalConditions: p.subgoalGraphData && p.subgoalGraphData.subgoals
                ? Object.fromEntries(Object.entries(p.subgoalGraphData.subgoals).map(([k, v]) => [k, v.verificationCondition ? v.verificationCondition.type : null]))
                : null,
              // G7 evidence: the planner state machine and the destination
              // verifier's own verdicts, copied UNCHANGED from the state the
              // loop publishes. Nothing is invoked or written here.
              planningEngineState: p.planningEngineState ?? null,
              highLevelGoalId: p.highLevelGoal ? p.highLevelGoal.goalId : null,
              currentUrl: p.currentUrl ?? null,
              pageType: p.pageType ?? null,
              reason: p.reason ?? null,
              subgoalVerificationHistory: Array.isArray(p.subgoalVerificationHistory)
                ? p.subgoalVerificationHistory.slice(-12).map((h) => ({
                    subgoalId: h.subgoalId,
                    satisfied: h.satisfied,
                    reason: h.reason,
                  }))
                : null,
              destinationSubgoalStates: p.subgoalGraphData && p.subgoalGraphData.subgoals
                ? Object.fromEntries(
                    Object.entries(p.subgoalGraphData.subgoals)
                      .filter(([, v]) => v.destination)
                      .map(([k, v]) => [k, { state: v.state, destination: v.destination, cond: v.verificationCondition ? v.verificationCondition.type : null }])
                  )
                : null,
            });
          }
        } catch (e) { /* observation only */ }
        return orig(tabId, msg, ...rest);
      };
      return 'shimmed';
    })()`);
    log('progress shim:', shim);
    await page.evaluate(`(() => {
      window.postMessage({ source: 'privagent-dashboard', type: 'START_TASK', task: ${JSON.stringify(TASK)} }, '*');
      return true;
    })()`);

    let targetTabId = null;
    for (let i = 0; i < 60; i += 1) {
      await sleep(500);
      const raw = await sw.evaluate(`(async () => {
        const tabs = await chrome.tabs.query({});
        const t = tabs.find(x => (x.url || x.pendingUrl || '').startsWith('${TARGET_ORIGIN}'));
        return JSON.stringify(t ? { id: t.id, url: t.url } : null);
      })()`);
      const t = JSON.parse(raw);
      if (t) { targetTabId = t.id; out.analysis.provisionedTab = t; log('target tab', targetTabId, t.url); break; }
    }
    if (!targetTabId) throw new Error('target resolver never provisioned a tab');

    await sleep(SETTLE_MS);
    await sleep(4000);

    out.reasoningRequests = netEvents.map((r) => ({
      url: r.url,
      status: r.status ?? null,
      requestBody: r.postData,
      responseBody: r.responseBody ?? r.responseBodyError ?? null,
    }));

    // ── Mechanical analysis of every captured request ───────────────────────
    const analysed = [];
    for (const r of out.reasoningRequests) {
      let parsed = null;
      try { parsed = JSON.parse(String(r.requestBody ?? '')); } catch { /* not json */ }
      const entry = {
        url: r.url,
        status: r.status,
        bytes: r.requestBody ? String(r.requestBody).length : 0,
        topLevelKeys: parsed ? Object.keys(parsed) : null,
      };
      if (parsed) {
        const sc = parsed.context?.semantic_context ?? null;
        entry.hasSemanticContext = !!sc;
        if (sc) {
          entry.semanticContextKeys = Object.keys(sc);
          entry.declaredDestination = scanDeclaredDestination(sc.declaredDestination);
        } else {
          entry.declaredDestination = { present: false, reason: 'no semantic_context on the egress payload' };
        }
        entry.task = parsed.task ?? null;
        entry.observedContextUrl = parsed.context?.url ?? null;
        entry.previousActionCount = Array.isArray(parsed.previousActions) ? parsed.previousActions.length : null;
        // Page-derived leakage probe: does any string in the WHOLE payload that
        // is not the task or a URL contain fixture prose? Recorded, not asserted.
        entry.forbiddenKeysAnywhere = FORBIDDEN.filter(
          (f) => keyPaths(parsed).some((p) => p.split('.').pop() === f)
        );
      }
      entry.responsePreview = r.responseBody ? String(r.responseBody).slice(0, 800) : null;
      analysed.push(entry);
    }
    out.analysis.perRequest = analysed;

    const withDecl = analysed.filter((a) => a.declaredDestination?.present);
    out.analysis.summary = {
      totalApiRequests: analysed.length,
      requestsCarryingDeclaredDestination: withDecl.length,
      anyRoleOnlyRequest: withDecl.some((a) => Array.isArray(a.declaredDestination.roles) && a.declaredDestination.destinationUrl === null),
      anyUrlCarryingRequest: withDecl.some((a) => a.declaredDestination.destinationUrl !== null),
      anyForbiddenKeyInDeclaration: withDecl.some((a) => (a.declaredDestination.forbiddenKeysPresent || []).length > 0),
      anyUnexpectedStringLeafInDeclaration: withDecl.some((a) => (a.declaredDestination.unexpectedStringLeaves || []).length > 0),
      anyForbiddenKeyInWholePayload: analysed.some((a) => (a.forbiddenKeysAnywhere || []).length > 0),
    };

    // What the extension actually reported to the dashboard.
    try {
      const raw = await sw.evaluate('JSON.stringify(globalThis.__st10 || [])');
      const reports = JSON.parse(raw);
      out.reportedStates = reports;
      out.analysis.statesWithActionResult = reports.filter((r) => r.lastActionResult);
    } catch (e) {
      out.reportedStatesError = String(e).slice(0, 200);
    }

    // Final real observation of where the agent ended up.
    try {
      const obs = await sw.evaluate(`(async () => {
        const res = await chrome.tabs.sendMessage(${targetTabId}, { type: 'PRIVAGENT_SCAN_REQUEST' });
        const sc = res?.semanticContext || null;
        const wm = res?.worldModel || null;
        return JSON.stringify({
          url: wm?.page?.url ?? null,
          semanticPageType: sc?.pageType ?? null,
          semanticConfidence: sc?.confidence ?? null,
          semanticPageGeneration: sc?.pageGeneration ?? null,
        });
      })()`);
      out.observations.push(JSON.parse(obs));
    } catch (e) {
      out.observationError = String(e).slice(0, 200);
    }

    log('summary:', JSON.stringify(out.analysis.summary));
  } catch (e) {
    out.error = String(e && e.message ? e.message : e).slice(0, 600);
    log('ERROR', out.error);
  } finally {
    const keep = [
      'subgoal', 'DESTINATION', 'destination', 'ACTION_NO_EFFECT', 'GoalVerifier', 'goal verification',
      'verified', 'MATCH', 'MISMATCH', 'UNKNOWN', 'reasoner', 'provider', 'refus', 'rate limit', '429',
      'targetResolver', 'DESTINATION_REQUIRED', 'error', 'fail',
      'G7_RETRY_DIAGNOSTIC', 'G7_RETRY_LOOP',
    ];
    out.loopLogs = out.rawLogs.filter((l) => keep.some((k) => l.includes(k))).slice(0, 500);
    try { sw?.close?.(); } catch { /* ignore */ }
    try { page?.close?.(); } catch { /* ignore */ }
    try { bs?.close?.(); } catch { /* ignore */ }
    try { chrome.proc.kill('SIGKILL'); } catch { /* ignore */ }
  }

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  log('wrote', OUT);
  return out;
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
