// PrivAgent Synthetic Banking Demo Server (Node.js fallback)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.DEMO_PORT || 4173;
const ROOT = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  let reqPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const safePath = path.normalize(path.join(ROOT, reqPath));

  if (!safePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Access denied');
    return;
  }

  fs.readFile(safePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('File not found');
      return;
    }
    const ext = path.extname(safePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'text/plain',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`============================================================`);
  console.log(`🛡️  PrivAgent Demo Banking Site (Node Server)`);
  console.log(`👉 http://localhost:${PORT}`);
  console.log(`============================================================`);
});
