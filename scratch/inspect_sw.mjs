async function inspect() {
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
  const { sessionId: sDash } = await send('Target.attachToTarget', { targetId: dash.id, flatten: true });
  const dashState = await send('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__app.adapter.getState())',
    returnByValue: true
  }, sDash);
  console.log('Dashboard State:', JSON.parse(dashState.result?.value || '{}'));

  // Also check service worker
  const sw = targets.find(t => t.type === 'service_worker' && t.url.includes('mdecdhgnjafbcmionkhfjmeljajbpkle'));
  if (sw) {
    const { sessionId: sSW } = await send('Target.attachToTarget', { targetId: sw.id, flatten: true });
    await send('Runtime.enable', {}, sSW);
    const swInfo = await send('Runtime.evaluate', {
      expression: '({ activeRunOwner: typeof activeRunOwner !== "undefined" ? activeRunOwner : null })',
      returnByValue: true
    }, sSW);
    console.log('SW Info:', swInfo.result?.value);
  }

  ws.close();
}
inspect().catch(console.error);
