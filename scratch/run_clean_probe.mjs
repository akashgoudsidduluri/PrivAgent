import WebSocket from 'ws';

async function main() {
  const listResp = await fetch('http://127.0.0.1:9222/json/list');
  const targets = await listResp.json();
  const dashTarget = targets.find(t => t.url.includes('localhost:5173'));
  const targetTab = targets.find(t => t.url.includes('localhost:4173') || t.url.includes('localhost:4174') || t.url.includes('groq.com'));

  if (!dashTarget) {
    console.error('Dashboard target not found!');
    process.exit(1);
  }

  const ws = new WebSocket(dashTarget.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });

  let idCounter = 1;
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = idCounter++;
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      const handler = (raw) => {
        const data = JSON.parse(raw.toString());
        if (data.id === id) {
          ws.off('message', handler);
          if (data.error) reject(data.error);
          else resolve(data.result);
        }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify(msg));
    });
  }

  const { sessionId: dashSession } = await send('Target.attachToTarget', { targetId: dashTarget.id, flatten: true });
  await send('Page.enable', {}, dashSession);
  await send('Runtime.enable', {}, dashSession);

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
    await new Promise(r => setTimeout(r, 1500));
  }

  async function runCleanTask(taskPrompt, startUrl, maxWaitMs = 25000) {
    console.log(`\n==================================================`);
    console.log(`STARTING CLEAN TASK: "${taskPrompt}"`);
    console.log(`START URL: ${startUrl}`);

    if (startUrl) {
      await navigateTarget(startUrl);
    }

    // 1. Force stop any lingering task
    await evalInDash(`
      (() => {
        const stopBtn = document.getElementById('composer-btn-stop');
        if (stopBtn && stopBtn.style.display !== 'none') {
          stopBtn.click();
        }
      })()
    `);
    await new Promise(r => setTimeout(r, 1000));

    // Reset captured events
    await evalInDash(`
      window.__capturedEvents = [];
      window.__lastProgress = null;
      if (!window.__hasMatrixListener) {
        window.__hasMatrixListener = true;
        window.addEventListener('message', (e) => {
          if (e.data && e.data.source === 'privagent-extension' && e.data.type === 'TASK_PROGRESS') {
            window.__capturedEvents.push(e.data.payload);
            window.__lastProgress = e.data.payload;
          }
        });
      }
    `);

    // Reset via New Task button
    await evalInDash(`document.getElementById('sidebar-btn-new-task')?.click();`);
    await new Promise(r => setTimeout(r, 500));

    // Set composer text
    await evalInDash(`
      (() => {
        const input = document.getElementById('composer-input');
        if (input) {
          input.value = ${JSON.stringify(taskPrompt)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      })()
    `);
    await new Promise(r => setTimeout(r, 400));

    // Click Run
    await evalInDash(`document.getElementById('composer-btn-run')?.click();`);
    console.log(`Dispatched task. Monitoring execution...`);

    const startTime = Date.now();
    let finalPayload = null;

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise(r => setTimeout(r, 1000));
      const payload = await evalInDash(`window.__lastProgress`);
      if (payload) {
        finalPayload = payload;
        process.stdout.write(`[${Math.round((Date.now()-startTime)/1000)}s: ${payload.status} (step ${payload.currentStep || 0}/${payload.maxSteps || 10})] `);
        if (payload.status === 'SUCCESS' || payload.status === 'FAILED' || payload.status === 'STOPPED') {
          console.log(`\nTerminal state reached: ${payload.status}`);
          break;
        }
      } else {
        process.stdout.write(`.`);
      }
    }
    console.log('');

    // Capture UI final state
    const uiState = await evalInDash(`
      (() => {
        const badge = document.querySelector('.agent-status-badge');
        const headline = document.querySelector('.final-headline-group span');
        const prose = document.querySelector('.final-summary-prose');
        const destBadge = document.querySelector('.destination-verified-badge');
        const browserUrl = document.querySelector('.status-info-card .metric-val.mono');
        const timeline = Array.from(document.querySelectorAll('.timeline-entry')).map(e => ({
          title: e.querySelector('.timeline-title')?.textContent?.trim() || '',
          badge: e.querySelector('.timeline-badge')?.textContent?.trim() || '',
          detail: e.querySelector('.timeline-details-text')?.textContent?.trim() || ''
        }));
        return {
          status: badge?.textContent?.trim() || '',
          headline: headline?.textContent?.trim() || '',
          prose: prose?.textContent?.trim() || '',
          destVerified: destBadge?.textContent?.trim() || '',
          browserUrl: browserUrl?.textContent?.trim() || '',
          timeline
        };
      })()
    `);

    // Print summary
    console.log(`--- RUNTIME TELEMETRY ---`);
    console.log(`Status: ${finalPayload?.status || 'TIMEOUT'}`);
    console.log(`Reason: ${finalPayload?.reason || 'none'}`);
    console.log(`Steps count: ${finalPayload?.steps?.length || 0}`);
    (finalPayload?.steps || []).forEach((s, i) => {
      console.log(`  Step ${i + 1}: ${s.action?.action || s.actionType} | Target: ${s.action?.target || 'none'} | Success: ${s.executionSuccess} | Reason: ${s.action?.reason || s.validationReason}`);
    });
    console.log(`--- UI STATE ---`);
    console.log(`UI Status: ${uiState.status}`);
    console.log(`UI Headline: ${uiState.headline}`);
    console.log(`UI Prose: ${uiState.prose}`);
    console.log(`UI Dest Verified: ${uiState.destVerified || 'Not Verified'}`);
    console.log(`UI Browser URL: ${uiState.browserUrl}`);
    console.log(`UI Timeline Entries: ${uiState.timeline.length}`);
    uiState.timeline.forEach((t, i) => console.log(`  Timeline ${i + 1}: [${t.badge}] ${t.title} - ${t.detail}`));

    return { taskPrompt, finalPayload, uiState };
  }

  // 1. Scroll investigation
  await runCleanTask('scroll to the transactions section', 'http://localhost:4173/');

  // 2. Groq API keys investigation
  await runCleanTask('open groq api keys page', 'http://localhost:4173/');

  // 3. Store catalog navigation
  await runCleanTask('open the store catalog', 'http://localhost:4173/');

  // 4. Multi-step task
  await runCleanTask('open the account details and find recent transactions', 'http://localhost:4173/');

  ws.close();
}

main().catch(console.error);
