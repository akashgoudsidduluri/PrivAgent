import { writeFileSync } from 'fs';

async function connectCDP() {
  const versionInfo = await (await fetch('http://127.0.0.1:9222/json/version')).json();
  const ws = new WebSocket(versionInfo.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);

  let id = 1;
  const send = (method, params = {}, sessionId = undefined) => new Promise((resolve, reject) => {
    const curId = id++;
    const handler = (msg) => {
      const d = JSON.parse(msg.data);
      if (d.id === curId) {
        ws.removeEventListener('message', handler);
        if (d.error) reject(d.error);
        else resolve(d.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id: curId, method, params, sessionId }));
  });

  return { ws, send };
}

async function runFastRealChromeCheck() {
  console.log('=== FAST REAL-CHROME CHECK (PHASE 18.2) ===');
  const { ws, send } = await connectCDP();

  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const dashTarget = targets.find(t => t.url.includes('5173'));
  const bankTarget = targets.find(t => t.url.includes('4173'));
  const swTarget = targets.find(t => t.type === 'service_worker');

  if (!dashTarget || !bankTarget) {
    throw new Error('Dashboard or Bank tab not found!');
  }

  const { sessionId: dashSession } = await send('Target.attachToTarget', { targetId: dashTarget.id, flatten: true });
  await send('Page.enable', {}, dashSession);
  await send('Runtime.enable', {}, dashSession);

  const { sessionId: bankSession } = await send('Target.attachToTarget', { targetId: bankTarget.id, flatten: true });
  await send('Page.enable', {}, bankSession);
  await send('Runtime.enable', {}, bankSession);

  let swSession;
  if (swTarget) {
    const res = await send('Target.attachToTarget', { targetId: swTarget.id, flatten: true });
    swSession = res.sessionId;
    await send('Runtime.enable', {}, swSession);
    console.log('Attached to Extension Service Worker:', swTarget.url);
  }

  // Set up console log listening across all targets
  const logs = [];
  ws.addEventListener('message', (msg) => {
    try {
      const d = JSON.parse(msg.data);
      if (d.method === 'Runtime.consoleAPICalled') {
        const text = d.params.args.map(a => a.value !== undefined ? (typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value)) : (a.description || '')).join(' ');
        logs.push({ time: Date.now(), text });
        console.log('[LOG]', text);
      }
    } catch {}
  });

  // Reload bank tab and set it to the bottom
  console.log('Reloading bank tab...');
  await send('Page.reload', {}, bankSession);
  await new Promise(r => setTimeout(r, 1500));

  // Scroll to bottom
  const initScrollRes = await send('Runtime.evaluate', {
    expression: 'window.scrollTo(0, document.body.scrollHeight); window.scrollY;',
    returnByValue: true
  }, bankSession);
  const initialScrollY = initScrollRes.result?.value;
  console.log(`Bank page scrolled to bottom. Initial scrollY: ${initialScrollY}`);

  // Reload dashboard
  console.log('Reloading dashboard tab...');
  await send('Page.reload', {}, dashSession);
  await new Promise(r => setTimeout(r, 2000));

  // Check connection status
  const extConnected = await send('Runtime.evaluate', {
    expression: '(async () => window.__app?.adapter ? await window.__app.adapter.checkExtensionConnected() : false)()',
    awaitPromise: true,
    returnByValue: true
  }, dashSession);
  console.log('Extension connected:', extConnected.result?.value);

  // Trigger task: "scroll down to see more transactions"
  console.log('Starting task: "scroll down to see more transactions"...');
  await send('Runtime.evaluate', {
    expression: `
      if (window.__app?.adapter) {
        window.__app.adapter.startTask('scroll down to see more transactions');
      } else {
        window.postMessage({ source: 'privagent-dashboard', type: 'START_TASK', task: 'scroll down to see more transactions' }, '*');
      }
    `
  }, dashSession);

  // Poll state and logs for up to 30 seconds or until actions occur
  console.log('Observing agent execution in real Chrome...');
  const startTime = Date.now();
  let finalState = null;

  while (Date.now() - startTime < 30000) {
    await new Promise(r => setTimeout(r, 2000));
    const stateRes = await send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__app?.adapter?.getState() || {})',
      returnByValue: true
    }, dashSession);
    const state = JSON.parse(stateRes.result?.value || '{}');
    finalState = state;
    console.log(`Current state: status=${state.status}, stage=${state.currentPipelineStage}, steps=${state.steps?.length}`);
    if (state.steps?.length > 0) {
      console.log('Steps observed:', JSON.stringify(state.steps, null, 2));
    }
    if (state.steps && state.steps.length >= 2) {
      console.log('Sufficient steps observed to verify loop behavior.');
      break;
    }
    if (state.status === 'COMPLETED' || state.status === 'FAILED' || state.status === 'STOPPED') {
      if (state.steps?.length >= 1) {
        console.log(`Terminal state reached: ${state.status}`);
        break;
      }
    }
  }

  console.log('\n=== REAL CHROME RUN SUMMARY ===');
  console.log('Initial position:', initialScrollY);
  console.log('Steps count:', finalState?.steps?.length || 0);
  console.log('Final status:', finalState?.status);

  // Print all relevant log lines containing scroll, ACTION_NO_EFFECT, recovery
  console.log('\n=== FILTERED CDP TRACES ===');
  const relevantLogs = logs.filter(l => 
    l.text.includes('scroll') ||
    l.text.includes('SCROLL') ||
    l.text.includes('ACTION_') ||
    l.text.includes('recovery') ||
    l.text.includes('REPERCEIVE') ||
    l.text.includes('AgentTrace') ||
    l.text.includes('effect')
  );
  for (const l of relevantLogs) {
    console.log(l.text);
  }

  process.exit(0);
}

runFastRealChromeCheck().catch(err => {
  console.error('Fatal error in fast check:', err);
  process.exit(1);
});
