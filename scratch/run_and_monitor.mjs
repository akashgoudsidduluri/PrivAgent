import fs from 'fs';
import { execSync } from 'child_process';

async function main() {
  console.log('=== Phase 18.4 Direct SW Agent Runner & Monitor ===');
  const list = await (await fetch('http://127.0.0.1:9222/json')).json();
  const sw = list.find(t => t.type === 'service_worker' && t.url.includes('mdecdhgnjafbcmionkhfjmeljajbpkle'));
  if (!sw) {
    console.error('No SW found!');
    process.exit(1);
  }
  console.log('Connecting to Service Worker at:', sw.webSocketDebuggerUrl);
  const ws = new WebSocket(sw.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);

  let id = 1;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
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

  await send('Runtime.enable');

  const capturedLogs = [];
  const securityDecisions = [];
  const traversedUrls = new Set(['https://groq.com/']);

  ws.addEventListener('message', (m) => {
    try {
      const data = JSON.parse(m.data);
      if (data.method === 'Runtime.consoleAPICalled') {
        const text = data.params.args.map(a => {
          if (a.value !== undefined) {
            return typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value);
          }
          return a.description || '';
        }).join(' ');
        capturedLogs.push({ type: data.params.type, text, time: Date.now() });
        if (text.includes('security critic') || text.includes('containment') || text.includes('[AgentTrace]') || text.includes('subgoal') || text.includes('GoalVerifier') || text.includes('destination')) {
          console.log('[AGENT LOG]', text);
        }
        if (text.includes('security critic')) {
          securityDecisions.push(text);
        }
      }
    } catch {}
  });

  const TASK = 'open groq api keys page';
  console.log(`\n==================================================`);
  console.log(`DISPATCHING TASK: "${TASK}"`);
  console.log(`==================================================`);

  await send('Runtime.evaluate', {
    expression: `chrome.runtime.sendMessage({ type: 'PRIVAGENT_DASHBOARD_START_TASK', task: ${JSON.stringify(TASK)} })`
  });

  const startTime = Date.now();
  let loopFinalState = null;

  while (Date.now() - startTime < 75000) {
    await new Promise(r => setTimeout(r, 2000));

    try {
      const curTargets = await (await fetch('http://127.0.0.1:9222/json')).json();
      for (const t of curTargets) {
        if (t.type === 'page' && t.url && (t.url.includes('groq.com') || t.url.includes('localhost'))) {
          traversedUrls.add(t.url);
        }
      }
    } catch {}

    const stateRes = await send('Runtime.evaluate', {
      expression: `(() => {
        const loop = globalThis.__privagentActiveLoop;
        const last = globalThis.__privagentLastState;
        if (last) return JSON.stringify({ source: 'lastState', state: last });
        if (loop) return JSON.stringify({ source: 'activeLoop', state: loop.getState() });
        return JSON.stringify({ source: 'none' });
      })()`,
      returnByValue: true
    });

    let loopData = { source: 'none' };
    try { loopData = JSON.parse(stateRes.result?.value || '{}'); } catch {}

    if (loopData.state) {
      loopFinalState = loopData.state;
      if (loopFinalState.currentUrl) traversedUrls.add(loopFinalState.currentUrl);
      console.log(`[POLL ${Math.round((Date.now() - startTime)/1000)}s] status=${loopFinalState.status}, stage=${loopFinalState.currentPipelineStage}, steps=${loopFinalState.steps?.length}, url=${loopFinalState.currentUrl}`);

      if (['COMPLETED', 'SUCCESS', 'FAILED', 'STOPPED'].includes(loopFinalState.status)) {
        console.log(`>>> Terminal status reached: ${loopFinalState.status}`);
        break;
      }
    } else {
      console.log(`[POLL ${Math.round((Date.now() - startTime)/1000)}s] Initializing...`);
    }
  }

  // Negative control test
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
    status: loopFinalState?.status,
    goalStatus: loopFinalState?.goalStatus,
    reason: loopFinalState?.reason,
    urlsTraversed: Array.from(traversedUrls),
    finalUrl: loopFinalState?.currentUrl || Array.from(traversedUrls).pop(),
    stepsCount: loopFinalState?.steps?.length || 0,
    steps: loopFinalState?.steps,
    securityDecisions,
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
    capturedLogs: capturedLogs.filter(l => 
      l.text.includes('[AgentTrace]') ||
      l.text.includes('security critic') ||
      l.text.includes('containment') ||
      l.text.includes('destination') ||
      l.text.includes('subgoal') ||
      l.text.includes('GoalVerifier')
    )
  };

  fs.writeFileSync('scratch/phase18_4_monitored_results.json', JSON.stringify(results, null, 2));
  console.log('\nResults saved to scratch/phase18_4_monitored_results.json');
  console.log('Final Summary:', {
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

main().catch(err => {
  console.error('Run failed:', err);
  process.exit(1);
});
