async function runTest() {
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

  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const dash = targets.find(t => t.url.includes('5173'));
  const bank = targets.find(t => t.url.includes('4173'));

  const { sessionId: sDash } = await send('Target.attachToTarget', { targetId: dash.id, flatten: true });
  const { sessionId: sBank } = await send('Target.attachToTarget', { targetId: bank.id, flatten: true });

  await send('Page.enable', {}, sDash);
  await send('Runtime.enable', {}, sDash);
  await send('Page.enable', {}, sBank);
  await send('Runtime.enable', {}, sBank);

  // Attach to service worker if present
  const allTargets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const sw = allTargets.find(t => t.type === 'service_worker' && t.url.includes('mdecdhgnjafbcmionkhfjmeljajbpkle'));
  if (sw) {
    const { sessionId: sSW } = await send('Target.attachToTarget', { targetId: sw.id, flatten: true });
    await send('Runtime.enable', {}, sSW);
  }

  // Collect console logs
  const logs = [];
  ws.addEventListener('message', (m) => {
    try {
      const d = JSON.parse(m.data);
      if (d.method === 'Runtime.consoleAPICalled') {
        const text = d.params.args.map(a => a.value !== undefined ? (typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value)) : (a.description || '')).join(' ');
        logs.push(text);
        if (text.includes('[AgentLoop]') || text.includes('[AgentTrace]') || text.includes('ACTION_') || text.includes('scroll') || text.includes('SCROLL') || text.includes('recovery') || text.includes('Step')) {
          console.log('[BROWSER LOG]', text);
        }
      }
    } catch {}
  });

  // Pre-scroll bank page to bottom
  const initScrollRes = await send('Runtime.evaluate', {
    expression: 'window.scrollTo(0, document.body.scrollHeight); window.scrollY;',
    returnByValue: true
  }, sBank);
  const initialPosition = initScrollRes.result?.value;
  console.log(`Initial position (at bottom): ${initialPosition}`);

  // Trigger task: "scroll to view more transactions"
  console.log('Triggering task...');
  await send('Runtime.evaluate', {
    expression: `window.__app.adapter.startTask('scroll to view more transactions');`
  }, sDash);

  let initialAction = null;
  let scrollDelta = null;
  let effect = null;
  let nextAction = null;
  let identicalScrollCount = 0;
  let repeatedIdenticalScroll = 'NO';
  let finalState = 'RUNNING';

  const startTime = Date.now();
  while (Date.now() - startTime < 35000) {
    await new Promise(r => setTimeout(r, 1500));
    const stateRes = await send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__app.adapter.getState())',
      returnByValue: true
    }, sDash);
    const state = JSON.parse(stateRes.result?.value || '{}');
    const steps = state.steps || [];

    if (steps.length > 0 && !initialAction) {
      initialAction = steps[0].action || JSON.stringify(steps[0]);
    }

    if (steps.length >= 1) {
      // Find scroll action
      const step1 = steps[0];
      scrollDelta = step1.scrollDelta ?? 0;
      effect = step1.effect || (step1.status === 'FAILED' ? 'ACTION_NO_EFFECT' : (scrollDelta === 0 ? 'ACTION_NO_EFFECT' : 'SUCCESS'));

      if (steps.length >= 2) {
        nextAction = steps[1].action || JSON.stringify(steps[1]);
        if (typeof steps[0].action === 'object' && typeof steps[1].action === 'object') {
          if (steps[0].action?.action === 'scroll' && steps[1].action?.action === 'scroll' && steps[0].action?.direction === steps[1].action?.direction) {
            repeatedIdenticalScroll = 'YES';
            identicalScrollCount++;
          }
        } else if (String(steps[0].action).includes('scroll') && String(steps[1].action).includes('scroll')) {
          const s0 = String(steps[0].action);
          const s1 = String(steps[1].action);
          if (s0 === s1) {
            repeatedIdenticalScroll = 'YES';
            identicalScrollCount++;
          }
        }
        finalState = state.status;
        console.log('Got second action! Stopping test with enough evidence.');
        break;
      }
    }

    if (state.status === 'COMPLETED' || state.status === 'FAILED' || state.status === 'STOPPED') {
      finalState = state.status;
      if (steps.length >= 1) {
        console.log(`Task terminated with status: ${finalState}`);
        break;
      }
    }
  }

  // Also check logs for the raw actions if state steps format is nested
  for (const log of logs) {
    if (log.includes('ACTION_NO_EFFECT')) {
      effect = 'ACTION_NO_EFFECT';
    }
    if (log.includes('scrollDelta: 0') || log.includes('scrollDelta":0') || log.includes('scrollDelta=0')) {
      scrollDelta = 0;
    }
  }

  // Look for action proposals in logs
  const actionLogs = logs.filter(l => l.includes('requestAction') || l.includes('Action proposed') || l.includes('Executing action') || l.includes('"action":"scroll"'));
  console.log('\n--- ACTION LOGS SUMMARY ---');
  actionLogs.forEach(l => console.log(l));

  console.log('\n=== REAL CHROME DATA COLLECTED ===');
  console.log(JSON.stringify({
    initialPosition,
    initialAction,
    scrollDelta,
    effect,
    nextAction,
    repeatedIdenticalScroll,
    identicalScrollCount,
    finalState
  }, null, 2));

  ws.close();
  process.exit(0);
}

runTest().catch(e => {
  console.error(e);
  process.exit(1);
});
