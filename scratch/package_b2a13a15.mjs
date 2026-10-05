#!/usr/bin/env node
/**
 * PHASE 18.8 / B2 + A13 + A15 — machine-readable evidence packaging.
 *
 * Turns the raw multi-turn browser transcript into a verdict artifact with the
 * assertions the brief asks for, computed FROM THE TRANSCRIPT (not asserted by
 * hand):
 *
 *   · navigation occurred                       (urlBefore !== urlAfter)
 *   · the DOM detection ids differ across pages (read back from the fixtures)
 *   · the world-model id differs                (different perception)
 *   · the same entity was re-established        (productId + normalized title)
 *   · identity was revalidated, never assumed   (REVALIDATED verdict)
 *   · nothing was guessed                       (ambiguous reference refused)
 *   · no raw sensitive value is in any artifact field
 *
 * Run: node scratch/package_b2a13a15.mjs <raw-artifact>
 */
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import path from 'node:path';

const RAW = process.argv[2] || 'docs/evidence/post-17-10/audit/p188_mt10_raw.json';
const OUT = process.argv[3] || 'docs/evidence/post-17-10/audit/p188_B2A13A15.json';
const FIXTURE = process.env.FIXTURE_ORIGIN || 'http://localhost:4174';

const raw = JSON.parse(fs.readFileSync(RAW, 'utf8'));

/**
 * DOM detection ids, read back the way the content script sees them: the page
 * is parsed WITH its own scripts running, so the id/class the fixture publishes
 * at runtime is the one that counts.
 */
async function detectionIds(url) {
  const html = await (await fetch(url)).text();
  const dom = new JSDOM(html, { runScripts: 'dangerously', url });
  const cards = [...dom.window.document.querySelectorAll('.product-card, [data-product]')];
  return {
    detectionIds: cards.map((c) => c.id || '(none)'),
    dataProductIds: [...new Set(cards.map((c) => c.getAttribute('data-product-id')).filter(Boolean))],
    titles: cards.map((c) => (c.querySelector('.product-title, .title, h1, h2, h3')?.textContent || '').trim().slice(0, 60)),
  };
}

const turns = raw.turns.map((t) => {
  const c = t.terminal?.conversation ?? null;
  return {
    id: t.id,
    task: t.task,
    status: t.terminal?.status ?? 'NO_TERMINAL',
    urlBefore: t.terminal?.urlBefore ?? null,
    urlAfter: t.terminal?.urlAfter ?? null,
    conversationId: c?.conversationId ?? null,
    turnIndex: c?.turnIndex ?? null,
    turnCount: c?.turnCount ?? null,
    candidateCount: c?.candidateCount ?? null,
    selectedOrdinal: c?.selectedOrdinal ?? null,
    selectedIdentityKey: c?.selectedIdentityKey ?? null,
    selectedProductId: c?.selectedProductId ?? null,
    selectedEntityType: c?.selectedEntityType ?? null,
    revalidation: c?.revalidation ?? null,
    referenceOutcome: c?.referenceOutcome ?? null,
    clarificationCode: c?.clarificationCode ?? null,
    finalResult: t.terminal?.finalResult ?? null,
    dashboardHeadline: (t.terminal?.dashboardBodyExcerpt ?? '').slice(0, 0) || null,
  };
});

const byId = Object.fromEntries(turns.map((t) => [t.id, t]));
const listingDom = await detectionIds(`${FIXTURE}/results.html`);
const detailDom = await detectionIds(`${FIXTURE}/product.html?id=3`);

const wmIds = raw.swLogs.map((l) => l.text);
/** The world-model id of the perception that PRECEDED this transcript line. */
const wmFor = (needle) => {
  const at = wmIds.findIndex((l) => l.includes(needle));
  if (at < 0) return null;
  for (let i = at; i >= 0 && i > at - 40; i--) {
    const hit = wmIds[i].match(/worldModelId:([^,}]+)/);
    if (hit) return hit[1].trim();
  }
  return null;
};
const listingWorldModel = wmFor('REFERENCE_RESOLVED_ORDINAL');
const detailWorldModel = wmFor('product.html');

const T2 = byId.T2;
const T3 = byId.T3;
const T4 = byId.T4;
const T6 = byId.T6;

