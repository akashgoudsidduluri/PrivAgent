/**
 * Minimal target fixture for the START_TASK localhost-port real-Chrome check.
 *
 * Served on the port the user asked the agent to work on. Contains a heading and
 * a form so initial perception has real elements to perceive.
 */
import http from 'http';

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Target Fixture</title></head>
<body>
  <h1 id="heading">Contact Form</h1>
  <form id="contact-form">
    <label for="name">Full Name</label>
    <input id="name" name="name" type="text">
    <label for="email">Email</label>
    <input id="email" name="email" type="email">
    <button id="submit" type="button">Submit</button>
  </form>
</body></html>`;

export function serveTargetFixture(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/' || req.url.startsWith('/index')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
    server.on('error', reject);
    // Bind the loopback family the user named: localhost covers 127.0.0.1 here.
    server.listen(port, () => resolve(server));
  });
}
