async function enable() {
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const extTab = targets.find(t => t.url.includes('chrome://extensions'));
  const versionInfo = await (await fetch('http://127.0.0.1:9222/json/version')).json();
  const ws = new WebSocket(versionInfo.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 1;
  const send = (m, p = {}, sid) => new Promise((res) => {
    const cid = id++;
    const h = (msg) => {
      const d = JSON.parse(msg.data);
      if (d.id === cid) {
        ws.removeEventListener('message', h);
        res(d.result);
      }
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: cid, method: m, params: p, sessionId: sid }));
  });

  const { sessionId } = await send('Target.attachToTarget', { targetId: extTab.id, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  const r = await send('Runtime.evaluate', {
    expression: "new Promise(res => chrome.management.setEnabled('mdecdhgnjafbcmionkhfjmeljajbpkle', true, () => res(chrome.runtime.lastError || 'ok')))",
    awaitPromise: true,
    returnByValue: true
  }, sessionId);
  console.log('Update result:', r);

  const infoRes = await send('Runtime.evaluate', {
    expression: "new Promise(res => chrome.developerPrivate.getExtensionsInfo(res))",
    awaitPromise: true,
    returnByValue: true
  }, sessionId);
  const pa = infoRes.result.value.find(e => e.id === 'mdecdhgnjafbcmionkhfjmeljajbpkle');
  console.log('State now:', pa?.state);

  ws.close();
}
enable().catch(console.error);
