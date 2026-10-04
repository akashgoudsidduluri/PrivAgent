const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const sw = list.find(t => t.type === 'service_worker' && t.url.includes('mdecdhgnjafbcmionkhfjmeljajbpkle'));
if (!sw) {
  console.error('No SW found!');
  process.exit(1);
}
console.log('Connecting to SW at', sw.webSocketDebuggerUrl);
const ws = new WebSocket(sw.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);

ws.send(JSON.stringify({
  id: 1,
  method: 'Runtime.evaluate',
  params: {
    expression: "chrome.runtime.sendMessage({ type: 'PRIVAGENT_DASHBOARD_START_TASK', task: 'open groq api keys page' })",
    awaitPromise: true,
    returnByValue: true
  }
}));

ws.onmessage = m => {
  console.log('Response from SW:', m.data);
  ws.close();
};
