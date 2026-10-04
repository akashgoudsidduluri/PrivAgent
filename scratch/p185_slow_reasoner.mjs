/**
 * PHASE 18.5 — Controlled slow-reasoner stand-in for the backend.
 *
 * Purpose: deterministically reproduce the WATCHDOG_TIMEOUT condition in REAL
 * Chrome. Reasoning that fails RETRYABLY and SLOWLY is the only state in which
 * the bug is observable, because:
 *
 *   - a single provider attempt is capped at 55s by the AbortController, which
 *     is UNDER the 60s reasoning watchdog window, so it can never trip it;
 *   - three such attempts span ~75-165s, which is OVER the 60s window.
 *
 * So the endpoint sleeps STALL_MS, then returns a retryable 503. The extension
 * sees exactly what it sees from a real backend that is slow and erroring, with
 * no rate-limit luck involved.
 *
 * STALL_MS and PORT are env-configurable. Nothing else is stubbed: the real
 * built extension, the real dashboard, real Chrome and real CDP.
 */
import http from 'http';

const PORT = Number(process.env.STALL_PORT || 8010);
const STALL_MS = Number(process.env.STALL_MS || 25000);

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    if (req.url && req.url.includes('/api/v1/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok', backend_status: 'CONNECTED', reasoner: 'groq',
        reasoner_status: 'AVAILABLE', reasoner_configured: true,
        model: 'openai/gpt-oss-20b', privacy_firewall: 'ACTIVE',
      }));
      return;
    }

    console.log(`[stall] ${new Date().toISOString()} ${req.method} ${req.url} -> sleeping ${STALL_MS}ms then 503 retryable`);
    await new Promise((r) => setTimeout(r, STALL_MS));

    const payload = JSON.stringify({
      detail: {
        success: false,
        reason: `Injected slow retryable stall after ${STALL_MS}ms (Phase 18.5 controlled harness).`,
        error_kind: 'http_server_error',
        retryable: true,
      },
    });
    res.writeHead(503, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
    console.log(`[stall] ${new Date().toISOString()} responded 503`);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[stall] listening on 127.0.0.1:${PORT} stall=${STALL_MS}ms`);
});