async function test() {
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

  console.log('Calling Extensions.loadUnpacked on C:/privagent_dist...');
  try {
    const resLoad = await send('Extensions.loadUnpacked', { path: 'C:/privagent_dist' });
    console.log('loadUnpacked result:', resLoad);
  } catch (e) {
    console.error('loadUnpacked error:', e);
  }

  const t = await send('Target.createTarget', { url: 'chrome://extensions' });
  const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await new Promise(r => setTimeout(r, 2000));
  
  const res = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const mgr = document.querySelector('extensions-manager');
        if (!mgr) return 'No extensions-manager';
        const list = mgr.shadowRoot?.querySelector('extensions-item-list');
        const items = list?.shadowRoot?.querySelectorAll('extensions-item') || [];
        return Array.from(items).map(item => ({
          name: item.shadowRoot?.querySelector('#name')?.textContent?.trim(),
          id: item.id,
          enabled: item.shadowRoot?.querySelector('#enableToggle')?.hasAttribute('checked'),
          errors: item.shadowRoot?.querySelector('#errors-button')?.textContent?.trim() || null
        }));
      })()
    `,
    returnByValue: true
  }, sessionId);
  console.log('Extensions info:', JSON.stringify(res.result?.value, null, 2));
  ws.close();
}
test().catch(console.error);
