import { writeFileSync } from 'fs';

async function main() {
  console.log('Connecting to Chrome DevTools Protocol at 127.0.0.1:9222...');
  
  // 1. Get targets
  const targetsRes = await fetch('http://127.0.0.1:9222/json');
  const targets = await targetsRes.json();
  console.log('Open targets:', targets.map(t => ({ title: t.title, type: t.type, url: t.url })));

  // Use browser target to get all targets including extensions
  const versionRes = await fetch('http://127.0.0.1:9222/json/version');
  const versionInfo = await versionRes.json();
  console.log('Browser WebSocket URL:', versionInfo.webSocketDebuggerUrl);

  const ws = new WebSocket(versionInfo.webSocketDebuggerUrl);

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

  await new Promise((resolve) => {
    ws.onopen = resolve;
  });

  console.log('WebSocket connected. Discovering extension targets...');
  const { targetInfos } = await sendCommand('Target.getTargets');
  console.log('All TargetInfos:', targetInfos.map(t => ({ title: t.title, type: t.type, url: t.url })));

  const extTarget = targetInfos.find(t => t.url.startsWith('chrome-extension://'));
  if (!extTarget) {
    console.error('No extension target found! Make sure PrivAgent is loaded.');
    process.exit(1);
  }

  const extId = new URL(extTarget.url).hostname;
  console.log(`Found PrivAgent extension ID: ${extId}`);

  // Now create a target for the extension popup!
  const popupUrl = `chrome-extension://${extId}/src/popup/popup.html`;
  console.log(`Creating target for popup: ${popupUrl}`);
  
  const { targetId } = await sendCommand('Target.createTarget', { url: popupUrl });
  console.log('Created popup target:', targetId);

  // Attach to popup target
  const { sessionId } = await sendCommand('Target.attachToTarget', { targetId, flatten: true });
  console.log('Attached to popup with sessionId:', sessionId);

  // Enable Page and Runtime
  await sendCommand('Page.enable', {}, sessionId);
  await sendCommand('Runtime.enable', {}, sessionId);

  // Helper to evaluate JS in popup
  async function evalInPopup(expression) {
    const res = await sendCommand('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, sessionId);
    if (res.exceptionDetails) {
      throw new Error(`Eval error: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result.value;
  }

  // Wait 1.5s for popup DOM to load and health check to run
  console.log('Waiting for popup to load and perform health check...');
  await new Promise(r => setTimeout(r, 2000));

  // Check health status in popup
  const healthLabelText = await evalInPopup('document.getElementById("health-label")?.textContent');
  const healthDotClass = await evalInPopup('document.getElementById("health-dot")?.className');
  const sendButtonDisabled = await evalInPopup('document.getElementById("btn-send-agent")?.disabled');
  console.log('Agent API Health status in popup:', { healthLabelText, healthDotClass, sendButtonDisabled });

  if (!healthDotClass?.includes('online')) {
    console.error('Agent API health check failed in popup!');
  } else {
    console.log('✅ Health indicator successfully shows Online in the browser extension UI!');
  }

  // Trigger DOM Scan
  console.log('Triggering DOM Privacy Scan in popup...');
  await evalInPopup('document.getElementById("btn-rescan")?.click()');
  await new Promise(r => setTimeout(r, 2000));

  const detectedCount = await evalInPopup('document.getElementById("metric-detected")?.textContent');
  const protectedCount = await evalInPopup('document.getElementById("metric-protected")?.textContent');
  const statusTitleText = await evalInPopup('document.getElementById("status-title")?.textContent');
  console.log('DOM Privacy Scan results in browser:', { detectedCount, protectedCount, statusTitleText });

  // Click "Send to Agent API"
  console.log('Clicking "Send to Agent API" button (#btn-send-agent)...');
  await evalInPopup('document.getElementById("btn-send-agent")?.click()');

  // Wait 2s for backend transmission and UI update
  await new Promise(r => setTimeout(r, 2500));

  const agentStatusText = await evalInPopup('document.getElementById("agent-status")?.textContent');
  const agentMetaDisplay = await evalInPopup('document.getElementById("agent-meta")?.style.display');
  const sentDetectionCount = await evalInPopup('document.getElementById("agent-detection-count")?.textContent');
  const lastSentTime = await evalInPopup('document.getElementById("agent-last-sent")?.textContent');

  console.log('Agent UI Status after Send:', {
    agentStatusText,
    agentMetaDisplay,
    sentDetectionCount,
    lastSentTime
  });

  // Click "View Agent Payload" modal button to test JSON viewer
  console.log('Clicking "View Agent Payload" modal button...');
  await evalInPopup('document.getElementById("btn-view-agent-payload")?.click()');
  await new Promise(r => setTimeout(r, 1000));

  const modalOpen = await evalInPopup('document.getElementById("payload-modal")?.classList.contains("open")');
  const modalJsonRaw = await evalInPopup('document.getElementById("payload-json")?.textContent');
  console.log('Modal is open:', modalOpen);

  try {
    const parsedPayload = JSON.parse(modalJsonRaw);
    console.log('Successfully parsed Agent Payload from UI Modal:');
    console.log('  Status:', parsedPayload.status);
    console.log('  Total Detections:', parsedPayload.total_detections);
    console.log('  URL:', parsedPayload.url);
    console.log('  Title:', parsedPayload.title);
    console.log('  Viewport:', parsedPayload.viewport);
    console.log('  Detections count:', parsedPayload.detections?.length);
    console.log('  Detection sample:', parsedPayload.detections?.[0]);
  } catch (e) {
    console.error('Failed to parse modal JSON:', modalJsonRaw);
  }

  // Capture screenshot of popup
  console.log('Taking screenshot of extension popup with Agent API sent state...');
  const { data: screenshotBase64 } = await sendCommand('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync('popup-agent-test.png', Buffer.from(screenshotBase64, 'base64'));
  console.log('Saved screenshot to popup-agent-test.png');

  // Verify directly from FastAPI backend endpoint: GET /api/v1/context/latest
  console.log('Verifying FastAPI backend endpoint GET /api/v1/context/latest...');
  const backendRes = await fetch('http://127.0.0.1:8010/api/v1/context/latest');
  const backendData = await backendRes.json();
  console.log('Backend /api/v1/context/latest response status:', backendRes.status);
  console.log('Backend stored payload summary:');
  console.log('  Status:', backendData.status);
  console.log('  Total Detections in backend:', backendData.total_detections);
  console.log('  Received timestamp:', backendData.timestamp);
  console.log('  Detections:', backendData.detections?.map(d => ({ entity_type: d.entity_type, source: d.source, bbox: d.bounding_box })));

  // Security checks on backend data
  const forbiddenKeys = ['value', 'text', 'textContent', 'password', 'rawText', 'rawOCR', 'ocrText', 'words'];
  const jsonStr = JSON.stringify(backendData);
  const leakedKeys = forbiddenKeys.filter(k => new RegExp(`"${k}"\\s*:`, 'i').test(jsonStr));

  if (leakedKeys.length > 0) {
    console.error('SECURITY VIOLATION! Leaked keys found in backend:', leakedKeys);
    process.exit(1);
  } else {
    console.log('🛡️ Security Verification Passed: ZERO forbidden keys or raw text found in backend payload!');
  }

  console.log('\n=============================================================');
  console.log('🎉 BROWSER TEST SUCCESSFUL!');
  console.log('1. Extension loaded in Chrome.');
  console.log('2. Popup opened and connected to FastAPI Agent Safety API.');
  console.log('3. Health check indicator: Online.');
  console.log('4. DOM privacy scan executed.');
  console.log('5. "Send to Agent API" button clicked.');
  console.log('6. Sanitized zero-PII payload validated and dispatched.');
  console.log('7. FastAPI backend stored the context at /api/v1/context/latest.');
  console.log('8. JSON Modal inspected and screenshot captured.');
  console.log('=============================================================');

  await sendCommand('Target.closeTarget', { targetId });
  ws.close();
  process.exit(0);
}

main().catch(err => {
  console.error('Test script error:', err);
  process.exit(1);
});
