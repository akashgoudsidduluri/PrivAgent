// Helper to probe Chrome CDP
const http = require('http');

async function getTargets() {
  const res = await fetch('http://127.0.0.1:9222/json');
  return await res.json();
}

async function main() {
  const targets = await getTargets();
  console.log('Targets:', targets.map(t => ({ id: t.id, type: t.type, title: t.title, url: t.url })));
}

main().catch(console.error);
