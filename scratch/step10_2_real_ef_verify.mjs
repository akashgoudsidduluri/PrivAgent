/**
 * STEP 10.2 — REAL-E / REAL-F.
 *
 * REAL-E: an OBSERVED page state (the live tab URL, the classifier's pageType,
 *         the semantic facts, the generation counter) must not be able to
 *         rewrite the declaration.
 * REAL-F: a PROPOSED ACTION (`history[].url`, in particular) must not be able to
 *         rewrite the declaration either.
 *
 * Both are checked over the ACTUAL serialized request bodies captured from the
 * real extension running in real Chrome against the real fixture and the real
 * backend — not over a projection the harness made. Every `declaredDestination`
 * block that appeared on the wire is compared against the declaration derived
 * from the USER PROMPT ALONE, and is then scanned for any URL that the user
 * did not type.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(REPO_ROOT, 'docs/evidence/post-17-10/audit');

/** The declaration each task produces, from the prompt alone. */
const EXPECTED = {
  'open the store catalog': { provenance: 'USER_DECLARED_DESTINATION', role: ['LISTING'] },
  'open http://localhost:4174/results.html': {
    provenance: 'USER_DECLARED_DESTINATION',
    destinationUrl: 'http://localhost:4174/results.html',
  },
  'open the store catalog at http://localhost:4174/results.html': {
    provenance: 'USER_DECLARED_DESTINATION',
    role: ['LISTING'],
    entryUrl: 'http://localhost:4174/results.html',
  },
  'open http://localhost:4174/search.html': {
    provenance: 'USER_DECLARED_DESTINATION',
    destinationUrl: 'http://localhost:4174/search.html',
  },
};

const FORBIDDEN = ['text', 'value', 'input', 'raw', 'password', 'token', 'innerText', 'textContent'];

const files = fs
  .readdirSync(DIR)
  .filter(
    (f) =>
      f.startsWith('step10_2_real_') &&
      f.endsWith('.json') &&
      !/backend_forgery|no_rewrite/.test(f)
  )
  .sort();

const report = { work: 'STEP 10.2 REAL-E / REAL-F', files: [], violations: [], summary: {} };
let totalRequests = 0;
let totalBlocks = 0;

for (const f of files) {
  const cap = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const task = cap.inputs?.task;
  const expected = EXPECTED[task];
  const perFile = {
    file: f,
    task,
    expectedFromPromptAlone: expected ?? null,
    chromeVersion: cap.environment?.chromeVersion,
    requests: 0,
    blocksObserved: [],
    observedContextUrls: [],
    actionUrls: [],
  };

  for (const req of cap.reasoningRequests || []) {
    perFile.requests += 1;
    totalRequests += 1;
    let body = null;
    try {
      body = typeof req.requestBody === 'string' ? JSON.parse(req.requestBody) : req.requestBody;
    } catch {
      continue;
    }
    if (!body || typeof body !== 'object') continue;

    const ctx = body.context || {};
    if (typeof ctx.url === 'string') perFile.observedContextUrls.push(ctx.url);

    // REAL-F: every URL the model previously proposed to navigate to.
    for (const h of body.history || []) {
      if (h && typeof h.url === 'string') perFile.actionUrls.push(h.url);
    }

    const block = ctx.semantic_context?.declaredDestination;
    if (block === undefined || block === null) continue;
    totalBlocks += 1;
    perFile.blocksObserved.push(block);

    if (!expected) {
      report.violations.push({ file: f, why: 'no expected declaration for this task' });
      continue;
    }
    if (JSON.stringify(block) !== JSON.stringify(expected)) {
      report.violations.push({
        file: f,
        why: 'rendered declaration differs from the one derived from the user prompt',
        expected,
        observed: block,
      });
    }
    for (const k of FORBIDDEN) {
      if (k in block) report.violations.push({ file: f, why: `forbidden key ${k} in declaration` });
    }
  }
  report.files.push(perFile);
}

/**
 * The decisive cross-check, independent of EXPECTED: a URL may appear inside a
 * declaration ONLY if the USER typed it in the task. Everything else — the live
 * tab URL, a URL the model proposed, a URL found on the page — is a rewrite.
 */
for (const perFile of report.files) {
  if (!perFile.task) continue;
  const typed = perFile.task.match(/https?:\/\/[^\s"'`)\]<]+/g) || [];
  const typedNorm = new Set(
    typed.map((u) => {
      try {
        const p = new URL(u);
        return `${p.host.toLowerCase()}${(p.pathname || '/').replace(/\/+$/, '').toLowerCase() || '/'}`;
      } catch {
        return u;
      }
    })
  );
  const nonUserUrls = [
    ...new Set([...perFile.observedContextUrls, ...perFile.actionUrls]),
  ].filter((u) => !typedNorm.has((() => {
    try {
      const p = new URL(u);
      return `${p.host.toLowerCase()}${(p.pathname || '/').replace(/\/+$/, '').toLowerCase() || '/'}`;
    } catch {
      return u;
    }
  })()));

  perFile.urlsTheUserDidNotType = nonUserUrls;

  for (const block of perFile.blocksObserved) {
    for (const [k, v] of Object.entries(block)) {
      if (typeof v !== 'string' || !/^https?:\/\//.test(v)) continue;
      const p = new URL(v);
      const norm = `${p.host.toLowerCase()}${(p.pathname || '/').replace(/\/+$/, '').toLowerCase() || '/'}`;
      if (!typedNorm.has(norm)) {
        report.violations.push({
          file: perFile.file,
          why: `declaration field ${k} carries a URL the user never typed`,
          value: v,
          observedUrls: nonUserUrls,
        });
      }
    }
  }
}

report.summary = {
  files: report.files.length,
  requestsInspected: totalRequests,
  declarationBlocksObserved: totalBlocks,
  violations: report.violations.length,
};

const out = path.join(DIR, 'step10_2_real_EF_no_rewrite.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2));

console.log(JSON.stringify(report.summary));
for (const f of report.files) {
  console.log(
    `  ${f.file}\n    task=${f.task}\n    blocks=${JSON.stringify(f.blocksObserved)}\n    observedContextUrls=${JSON.stringify([...new Set(f.observedContextUrls)])}\n    actionUrls=${JSON.stringify([...new Set(f.actionUrls)])}\n    urlsTheUserDidNotType=${JSON.stringify(f.urlsTheUserDidNotType)}`
  );
}
if (report.violations.length) {
  console.log('\nVIOLATIONS:');
  for (const v of report.violations) console.log(' ', JSON.stringify(v));
}