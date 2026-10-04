async function querySW() {
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const sw = targets.find(t => t.type === 'service_worker');
  const versionInfo = await (await fetch('http://127.0.0.1:9222/json/version')).json();
  const ws = new WebSocket(versionInfo.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 1;
  const send = (m, p = {}, sid) => new Promise((res, rej) => {
    const cid = id++;
    const h = (msg) => {
      const d = JSON.parse(msg.data);
      if (d.id === cid) {
        ws.removeEventListener('message', h);
        if (d.error) rej(d.error); else res(d.result);
      }
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: cid, method: m, params: p, sessionId: sid }));
  });

  const { sessionId } = await send('Target.attachToTarget', { targetId: sw.id, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      try {
        if (typeof activeLoop !== 'undefined' && activeLoop) {
          const s = activeLoop.getState();
          return {
            hasActiveLoop: true,
            status: s.status,
            goalStatus: s.goalStatus,
            currentUrl: s.currentUrl,
            steps: s.steps,
            lastSecurityCritic: s.lastSecurityCritic,
            containmentDecision: s.containmentDecision,
            destinationObservation: s.destinationObservation,
            goalVerificationOutcome: s.goalVerificationOutcome,
            reason: s.reason,
          };
        }
        return { hasActiveLoop: false };
      } catch (e) {
        return { error: String(e) };
      }
    })()`,
    returnByValue: true
  }, sessionId);

  console.log('SW ActiveLoop State:', JSON.stringify(r.result?.value, null, 2));

  // Also query groq tab URL
  const groqTab = targets.find(t => t.url.includes('groq.com') || t.url.includes('console.groq.com'));
  console.log('Live Groq Tab URL in Chrome:', groqTab?.url);

  ws.close();
}
querySW().catch(console.error);
