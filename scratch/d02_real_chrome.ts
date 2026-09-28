/**
 * PHASE 17.9 D-02 — REAL CHROME VERIFICATION.
 *
 * Reuses the existing Phase 16 CDP infrastructure (`scratch/phase16_cdp.mjs`) and
 * the same real-Chrome shape as the D-01 probe. No new browser harness: the
 * launcher, CDP client and static server all come from the shared module.
 *
 * WHAT IS REAL
 * ────────────
 * Real Chromium, the PRODUCTION-BUILT MV3 extension, the real content script
 * performing a real DOM privacy scan, the real buildAgentPayload +
 * minimizeAgentContext egress path, the production AgentLoop / M5 / grounding /
 * containment, and REAL dispatch — executeAction clicks the live element and the
 * result is read back out of the page.
 *
 * Stubbed, and only this: the model. A real reasoner cannot be made to
 * deterministically propose one specific refused action, and D-02 is about what
 * recovery does with such a proposal. D-02 does not live in the provider.
 *
 * THE OBSERVATION
 * ───────────────
 * A PII-bearing-reason proposal is refused by M5 on a real grounded control.
 * Goal-alignment recovery — dead before D-02 — must now find the real
 * goal-aligned control, and the healed action must pass GATE 1 and M5 before it
 * is dispatched. The page must show the effect of the HEALED control and never
 * the original one.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT, CHROME_BIN, sleep, cdpGet, openSession, launchChrome } from './phase16_cdp.mjs';
import { AgentLoop } from '../extension/src/agent/agentLoop';
import { buildAgentPayload } from '../extension/src/privacy/types';
import { minimizeAgentContext } from '../extension/src/privacy/contextMinimizer';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import type { BrowserAction } from '../extension/src/agent/actionTypes';

const EXT_DIST = path.join(REPO_ROOT, 'dist');
const PORT = 4272;
const CDP = 9542;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const EVIDENCE = path.join(REPO_ROOT, 'docs', 'evidence', 'phase17', '17.9-d02-remediation');

const GOAL = 'Open the transaction history';
const ORPHAN_SEL = '#zzz-opaque';
const GOAL_SEL = '#transaction-history';

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>D-02 Fixture</title>
<style>body{font-family:sans-serif;margin:24px}</style></head><body>
<h1>Account</h1>
<button id="zzz-opaque" type="button">Apply</button>
<button id="transaction-history" type="button">Transaction history</button>
<div id="effect">untouched</div>
<script>
  document.getElementById('transaction-history').addEventListener('click', () => {
    document.getElementById('effect').textContent = 'history-opened';
  });
  document.getElementById('zzz-opaque').addEventListener('click', () => {
    document.getElementById('effect').textContent = 'orphan-clicked';
  });
</script></body></html>`;

const checks: { name: string; pass: boolean; actual: unknown }[] = [];
const rec = (name: string, pass: boolean, actual: unknown) => {
  checks.push({ name, pass, actual });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ->  ${JSON.stringify(actual)}`);
};

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });

  const server = await new Promise<http.Server>((res) => {
    const s = http.createServer((_q, r) => {
      r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      r.end(HTML);
    });
    s.listen(PORT, '127.0.0.1', () => res(s));
  });

  const { proc, profile } = launchChrome(CDP, [
    `--disable-extensions-except=${EXT_DIST}`,
    `--load-extension=${EXT_DIST}`,
  ]);
  const cleanup = () => {
    try { proc.kill('SIGKILL'); } catch { /* gone */ }
    try { server.close(); } catch { /* closed */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  let sw: any = null;
  let page: any = null;
  try {
    if (!fs.existsSync(path.join(EXT_DIST, 'manifest.json'))) {
      throw new Error('dist/manifest.json missing — run `npm run build:extension` first.');
    }
    for (let i = 0; i < 60; i++) {
      try { await cdpGet(CDP, '/json/version'); break; } catch { await sleep(500); }
    }
    let swT: any = null;
    for (let i = 0; i < 60 && !swT; i++) {
      const list = await cdpGet(CDP, '/json/list');
      swT = list.find((x: any) => x.url?.includes('serviceWorker.js'));
      if (!swT) await sleep(500);
    }
    if (!swT) throw new Error('extension service worker never appeared');
    sw = await openSession(swT.webSocketDebuggerUrl);
    await sw.send('Runtime.enable');
    rec('the production MV3 extension loads into real Chromium', true, swT.url);

    const created = await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(ORIGIN + '/')}`, { method: 'PUT' }).then((r) => r.json());
    page = await openSession(created.webSocketDebuggerUrl);
    await sleep(1500);

    const tabId: number = await sw.evaluate(
      `(async () => { const t = await chrome.tabs.query({}); const m = t.find(x => (x.url||'').startsWith('${ORIGIN}')); return m ? m.id : -1; })()`
    );
    rec('the fixture page is a real tab', tabId > 0, tabId);

    // REAL perception through the production content script.
    const scan = await sw.evaluate(
      `(async () => { try { return await chrome.tabs.sendMessage(${tabId}, { type: 'PRIVAGENT_SCAN_REQUEST' }); } catch (e) { return { error: String(e) }; } })()`
    );
    const report = scan?.report;
    rec('the real content script returns a real sanitized scan report', !!report, report?.status ?? scan?.error);

    const built = buildAgentPayload(report, null, null);
    if (!built) throw new Error('buildAgentPayload refused the real report');
    const context = minimizeAgentContext(built, { task: GOAL }).payload as AgentContextPayload;
    rec('real perception produces detections for the live page', context.detections.length >= 2, context.detections.length);

    const sel = (d: any) => String(d.selector ?? '');
    const orphan = context.detections.find((d) => sel(d) === ORPHAN_SEL);
    const goalDet = context.detections.find((d) => sel(d) === GOAL_SEL);
    rec('a real detection is the opaque control', !!orphan, orphan?.id);
    rec('a real detection is the goal-aligned control', !!goalDet, goalDet?.id);

    if (!orphan || !goalDet) throw new Error('fixture detections not found in real perception');

    // M5 must refuse this: a person name in the reason, on a real grounded target.
    const proposal = {
      action: 'click',
      target: orphan.id,
      reason: 'Open the statement for Aria Vasquez',
    } as unknown as BrowserAction;

    const dispatched: BrowserAction[] = [];
    const loop = new AgentLoop(
      { name: 'D02Real', requestAction: async () => proposal as never, registerFailure: () => {}, resetEscalation: () => {} },
      {
        perceivePage: async () => context,
        getEffectSnapshot: async () => null,
        // REAL dispatch into the live page.
        executeAction: async (a) => {
          dispatched.push(a);
          const id = String((a as any).target ?? '');
          await page.evaluate(
            `(() => { const el = document.getElementById(${JSON.stringify(id)}); if (el) el.click(); return true; })()`
          );
          return { success: true };
        },
      },
      {
        maxSteps: 1, maxRetries: 1, delayBetweenStepsMs: 0,
        targetTabId: tabId, initialUrl: `${ORIGIN}/`,
        containmentScope: { rootHost: '127.0.0.1', origin: ORIGIN, tabId, dashboardOrigin: 'chrome-extension://dashboard' },
      }
    );

    let threw: string | null = null;
    let state: any = null;
    try { state = await loop.runTask(GOAL); } catch (e) { threw = (e as Error)?.name ?? 'UnknownError'; }

    rec('runTask does not throw', threw === null, threw);
    rec('the healed GOAL-ALIGNED target is what was dispatched',
      dispatched.length === 1 && (dispatched[0] as any).target === goalDet.id,
      dispatched.map((a) => (a as any).target));
    rec('the original refused control was NEVER dispatched',
      !dispatched.map((a) => (a as any).target).includes(orphan.id),
      dispatched.map((a) => (a as any).target));

    const effect = await page.evaluate(`document.getElementById('effect').textContent`);
    rec('the real page shows the effect of the HEALED control', effect === 'history-opened', effect);

    rec('no SUCCESS was produced', state?.status !== 'SUCCESS', state?.status);
    rec('no raw PII entered the decision trace',
      !JSON.stringify(state?.decisionTraceSummary ?? {}).toLowerCase().includes('aria') &&
      !JSON.stringify(state?.decisionTraceSummary ?? {}).toLowerCase().includes('vasquez'),
      'clean');

    const all = checks.every((c) => c.pass);
    const out = {
      phase: '17.9 D-02 remediation',
      track: 'REAL_CHROME',
      classification: all ? 'PROVEN_REAL' : 'FAILED',
      reuses: 'scratch/phase16_cdp.mjs (existing Phase 16 CDP infrastructure) — no new browser harness',
      whatIsReal: {
        browser: 'Chromium, CDP-driven, same binary as every earlier phase',
        extension: 'PRODUCTION BUILD from dist/, loaded with --load-extension',
        perception: 'real content script PRIVAGENT_SCAN_REQUEST over the live page, then the real buildAgentPayload + minimizeAgentContext',
        authorities: 'production AgentLoop, M5, grounding and containment, imported from source and unmodified',
        dispatch: 'a real element.click() in the live page, with the DOM result read back',
      },
      whatIsStubbed: { model: 'the provider returns one fixed M5-refused proposal; D-02 does not live in the provider' },
      goal: GOAL,
      realDetections: context.detections.length,
      orphanDetection: { id: orphan.id, selector: sel(orphan) },
      goalDetection: { id: goalDet.id, selector: sel(goalDet) },
      dispatchedTargets: dispatched.map((a) => (a as any).target),
      pageEffect: effect,
      checks,
      verdict: all ? 'ALL REAL-CHROME CHECKS PASSED' : 'ONE OR MORE REAL-CHROME CHECKS FAILED',
    };
    fs.writeFileSync(path.join(EVIDENCE, 'd02_real_chrome_results.json'), `${JSON.stringify(out, null, 2)}\n`);
    console.log(`\n${out.verdict}  (${checks.filter((c) => c.pass).length}/${checks.length})`);
    process.exitCode = all ? 0 : 1;
  } finally {
    try { sw?.close(); } catch { /* noop */ }
    try { page?.close(); } catch { /* noop */ }
    cleanup();
  }
}

main().catch((e) => {
  console.error('D02_REAL_CHROME_ERROR:', e?.stack ?? e);
  process.exitCode = 2;
});
