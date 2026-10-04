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

async function runScrollTests() {
  console.log('=== REAL CHROME TEST: PHASE 18.2 SCROLL NO-EFFECT LOOP REPAIR ===\n');
  const { ws, send } = await connectCDP();

  try {
    const extRes = await send('Extensions.loadUnpacked', { path: 'C:/Users/AKASH/Projects/SEM PROJECT/sem-v/PrivAgent/dist' });
    console.log('Extensions.loadUnpacked result:', extRes);
  } catch (e) {
    console.log('Extensions.loadUnpacked notice:', e.message);
  }

  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const dashTarget = targets.find(t => t.url.includes('5173'));
  const bankTarget = targets.find(t => t.url.includes('4173'));

  if (!dashTarget || !bankTarget) {
    throw new Error('Dashboard (5173) or Bank demo (4173) tab not found!');
  }

  const { sessionId: dashSession } = await send('Target.attachToTarget', { targetId: dashTarget.id, flatten: true });
  await send('Page.enable', {}, dashSession);
  await send('Runtime.enable', {}, dashSession);

  const { sessionId: bankSession } = await send('Target.attachToTarget', { targetId: bankTarget.id, flatten: true });
  await send('Page.enable', {}, bankSession);
  await send('Runtime.enable', {}, bankSession);

  // Reload dashboard and bank tab to reconnect extension content script
  console.log('Reloading dashboard tab (5173)...');
  await send('Page.reload', {}, dashSession);
  await new Promise(r => setTimeout(r, 2500));

  console.log('Reloading bank tab (4173)...');
  await send('Page.reload', {}, bankSession);
  await new Promise(r => setTimeout(r, 1500));

  // Verify extension connection
  const extStatus = await send('Runtime.evaluate', {
    expression: '(async () => window.__app?.adapter ? await window.__app.adapter.checkExtensionConnected() : false)()',
    awaitPromise: true,
    returnByValue: true,
  }, dashSession);
  console.log('Extension connected status on dashboard:', extStatus.result?.value);

  // Capture all logs
  const traces = [];
  ws.addEventListener('message', (msg) => {
    try {
      const d = JSON.parse(msg.data);
      if (d.method === 'Runtime.consoleAPICalled') {
        const text = d.params.args.map(a => a.value !== undefined ? (typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value)) : (a.description || '')).join(' ');
        traces.push({ time: Date.now(), text });
        if (text.includes('[AgentTrace]') || text.includes('ACTION_') || text.includes('SCROLL') || text.includes('recovery')) {
          console.log('[CHROME TRACE]', text);
        }
      }
    } catch {}
  });

  // Attach to SW to see extension trace logs directly
  const swTarget = targets.find(t => t.type === 'service_worker' && (t.url.includes('service_worker') || t.url.includes('chrome-extension')));
  if (swTarget) {
    try {
      const { sessionId } = await send('Target.attachToTarget', { targetId: swTarget.id, flatten: true });
      await send('Runtime.enable', {}, sessionId);
      console.log('Attached to extension Service Worker directly.');
    } catch (e) {
      console.log('SW attach notice:', e.message);
    }
  }

  // =========================================================================
  // TEST PART 1: "scroll to the transactions section" at bottom of page
  // =========================================================================
  console.log('\n--- PART 1: TEST INEFFECTIVE SCROLL AT BOTTOM BOUNDARY ---');
  await send('Page.reload', {}, bankSession);
  await new Promise(r => setTimeout(r, 1200));

  // Scroll bank page to bottom
  const scrollHeightRes = await send('Runtime.evaluate', {
    expression: 'window.scrollTo(0, document.body.scrollHeight); window.scrollY;',
    returnByValue: true
  }, bankSession);
  const bottomScrollY = scrollHeightRes.result?.value;
  console.log(`Bank page scrolled to bottom: scrollY = ${bottomScrollY}`);

  console.log('Triggering task: "scroll to the transactions section"');
  await send('Runtime.evaluate', {
    expression: `
      window.__app ? window.__app.adapter.startTask('scroll to the transactions section') :
      window.postMessage({ source: 'privagent-dashboard', type: 'START_TASK', task: 'scroll to the transactions section' }, '*');
    `,
  }, dashSession);

  // Observe for 12 seconds
  console.log('Observing Part 1 for 12 seconds...');
  await new Promise(r => setTimeout(r, 12000));

  // Inspect state
  const dashState1Res = await send('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__app ? window.__app.adapter.getState() : {})',
    returnByValue: true
  }, dashSession);
  const state1 = JSON.parse(dashState1Res.result?.value || '{}');

  console.log('\nPart 1 Final Dashboard State:');
  console.log(`Status: ${state1.status}`);
  console.log(`Steps count: ${state1.steps?.length ?? 0}`);
  console.log(`Reason: ${state1.reason || state1.error || 'N/A'}`);

  // Save screenshot of Part 1
  const screenshot1 = await send('Page.captureScreenshot', {}, dashSession);
  writeFileSync('c:/Users/AKASH/Projects/SEM PROJECT/sem-v/PrivAgent/scratch/part1_scroll_no_effect.png', Buffer.from(screenshot1.data, 'base64'));
  console.log('Saved scratch/part1_scroll_no_effect.png');

  // =========================================================================
  // TEST PART 2: POSITIVE SCROLLING TEST FROM TOP (scrollY = 0)
  // =========================================================================
  console.log('\n--- PART 2: TEST POSITIVE SCROLLING FROM TOP (PROGRESS ALLOWED) ---');
  await send('Page.reload', {}, bankSession);
  await new Promise(r => setTimeout(r, 1200));

  // Ensure scroll is at top
  const topScrollRes = await send('Runtime.evaluate', {
    expression: 'window.scrollTo(0, 0); window.scrollY;',
    returnByValue: true
  }, bankSession);
  console.log(`Bank page at top: scrollY = ${topScrollRes.result?.value}`);

  console.log('Triggering task: "scroll down to view the page"');
  await send('Runtime.evaluate', {
    expression: `
      window.__app ? window.__app.adapter.startTask('scroll down to view the page') :
      window.postMessage({ source: 'privagent-dashboard', type: 'START_TASK', task: 'scroll down to view the page' }, '*');
    `,
  }, dashSession);

  console.log('Observing Part 2 for 8 seconds...');
  await new Promise(r => setTimeout(r, 8000));

  const finalScrollYRes = await send('Runtime.evaluate', {
    expression: 'window.scrollY;',
    returnByValue: true
  }, bankSession);
  console.log(`Bank page scrollY after scrolling: ${finalScrollYRes.result?.value}`);

  const dashState2Res = await send('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__app ? window.__app.adapter.getState() : {})',
    returnByValue: true
  }, dashSession);
  const state2 = JSON.parse(dashState2Res.result?.value || '{}');

  console.log('\nPart 2 Final Dashboard State:');
  console.log(`Status: ${state2.status}`);
  console.log(`Steps count: ${state2.steps?.length ?? 0}`);

  // Save screenshot of Part 2
  const screenshot2 = await send('Page.captureScreenshot', {}, dashSession);
  writeFileSync('c:/Users/AKASH/Projects/SEM PROJECT/sem-v/PrivAgent/scratch/part2_positive_scroll.png', Buffer.from(screenshot2.data, 'base64'));
  console.log('Saved scratch/part2_positive_scroll.png');

  console.log('\n=== REAL CHROME TESTS COMPLETED SUCCESSFULLY ===');
}

runScrollTests().catch(err => {
  console.error('Real Chrome test error:', err);
  process.exit(1);
});
