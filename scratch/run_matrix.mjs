import { writeFileSync, appendFileSync } from 'fs';

const OUT_FILE = 'scratch/observation_results.json';
const REPORT_FILE = 'scratch/observation_report.md';

function logReport(text) {
  console.log(text);
  appendFileSync(REPORT_FILE, text + '\n', 'utf8');
}

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

async function main() {
  writeFileSync(REPORT_FILE, '# PrivAgent Phase 18 — Behavioral Observation Report\n\n', 'utf8');
  console.log('Connecting to Chrome via CDP...');
  const { ws, send } = await connectCDP();

  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  console.log('Found targets:', targets.map(t => ({ id: t.id, title: t.title, url: t.url })));

  const dashTarget = targets.find(t => t.url.includes('5173'));
  if (!dashTarget) throw new Error('Dashboard (5173) target not found!');

  let targetTab = targets.find(t => t.url.includes('4173') || t.url.includes('4174'));
  if (!targetTab) {
    targetTab = targets.find(t => t.type === 'page' && !t.url.includes('5173'));
  }
  console.log(`Dashboard: ${dashTarget.id}, Target Tab: ${targetTab?.id} (${targetTab?.url})`);

  // Attach to Dashboard
  const { sessionId: dashSession } = await send('Target.attachToTarget', { targetId: dashTarget.id, flatten: true });
  await send('Page.enable', {}, dashSession);
  await send('Runtime.enable', {}, dashSession);

  // Attach to Target Tab
  let targetSession = null;
  if (targetTab) {
    const { sessionId } = await send('Target.attachToTarget', { targetId: targetTab.id, flatten: true });
    targetSession = sessionId;
    await send('Page.enable', {}, targetSession);
    await send('Runtime.enable', {}, targetSession);
  }

  async function evalInDash(expr) {
    const res = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    }, dashSession);
    if (res.exceptionDetails) {
      throw new Error(`Dash eval error: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result.value;
  }

  async function navigateTarget(url) {
    if (!targetSession) return;
    console.log(`Navigating target tab to: ${url}`);
    await send('Page.navigate', { url }, targetSession);
    await new Promise(r => setTimeout(r, 1200));
  }

  async function getTargetUrl() {
    if (!targetSession) return '';
    const res = await send('Runtime.evaluate', { expression: 'window.location.href', returnByValue: true }, targetSession);
    return res.result.value || '';
  }

  // Set up message interception on dashboard to capture exact TASK_PROGRESS payloads
  await evalInDash(`
    window.__capturedEvents = [];
    window.__lastProgress = null;
    window.addEventListener('message', (e) => {
      if (e.data && e.data.source === 'privagent-extension' && e.data.type === 'TASK_PROGRESS') {
        window.__capturedEvents.push(e.data.payload);
        window.__lastProgress = e.data.payload;
      }
    });
  `);

  async function executeTaskAndObserve(taskName, category, targetStartUrl, maxWaitMs = 12000) {
    logReport(`--------------------------------------------------`);
    logReport(`TASK: "${taskName}"`);
    logReport(`CATEGORY: ${category}`);

    if (targetStartUrl) {
      await navigateTarget(targetStartUrl);
    }
    const currentUrl = await getTargetUrl();
    logReport(`START STATE:\nURL: ${currentUrl}`);

    // Reset dash message accumulator
    await evalInDash(`window.__capturedEvents = []; window.__lastProgress = null;`);

    // Reset via New Task button
    await evalInDash(`document.getElementById('sidebar-btn-new-task')?.click();`);
    await new Promise(r => setTimeout(r, 400));

    // Fill composer input
    await evalInDash(`
      (() => {
        const input = document.getElementById('composer-input');
        if (input) {
          input.value = ${JSON.stringify(taskName)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      })()
    `);
    await new Promise(r => setTimeout(r, 300));

    // Click Run
    await evalInDash(`document.getElementById('composer-btn-run')?.click();`);
    console.log(`Started task "${taskName}". Waiting for execution...`);

    // Poll until terminal state or timeout
    const startTime = Date.now();
    let lastStatus = 'RUNNING';
    let progressData = null;

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise(r => setTimeout(r, 800));
      progressData = await evalInDash(`window.__lastProgress`);
      lastStatus = progressData?.status || 'RUNNING';

      if (lastStatus === 'SUCCESS' || lastStatus === 'FAILED' || lastStatus === 'STOPPED' || lastStatus === 'NEEDS_USER_CONFIRMATION') {
        break;
      }
    }

    // Capture final DOM state from UI
    const uiState = await evalInDash(`
      (() => {
        const badge = document.querySelector('.agent-status-badge');
        const liveSummary = document.querySelector('.agent-live-summary-bar span:last-child');
        const stepCounter = document.querySelector('.summary-step-counter');
        const finalHeadline = document.querySelector('.final-headline-group span');
        const finalProse = document.querySelector('.final-summary-prose');
        const destBadge = document.querySelector('.destination-verified-badge');
        const browserUrl = document.querySelector('.status-info-card .metric-val.mono');
        const timelineEntries = Array.from(document.querySelectorAll('.timeline-entry')).map(e => ({
          title: e.querySelector('.timeline-title')?.textContent?.trim() || '',
          badge: e.querySelector('.timeline-badge')?.textContent?.trim() || '',
          detail: e.querySelector('.timeline-details-text')?.textContent?.trim() || ''
        }));

        return {
          statusBadge: badge?.textContent?.trim() || '',
          statusClass: badge?.className || '',
          liveSummary: liveSummary?.textContent?.trim() || '',
          stepCounter: stepCounter?.textContent?.trim() || '',
          finalHeadline: finalHeadline?.textContent?.trim() || '',
          finalProse: finalProse?.textContent?.trim() || '',
          destBadge: destBadge?.textContent?.trim() || '',
          browserUrl: browserUrl?.textContent?.trim() || '',
          timelineEntries
        };
      })()
    `);

    // Extract runtime events
    const allEvents = await evalInDash(`window.__capturedEvents || []`);
    const finalEvent = progressData || (allEvents.length ? allEvents[allEvents.length - 1] : null);

    // Format fields
    const steps = finalEvent?.steps || [];
    logReport(`\nACTION TRACE:`);
    if (steps.length === 0) {
      logReport(`(No actions dispatched)`);
    } else {
      steps.forEach((s, idx) => {
        logReport(`${idx + 1}. Action: ${s.action?.action || s.actionType || 'unknown'} | Target: ${s.action?.target || s.targetDescription || 'none'} | Success: ${s.executionSuccess} | Reason: ${s.action?.reason || s.validationReason || 'none'}`);
      });
    }

    logReport(`\nRECOVERY:`);
    const recoveries = steps.filter(s => s.selfHealing?.recovered || s.selfHealingRecovered);
    if (recoveries.length === 0) {
      logReport(`attempt 0: none required`);
    } else {
      recoveries.forEach((r, i) => logReport(`attempt ${i + 1}: ${r.selfHealing?.diagnosis || 'recovered target'}`));
    }

    logReport(`\nDESTINATION:`);
    logReport(`declared: ${finalEvent?.plan?.goal || finalEvent?.destinationDeclaration || taskName}`);
    logReport(`observed: ${finalEvent?.currentUrl || currentUrl}`);
    const destVerified = finalEvent?.destinationVerified || Boolean(uiState.destBadge);
    logReport(`verification: ${destVerified ? 'MATCH' : 'PENDING/UNKNOWN'}`);
    logReport(`final: ${destVerified ? 'VERIFIED' : 'UNVERIFIED'}`);

    logReport(`\nGOAL:`);
    logReport(`final verifier: GoalVerifier`);
    logReport(`final status: ${finalEvent?.status || lastStatus}`);

    logReport(`\nPROVIDER:`);
    logReport(`requests: ${allEvents.length}`);
    logReport(`errors: ${finalEvent?.status === 'FAILED' ? (finalEvent?.reason || uiState.finalProse || 'None reported') : 'none'}`);
    logReport(`retry: 0`);
    logReport(`terminal: ${finalEvent?.status || lastStatus}`);

    logReport(`\nUI:`);
    logReport(`status shown: ${uiState.statusBadge}`);
    logReport(`timeline shown: ${uiState.timelineEntries.length} entries`);
    logReport(`destination shown: ${uiState.destBadge || 'None'}`);
    logReport(`browser context shown: ${uiState.browserUrl}`);
    logReport(`final response shown: ${uiState.finalHeadline ? uiState.finalHeadline + ' - ' + uiState.finalProse : 'None'}`);

    const runtimeStatus = finalEvent?.status || 'UNKNOWN';
    const uiStatus = uiState.statusBadge.toUpperCase();
    const isMatch = (runtimeStatus === 'SUCCESS' && uiStatus.includes('SUCCESS')) ||
                    (runtimeStatus === 'FAILED' && uiStatus.includes('FAILED')) ||
                    (runtimeStatus === 'RUNNING' && uiStatus.includes('WORKING')) ||
                    (runtimeStatus === 'NEEDS_USER_CONFIRMATION' && uiStatus.includes('CONFIRMATION'));

    logReport(`\nTRUTHFULNESS:\n${isMatch ? 'MATCH' : 'MISMATCH'}`);

    let suspectedLayer = 'none';
    if (finalEvent?.status === 'FAILED') {
      const r = (finalEvent.reason || '').toLowerCase();
      if (r.includes('text-safety') || r.includes('person_name') || r.includes('provider') || r.includes('reasoning unavailable')) {
        suspectedLayer = 'provider / text-safety';
      } else if (r.includes('destination') || r.includes('mismatch')) {
        suspectedLayer = 'destination verification';
      } else if (r.includes('timeout')) {
        suspectedLayer = 'provider';
      } else if (r.includes('scroll') || r.includes('no-effect')) {
        suspectedLayer = 'execution / recovery';
      } else {
        suspectedLayer = 'goal verification / action selection';
      }
    } else if (finalEvent?.status === 'SUCCESS') {
      suspectedLayer = 'expected behavior';
    }
    logReport(`SUSPECTED LAYER:\n${suspectedLayer}\n`);

    return {
      task: taskName,
      category,
      runtimeStatus,
      uiStatus,
      destVerified,
      stepsCount: steps.length,
      match: isMatch,
      suspectedLayer,
      reason: finalEvent?.reason || uiState.finalProse || ''
    };
  }

  const results = [];

  // CATEGORY A — SIMPLE NAVIGATION
  results.push(await executeTaskAndObserve('open the store catalog', 'CATEGORY A — SIMPLE NAVIGATION', 'http://localhost:4174/'));
  results.push(await executeTaskAndObserve('open groq api keys page', 'CATEGORY A — SIMPLE NAVIGATION', 'http://localhost:4174/'));
  results.push(await executeTaskAndObserve('open the account details', 'CATEGORY A — SIMPLE NAVIGATION', 'http://localhost:4173/'));

  // CATEGORY B — SEARCH / NAVIGATION
  results.push(await executeTaskAndObserve('search for deathnote', 'CATEGORY B — SEARCH / NAVIGATION', 'http://localhost:4174/'));
  results.push(await executeTaskAndObserve('search for cats and open any result', 'CATEGORY B — SEARCH / NAVIGATION', 'http://localhost:4174/'));
  results.push(await executeTaskAndObserve('search the store for shoes', 'CATEGORY B — SEARCH / NAVIGATION', 'http://localhost:4174/'));

  // CATEGORY C — SCROLL / FIND INFORMATION
  results.push(await executeTaskAndObserve('scroll to the transactions section', 'CATEGORY C — SCROLL / FIND INFORMATION', 'http://localhost:4173/'));
  results.push(await executeTaskAndObserve('find recent transactions', 'CATEGORY C — SCROLL / FIND INFORMATION', 'http://localhost:4173/'));
  results.push(await executeTaskAndObserve('scroll to the bottom of the page', 'CATEGORY C — SCROLL / FIND INFORMATION', 'http://localhost:4173/'));
  results.push(await executeTaskAndObserve('find the customer identification section', 'CATEGORY C — SCROLL / FIND INFORMATION', 'http://localhost:4173/'));

  // CATEGORY D — MULTI-STEP TASKS
  results.push(await executeTaskAndObserve('open the account details and find recent transactions', 'CATEGORY D — MULTI-STEP TASKS', 'http://localhost:4173/'));
  results.push(await executeTaskAndObserve('open the store catalog and find a product', 'CATEGORY D — MULTI-STEP TASKS', 'http://localhost:4174/'));
  results.push(await executeTaskAndObserve('search for a product and open its details', 'CATEGORY D — MULTI-STEP TASKS', 'http://localhost:4174/'));

  // CATEGORY E — ALREADY-SATISFIED TASKS
  results.push(await executeTaskAndObserve('open the store catalog', 'CATEGORY E — ALREADY-SATISFIED TASKS', 'http://localhost:4174/'));
  results.push(await executeTaskAndObserve('find recent transactions', 'CATEGORY E — ALREADY-SATISFIED TASKS', 'http://localhost:4173/'));
  results.push(await executeTaskAndObserve('open the store catalog', 'CATEGORY E — ALREADY-SATISFIED TASKS', 'http://localhost:4174/'));

  // CATEGORY F — WRONG DESTINATION
  results.push(await executeTaskAndObserve('open the store catalog', 'CATEGORY F — WRONG DESTINATION', 'http://localhost:4173/'));
  results.push(await executeTaskAndObserve('open the account details', 'CATEGORY F — WRONG DESTINATION', 'http://localhost:4174/'));

  // CATEGORY G — PROVIDER FAILURE
  results.push(await executeTaskAndObserve('execute impossible secret token operation', 'CATEGORY G — PROVIDER FAILURE', 'http://localhost:4173/'));
  results.push(await executeTaskAndObserve('query backend with invalid entity action', 'CATEGORY G — PROVIDER FAILURE', 'http://localhost:4173/'));

  // CATEGORY H — NEW TASK RESET
  logReport('=== CATEGORY H — SEQUENTIAL RESET RUN ===');
  results.push(await executeTaskAndObserve('open the store catalog', 'CATEGORY H — NEW TASK RESET (1)', 'http://localhost:4174/'));
  results.push(await executeTaskAndObserve('open the account details', 'CATEGORY H — NEW TASK RESET (2)', 'http://localhost:4173/'));
  results.push(await executeTaskAndObserve('search for cats', 'CATEGORY H — NEW TASK RESET (3)', 'http://localhost:4174/'));

  writeFileSync(OUT_FILE, JSON.stringify(results, null, 2), 'utf8');
  console.log(`Saved all ${results.length} observations to ${OUT_FILE} and ${REPORT_FILE}.`);

  ws.close();
}

main().catch(err => {
  console.error('Fatal error in observation script:', err);
  process.exit(1);
});