const checks = [
  {
    id: 'B2-1',
    claim: 'a first turn creates a conversation and captures observed candidates',
    pass: T2?.conversationId != null && T2.candidateCount > 1,
    observed: { conversationId: T2?.conversationId, candidateCount: T2?.candidateCount },
  },
  {
    id: 'B2-2',
    claim: 'a follow-up turn CONTINUES the same conversation',
    pass: T3?.conversationId === T2?.conversationId && T3.turnIndex === T2.turnIndex + 1,
    observed: { turnIndex: T3?.turnIndex, turnCount: T3?.turnCount, conversationId: T3?.conversationId },
  },
  {
    id: 'B2-3',
    claim: 'a turn with no reference starts a NEW conversation (isolation)',
    pass: byId.T5?.conversationId !== T4?.conversationId && byId.T5?.turnIndex === 0,
    observed: { previous: T4?.conversationId, next: byId.T5?.conversationId, turnIndex: byId.T5?.turnIndex },
  },
  {
    id: 'A13-1',
    claim: '"the third one" resolves to the THIRD observed candidate',
    pass: T2?.selectedOrdinal === 3 && T2?.referenceOutcome === 'RESOLVED' && T2?.revalidation === 'REVALIDATED',
    observed: { selectedOrdinal: T2?.selectedOrdinal, outcome: T2?.referenceOutcome, revalidation: T2?.revalidation },
  },
  {
    id: 'A13-2',
    claim: '"it" resolves to the SELECTION, not to a guess',
    //
    // Ordinals are PAGE-LOCAL by contract (A15): "the third one" is meaningless
    // on a page that has one entity, so the assertion is on the ENTITY, not the
    // position.
    pass:
      T3?.referenceOutcome === 'RESOLVED' &&
      T3?.selectedProductId === T2?.selectedProductId &&
      T3?.selectedEntityType === 'PRODUCT',
    observed: {
      outcome: T3?.referenceOutcome,
      listingProductId: T2?.selectedProductId,
      detailProductId: T3?.selectedProductId,
    },
  },
  {
    id: 'A13-3',
    claim: 'an ambiguous "it" with several candidates and no selection is REFUSED',
    pass:
      T6?.status === 'NEEDS_CLARIFICATION' &&
      T6?.referenceOutcome === 'NEEDS_CLARIFICATION' &&
      T6?.clarificationCode === 'AMBIGUOUS_REFERENCE',
    observed: {
      status: T6?.status,
      code: T6?.clarificationCode,
      candidates: T6?.candidateCount,
      selection: T6?.selectedOrdinal,
    },
  },
  {
    id: 'A15-1',
    claim: 'NAVIGATION OCCURRED between the listing and the detail page',
    pass: T3?.urlBefore !== T3?.urlAfter && String(T3?.urlAfter).includes('product.html'),
    observed: { urlBefore: T3?.urlBefore, urlAfter: T3?.urlAfter },
  },
  {
    id: 'A15-2',
    claim: 'the DOM detection ids are DIFFERENT on the two pages',
    pass:
      listingDom.detectionIds.length > 0 &&
      detailDom.detectionIds.length > 0 &&
      !detailDom.detectionIds.some((id) => listingDom.detectionIds.includes(id)),
    observed: { listing: listingDom.detectionIds, detail: detailDom.detectionIds },
  },
  {
    id: 'A15-3',
    claim: 'the perception is a DIFFERENT world model (new page generation)',
    pass: !!listingWorldModel && !!detailWorldModel && listingWorldModel !== detailWorldModel,
    observed: { listingWorldModel, detailWorldModel },
  },
  {
    id: 'A15-4',
    claim: 'the SAME entity was re-established across the navigation (productId carried over)',
    pass:
      T3?.selectedProductId != null &&
      T3.selectedProductId === T2?.selectedProductId &&
      T3?.revalidation === 'REVALIDATED',
    observed: {
      listingProductId: T2?.selectedProductId,
      detailProductId: T3?.selectedProductId,
      revalidation: T3?.revalidation,
    },
  },
  {
    id: 'A15-5',
    claim: '"it" on the NEXT page still resolves to that entity (not the page index)',
    pass:
      T4?.referenceOutcome === 'RESOLVED' &&
      T4?.selectedProductId === T2?.selectedProductId &&
      T4?.selectedEntityType === 'PRODUCT',
    observed: { outcome: T4?.referenceOutcome, productId: T4?.selectedProductId, type: T4?.selectedEntityType },
  },
  {
    id: 'A15-6',
    claim: 'the page-scoped identity hash CHANGED, so revalidation is a re-establishment, not a stale carry-over',
    pass: !!T3?.selectedIdentityKey && T3.selectedIdentityKey !== T2?.selectedIdentityKey,
    observed: { listingIdentityKey: T2?.selectedIdentityKey, detailIdentityKey: T3?.selectedIdentityKey },
  },
];

// ── Privacy proof over the artifact itself ───────────────────────────────────
const SENSITIVE_MARKERS = [
  '4111111111111111',
  '4111 1111 1111 1111',
  '9876543210',
  'rachit',
  'cvv',
  'password',
  'otp',
];
const artifactText = JSON.stringify({ turns, checks });
const privacy = {
  markersScanned: SENSITIVE_MARKERS.length,
  hits: SENSITIVE_MARKERS.filter((m) => artifactText.toLowerCase().includes(m.toLowerCase())),
  rawPageTextStored:
    turns.some((t) => JSON.stringify(t).includes('data-product-id')) ||
    turns.some((t) => JSON.stringify(t).length > 4000),
  screenshotOrOcrStored: artifactText.includes('data:image') || artifactText.includes('rawOCR'),
};

const artifact = {
  phase: '18.8-B2/A13/A15',
  work: 'Continuous multi-turn conversation, deterministic reference resolution, cross-page entity identity',
  labels: raw.labels,
  provider: 'CONTROLLED (scratch/i8a7a8_controlled_provider.py, STUB_MODE=multiturn)',
  honesty:
    'CONTROLLED_PROVIDER. The live groq route was not used: it was rate-limited and returned malformed action payloads, so no live leg is claimed.',
  source: path.basename(RAW),
  environment: raw.environment ?? {},
  fixture: { origin: FIXTURE, listingDetectionIds: listingDom, detailDetectionIds: detailDom },
  turns,
  checks,
  summary: {
    passed: checks.filter((c) => c.pass).length,
    failed: checks.filter((c) => !c.pass).length,
  },
  privacy: {
    ...privacy,
    pass: privacy.hits.length === 0 && !privacy.rawPageTextStored && !privacy.screenshotOrOcrStored,
  },
};

fs.writeFileSync(path.join(process.cwd(), OUT), JSON.stringify(artifact, null, 2));
console.log(
  `${OUT}: ${artifact.summary.passed}/${checks.length} checks passed, privacy=${artifact.privacy.pass ? 'PASS' : 'FAIL'}`
);
for (const c of checks) if (!c.pass) console.log(`  FAIL ${c.id}: ${c.claim}`);
process.exitCode = artifact.summary.failed === 0 && artifact.privacy.pass ? 0 : 1;