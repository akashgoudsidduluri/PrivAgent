/** Shared CDP + server utilities for the Phase 16 harnesses. */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(__filename), '..');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const CHROME_BIN =
  process.env.PRIVAGENT_CHROME_BIN ||
  path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');
export const PYTHON = path.join(REPO_ROOT, 'backend', '.venv', 'bin', 'python');

export function cdpGet(port, endpoint, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: endpoint, method }, (res) => {
      let raw = '';
      res.on('data', (d) => (raw += d));
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('non-JSON')); } });
    });
    req.on('error', reject);
    req.end();
  });
}

export class Session {
  constructor(ws, sessionId) {
    this.ws = ws; this.sessionId = sessionId; this.id = 0; this.pending = new Map();
    this.logs = []; this.onEvent = null;
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const e = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(e.t);
        m.error ? e.reject(new Error(JSON.stringify(m.error))) : e.resolve(m.result);
      } else if (m.method) {
        if (m.method === 'Runtime.consoleAPICalled') {
          try { this.logs.push({ level: m.params.type, text: (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ') }); } catch {}
        }
        if (this.onEvent) this.onEvent(m);
      }
    };
  }
  send(method, params = {}, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const t = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} timeout`)); } }, timeoutMs);
      this.pending.set(id, { resolve, reject, t });
      const p = { id, method, params };
      if (this.sessionId) p.sessionId = this.sessionId;
      this.ws.send(JSON.stringify(p));
    });
  }
  async evaluate(expression, { awaitPromise = true, timeoutMs = 60000 } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

export async function openSession(u) {
  const ws = new globalThis.WebSocket(u);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')); });
  return new Session(ws);
}

export function serveStatic(port, rootDir) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0]);
    let file = path.join(rootDir, p === '/' ? 'index.html' : p);
    if (!file.startsWith(rootDir)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
    return undefined;
  });
  return new Promise((resolve) => server.listen(port, '0.0.0.0', () => resolve(server)));
}

export function startBackend(port, logPath) {
  const fd = fs.openSync(logPath, 'w');
  const proc = spawn(PYTHON, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port)],
    { cwd: path.join(REPO_ROOT, 'backend'), stdio: ['ignore', fd, fd] });
  return { proc, fd };
}

export async function waitForBackend(port, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      const s = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/openapi.json' }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
        req.on('error', reject); req.end();
      });
      if (s === 200) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

export function launchChrome(cdpPort, extraArgs = []) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'privagent-p16-'));
  const proc = spawn(CHROME_BIN, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--window-size=1280,900', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--proxy-bypass-list=*',
    ...extraArgs, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  return { proc, profile };
}

export function readReasonerConfig() {
  const r = spawnSync(PYTHON, ['-c', [
    'import sys; sys.path.insert(0,".")',
    'from app import config',
    'from app.reasoner import build_reasoner, resolve_reasoner_name',
    'n=resolve_reasoner_name(config.REASONER_MODE); r=build_reasoner(n)',
    'print(config.REASONER_MODE, config.has_api_key("groq"), config.GROQ_MODEL, config.REASONER_FALLBACK_PROVIDER or "none", type(r).__name__)',
  ].join(';')], { cwd: path.join(REPO_ROOT, 'backend'), encoding: 'utf8' });
  if (r.status !== 0) return { error: 'could not read config', stderr: String(r.stderr || '').slice(0, 200) };
  const [mode, hasKey, model, fallback, cls] = r.stdout.trim().split(' ');
  return { mode, apiKeyConfigured: hasKey === 'True', model, configuredFallback: fallback, reasonerClass: cls, keyValueNeverPrinted: true };
}

/** Attach to the extension service worker and record reasoner wire traffic. */
export async function attachServiceWorker(cdpPort) {
  const t = (await cdpGet(cdpPort, '/json/list')).find((x) => x.url && x.url.includes('serviceWorker.js'));
  if (!t || !t.webSocketDebuggerUrl) return null;
  const s = await openSession(t.webSocketDebuggerUrl);
  await s.send('Runtime.enable');
  await s.send('Network.enable');
  return s;
}
