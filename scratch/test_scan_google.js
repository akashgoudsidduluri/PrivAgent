// Test Google scan via CDP
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

  const tabQuery = await sendCommand('Runtime.evaluate', {
    expression: 'chrome.tabs.query({ url: "*://*.google.com/*" }).then(t => t[0]?.id)',
    awaitPromise: true,
    returnByValue: true,
  }, swSession);

  const googleTabId = tabQuery.result.value;
  console.log('Google Tab ID:', googleTabId);

  // Navigate to https://www.google.com
  await sendCommand('Runtime.evaluate', {
    expression: `chrome.tabs.update(${googleTabId}, { url: "https://www.google.com" })`,
    awaitPromise: true,
  }, swSession);

  // Wait 3s for Google to load
  await new Promise(r => setTimeout(r, 3000));

  // Send PRIVAGENT_SCAN_REQUEST
  const scanRes = await sendCommand('Runtime.evaluate', {
    expression: `chrome.tabs.sendMessage(${googleTabId}, { type: "PRIVAGENT_SCAN_REQUEST" })`,
    awaitPromise: true,
    returnByValue: true,
  }, swSession);

  console.log('Scan response report status:', scanRes.result?.value?.report?.status);
  console.log('Sensitive elements:', scanRes.result?.value?.report?.sensitiveElementsDetected);
  console.log('Total scanned:', scanRes.result?.value?.report?.totalElementsScanned);
  console.log('Detections sample:', scanRes.result?.value?.report?.detections?.slice(0, 10));

  ws.close();
}

main().catch(console.error);
