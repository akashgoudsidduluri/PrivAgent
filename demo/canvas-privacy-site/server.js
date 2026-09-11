const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.CANVAS_DEMO_PORT || '4174', 10);
const DIRECTORY = __dirname;

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  let filePath = path.join(DIRECTORY, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      res.end(content, 'utf-8');
    }
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`\n[!] Port ${PORT} is already in use by another instance.`);
    console.log(`[*] Canvas Demo site active at http://localhost:${PORT}\n`);
    process.exit(0);
  } else {
    throw e;
  }
});

server.listen(PORT, () => {
  console.log('============================================================');
  console.log('[PrivAgent] Milestone 3 Canvas Privacy Demo (SIH26171, ISRO)');
  console.log(`[*] Local Canvas Demo Portal: http://localhost:${PORT}`);
  console.log(`[*] Directory: ${DIRECTORY}`);
  console.log('============================================================');
});
