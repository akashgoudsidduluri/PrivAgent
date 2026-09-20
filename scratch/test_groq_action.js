async function main() {
  const versionRes = await fetch('http://127.0.0.1:9222/json/version');
  const versionInfo = await versionRes.json();
  const ws = new WebSocket(versionInfo.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);

  let id = 1;
  const send = (m, p = {}) => new Promise((res) => {
    const curId = id++;
    const h = (e) => { const d = JSON.parse(e.data); if (d.id === curId) { ws.removeEventListener('message', h); res(d.result); } };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: curId, method: m, params: p }));
  });

  const { targetInfos } = await send('Target.getTargets');
  const sw = targetInfos.find(t => t.type === 'service_worker');
  const { sessionId } = await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  const tabs = await send('Runtime.evaluate', {
    expression: 'chrome.tabs.query({ url: "*://*.google.com/*" }).then(t => t[0]?.id)',
    awaitPromise: true, returnByValue: true
  }, sessionId);

  const googleTabId = tabs.result.value;
  const scan = await send('Runtime.evaluate', {
    expression: `chrome.tabs.sendMessage(${googleTabId}, { type: "PRIVAGENT_SCAN_REQUEST" })`,
    awaitPromise: true, returnByValue: true
  }, sessionId);

  const report = scan.result.value.report;
  const detections = report.detections.map(d => ({
    id: d.id,
    type: d.type,
    confidence: d.confidence,
    bbox: { x: d.bbox[0], y: d.bbox[1], width: d.bbox[2], height: d.bbox[3] },
    length: d.length,
    source: d.source,
    selector: d.selector,
    label: d.label || '',
  }));

  const payload = {
    task: 'Search for cats on Google',
    context: {
      url: report.url,
      timestamp: report.timestamp,
      viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
      detections,
      total_elements_scanned: report.totalElementsScanned,
      sensitive_elements_detected: report.sensitiveElementsDetected,
      sanitized_status: 'sanitized_only',
      page_type: 'search',
    },
    history: []
  };

  console.log('Sending to backend with', detections.length, 'detections...');
  const res = await fetch('http://127.0.0.1:8010/api/v1/agent/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  console.log('Backend HTTP status:', res.status);
  console.log('Backend response:', JSON.stringify(data, null, 2));
  ws.close();
}

main().catch(console.error);
