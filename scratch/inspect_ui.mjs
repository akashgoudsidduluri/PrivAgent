async function checkText() {
  const versionInfo = await (await fetch('http://127.0.0.1:9222/json/version')).json();
  const ws = new WebSocket(versionInfo.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 1;
  const send = (method, params = {}, sessionId = undefined) => new Promise((res, rej) => {
    const curId = id++;
    const handler = (msg) => {
      const d = JSON.parse(msg.data);
      if (d.id === curId) {
        ws.removeEventListener('message', handler);
        if (d.error) rej(d.error); else res(d.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id: curId, method, params, sessionId }));
  });

  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const dashTarget = targets.find(t => t.url.includes('5173'));
  const { sessionId: dashSession } = await send('Target.attachToTarget', { targetId: dashTarget.id, flatten: true });
  await send('Runtime.enable', {}, dashSession);

  const res = await send('Runtime.evaluate', {
    expression: 'document.querySelector(".activity-timeline") ? document.querySelector(".activity-timeline").innerText : "none"',
    returnByValue: true
  }, dashSession);
  console.log('Activity timeline text:', res.result?.value);

  const state = await send('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__app.adapter.getState())',
    returnByValue: true
  }, dashSession);
  console.log('Adapter state:', state.result?.value);

  ws.close();
}
checkText().catch(console.error);
