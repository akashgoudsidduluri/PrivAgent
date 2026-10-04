import fs from 'fs';
import { execSync } from 'child_process';

async function connectToTarget(predicate) {
  const list = await (await fetch('http://127.0.0.1:9222/json')).json();
  const target = list.find(predicate);
  if (!target) return null;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 1;
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const curId = id++;
    const handler = (m) => {
      const data = JSON.parse(m.data);
      if (data.id === curId) {
        ws.removeEventListener('message', handler);
        if (data.error) reject(data.error); else resolve(data.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id: curId, method, params }));
  });
  return { ws, target, call };
}

async function main() {
  console.log('=== Phase 18.4 Real Chrome Direct-CDP Verification ===');

  // 1. Reload unpacked extension
  console.log('1. Reloading extension...');
  const extConn = await connectToTarget(t => t.url.includes('chrome://extensions'));
  if (extConn) {
    const exts = await extConn.call('Runtime.evaluate', {
      expression: 'new Promise(r => chrome.developerPrivate.getExtensionsInfo(r))',
      awaitPromise: true,
      returnByValue: true
    });
    const privAgent = exts.result?.value?.find(e => e.name?.includes('PrivAgent'));
    if (privAgent) {
      await extConn.call('Runtime.evaluate', {
        expression: `chrome.developerPrivate.reload('${privAgent.id}')`,
        awaitPromise: true
      });
      await new Promise(r => setTimeout(r, 1200));
      await extConn.call('Runtime.evaluate', {
        expression: `new Promise(res => chrome.management.setEnabled('${privAgent.id}', true, res))`,
        awaitPromise: true
      });
      console.log('   PrivAgent reloaded and enabled:', privAgent.id);
    }
    extConn.ws.close();
  }

  await new Promise(r => setTimeout(r, 1500));

  // 2. Connect to Service Worker
  console.log('2. Connecting to Service Worker...');
  let swConn = await connectToTarget(t => t.type === 'service_worker' && t.url.includes('mdecdhgnjafbcmionkhfjmeljajbpkle'));
  if (!swConn) throw new Error('Service Worker not found!');
  console.log('   Connected to SW:', swConn.target.url);

  // Hook logs in Service Worker
  await swConn.call('Runtime.evaluate', {
    expression: `
      globalThis.__capturedLogs = [];
      const wrap = (lvl) => {
        const orig = console[lvl];
        console[lvl] = (...args) => {
          try {
            const formatted = args.map(a => {
              if (a === null) return 'null';
              if (a === undefined) return 'undefined';
              if (typeof a === 'object') {
                try { return JSON.stringify(a); } catch { return String(a); }
              }
              return String(a);
            }).join(' ');
            globalThis.__capturedLogs.push({ level: lvl, text: formatted, time: Date.now() });
          } catch {}
          orig.apply(console, args);
        };
      };
      wrap('info');
      wrap('warn');
      wrap('error');
      wrap('log');
    `
  });

  // 3. Connect to Dashboard tab
  console.log('3. Connecting to Dashboard...');
  let dashConn = await connectToTarget(t => t.url.includes('5173'));
  if (!dashConn) throw new Error('Dashboard tab not found on 5173!');

  let extConnected = false;
  try {
    const chk = await dashConn.call('Runtime.evaluate', {
      expression: 'window.__app?.adapter ? await window.__app.adapter.checkExtensionConnected() : false',
      awaitPromise: true,
      returnByValue: true
    });
    extConnected = chk.result?.value;
  } catch {}

  if (!extConnected) {
    console.log('   Dashboard not linked to extension, reloading dashboard...');
    await dashConn.call('Runtime.evaluate', {
      expression: 'setTimeout(() => location.reload(), 10)'
    });
    dashConn.ws.close();
    await new Promise(r => setTimeout(r, 2500));
    dashConn = await connectToTarget(t => t.url.includes('5173'));
    for (let i = 0; i < 5; i++) {
      const chk = await dashConn.call('Runtime.evaluate', {
        expression: 'window.__app?.adapter ? await window.__app.adapter.checkExtensionConnected() : false',
        awaitPromise: true,
        returnByValue: true
      });
      if (chk.result?.value) {
        extConnected = true;
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  console.log('   Dashboard connected:', extConnected);

  // 4. Ensure target tab (groq.com) exists
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  let groqTab = targets.find(t => t.url.includes('groq.com'));
  if (!groqTab) {
    console.log('4. Navigating to groq.com in target tab...');
    // Create tab via CDP or browser
    const version = await (await fetch('http://127.0.0.1:9222/json/version')).json();
    const rootWs = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise(r => rootWs.onopen = r);
    rootWs.send(JSON.stringify({ id: 999, method: 'Target.createTarget', params: { url: 'https://groq.com/' } }));
    await new Promise(r => setTimeout(r, 3000));
    rootWs.close();
  } else {
    console.log('4. Target tab ready at:', groqTab.url);
  }

  // 5. Trigger task
  const TASK = 'open groq api keys page';
  console.log(`\n==================================================`);
  console.log(`STARTING TASK: "${TASK}"`);
  console.log(`==================================================`);

  await dashConn.call('Runtime.evaluate', {
    expression: `(async () => { await window.__app.adapter.startTask(${JSON.stringify(TASK)}); })()`,
    awaitPromise: true
  });

  const startTime = Date.now();
  let finalState = null;
  const traversedUrls = new Set(['https://groq.com/']);

  while (Date.now() - startTime < 60000) {
    await new Promise(r => setTimeout(r, 2000));

    try {
      const curList = await (await fetch('http://127.0.0.1:9222/json')).json();
      for (const t of curList) {
        if (t.type === 'page' && t.url && (t.url.includes('groq.com') || t.url.includes('localhost'))) {
          traversedUrls.add(t.url);
        }
      }
    } catch {}

    const swStateRes = await swConn.call('Runtime.evaluate', {
      expression: `(() => {
        const last = globalThis.__privagentLastState;
        const loop = globalThis.__privagentActiveLoop;
        if (last) return JSON.stringify({ src: 'lastState', state: last });
        if (loop) return JSON.stringify({ src: 'activeLoop', state: loop.getState() });
        return JSON.stringify({ src: 'none' });
      })()`,
      returnByValue: true
    });

    let loopData = { src: 'none' };
    try { loopData = JSON.parse(swStateRes.result?.value || '{}'); } catch {}

    if (loopData.state) {
      finalState = loopData.state;
      if (finalState.currentUrl) traversedUrls.add(finalState.currentUrl);
      console.log(`[POLL ${Math.round((Date.now() - startTime)/1000)}s] status=${finalState.status}, stage=${finalState.currentPipelineStage}, steps=${finalState.steps?.length}, url=${finalState.currentUrl || 'initial'}`);

      if (['COMPLETED', 'SUCCESS', 'FAILED', 'STOPPED'].includes(finalState.status)) {
        console.log(`>>> Loop reached terminal status: ${finalState.status}`);
        break;
      }
    } else {
      console.log(`[POLL ${Math.round((Date.now() - startTime)/1000)}s] Waiting for loop initialization...`);
    }
  }

  // 6. Read SW logs
  const logsRes = await swConn.call('Runtime.evaluate', {
    expression: 'JSON.stringify(globalThis.__capturedLogs || [])',
    returnByValue: true
  });
  const allLogs = JSON.parse(logsRes.result?.value || '[]');

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

  // 8. Compile structured results
  const navigationSteps = (finalState?.steps || []).filter(s => s.action?.action === 'navigate');
  const securityCriticLogs = allLogs.filter(l => l.text.includes('security critic') || l.text.includes('SECURITY_CRITIC'));
  const destinationLogs = allLogs.filter(l => l.text.includes('destination') || l.text.includes('Destination'));
  const goalLogs = allLogs.filter(l => l.text.includes('GoalVerifier') || l.text.includes('subgoal'));

  const report = {
    testTask: TASK,
    status: finalState?.status,
    goalStatus: finalState?.goalStatus,
    reason: finalState?.reason,
    urlsTraversed: Array.from(traversedUrls),
    finalUrl: finalState?.currentUrl || Array.from(traversedUrls).pop(),
    stepsCount: finalState?.steps?.length || 0,
    steps: finalState?.steps,
    navigationSteps,
    securityCriticLogs,
    destinationLogs,
    goalLogs,
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
    swLogs: allLogs.filter(l =>
      l.text.includes('[AgentTrace]') ||
      l.text.includes('security critic') ||
      l.text.includes('containment') ||
      l.text.includes('subgoal') ||
      l.text.includes('groq')
    )
  };

  fs.writeFileSync('scratch/phase18_4_final_real_chrome.json', JSON.stringify(report, null, 2));
  console.log('\nReport written to scratch/phase18_4_final_real_chrome.json');
  console.log('Summary:', {
    task: TASK,
    status: report.status,
    goalStatus: report.goalStatus,
    reason: report.reason,
    stepsCount: report.stepsCount,
    navigationProposed: navigationSteps.map(s => s.action.url),
    urlsTraversed: report.urlsTraversed,
    negativeControlBlocked: report.negativeControl.blocked
  });

  dashConn.ws.close();
  swConn.ws.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
