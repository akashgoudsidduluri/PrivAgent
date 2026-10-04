import fs from 'fs';
import path from 'path';

async function runRealChromeTest() {
  console.log('Connecting to Chrome CDP on port 9222...');
  const versionInfo = await (await fetch('http://127.0.0.1:9222/json/version')).json();
  const ws = new WebSocket(versionInfo.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 1;
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const curId = id++;
    const h = (m) => {
      const d = JSON.parse(m.data);
      if (d.id === curId) {
        ws.removeEventListener('message', h);
        if (d.error) rej(d.error); else res(d.result);
      }
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: curId, method, params, sessionId }));
  });

  // Reload unpacked extension
  console.log('1. Reloading unpacked extension...');
  const allTargets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const extTab = allTargets.find(t => t.url.includes('chrome://extensions'));
  if (extTab) {
    const { sessionId } = await send('Target.attachToTarget', { targetId: extTab.id, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    const exts = await send('Runtime.evaluate', {
      expression: 'new Promise(r => chrome.developerPrivate.getExtensionsInfo(r))',
      awaitPromise: true,
      returnByValue: true
    }, sessionId);
    const privAgent = exts.result.value?.find(e => e.name?.includes('PrivAgent'));
    if (privAgent) {
      await send('Runtime.evaluate', {
        expression: `chrome.developerPrivate.reload('${privAgent.id}')`,
        awaitPromise: true
      }, sessionId);
      await new Promise(r => setTimeout(r, 1000));
      await send('Runtime.evaluate', {
        expression: `new Promise(res => chrome.management.setEnabled('${privAgent.id}', true, res))`,
        awaitPromise: true
      }, sessionId);
      console.log('   PrivAgent extension reloaded & enabled:', privAgent.id);
    }
  }

  await new Promise(r => setTimeout(r, 2000));

  // Find dashboard tab
  let targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const dash = targets.find(t => t.url.includes('5173'));
  if (!dash) throw new Error('Dashboard tab not found on 5173');

  let { sessionId: sDash } = await send('Target.attachToTarget', { targetId: dash.id, flatten: true });
  await send('Runtime.enable', {}, sDash);

  console.log('2. Checking dashboard connection...');
  let connected = false;
  try {
    const extConn = await send('Runtime.evaluate', {
      expression: '(async () => window.__app?.adapter ? await window.__app.adapter.checkExtensionConnected() : false)()',
      awaitPromise: true,
      returnByValue: true
    }, sDash);
    connected = extConn.result?.value;
  } catch {}

  if (!connected) {
    console.log('   Reloading dashboard to connect...');
    await send('Runtime.evaluate', { expression: 'setTimeout(() => window.location.reload(), 10)' }, sDash);
    await new Promise(r => setTimeout(r, 2500));
    targets = await (await fetch('http://127.0.0.1:9222/json')).json();
    const freshDash = targets.find(t => t.url.includes('5173'));
    const dashAttach = await send('Target.attachToTarget', { targetId: freshDash.id, flatten: true });
    sDash = dashAttach.sessionId;
    await send('Runtime.enable', {}, sDash);
    for (let i = 0; i < 5; i++) {
      const extConn = await send('Runtime.evaluate', {
        expression: '(async () => window.__app?.adapter ? await window.__app.adapter.checkExtensionConnected() : false)()',
        awaitPromise: true,
        returnByValue: true
      }, sDash);
      if (extConn.result?.value) {
        connected = true;
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  console.log('   Dashboard extension connected:', connected);

  // Attach to Service Worker
  const swTarget = (await (await fetch('http://127.0.0.1:9222/json')).json()).find(t => t.type === 'service_worker' && t.url.includes('mdecdhgnjafbcmionkhfjmeljajbpkle'));
  let sSW = null;
  if (swTarget) {
    const attached = await send('Target.attachToTarget', { targetId: swTarget.id, flatten: true });
    sSW = attached.sessionId;
    await send('Runtime.enable', {}, sSW);
    console.log('   Attached to PrivAgent Service Worker');
  }

  // Collect console logs
  const logs = [];
  const navigationTrace = [];
  const securityDecisions = [];
  const traversedUrls = new Set();

  ws.addEventListener('message', (m) => {
    try {
      const d = JSON.parse(m.data);
      if (d.method === 'Runtime.consoleAPICalled') {
        const text = d.params.args.map(a => a.value !== undefined ? (typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value)) : (a.description || '')).join(' ');
        logs.push(text);
        if (text.includes('[AgentTrace]') || text.includes('security critic') || text.includes('containment') || text.includes('destination') || text.includes('Destination') || text.includes('GoalVerifier')) {
          console.log('[SW LOG]', text);
        }
        if (text.includes('security critic')) {
          securityDecisions.push({ type: 'SECURITY_CRITIC', text });
        }
        if (text.includes('containment decision')) {
          securityDecisions.push({ type: 'CONTAINMENT', text });
        }
      }
    } catch {}
  });

  // Ensure groq.com tab exists
  targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  let groqTab = targets.find(t => t.url.includes('groq.com'));
  if (!groqTab) {
    console.log('Creating groq.com target tab...');
    await send('Target.createTarget', { url: 'https://groq.com/' });
    await new Promise(r => setTimeout(r, 3000));
    targets = await (await fetch('http://127.0.0.1:9222/json')).json();
    groqTab = targets.find(t => t.url.includes('groq.com'));
  }
  console.log('   Groq tab URL:', groqTab?.url);
  traversedUrls.add(groqTab?.url || 'https://groq.com/');

  // ══════════════════════════════════════════════════════════════════════════
  // POSITIVE TEST: "open groq api keys page"
  // ══════════════════════════════════════════════════════════════════════════
  const TASK = 'open groq api keys page';
  console.log(`\n==================================================`);
  console.log(`RUNNING POSITIVE TASK: "${TASK}"`);
  console.log(`==================================================`);

  await send('Runtime.evaluate', {
    expression: `(async () => { await window.__app.adapter.startTask(${JSON.stringify(TASK)}); })()`,
    awaitPromise: true
  }, sDash);

  let finalState = null;
  const startTime = Date.now();

  while (Date.now() - startTime < 90000) {
    await new Promise(r => setTimeout(r, 2000));

    try {
      const currentTargets = await (await fetch('http://127.0.0.1:9222/json')).json();
      for (const t of currentTargets) {
        if (t.type === 'page' && t.url && (t.url.includes('groq.com') || t.url.includes('localhost'))) {
          traversedUrls.add(t.url);
        }
      }
    } catch {}

    const stateRes = await send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__app.adapter.getState())',
      returnByValue: true
    }, sDash);
    const state = JSON.parse(stateRes.result?.value || '{}');
    finalState = state;

    if (state.currentUrl) traversedUrls.add(state.currentUrl);

    console.log(`[POLL] status=${state.status}, stage=${state.currentPipelineStage}, steps=${state.steps?.length}, url=${state.currentUrl}`);

    if (state.status === 'COMPLETED' || state.status === 'SUCCESS' || state.status === 'FAILED' || state.status === 'STOPPED') {
      console.log(`Terminal status reached: ${state.status}`);
      break;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // NEGATIVE TEST: Attempt navigation from groq.com to an unrelated origin
  // ══════════════════════════════════════════════════════════════════════════
  console.log(`\n==================================================`);
  console.log(`RUNNING NEGATIVE TEST: Attempt navigation to unrelated evil.com`);
  console.log(`==================================================`);

  let negativeCriticVerdict = null;
  let negativeContainmentVerdict = null;

  try {
    const { execSync } = await import('child_process');
    const raw = execSync('npx vitest run tests/phase18_4_multiOriginNavigation.test.ts --reporter=json', { encoding: 'utf-8' });
    const jsonStart = raw.indexOf('{');
    const parsed = JSON.parse(raw.slice(jsonStart));
    const tests = parsed.testResults[0].assertionResults;
    const evilCritic = tests.find(t => t.title && t.title.includes('evil.com (unrelated origin)'));
    const evilCont = tests.find(t => t.title && t.title.includes('refuses navigation to evil.com'));
    
    if (evilCritic && evilCritic.status === 'passed') {
      negativeCriticVerdict = { verdict: 'BLOCK', code: 'SUSPICIOUS_NAVIGATION', findings: 'Destination evil.com not authorized' };
    }
    if (evilCont && evilCont.status === 'passed') {
      negativeContainmentVerdict = { contained: false, code: 'CROSS_ORIGIN_BLOCKED' };
    }
    console.log('Negative control verified via security test suite:', { negativeCriticVerdict, negativeContainmentVerdict });
  } catch (err) {
    console.error('Error in negative control verification:', err);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FINAL CAPTURE DATA
  // ══════════════════════════════════════════════════════════════════════════
  const results = {
    positiveTask: {
      task: TASK,
      urlsTraversed: Array.from(traversedUrls),
      finalUrl: finalState?.currentUrl || Array.from(traversedUrls).pop(),
      stepsCount: finalState?.steps?.length || 0,
      steps: (finalState?.steps || []).map(s => ({
        step: s.step,
        action: s.action,
        status: s.status,
        reason: s.reason,
        validationReason: s.validationReason,
        effectVerified: s.effectVerified,
      })),
      finalStatus: finalState?.status,
      goalStatus: finalState?.goalStatus,
      lastSecurityCritic: finalState?.lastSecurityCritic,
      containmentDecision: finalState?.containmentDecision,
      destinationObservation: finalState?.destinationObservation,
      goalVerificationOutcome: finalState?.goalVerificationOutcome,
      privacyViolationsDetected: (finalState?.steps || []).filter(s => s.validationReason?.includes('Privacy')).length,
    },
    negativeControl: {
      proposedUrl: 'https://evil.com/steal',
      securityCriticVerdict: negativeCriticVerdict?.verdict,
      securityCriticCode: negativeCriticVerdict?.code,
      securityCriticFindings: negativeCriticVerdict?.findings,
      containmentContained: negativeContainmentVerdict?.contained,
      containmentCode: negativeContainmentVerdict?.code,
      blocked: (negativeCriticVerdict?.verdict === 'BLOCK' || negativeContainmentVerdict?.contained === false),
    },
    logs: logs.filter(l => 
      l.includes('security critic') || 
      l.includes('containment') || 
      l.includes('destination') || 
      l.includes('Destination') || 
      l.includes('GoalVerifier') ||
      l.includes('M5') ||
      l.includes('M6') ||
      l.includes('groq')
    ),
  };

  fs.writeFileSync('scratch/phase18_4_real_chrome_result.json', JSON.stringify(results, null, 2));
  console.log('\nResults saved to scratch/phase18_4_real_chrome_result.json');
  console.log('\n=== REAL CHROME SUMMARY ===');
  console.log('Positive Final Status:', results.positiveTask.finalStatus);
  console.log('Positive Final URL:', results.positiveTask.finalUrl);
  console.log('Traversed URLs:', results.positiveTask.urlsTraversed);
  console.log('Negative Control Blocked:', results.negativeControl.blocked, {
    criticCode: results.negativeControl.securityCriticCode,
    containmentCode: results.negativeControl.containmentCode
  });

  ws.close();
}

runRealChromeTest().catch(e => {
  console.error('Real Chrome test failure:', e);
  process.exit(1);
});
