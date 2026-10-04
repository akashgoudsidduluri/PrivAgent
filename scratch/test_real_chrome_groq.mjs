async function testGroqRealChrome() {
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

  console.log('1. Reloading unpacked extension in Chrome...');
  try {
    const loadRes = await send('Extensions.loadUnpacked', { path: 'C:/privagent_dist' });
    console.log('Extensions.loadUnpacked result:', loadRes);
  } catch (e) {
    console.log('loadUnpacked notice:', e.message);
  }

  // Find targets
  let targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const dash = targets.find(t => t.url.includes('5173'));
  if (!dash) throw new Error('Dashboard tab not found on 5173');

  const { sessionId: sDash } = await send('Target.attachToTarget', { targetId: dash.id, flatten: true });
  await send('Page.enable', {}, sDash);
  await send('Runtime.enable', {}, sDash);

  console.log('2. Reloading dashboard tab...');
  await send('Page.reload', {}, sDash);
  await new Promise(r => setTimeout(r, 3000));

  // Verify extension connection
  const extConn = await send('Runtime.evaluate', {
    expression: '(async () => window.__app?.adapter ? await window.__app.adapter.checkExtensionConnected() : false)()',
    awaitPromise: true,
    returnByValue: true
  }, sDash);
  console.log('Extension connected:', extConn.result?.value);

  // Capture all logs
  const logs = [];
  const traversedUrls = new Set();
  ws.addEventListener('message', (m) => {
    try {
      const d = JSON.parse(m.data);
      if (d.method === 'Runtime.consoleAPICalled') {
        const text = d.params.args.map(a => a.value !== undefined ? (typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value)) : (a.description || '')).join(' ');
        logs.push(text);
        if (text.includes('[AgentTrace]') || text.includes('destination') || text.includes('Destination') || text.includes('GoalVerifier') || text.includes('subgoal')) {
          console.log('[BROWSER]', text);
        }
      }
    } catch {}
  });

  // Get initial state
  const initStateRes = await send('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__app.adapter.getState())',
    returnByValue: true
  }, sDash);
  const initState = JSON.parse(initStateRes.result?.value || '{}');
  const initialUrl = initState.currentUrl || 'http://localhost:5173/';
  traversedUrls.add(initialUrl);

  const TASK = 'open groq api keys page';
  console.log(`3. Starting task: "${TASK}"...`);
  await send('Runtime.evaluate', {
    expression: `window.__app.adapter.startTask(${JSON.stringify(TASK)});`
  }, sDash);

  let finalState = null;
  const startTime = Date.now();

  while (Date.now() - startTime < 45000) {
    await new Promise(r => setTimeout(r, 2000));

    // Check all open tabs to track traversed URLs
    try {
      const currentTargets = await (await fetch('http://127.0.0.1:9222/json')).json();
      for (const t of currentTargets) {
        if (t.type === 'page' && t.url) {
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

    if (state.status === 'COMPLETED' || state.status === 'FAILED' || state.status === 'STOPPED') {
      console.log(`Terminal status reached: ${state.status}`);
      break;
    }
  }

  // Extract destination declaration from plan or decomposition
  const plan = finalState?.plan;
  const subgoals = plan?.steps || [];
  const destSubgoal = subgoals.find(s => s.targetHint?.includes('destination') || s.expectedActionType === 'navigate' || s.description?.toLowerCase().includes('destination'));

  // Detailed analysis of collected items
  console.log('\n=== REAL CHROME CAPTURE REPORT ===');
  console.log('1. Initial URL:', initialUrl);
  console.log('2. Traversed URLs:', Array.from(traversedUrls));
  console.log('3. Final URL:', finalState?.currentUrl || Array.from(traversedUrls).pop());
  console.log('4. Final Status:', finalState?.status);
  console.log('5. Final Stage:', finalState?.currentPipelineStage);
  console.log('6. Steps Count:', finalState?.steps?.length);
  console.log('7. Plan Subgoals:', JSON.stringify(subgoals, null, 2));

  // Find logs about destination verification and goal verification
  console.log('\n=== FILTERED DESTINATION & VERIFIER LOGS ===');
  for (const l of logs) {
    if (
      l.toLowerCase().includes('destination') ||
      l.toLowerCase().includes('groq') ||
      l.toLowerCase().includes('goalverifier') ||
      l.toLowerCase().includes('subgoal') ||
      l.toLowerCase().includes('page role') ||
      l.toLowerCase().includes('role_only') ||
      l.toLowerCase().includes('target resolved')
    ) {
      console.log(l);
    }
  }

  ws.close();
  process.exit(0);
}

testGroqRealChrome().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
