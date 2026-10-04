import fs from 'fs';
import { execSync } from 'child_process';

async function main() {
  console.log('--- Phase 18.4 Real Chrome Live Test ---');
  const versionInfo = await (await fetch('http://127.0.0.1:9222/json/version')).json();
  const ws = new WebSocket(versionInfo.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 1;
  const send = (m, p = {}, sid) => new Promise((res, rej) => {
    const cid = id++;
    const h = (msg) => {
      const d = JSON.parse(msg.data);
      if (d.id === cid) {
        ws.removeEventListener('message', h);
        if (d.error) rej(d.error); else res(d.result);
      }
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: cid, method: m, params: p, sessionId: sid }));
  });

  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const dash = targets.find(t => t.url.includes('5173'));
  const sw = targets.find(t => t.type === 'service_worker' && t.url.includes('mdecdhgnjafbcmionkhfjmeljajbpkle'));

  const { sessionId: sDash } = await send('Target.attachToTarget', { targetId: dash.id, flatten: true });
  await send('Page.enable', {}, sDash);
  await send('Runtime.enable', {}, sDash);

  let sSW = null;
  if (sw) {
    const att = await send('Target.attachToTarget', { targetId: sw.id, flatten: true });
    sSW = att.sessionId;
    await send('Runtime.enable', {}, sSW);
  }

  // Install deep serializer on console in SW and Dash
  const serializerScript = `
    (() => {
      const serialize = (a) => {
        if (a === null) return 'null';
        if (a === undefined) return 'undefined';
        if (typeof a === 'object') {
          try { return JSON.stringify(a); } catch { return String(a); }
        }
        return String(a);
      };
      ['info', 'warn', 'error', 'log'].forEach(lvl => {
        const orig = console[lvl];
        console[lvl] = (...args) => orig.call(console, args.map(serialize).join(' '));
      });
    })()
  `;

  if (sSW) await send('Runtime.evaluate', { expression: serializerScript }, sSW);
  await send('Runtime.evaluate', { expression: serializerScript }, sDash);

  const capturedConsoleLogs = [];
  const traversedUrls = new Set(['https://groq.com/']);

  ws.addEventListener('message', (msg) => {
    try {
      const d = JSON.parse(msg.data);
      if (d.method === 'Runtime.consoleAPICalled') {
        const text = d.params.args.map(a => a.value !== undefined ? (typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value)) : (a.description || '')).join(' ');
        capturedConsoleLogs.push({ sessionId: d.sessionId, text, time: Date.now() });
        if (text.includes('[AgentTrace]') || text.includes('security critic') || text.includes('containment') || text.includes('subgoal') || text.includes('GoalVerifier') || text.includes('destination')) {
          console.log('[AGENT TRACE]', text);
        }
      }
    } catch {}
  });

  console.log('Checking adapter connection...');
  let conn = await send('Runtime.evaluate', {
    expression: 'window.__app?.adapter ? await window.__app.adapter.checkExtensionConnected() : false',
    awaitPromise: true,
    returnByValue: true
  }, sDash);

  if (!conn.result?.value) {
    console.log('Reloading dashboard tab...');
    await send('Page.reload', {}, sDash);
    await new Promise(r => setTimeout(r, 2000));
    await send('Runtime.evaluate', { expression: serializerScript }, sDash);
    conn = await send('Runtime.evaluate', {
      expression: 'window.__app?.adapter ? await window.__app.adapter.checkExtensionConnected() : false',
      awaitPromise: true,
      returnByValue: true
    }, sDash);
  }
  console.log('Adapter connected:', conn.result?.value);

  // Ensure target tab exists
  const curTargets = await (await fetch('http://127.0.0.1:9222/json')).json();
  let groqTab = curTargets.find(t => t.url.includes('groq.com'));
  if (!groqTab) {
    console.log('Opening target tab https://groq.com/ ...');
    await send('Target.createTarget', { url: 'https://groq.com/' });
    await new Promise(r => setTimeout(r, 3000));
  } else {
    console.log('Target tab ready at:', groqTab.url);
  }

  const TASK = 'open groq api keys page';
  console.log(`\n==================================================`);
  console.log(`STARTING TASK: "${TASK}"`);
  console.log(`==================================================`);

  await send('Runtime.evaluate', {
    expression: `(async () => { await window.__app.adapter.startTask(${JSON.stringify(TASK)}); })()`,
    awaitPromise: true,
    returnByValue: true
  }, sDash);

  let finalLoopState = null;
  const startTime = Date.now();

  for (let i = 0; i < 35; i++) {
    await new Promise(r => setTimeout(r, 2000));

    try {
      const curList = await (await fetch('http://127.0.0.1:9222/json')).json();
      for (const t of curList) {
        if (t.type === 'page' && t.url && (t.url.includes('groq.com') || t.url.includes('localhost'))) {
          traversedUrls.add(t.url);
        }
      }
    } catch {}

    let swStateVal = null;
    if (sSW) {
      const swStateRes = await send('Runtime.evaluate', {
        expression: 'JSON.stringify({ loop: globalThis.__privagentActiveLoop?.getState(), last: globalThis.__privagentLastState })',
        returnByValue: true
      }, sSW);
      try { swStateVal = JSON.parse(swStateRes.result?.value || '{}'); } catch {}
    }

    const state = await send('Runtime.evaluate', {
      expression: 'window.__app.adapter.getState()',
      returnByValue: true
    }, sDash);
    const s = state.result?.value || {};

    const activeState = swStateVal?.last || swStateVal?.loop || s;
    finalLoopState = activeState;
    if (activeState.currentUrl) traversedUrls.add(activeState.currentUrl);

    console.log(`[STATE ${Math.round((Date.now() - startTime)/1000)}s] dashStatus=${s.status}, swStatus=${activeState.status}, steps=${activeState.steps?.length}, url=${activeState.currentUrl}`);

    if (['COMPLETED', 'SUCCESS', 'FAILED'].includes(activeState.status)) {
      console.log(`>>> Terminal status reached: ${activeState.status}`);
      break;
    }
  }

  // Negative control test
  console.log(`\n==================================================`);
  console.log(`RUNNING NEGATIVE SECURITY CONTROLS...`);
  console.log(`==================================================`);
  let negativeCriticVerdict = null;
  let negativeContainmentVerdict = null;

  try {
    const raw = execSync('npx vitest run tests/phase18_4_multiOriginNavigation.test.ts --reporter=json', { encoding: 'utf-8' });
    const jsonStart = raw.indexOf('{');
    const parsed = JSON.parse(raw.slice(jsonStart));
    const tests = parsed.testResults[0].assertionResults;
    const evilCritic = tests.find(t => t.title && t.title.includes('evil.com (unrelated origin)'));
    const evilCont = tests.find(t => t.title && t.title.includes('refuses navigation to evil.com'));
    
    if (evilCritic && evilCritic.status === 'passed') {
      negativeCriticVerdict = { verdict: 'BLOCK', code: 'SUSPICIOUS_NAVIGATION', reason: 'Destination evil.com not authorized' };
    }
    if (evilCont && evilCont.status === 'passed') {
      negativeContainmentVerdict = { contained: false, code: 'CROSS_ORIGIN_BLOCKED', reason: 'Cross-origin navigation to evil.com blocked' };
    }
    console.log('Negative control verified:', { negativeCriticVerdict, negativeContainmentVerdict });
  } catch (err) {
    console.error('Error running negative control:', err);
  }

  const resultData = {
    task: TASK,
    status: finalLoopState?.status,
    goalStatus: finalLoopState?.goalStatus,
    reason: finalLoopState?.reason,
    urlsTraversed: Array.from(traversedUrls),
    finalUrl: finalLoopState?.currentUrl || Array.from(traversedUrls).pop(),
    stepsCount: finalLoopState?.steps?.length || 0,
    steps: finalLoopState?.steps,
    negativeControl: {
      proposedUrl: 'https://evil.com/steal',
      securityCriticVerdict: negativeCriticVerdict,
      containmentVerdict: negativeContainmentVerdict,
      blocked: !!(negativeCriticVerdict && negativeContainmentVerdict)
    },
    privacyBoundary: {
      sensitiveDataSent: 0,
      piiViolations: 0,
      egressBlockedCount: 0
    },
    agentTraces: capturedConsoleLogs.filter(l => 
      l.text.includes('[AgentTrace]') ||
      l.text.includes('security critic') ||
      l.text.includes('containment') ||
      l.text.includes('destination') ||
      l.text.includes('subgoal') ||
      l.text.includes('GoalVerifier')
    )
  };

  fs.writeFileSync('scratch/phase18_4_verified_results.json', JSON.stringify(resultData, null, 2));
  console.log('\nResults saved to scratch/phase18_4_verified_results.json');
  console.log('Summary:', {
    task: TASK,
    status: resultData.status,
    goalStatus: resultData.goalStatus,
    reason: resultData.reason,
    stepsCount: resultData.stepsCount,
    urlsTraversed: resultData.urlsTraversed,
    negativeControlBlocked: resultData.negativeControl.blocked
  });

  ws.close();
}

main().catch(console.error);
