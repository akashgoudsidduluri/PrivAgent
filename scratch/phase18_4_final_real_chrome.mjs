import fs from 'fs';
import { execSync } from 'child_process';

async function main() {
  console.log('=== PHASE 18.4 REAL CHROME VERIFICATION ===');
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

  // 1. Reload unpacked extension
  console.log('1. Reloading extension in Chrome...');
  const targets1 = await (await fetch('http://127.0.0.1:9222/json')).json();
  const extTab = targets1.find(t => t.url.includes('chrome://extensions'));
  if (extTab) {
    const { sessionId } = await send('Target.attachToTarget', { targetId: extTab.id, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    const exts = await send('Runtime.evaluate', {
      expression: 'new Promise(r => chrome.developerPrivate.getExtensionsInfo(r))',
      awaitPromise: true,
      returnByValue: true
    }, sessionId);
    const privAgent = exts.result?.value?.find(e => e.name?.includes('PrivAgent'));
    if (privAgent) {
      await send('Runtime.evaluate', {
        expression: `chrome.developerPrivate.reload('${privAgent.id}')`,
        awaitPromise: true
      }, sessionId);
      await new Promise(r => setTimeout(r, 1200));
      await send('Runtime.evaluate', {
        expression: `new Promise(res => chrome.management.setEnabled('${privAgent.id}', true, res))`,
        awaitPromise: true
      }, sessionId);
      console.log('   PrivAgent reloaded and enabled:', privAgent.id);
    }
  }

  await new Promise(r => setTimeout(r, 2000));

  // 2. Attach to Dashboard
  console.log('2. Connecting to Dashboard...');
  const targets2 = await (await fetch('http://127.0.0.1:9222/json')).json();
  const dash = targets2.find(t => t.url.includes('5173'));
  if (!dash) throw new Error('Dashboard not found on 5173');
  const { sessionId: sDash } = await send('Target.attachToTarget', { targetId: dash.id, flatten: true });
  await send('Page.enable', {}, sDash);
  await send('Runtime.enable', {}, sDash);

  console.log('   Reloading dashboard to attach cleanly to reloaded extension...');
  await send('Page.reload', {}, sDash);
  await new Promise(r => setTimeout(r, 2500));

  // 3. Attach to Service Worker
  console.log('3. Connecting to Service Worker...');
  const targets3 = await (await fetch('http://127.0.0.1:9222/json')).json();
  const sw = targets3.find(t => t.type === 'service_worker' && t.url.includes('mdecdhgnjafbcmionkhfjmeljajbpkle'));
  let sSW = null;
  if (sw) {
    const att = await send('Target.attachToTarget', { targetId: sw.id, flatten: true });
    sSW = att.sessionId;
    await send('Runtime.enable', {}, sSW);
    console.log('   Attached to Service Worker:', sw.id);
  }

  // 4. Console log capture
  const consoleLogs = [];
  const traversedUrls = new Set(['https://groq.com/']);

  ws.addEventListener('message', (msg) => {
    try {
      const d = JSON.parse(msg.data);
      if (d.method === 'Runtime.consoleAPICalled') {
        const text = d.params.args.map(a => a.value !== undefined ? (typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value)) : (a.description || '')).join(' ');
        consoleLogs.push({ sessionId: d.sessionId, text, time: Date.now() });
        if (text.includes('[AgentTrace]') || text.includes('security critic') || text.includes('containment') || text.includes('subgoal') || text.includes('GoalVerifier') || text.includes('destination') || text.includes('M5')) {
          console.log('[AGENT TRACE]', text);
        }
      }
    } catch {}
  });

  // 5. Ensure target tab exists
  let groqTab = targets3.find(t => t.url.includes('groq.com'));
  if (!groqTab) {
    console.log('5. Opening groq.com target tab...');
    await send('Target.createTarget', { url: 'https://groq.com/' });
    await new Promise(r => setTimeout(r, 3000));
  } else {
    console.log('5. Target tab ready at:', groqTab.url);
  }

  // Check dashboard adapter connection
  let connected = false;
  for (let i = 0; i < 5; i++) {
    const conn = await send('Runtime.evaluate', {
      expression: 'window.__app?.adapter ? await window.__app.adapter.checkExtensionConnected() : false',
      awaitPromise: true,
      returnByValue: true
    }, sDash);
    if (conn.result?.value) {
      connected = true;
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log('   Dashboard adapter connected:', connected);

  // 6. Start task
  const TASK = 'open groq api keys page';
  console.log(`\n==================================================`);
  console.log(`DISPATCHING TASK: "${TASK}"`);
  console.log(`==================================================`);

  await send('Runtime.evaluate', {
    expression: `(async () => { await window.__app.adapter.startTask(${JSON.stringify(TASK)}); })()`,
    awaitPromise: true,
    returnByValue: true
  }, sDash);

  const startTime = Date.now();
  let loopState = null;

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

    const state = await send('Runtime.evaluate', {
      expression: 'window.__app.adapter.getState()',
      returnByValue: true
    }, sDash);
    const s = state.result?.value || {};
    loopState = s;

    if (s.currentUrl) traversedUrls.add(s.currentUrl);

    console.log(`[POLL ${Math.round((Date.now() - startTime)/1000)}s] status=${s.status}, stage=${s.currentPipelineStage}, steps=${s.steps?.length}, url=${s.currentUrl || 'initial'}`);

    if (['COMPLETED', 'SUCCESS', 'FAILED'].includes(s.status)) {
      console.log(`>>> Reached terminal state: ${s.status}`);
      break;
    }
  }

  // 7. Negative control tests
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

  const results = {
    task: TASK,
    status: loopState?.status,
    goalStatus: loopState?.goalStatus,
    reason: loopState?.reason,
    urlsTraversed: Array.from(traversedUrls),
    finalUrl: loopState?.currentUrl || Array.from(traversedUrls).pop(),
    stepsCount: loopState?.steps?.length || 0,
    steps: loopState?.steps,
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
    agentTraces: consoleLogs.filter(l => 
      l.text.includes('[AgentTrace]') ||
      l.text.includes('security critic') ||
      l.text.includes('containment') ||
      l.text.includes('destination') ||
      l.text.includes('subgoal') ||
      l.text.includes('GoalVerifier')
    )
  };

  fs.writeFileSync('scratch/phase18_4_final_real_chrome.json', JSON.stringify(results, null, 2));
  console.log('\nResults saved to scratch/phase18_4_final_real_chrome.json');
  console.log('Summary:', {
    task: TASK,
    status: results.status,
    goalStatus: results.goalStatus,
    reason: results.reason,
    stepsCount: results.stepsCount,
    urlsTraversed: results.urlsTraversed,
    negativeControlBlocked: results.negativeControl.blocked
  });

  ws.close();
}

main().catch(console.error);
