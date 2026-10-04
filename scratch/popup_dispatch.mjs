const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const popup = list.find(t => t.url.includes('popup.html'));
if (!popup) {
  console.error('No popup tab found');
  process.exit(1);
}
console.log('Popup target:', popup.id);
const ws = new WebSocket(popup.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);

ws.send(JSON.stringify({
  id: 1,
  method: 'Runtime.evaluate',
  params: {
    expression: "chrome.runtime.sendMessage({ type: 'PRIVAGENT_DASHBOARD_START_TASK', task: 'open groq api keys page' })",
    returnByValue: true
  }
}));

ws.onmessage = m => {
  const d = JSON.parse(m.data);
  if (d.id === 1) {
    console.log('Result:', d.result);
    ws.close();
  }
};
