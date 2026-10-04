const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const ext = list.find(t => t.url.includes('chrome://extensions'));
const ws = new WebSocket(ext.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 1;
const send = (m, p = {}) => new Promise((res, rej) => {
  const cur = id++;
  ws.addEventListener('message', function h(msg) {
    const d = JSON.parse(msg.data);
    if (d.id === cur) {
      ws.removeEventListener('message', h);
      if (d.error) rej(d.error); else res(d.result);
    }
  });
  ws.send(JSON.stringify({ id: cur, method: m, params: p }));
});

await send('Runtime.evaluate', {
  expression: "chrome.developerPrivate.reload('mdecdhgnjafbcmionkhfjmeljajbpkle')"
});
await new Promise(r => setTimeout(r, 1200));
const r = await send('Runtime.evaluate', {
  expression: "new Promise(res => chrome.management.setEnabled('mdecdhgnjafbcmionkhfjmeljajbpkle', true, () => res('enabled')))",
  awaitPromise: true,
  returnByValue: true
});
console.log('Result:', r.result?.value);
ws.close();
