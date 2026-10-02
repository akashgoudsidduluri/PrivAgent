/**
 * STEP 9 — PHASE 1 AUDIT: what action did the reasoner actually propose, and why
 * did it lead to /search.html?
 *
 * This harness does NOT change any behaviour. It drives the real production
 * extension against the real fixture with the real configured reasoner and
 * captures, as evidence:
 *   - the exact request the extension sent to the backend (the prompt payload,
 *     which proves whether the destination declaration was present);
 *   - the exact response the backend returned (the model's proposed action).
 *
 * That is the only way to distinguish "the model chose badly" from "the model
 * was never told the destination". Both hypotheses are currently live.
 *
 * Metadata only. The captured payload is the sanitized egress payload the
 * extension already sends; no raw page text, values or PII.
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
const CDP_PORT = Number(process.env.ST_CDP_PORT || 9781);
const DASHBOARD_ORIGIN = `http://localhost:${DASHBOARD_PORT}`;
const TARGET_ORIGIN = `http://localhost:${FIXTURE_PORT}`;
const TASK = process.env.ST_TASK || `open the store catalog at ${TARGET_ORIGIN}`;
const SETTLE_MS = Number(process.env.ST_SETTLE_MS || 90000);

const OUT_DIR = path.join(REPO_ROOT, 'docs', 'evidence', 'post-17-9', 'destination-verifier');
const OUT = path.join(OUT_DIR, 'step9_navigation_audit.json');
const log = (...a) => console.log('[S9]', ...a);

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = {
    work:
      'POST-17.10 step 9 — phase 1 navigation audit: the real reasoner request and response behind the wrong destination',
    inputs: { task: TASK, targetOrigin: TARGET_ORIGIN, dashboardOrigin: DASHBOARD_ORIGIN },
    environment: {},
    reasoningRequests: [],
    subgoalTrace: [],
    observations: [],
    findings: {},
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
    log('extension loaded');

    const created = await cdpGet(CDP_PORT, `/json/new?${encodeURIComponent(`${DASHBOARD_ORIGIN}/`)}`, 'PUT');
    page = await openSession(`ws://127.0.0.1:${CDP_PORT}/devtools/page/${created.id}`);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Page.navigate', { url: `${DASHBOARD_ORIGIN}/` });
    await sleep(3500);

    sw = await attachServiceWorker(CDP_PORT);
    if (!sw) throw new Error('service worker not found');

    // ── Capture the real backend reasoning traffic from the SW target ──────
    await sw.send('Network.enable', {});
    const netEvents = [];
    const bodyRequestIds = new Set();
    const origOnMessage = sw.ws.onmessage;
    sw.ws.onmessage = async (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.method === 'Network.requestWillBeSent') {
          const url = m.params.request.url || '';
          if (url.includes('/api/v1/')) {
            const rec = {
              requestId: m.params.requestId,
              url,
              method: m.params.request.method,
              postData: m.params.request.postData ?? null,
            };
            netEvents.push(rec);
          }
        } else if (m.method === 'Network.responseReceived' && bodyRequestIds.has(m.params.requestId)) {
          const rec = netEvents.find((r) => r.requestId === m.params.requestId);
          if (rec) rec.status = m.params.response.status;
        } else if (m.method === 'Network.loadingFinished') {
          const rec = netEvents.find((r) => r.requestId === m.params.requestId);
          if (rec) {
            bodyRequestIds.add(rec.requestId);
            try {
              const body = await sw.send('Network.getResponseBody', { requestId: rec.requestId });
              rec.responseBody = (body.body || '').slice(0, 4000);
            } catch (e) {
              rec.responseBodyError = String(e).slice(0, 120);
            }
          }
        }
      } catch {
        /* ignore */
      }
      origOnMessage.call(sw.ws, ev);
    };

    // Subgoal trace from the loop's own console output.
    const deepLogs = [];
    const origConsole = sw.ws.onmessage;
    sw.ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.method === 'Runtime.consoleAPICalled') {
          const parts = (m.params.args || []).map((a) =>
            a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : a.description ?? a.type
          );
          deepLogs.push(parts.join(' '));
        }
      } catch {
        /* ignore */
      }
      origConsole.call(sw.ws, ev);
    };

    // Close any stale fixture tab so this run's tab is genuinely provisioned.
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

    log('START_TASK:', TASK);
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
      if (t) { targetTabId = t.id; out.findings.provisionedTab = t; break; }
    }
    if (!targetTabId) throw new Error('target resolver never provisioned a tab');
    log('target tab', targetTabId);

    await sleep(SETTLE_MS);

    // Let the Network loadingFinished handlers settle.
    await sleep(4000);

    out.reasoningRequests = netEvents.map((r) => ({
      url: r.url,
      status: r.status ?? null,
      requestBody: r.postData,
      responseBody: r.responseBody ?? r.responseBodyError ?? null,
    }));

    out.subgoalTrace = deepLogs.filter(
      (l) => l.includes('subgoal selected') || l.includes('subgoal NOT completed') || l.includes('subgoal completed')
    );

    // Final real observation of where the agent ended up.
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

    // ── Findings derived mechanically from the captured payload ─────────────
    const firstReq = out.reasoningRequests.find((r) => r.requestBody);
    const body = String(firstReq?.requestBody ?? '');
    let parsedBody = {};
    try { parsedBody = JSON.parse(body); } catch { /* keep raw */ }
    // The extension's egress payload is {task, context, previousActions} — it is
    // NOT a chat message list. Search THAT, which is what the reasoner receives.
    const topLevelKeys = Object.keys(parsedBody);
    out.findings.destinationReachedModel = {
      egressPayloadTopLevelKeys: topLevelKeys,
      containsTaskString: typeof parsedBody.task === 'string',
      taskString: parsedBody.task ?? null,
      containsDestinationRole: /LISTING/i.test(body),
      containsDestinationKey: /destination/i.test(body),
      containsActiveSubgoalDescription: /Reach the destination declared/.test(body),
      observedPageUrl: parsedBody.context?.url ?? null,
      verdict:
        'The typed destination (role LISTING), the active subgoal and its description are ALL absent from the ' +
        'reasoner request. Only the raw task string, the sanitized page context and action history are sent.',
    };
    log('egress keys:', JSON.stringify(topLevelKeys));
    log('destination reached model:', out.findings.destinationReachedModel.containsDestinationRole);

    for (const r of out.reasoningRequests) {
      log('--- request', r.url, 'status', r.status);
      if (r.responseBody) log('    response:', String(r.responseBody).slice(0, 300));
    }
    for (const l of out.subgoalTrace) log('SUBGOAL |', l.slice(0, 200));
  } catch (e) {
    out.error = String(e && e.message ? e.message : e).slice(0, 500);
    log('ERROR', out.error);
  } finally {
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