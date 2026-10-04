// PHASE 18.5 / I-2 — Does the CURRENT backend reject the exact history shape
// the extension sends? The 422 seen during Phase 18.5 may have been a stale
// backend process rather than a live schema disagreement.
const URL = 'http://127.0.0.1:8010/api/v1/agent/action';

const baseCtx = (url) => ({
  url,
  timestamp: Date.now(),
  viewport: { width: 1280, height: 800 },
  detections: [],
  total_elements_scanned: 20,
  sensitive_elements_detected: 0,
  sanitized_status: 'sanitized_only',
  page_type: 'LISTING',
});

const CASES = [
  ['effect only (SCROLL_CHANGED)', [{ action: 'scroll', direction: 'down', amount: 500, effect: 'SCROLL_CHANGED' }]],
  ['scrollDelta only', [{ action: 'scroll', direction: 'down', amount: 500, scrollDelta: 500 }]],
  ['effect + scrollDelta (ACTION_NO_EFFECT)', [{ action: 'scroll', direction: 'down', amount: 500, effect: 'ACTION_NO_EFFECT', scrollDelta: 0 }]],
  ['URL_NAVIGATION_OBSERVED', [{ action: 'navigate', url: 'https://example.com/', effect: 'URL_NAVIGATION_OBSERVED' }]],
  ['snake_case scroll_delta', [{ action: 'scroll', direction: 'down', amount: 500, scroll_delta: 0 }]],
  ['control: plain action', [{ action: 'scroll', direction: 'down', amount: 500 }]],
];

for (const [label, history] of CASES) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      task: 'open store catalog',
      context: baseCtx('http://localhost:4174/'),
      history,
    }),
  });
  const j = await r.json().catch(() => null);
  console.log(JSON.stringify({
    label, http: r.status,
    error_kind: j?.detail?.error_kind,
    problem: Array.isArray(j?.detail) ? j.detail.map(d => `${d.loc.join('.')}:${d.type}`).join(' | ') : undefined,
  }));
}