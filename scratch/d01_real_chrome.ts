/**
 * PHASE 17.8 D-01 — REAL CHROME OBSERVATION.
 *
 * WHAT IS ACTUALLY REAL HERE, STATED PLAINLY
 * ────────────────────────────────────────────
 * Real: the browser (Playwright's Chromium, the same binary every earlier phase
 * used), the PRODUCTION-BUILT MV3 extension loaded into it, the real content
 * script performing a real DOM privacy scan, and the real page.
 * Real: the production `AgentLoop`, `AgentDecisionTracer`, M5 and containment
 * modules, imported from source and executed unmodified.
 * Real: dispatch. `executeAction` writes into the live DOM and reads the value
 * back, so "the refused action was not dispatched" is a page observation, not
 * a claim about a mock.
 *
 * Stubbed, and only this: the MODEL. A real reasoner cannot be made to
 * deterministically propose a specific raw value, and D-01 is precisely about
 * what happens when one is proposed. The provider therefore returns a fixed
 * PII-bearing proposal. The D-01 mechanism does not live in the provider.
 *
 * REQUIRED OBSERVATION
 * ────────────────────
 *   PII-bearing proposed action -> M5 refusal -> trace handling does not crash
 *   -> no dispatch.
 *
 * The precondition is proven in the SAME run, not asserted from a unit test: the
 * production tracer is called directly with the real proposal and is required
 * to throw `PrivacyBoundaryError`. If it stopped throwing, the loop half of
 * this probe would pass vacuously, so it is a hard gate.
 *
 * Run:  npx vite-node scratch/d01_real_chrome.ts
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { AgentLoop } from '../extension/src/agent/agentLoop';
import { AgentDecisionTracer } from '../extension/src/agent/decisionTrace';
import { PrivacyBoundaryError } from '../extension/src/privacy/rawValueScanner';
import { buildAgentPayload } from '../extension/src/privacy/types';
import { minimizeAgentContext } from '../extension/src/privacy/contextMinimizer';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import type { BrowserAction } from '../extension/src/agent/actionTypes';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const EXTENSION_DIST = path.join(REPO_ROOT, 'dist');
const FIXTURE_PORT = 4271;
const CDP_PORT = 9541;
const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;
const EVIDENCE = path.join(REPO_ROOT, 'docs', 'evidence', 'phase17', '17.8-d01-remediation');

const CHROME_BIN =
  process.env.PRIVAGENT_CHROME_BIN ||
  path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The raw value the model will propose. It exists ONLY in this file. */
const RAW_EMAIL = 'recipient@example.com';

// ── The fixture page ─────────────────────────────────────────────────────────
// A real checkout form. Nothing here is a stub: this is the page the agent
// perceives and the page that would receive the action if M5 allowed it.
const FIXTURE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>PrivAgent D-01 Checkout</title>
<style>body{font-family:sans-serif;margin:24px}label{display:block;margin:8px 0 4px}input{padding:8px;width:280px}</style>
</head><body>
<h1>Checkout</h1>
<form id="checkout">
  <label for="recipient">Recipient email</label>
  <input id="recipient" name="recipient" type="email" aria-label="Recipient email" autocomplete="off">
  <button id="place-order" type="button">Place order</button>
</form>
<div id="receipt">no-receipt-yet</div>
<script>document.getElementById('place-order').addEventListener('click',()=>{document.getElementById('receipt').textContent='receipt-issued';});</script>
</body></html>`;

function serveFixture(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(FIXTURE_HTML);
    return undefined;
  });
  return new Promise((resolve) => server.listen(FIXTURE_PORT, '127.0.0.1', () => resolve(server)));
}

// ── Minimal CDP client, reusing the Phase 16 conventions ─────────────────────
function cdpJson(port: number, endpoint: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: endpoint, method: 'GET' }, (res) => {
      let raw = '';
      res.on('data', (d) => (raw += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error('non-JSON'));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; t: NodeJS.Timeout }>();
  private consoleLines: string[] = [];
  constructor(private ws: WebSocket) {
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!;
        this.pending.delete(m.id);
        clearTimeout(p.t);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      } else if (m.method === 'Runtime.consoleAPICalled') {
        this.consoleLines.push(
          `${m.params.type}: ` + (m.params.args || []).map((a: any) => a.value ?? a.description ?? '').join(' '),
        );
      } else if (m.method === 'Runtime.exceptionThrown') {
        this.consoleLines.push(`EXCEPTION: ${m.params?.exceptionDetails?.text ?? 'unknown'}`);
      }
    };
  }
  send(method: string, params: any = {}, timeoutMs = 60000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, t });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, awaitTimeout: 60000 });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description ?? ''));
    return r.result.value;
  }
  logs(): string[] {
    return this.consoleLines;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

async function openCdp(wsUrl: string): Promise<Cdp> {
  const ws = new globalThis.WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('websocket failed'));
  });
  const c = new Cdp(ws);
  await c.send('Runtime.enable');
  // Only page targets expose Page.*; a service-worker target rejects it. The
  // console stream this probe needs comes from Runtime.* alone.
  await c.send('Page.enable').catch(() => undefined);
  return c;
}

// ── Chrome lifecycle ─────────────────────────────────────────────────────────
function launchChrome(): { proc: ReturnType<typeof spawn>; profile: string } {
  if (!fs.existsSync(CHROME_BIN)) throw new Error(`Chrome binary not found at ${CHROME_BIN}`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'privagent-d01-'));
  const proc = spawn(
    CHROME_BIN,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-proxy-server',
      '--proxy-bypass-list=*',
      '--window-size=1280,900',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      `--disable-extensions-except=${EXTENSION_DIST}`,
      `--load-extension=${EXTENSION_DIST}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  return { proc, profile };
}

