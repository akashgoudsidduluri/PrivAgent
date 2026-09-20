async function main() {
  const versionRes = await fetch('http://127.0.0.1:9222/json/version');
  const versionInfo = await versionRes.json();
  const ws = new WebSocket(versionInfo.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);

  let idCounter = 1;
  const pending = new Map();
  function sendCommand(method, params = {}, sessionId = undefined) {
    return new Promise((resolve, reject) => {
      const id = idCounter++;
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify(payload));
    });
  }

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(data.error);
      else resolve(data.result);
    }
  };

  const { targetInfos } = await sendCommand('Target.getTargets');
  const swTarget = targetInfos.find(t => t.type === 'service_worker');
  const { sessionId: swSession } = await sendCommand('Target.attachToTarget', {
    targetId: swTarget.targetId,
    flatten: true,
  });

  const tab = await sendCommand('Runtime.evaluate', {
    expression: 'chrome.tabs.create({ url: "http://localhost:4174/hostile.html" }).then(t => t.id)',
    awaitPromise: true,
    returnByValue: true,
  }, swSession);

  const tabId = tab.result.value;
  await new Promise(r => setTimeout(r, 2000));

  const scan = await sendCommand('Runtime.evaluate', {
    expression: `chrome.tabs.sendMessage(${tabId}, { type: "PRIVAGENT_SCAN_REQUEST" })`,
    awaitPromise: true,
    returnByValue: true,
  }, swSession);

  console.log('Hostile page detections:');
  for (const d of scan.result?.value?.report?.detections || []) {
    console.log(` - [${d.id}] type=${d.type} label="${d.label}" selector="${d.selector}"`);
  }

  ws.close();
}

main().catch(console.error);
