const body = JSON.stringify({
  task: 'open groq api keys page',
  context: {
    url: 'https://groq.com/',
    title: 'Groq is the premier neocloud for fast inference',
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    detections: [
      { id: '1', role: 'link', text: 'Console', selector: 'a' },
      { id: '2', role: 'link', text: 'API Keys', selector: 'a' }
    ]
  }
});
const res = await fetch('http://127.0.0.1:8010/api/v1/agent/action', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body
});
console.log('Status:', res.status);
console.log('Response:', await res.json());