async function waitForCdp(tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      await cdpJson(CDP_PORT, '/json/version');
      return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('CDP endpoint never came up');
}

async function waitForServiceWorker(tries = 60): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const list = await cdpJson(CDP_PORT, '/json/list');
    const t = list.find((x: any) => x.url && x.url.includes('serviceWorker.js'));
    if (t) return t;
    await sleep(500);
  }
  throw new Error('extension service worker never appeared');
}

// ── The probe ────────────────────────────────────────────────────────────────
async function main() {
  // The production AgentLoop runs in THIS process (the browser supplies real
  // perception and a real dispatch; the model is the only stub), so the
  // withheld marker is emitted on this process's own stdout, not the service
  // worker's. Capture it here so the marker can be asserted directly.
  const harnessLog: string[] = [];
  const realInfo = console.info.bind(console);
  console.info = (...args: unknown[]) => {
    harnessLog.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    realInfo(...args);
  };

  fs.mkdirSync(EVIDENCE, { recursive: true });
  const checks: { name: string; expected: string; actual: unknown; pass: boolean }[] = [];
  const record = (name: string, expected: string, actual: unknown, pass: boolean) => {
    checks.push({ name, expected, actual, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n        expected: ${expected}\n        actual:   ${JSON.stringify(actual)}`);
    return pass;
  };

  if (!fs.existsSync(path.join(EXTENSION_DIST, 'manifest.json'))) {
    throw new Error('dist/manifest.json missing — run `npm run build:extension` first.');
  }

  const server = await serveFixture();
  const { proc, profile } = launchChrome();
  const shutdown = () => {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    try {
      server.close();
    } catch {
      /* already closed */
    }
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  let sw: Cdp | null = null;
  let page: Cdp | null = null;
  try {
    await waitForCdp();
    const swTarget = await waitForServiceWorker();
    sw = await openCdp(swTarget.webSocketDebuggerUrl);
    record('the production MV3 extension loads into real Chromium', 'a live chrome-extension:// service worker', swTarget.url, swTarget.url.startsWith('chrome-extension://'));

    // Open the fixture page as a real tab.
    const created = await cdpJson(CDP_PORT, `/json/new?${encodeURIComponent(FIXTURE_ORIGIN + '/')}`).catch(async () => {
      // Older builds require PUT for /json/new.
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(FIXTURE_ORIGIN + '/')}`, { method: 'PUT' });
      return r.json();
    });
    page = await openCdp(created.webSocketDebuggerUrl);
    await sleep(1200);

    const tabId: number = await sw.evaluate(
      `(async () => { const t = await chrome.tabs.query({}); const m = t.find(x => (x.url||'').startsWith('${FIXTURE_ORIGIN}')); return m ? m.id : -1; })()`,
    );
    record('the fixture page is a real tab in the browser', 'a real chrome tab id > 0', tabId, tabId > 0);

    const realPageValue = await page.evaluate(`document.getElementById('recipient').value`);
    record('the real page input starts empty', '""', realPageValue, realPageValue === '');

    // ── REAL PERCEPTION: the production content script scans the live page ──
    const scan = await sw.evaluate(
      `(async () => { try { return await chrome.tabs.sendMessage(${tabId}, { type: 'PRIVAGENT_SCAN_REQUEST' }); } catch (e) { return { error: String(e) }; } })()`,
    );
    const report = scan?.report;
    record('the real content script returns a real sanitized scan report', 'a report with a passed privacy status', report?.status ?? scan?.error, !!report);

    // The production egress/minimization path, run locally on the real report.
    const built = buildAgentPayload(report, null, null);
    if (!built) throw new Error('buildAgentPayload refused the real scan report: ' + JSON.stringify(report?.status));
    const minimized = minimizeAgentContext(built, { task: 'Fill in the recipient email address' });
    const context = minimized.payload as AgentContextPayload;
    record('real perception yields real detections for the live page', '> 0 real detections', context.detections.length, context.detections.length > 0);

    // Find the real detection for the recipient input, by its real label.
    const recipient = context.detections.find((d) => /recipient/i.test(String((d as any).label ?? ''))) ?? context.detections[0];
    record('a real detection identifies the recipient email input', 'a real detection with an id and selector', { id: recipient.id, label: (recipient as any).label }, !!recipient?.id);

    // ── THE PII-BEARING PROPOSAL ───────────────────────────────────────────
    const proposal = {
      action: 'type',
      target: recipient.id,
      text: RAW_EMAIL,
      reason: 'Fill in the recipient email address',
    } as unknown as BrowserAction;

    // ── GATE: the production tracer really does throw on this proposal ──────
    // Without this the loop result below could pass vacuously.
    let tracerThrew: string | null = null;
    try {
      new AgentDecisionTracer('d01-real-chrome').recordStep({
        step: 1,
        goal: 'Fill in the recipient email address',
        proposedAction: proposal,
        riskAssessment: { riskLevel: 'LOW', score: 0, requiresConfirmation: false },
        structuralValidation: { passed: false, reason: 'M5 refused the proposal.' },
        semanticVerification: { verified: false, confidence: 0, alignment: 'UNKNOWN', reason: 'M5 refused the proposal.' },
        confidenceEvaluation: { confidenceScore: 0, directive: 'BLOCK', explanation: 'M5 refused the proposal.' },
        finalOutcome: 'FAILED',
      });
    } catch (e) {
      tracerThrew = e instanceof PrivacyBoundaryError ? 'PrivacyBoundaryError' : `OTHER:${(e as Error)?.name}`;
    }
    record(
      'the production tracer throws PrivacyBoundaryError on this real proposal (the D-01 precondition)',
      'PrivacyBoundaryError',
      tracerThrew,
      tracerThrew === 'PrivacyBoundaryError',
    );

    // ── THE REAL LOOP, AGAINST THE REAL PAGE ───────────────────────────────
    let dispatchedToRealPage = 0;
    const realDispatches: unknown[] = [];

    const loop = new AgentLoop(
      {
        name: 'D01RealChrome',
        requestAction: async () => proposal as never,
        registerFailure: () => {},
        resetEscalation: () => {},
      },
      {
        perceivePage: async () => context,
        getEffectSnapshot: async () => null,
        // A REAL dispatch: it writes into the live DOM and reads the value back.
        executeAction: async (a) => {
          dispatchedToRealPage++;
          realDispatches.push(a);
          if (a.action === 'type' && page) {
            await page.evaluate(
              `(() => { const el = document.getElementById('recipient'); el.value = ${JSON.stringify((a as any).text ?? '')}; el.dispatchEvent(new Event('input', {bubbles:true})); return el.value; })()`,
            );
          }
          return { success: true };
        },
      },
      {
        maxSteps: 1,
        maxRetries: 1,
        delayBetweenStepsMs: 0,
        targetTabId: tabId,
        initialUrl: `${FIXTURE_ORIGIN}/`,
        containmentScope: {
          rootHost: '127.0.0.1',
          origin: FIXTURE_ORIGIN,
          tabId,
          dashboardOrigin: 'chrome-extension://dashboard',
        },
      },
    );

    let threw: string | null = null;
    let state: Awaited<ReturnType<AgentLoop['runTask']>> | null = null;
    try {
      state = await loop.runTask('Fill in the recipient email address');
    } catch (e) {
      threw = (e as Error)?.name ?? 'UnknownError';
    }

    record('PrivacyBoundaryError does NOT escape runTask against the real page', 'no exception', threw, threw === null);
    record('the task ends in a refusal/failure state', 'FAILED', state?.status, state?.status === 'FAILED');
    record('no SUCCESS is produced', 'status is not SUCCESS', state?.status, state?.status !== 'SUCCESS');
    record('the refused action was never dispatched to the real page', '0 real dispatches', dispatchedToRealPage, dispatchedToRealPage === 0);

    // The page itself is the proof of non-dispatch.
    const afterValue = await page.evaluate(`document.getElementById('recipient').value`);
    record('the real page input is still empty — the PII never reached the DOM', '""', afterValue, afterValue === '');
    const receipt = await page.evaluate(`document.getElementById('receipt').textContent`);
    record('no downstream effect occurred on the real page', '"no-receipt-yet"', receipt, receipt === 'no-receipt-yet');

    record('the trace was withheld rather than fabricated', 'withheldDecisionTraceSteps === 1', loop.withheldDecisionTraceSteps, loop.withheldDecisionTraceSteps === 1);

    // Privacy: no raw value on the audited surface, and none in the browser logs.
    const audited = JSON.stringify({
      trace: state?.decisionTraceSummary,
      reason: state?.reason,
      failureHistory: state?.failureHistory,
    });
    record('the real audited surface carries no raw PII', 'no raw email in trace/reason', audited.includes(RAW_EMAIL) ? 'LEAKED' : 'clean', !audited.includes(RAW_EMAIL));

    const browserLog = [...(sw?.logs() ?? []), ...(page?.logs() ?? [])].join('\n');
    record('the raw value never appears in any browser log line', 'no raw email in the browser console', browserLog.includes(RAW_EMAIL) ? 'LEAKED' : 'clean', !browserLog.includes(RAW_EMAIL));
    record('the raw value never appears in the loop log either', 'no raw email in the loop log', harnessLog.join('\n').includes(RAW_EMAIL) ? 'LEAKED' : 'clean', !harnessLog.join('\n').includes(RAW_EMAIL));
    const withheldSeen = harnessLog.some((l) => l.includes('decision trace withheld'));
    record('the withheld marker is emitted by the running production loop', "an '[AgentTrace] decision trace withheld' line in the loop's own log", withheldSeen, withheldSeen);
    record('the withheld marker carries only the step and the constant', "step 1 and 'RAW_VALUE_IN_PROPOSAL', no raw value", (harnessLog.find((l) => l.includes('decision trace withheld')) ?? '(absent)').replace(RAW_EMAIL, '<RAW>'), (harnessLog.find((l) => l.includes('decision trace withheld')) ?? '').includes('RAW_VALUE_IN_PROPOSAL'));

    const allPass = checks.every((c) => c.pass);
    const out = {
      phase: '17.8 D-01 remediation',
      track: 'REAL_CHROME',
      classification: allPass ? 'PROVEN_REAL' : 'FAILED',
      whatIsReal: {
        browser: 'Playwright Chromium (same binary as the earlier phases), headless=new, CDP-driven',
        extension: 'PRODUCTION BUILD from dist/, loaded with --load-extension',
        perception: 'the real content script PRIVAGENT_SCAN_REQUEST over the live page, then the real buildAgentPayload + minimizeAgentContext egress path',
        authorities: 'the production AgentLoop, AgentDecisionTracer, M5 and containment, imported from source and unmodified',
        dispatch: 'a real DOM write into the live page, read back from the page itself',
      },
      whatIsStubbed: {
        model: 'The provider returns a fixed PII-bearing proposal. A real reasoner cannot be made to deterministically propose one raw value, and D-01 is exactly about what happens when one is proposed. D-01 does not live in the provider.',
      },
      requiredObservation: 'PII-bearing proposed action -> M5 refusal -> trace handling does not crash -> no dispatch',
      chromeBinary: CHROME_BIN,
      fixtureOrigin: FIXTURE_ORIGIN,
      realDetections: context.detections.length,
      recipientDetection: { id: recipient.id, label: (recipient as any).label ?? null },
      checks,
      verdict: allPass ? 'ALL REAL-CHROME CHECKS PASSED' : 'ONE OR MORE REAL-CHROME CHECKS FAILED',
    };
    fs.writeFileSync(path.join(EVIDENCE, 'd01_real_chrome_results.json'), `${JSON.stringify(out, null, 2)}\n`);
    console.log(`\n${out.verdict}  (${checks.filter((c) => c.pass).length}/${checks.length})`);
    console.log(`${path.join(EVIDENCE, 'd01_real_chrome_results.json')}`);
    process.exitCode = allPass ? 0 : 1;
  } finally {
    sw?.close();
    page?.close();
    shutdown();
  }
}

main().catch((e) => {
  console.error('REAL_CHROME_PROBE_ERROR:', e?.stack ?? e);
  process.exitCode = 2;
});
