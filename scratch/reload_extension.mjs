async function reloadExt() {
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
  const extTab = targets.find(t => t.url.includes('chrome://extensions'));
  if (extTab) {
    const { sessionId } = await send('Target.attachToTarget', { targetId: extTab.id, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    const exts = await send('Runtime.evaluate', {
      expression: 'new Promise(r => chrome.developerPrivate.getExtensionsInfo(r))',
      awaitPromise: true,
      returnByValue: true
    }, sessionId);
    const privAgent = exts.result.value?.find(e => e.name?.includes('PrivAgent'));
    console.log('PrivAgent extension:', privAgent?.id, privAgent?.name);
    if (privAgent) {
      await send('Runtime.evaluate', {
        expression: `chrome.developerPrivate.reload('${privAgent.id}')`,
        awaitPromise: true
      }, sessionId);
      console.log('PrivAgent reloaded successfully!');
    }
  }
  ws.close();
}
reloadExt().catch(console.error);
