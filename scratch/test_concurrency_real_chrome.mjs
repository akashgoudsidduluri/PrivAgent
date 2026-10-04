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

async function runRealChromeConcurrencyTest() {
  console.log('=== REAL CHROME TEST: PHASE 18.1 TASK CONCURRENCY & STALE LOOP REPAIR ===');
  const { ws, send } = await connectCDP();

  // Find all targets
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  console.log('Discovered targets:', targets.map(t => ({ id: t.id, type: t.type, url: t.url })));

  const dashTarget = targets.find(t => t.url.includes('5173'));
  if (!dashTarget) throw new Error('Dashboard tab (5173) not found');

  const bankTarget = targets.find(t => t.url.includes('4173'));
  if (!bankTarget) throw new Error('Bank demo tab (4173) not found');

  // Attach to Dashboard
  const { sessionId: dashSession } = await send('Target.attachToTarget', { targetId: dashTarget.id, flatten: true });
  await send('Page.enable', {}, dashSession);
  await send('Runtime.enable', {}, dashSession);

  // Attach to Bank target
  const { sessionId: bankSession } = await send('Target.attachToTarget', { targetId: bankTarget.id, flatten: true });
  await send('Page.enable', {}, bankSession);
  await send('Runtime.enable', {}, bankSession);

  // Reload Dashboard tab for clean test run
  console.log('Reloading dashboard tab...');
  await send('Page.reload', {}, dashSession);
  await new Promise(r => setTimeout(r, 2500));

  // Reload Bank tab as well
  console.log('Reloading bank tab...');
  await send('Page.reload', {}, bankSession);
  await new Promise(r => setTimeout(r, 1500));

  // Collect console logs
  const dashLogs = [];
  const bankLogs = [];
  const swLogs = [];

  ws.addEventListener('message', (msg) => {
    try {
      const d = JSON.parse(msg.data);
      if (d.method === 'Runtime.consoleAPICalled') {
        const text = d.params.args.map(a => a.value !== undefined ? (typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value)) : (a.description || '')).join(' ');
        const entry = { timestamp: Date.now(), text, type: d.params.type };
        if (d.sessionId === dashSession) {
          dashLogs.push(entry);
          if (text.includes('[AgentTrace]') || text.includes('[Adapter]') || text.includes('TASK')) {
            console.log('[DASHBOARD]', text);
          }
        } else if (d.sessionId === bankSession) {
          bankLogs.push(entry);
          console.log('[BANK TAB]', text);
        } else {
          swLogs.push(entry);
          console.log('[SW/OTHER]', text);
        }
      }
    } catch {}
  });

  // Attach to Service Worker if available
  const swTarget = targets.find(t => t.type === 'service_worker' && t.url.includes('eboamoccjjlamgjcoejbjfpjgnpnlflo'));
  let swSession = null;
  if (swTarget) {
    try {
      const { sessionId } = await send('Target.attachToTarget', { targetId: swTarget.id, flatten: true });
      swSession = sessionId;
      await send('Runtime.enable', {}, swSession);
      console.log('Attached to extension Service Worker target:', swTarget.id);
    } catch (e) {
      console.log('Could not attach to SW target directly (will rely on dashboard/CS relays):', e.message);
    }
  }

  // Verify dashboard adapter is connected
  const extCheck = await send('Runtime.evaluate', {
    expression: 'Boolean(window.__adapter ? window.__adapter.extensionConnected : true)',
    returnByValue: true
  }, dashSession);
  console.log('Extension check:', extCheck.result?.value);

  // Record initial scroll position on bank page
  const initialScroll = await send('Runtime.evaluate', {
    expression: 'window.scrollY',
    returnByValue: true
  }, bankSession);
  console.log('Bank tab initial scrollY:', initialScroll.result?.value);

  // 1. Start Task A: "scroll to the transactions section"
  console.log('\n>>> (1) STARTING TASK A: "scroll to the transactions section"');
  await send('Runtime.evaluate', {
    expression: `
      window.__app ? window.__app.adapter.startTask('scroll to the transactions section') :
      window.postMessage({ source: 'privagent-dashboard', type: 'START_TASK', task: 'scroll to the transactions section' }, '*');
    `,
  }, dashSession);

  // Wait 100ms so Task A is in-flight / target resolving
  await new Promise(r => setTimeout(r, 100));

  // 2. Immediately start Task B: "open the store catalog"
  console.log('\n>>> (2) IMMEDIATELY STARTING TASK B: "open the store catalog"');
  await send('Runtime.evaluate', {
    expression: `
      window.__app ? window.__app.adapter.startTask('open the store catalog') :
      window.postMessage({ source: 'privagent-dashboard', type: 'START_TASK', task: 'open the store catalog' }, '*');
    `,
  }, dashSession);

  // Wait 100ms
  await new Promise(r => setTimeout(r, 100));

  // 3. Immediately start Task C: "search for cats"
  console.log('\n>>> (3) IMMEDIATELY STARTING TASK C: "search for cats"');
  await send('Runtime.evaluate', {
    expression: `
      window.__app ? window.__app.adapter.startTask('search for cats') :
      window.postMessage({ source: 'privagent-dashboard', type: 'START_TASK', task: 'search for cats' }, '*');
    `,
  }, dashSession);

  console.log('\nObserving execution for 15 seconds to monitor all actions and progress...');
  await new Promise(r => setTimeout(r, 15000));

  // Inspect final Dashboard state
  const dashStateRes = await send('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__app ? window.__app.adapter.getState() : {})',
    returnByValue: true
  }, dashSession);
  const dashState = JSON.parse(dashStateRes.result?.value || '{}');

  // Inspect bank page final scroll position
  const finalScroll = await send('Runtime.evaluate', {
    expression: 'window.scrollY',
    returnByValue: true
  }, bankSession);

  // Inspect UI DOM elements
  const uiEvidence = await send('Runtime.evaluate', {
    expression: `(() => {
      const taskEl = document.querySelector('.hero-heading, .active-task, .task-title, #workspace-task-title');
      const stepItems = Array.from(document.querySelectorAll('.timeline-step, .step-item, .activity-step')).map(el => el.textContent.trim());
      const bodyText = document.body.innerText;
      return {
        stepCount: stepItems.length,
        steps: stepItems,
        containsTaskA: bodyText.includes('scroll to the transactions section'),
        containsTaskB: bodyText.includes('open the store catalog'),
        containsTaskC: bodyText.includes('search for cats'),
        containsScrollAction: bodyText.includes('Scroll down') || bodyText.includes('500px')
      };
    })()`,
    returnByValue: true
  }, dashSession);

  // Capture screenshot of Dashboard
  const dashScreenshot = await send('Page.captureScreenshot', { format: 'png' }, dashSession);
  const screenshotPath = 'scratch/concurrency_test_dashboard.png';
  writeFileSync(screenshotPath, Buffer.from(dashScreenshot.data, 'base64'));
  console.log('Saved dashboard screenshot to', screenshotPath);

  // Compile full evidence
  const evidence = {
    test: 'A -> B -> C Rapid Sequence Real Chrome Validation',
    timestamp: new Date().toISOString(),
    initialScrollY: initialScroll.result?.value,
    finalScrollY: finalScroll.result?.value,
    dashboardState: dashState,
    uiEvidence: uiEvidence.result?.value,
    dashLogsCount: dashLogs.length,
    supersededLogs: dashLogs.filter(l => l.text.includes('Superseding') || l.text.includes('Dropping') || l.text.includes('aborted')),
    taskEvents: dashLogs.filter(l => l.text.includes('START_TASK') || l.text.includes('TASK_PROGRESS') || l.text.includes('STOP_TASK')),
  };

  writeFileSync('scratch/concurrency_evidence.json', JSON.stringify(evidence, null, 2), 'utf8');
  console.log('\n=== REAL CHROME VALIDATION RESULTS ===');
  console.log('Active Task on Dashboard:', dashState.task);
  console.log('Active Status:', dashState.status);
  console.log('Step Count in Dashboard State:', dashState.steps?.length);
  console.log('UI contains Task A prompt:', uiEvidence.result?.value.containsTaskA);
  console.log('UI contains Task B prompt:', uiEvidence.result?.value.containsTaskB);
  console.log('UI contains Task C prompt:', uiEvidence.result?.value.containsTaskC);
  console.log('UI contains residual scroll action:', uiEvidence.result?.value.containsScrollAction);
  console.log('Bank page scroll changed:', initialScroll.result?.value !== finalScroll.result?.value);
  console.log('Superseded log entries:', evidence.supersededLogs.map(l => l.text));

  ws.close();
}

runRealChromeConcurrencyTest().catch(console.error);
