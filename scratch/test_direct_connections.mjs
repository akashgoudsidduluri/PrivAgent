async function connectToTarget(predicate) {
  const list = await (await fetch('http://127.0.0.1:9222/json')).json();
  const target = list.find(predicate);
  if (!target) return null;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 1;
  const call = (method, params = {}) => new Promise((resolve, reject) => {
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
  return { ws, target, call };
}

(async () => {
  const dash = await connectToTarget(t => t.url.includes('5173'));
  console.log('Dash connected:', dash.target.title);
  const evalDash = await dash.call('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
  console.log('Dash title:', evalDash.result?.value);
  dash.ws.close();

  const sw = await connectToTarget(t => t.type === 'service_worker' && t.url.includes('mdecdhgnjafbcmionkhfjmeljajbpkle'));
  console.log('SW connected:', sw?.target.url);
  if (sw) {
    const evalSw = await sw.call('Runtime.evaluate', { expression: 'typeof globalThis', returnByValue: true });
    console.log('SW globalThis:', evalSw.result?.value);
    sw.ws.close();
  }
})();
