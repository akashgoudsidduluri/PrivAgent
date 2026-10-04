// PHASE 18.5 probe: measure REAL /agent/action latency end-to-end.
// Schema-valid payload only — no shortcuts, so the measurement reflects the
// same code path the extension actually exercises.
const URL = 'http://127.0.0.1:8010/api/v1/agent/action';

function body(task, url, pageType) {
  return {
    task,
    context: {
      url,
      timestamp: Date.now(),
      viewport: { width: 1280, height: 800 },
      detections: [],
      total_elements_scanned: 120,
      sensitive_elements_detected: 0,
      sanitized_status: 'sanitized_only',
      page_type: pageType || 'LISTING',
      semantic_context: { pageType: pageType || 'LISTING', confidence: 0.99, url },
    },
    history: [],
  };
}

const CASES = [
  ['open wikipedia and find information about charminar', 'http://localhost:4174/search.html?q=charminar'],
  ['open wikipedia', 'http://localhost:4174/'],
  ['open store catalog', 'http://localhost:4174/'],
  ['search for cats', 'http://localhost:4174/'],
];

for (const [task, url] of CASES) {
  const t0 = Date.now();
  try {
    const r = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body(task, url)),
    });
    const j = await r.json().catch(() => null);
    const ms = Date.now() - t0;
    console.log(JSON.stringify({
      task, http: r.status, ms,
      success: j?.success,
      action: j?.action?.action,
      target: j?.action?.target ?? j?.action?.url,
      telemetry: j?.telemetry,
      detail: j?.detail ? JSON.stringify(j.detail).slice(0, 300) : undefined,
    }));
  } catch (e) {
    console.log(JSON.stringify({ task, error: String(e).slice(0, 200), ms: Date.now() - t0 }));
  }
}