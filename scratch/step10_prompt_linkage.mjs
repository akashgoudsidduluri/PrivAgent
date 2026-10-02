/**
 * Links the two halves of the role-only evidence chain with REAL data.
 *
 * The real-Chrome capture recorded the provider EGRESS PAYLOAD off the wire,
 * byte for byte, as the production extension sent it. This script feeds that
 * exact recorded object into the REAL backend prompt builder
 * (`app.reasoner._build_user_prompt`) and asserts what the model is actually
 * shown. It does not fabricate a payload and it does not touch the model.
 *
 * Run: node scratch/step10_prompt_linkage.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './phase16_cdp.mjs';

const EVID = path.join(REPO_ROOT, 'docs/evidence/post-17-9/destination-verifier');

const captured = [];
for (const f of fs.readdirSync(EVID)) {
  if (!/^step10_real_chrome_session\d+\.json$/.test(f)) continue;
  const doc = JSON.parse(fs.readFileSync(path.join(EVID, f), 'utf8'));
  for (const t of doc.tests ?? []) {
    for (const e of t.providerEgress ?? []) {
      if (e.declaredDestination) {
        captured.push({ file: f, key: t.key, declaredDestination: e.declaredDestination });
      }
    }
  }
}

if (!captured.length) {
  console.error('no captured declaredDestination found — run scratch/step10_real_chrome.mjs first');
  process.exit(1);
}

const payload = JSON.stringify(captured);
const script = [
  'import json, sys',
  'sys.path.insert(0, ".")',
  'from app.reasoner import _build_user_prompt, SYSTEM_PROMPT',
  'rows = json.loads(sys.stdin.read())',
  'out = []',
  'for r in rows:',
  '    p = _build_user_prompt(',
  '        task="open the store catalog at http://localhost:4174",',
  '        url="http://localhost:4174/",',
  '        viewport={"width":1280,"height":900},',
  '        screenshot_dimensions=None,',
  '        detections=[], history=[], steps_used=0, max_steps=5,',
  '        page_type="LISTING",',
  '        semantic_context={"declaredDestination": r["declaredDestination"]},',
  '    )',
  '    line = p[p.index("\\"declaredDestination\\""):]',
  '    line = line[: line.index("}") + 1]',
  '    out.append({"source": r["file"], "key": r["key"], "renderedLine": line})',
  'print(json.dumps({"systemPromptHasClause": "MUST NOT invent a URL from a role" in SYSTEM_PROMPT, "rows": out}, indent=2))',
].join('\n');

const res = spawnSync(path.join(REPO_ROOT, 'backend/.venv/bin/python'), ['-c', script], {
  cwd: path.join(REPO_ROOT, 'backend'),
  encoding: 'utf8',
  input: payload,
  maxBuffer: 32 * 1024 * 1024,
});

if (res.status !== 0) {
  console.error(res.stderr);
  process.exit(1);
}

const parsed = JSON.parse(res.stdout);
console.log('system prompt carries the read-only/non-authoritative clause:', parsed.systemPromptHasClause);
for (const r of parsed.rows) {
  console.log(`\n[${r.source}] TEST ${r.key} — what the model is actually shown:`);
  console.log('  ' + r.renderedLine.replace(/\s+/g, ' '));
}
