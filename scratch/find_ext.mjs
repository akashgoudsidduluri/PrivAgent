import WebSocket from 'ws';

async function run() {
  const v = await fetch('http://127.0.0.1:9222/json/version').then(r => r.json());
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));

  let msgId = 0;
  function send(method, params = {}, sessionId = undefined) {
    return new Promise((resolve) => {
      const id = ++msgId;
      const handler = (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          ws.off('message', handler);
          resolve(msg.result);
        }
      };
      ws.on('message', handler);
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
    });
  }

  const { targetInfos } = await send('Target.getTargets');
  const extTab = targetInfos.find(t => t.url && t.url.includes('chrome://extensions'));
  console.log('Extensions Tab:', extTab?.targetId);

  if (extTab) {
    const { sessionId } = await send('Target.attachToTarget', { targetId: extTab.targetId, flatten: true });
    const res = await send('Runtime.evaluate', {
      expression: `(() => {
        const manager = document.querySelector('extensions-manager');
        const itemList = manager?.shadowRoot?.querySelector('extensions-item-list');
        const items = itemList?.shadowRoot?.querySelectorAll('extensions-item');
        return Array.from(items || []).map(i => {
          const name = i.shadowRoot?.querySelector('#name')?.textContent?.trim();
          const reloadBtn = i.shadowRoot?.querySelector('#dev-reload-button');
          if (reloadBtn) reloadBtn.click();
          return { id: i.id, name, reloaded: Boolean(reloadBtn) };
        });
      })()`,
      returnByValue: true
    }, sessionId);
    console.log('Extensions:', res?.result?.value);
  }

  // Check targets again
  await new Promise(r => setTimeout(r, 1000));
  const targets2 = await send('Target.getTargets');
  const sw = targets2.targetInfos.filter(t => t.type === 'service_worker');
  console.log('Service Workers:', sw.map(t => [t.title, t.url]));

  ws.close();
}

run().catch(console.error);
