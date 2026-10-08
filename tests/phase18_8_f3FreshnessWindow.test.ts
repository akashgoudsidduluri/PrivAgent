/**
 * PHASE 18.8 / CLOSURE — THE EVIDENCE FRESHNESS WINDOW.
 *
 * THE WINDOW, precisely
 *   A record from page A stays citable after the tab has navigated to page B,
 *   because the LEDGER marks records STALE only when the NEXT observation
 *   arrives (ingestObservation → advance(pageGeneration)), while the LOOP's
 *   own generation (`state.currentPageGeneration`) has already moved on at the
 *   moment a navigation settles (advancePageGeneration) — and the
 *   post-action verdict runs in exactly that interval.
 *
 *   So, for one window: “evidence from page A may still certify page B”.
 *
 * THE STRONGER INVARIANT (this file)
 *   After a relevant navigation/generation change, evidence from the previous
 *   generation must not certify CURRENT information even before the next
 *   ledger observation.
 *
 * ONE COUNTER, NO PARALLEL STATE
 *   Both sides already read the SAME mechanism: the world model's monotonic
 *   `pageGeneration`, which the loop adopts each perception and which the SW
 *   stamps into every ingested record's provenance. The ledger's freshness
 *   rules (STALE never becomes CURRENT; only SANITIZED/current records are
 *   citable) are unchanged — this only asks that a citable record also belong
 *   to the generation being judged.
 *
 * CASES (PART A of the closure brief)
 *   1  page A evidence → navigate to page B → cannot certify B
 *   2  generation changes before the next observation → SUCCESS blocked
 *   3  the next observation transitions old evidence to STALE
 *   4  page B evidence can become VERIFIED and support SUCCESS afterwards
 *   5  a same-page action that does not change the generation keeps evidence
 *   6  back/forward follows generation semantics (a re-visit is a NEW record)
 *   7  cross-origin navigation invalidates prior evidence
 *   8  same-origin navigation that replaces the document invalidates too
 *   9  a provider ANSWER cannot bypass freshness
 *   10 a provider SUCCESS claim cannot bypass freshness
 *   11 freshness telemetry is keys/status only — never claim text or values
 *   12 the A10 / I-5 false-success evaluators stay green (run separately)
 */
import { describe, it, expect } from 'vitest';

import { EvidenceLedger } from '../extension/src/evidence/evidenceLedger';
import { verifyTerminalProposal } from '../extension/src/agent/proposal';
import { composeEvidenceAnswerFromLedger } from '../extension/src/agent/agentLoop';

const PAGE_A = 'https://en.wikipedia.org/wiki/Alpha';
const PAGE_B = 'https://en.wikipedia.org/wiki/Beta';
const TASK = 'tell me about alpha';

function ledgerWithPageA(): EvidenceLedger {
  const ledger = new EvidenceLedger();
  ledger.advance(2, PAGE_A);
  const rec = ledger.record({
    claim: 'Alpha was founded in 1591.',
    key: 'alpha',
    sourceUrl: PAGE_A,
    pageGeneration: 2,
    evidenceType: 'PAGE_TEXT',
    confidence: 0.9,
  });
  if (rec) ledger.verify(rec.id);
  return ledger;
}

describe('freshness window — one counter decides', () => {
  it('1. page A evidence cannot certify page B (generation mismatch)', () => {
    const ledger = ledgerWithPageA();
    // The loop's generation has moved on with the navigation; the ledger has
    // not yet observed page B.
    expect(ledger.verifiedKeysAtGeneration(2)).toContain('alpha');
    expect(ledger.verifiedKeysAtGeneration(3)).toEqual([]);
  });

  it('2. the generation change alone blocks SUCCESS, before any observation', () => {
    const ledger = ledgerWithPageA();
    // What the SUCCESS gate reads at generation 3: nothing.
    expect(ledger.verifiedKeysAtGeneration(3)).toEqual([]);
    // What the composer reads under the same generation scope (the loop's
    // scopedEvidenceLedgerView): nothing either, so no answer can be composed
    // from page A while page B is being judged.
    const scoped = {
      byIdSafe: (id: string) => {
        const record = ledger.byIdSafe(id);
        return record && record.pageGeneration === 3 ? record : undefined;
      },
      citable: () => ledger.citableAt(3),
    };
    expect(composeEvidenceAnswerFromLedger(scoped, TASK)).toBeUndefined();
    // …while the unscoped ledger still shows how the window used to look.
    expect(ledger.citable().map((r) => r.key)).toContain('alpha');
  });

  it('3. the next observation transitions old evidence to STALE', () => {
    const ledger = ledgerWithPageA();
    // Page B is observed at generation 3: ingest invalidates every other generation.
    ledger.advance(3, PAGE_B);
    const rec = ledger.byIdSafe(ledger.snapshot().records[0]!.id)!;
    expect(rec.freshness).toBe('STALE');
    expect(rec.verificationStatus).toBe('INVALIDATED');
    expect(ledger.verifiedKeysAtGeneration(3)).toEqual([]);
  });

  it('4. page B evidence can become VERIFIED and support the task afterwards', () => {
    const ledger = ledgerWithPageA();
    ledger.advance(3, PAGE_B);
    const fresh = ledger.record({
      claim: 'Beta opened in 1999.',
      key: 'beta',
      sourceUrl: PAGE_B,
      pageGeneration: 3,
      evidenceType: 'PAGE_TEXT',
      confidence: 0.9,
    })!;
    ledger.verify(fresh.id);
    expect(ledger.verifiedKeysAtGeneration(3)).toContain('beta');
    expect(ledger.verifiedKeysAtGeneration(3)).not.toContain('alpha');
  });

  it('5. a same-page action with no generation change keeps the evidence', () => {
    const ledger = ledgerWithPageA();
    // Scrolling/clicking inside the same document does not advance the
    // generation, so the record still belongs to the judged generation.
    expect(ledger.verifiedKeysAtGeneration(2)).toContain('alpha');
    expect(ledger.verifiedKeysAtGeneration(2)).toHaveLength(1);
  });

  it('6. back/forward is a new document: re-visiting page A creates a new record', () => {
    const ledger = ledgerWithPageA();
    ledger.advance(3, PAGE_B); // navigate away
    ledger.advance(4, PAGE_A); // navigate BACK — a fresh load, not the old one
    const revisited = ledger.record({
      claim: 'Alpha was founded in 1591.',
      key: 'alpha',
      sourceUrl: PAGE_A,
      pageGeneration: 4,
      evidenceType: 'PAGE_TEXT',
      confidence: 0.9,
    })!;
    ledger.verify(revisited.id);
    // The old generation-2 record never comes back to life: only the record
    // observed at generation 4 is published for generation 4.
    const keys = ledger.verifiedKeysAtGeneration(4);
    expect(keys).toContain('alpha');
    const publishedRecord = ledger
      .citableAt(4)
      .find((r) => r.verificationStatus === 'VERIFIED' && r.key === 'alpha');
    expect(publishedRecord?.pageGeneration).toBe(4);
    // …and the generation-2 record is STALE, not CURRENT, for the whole time.
    const old = ledger.snapshot().records.find((r) => r.pageGeneration === 2)!;
    expect(old.freshness).toBe('STALE');
    expect(old.verificationStatus).toBe('INVALIDATED');
  });

  it('7. a cross-origin navigation invalidates prior evidence', () => {
    const ledger = ledgerWithPageA();
    ledger.advance(3, 'https://evil.example.com/phish');
    expect(ledger.verifiedKeysAtGeneration(3)).toEqual([]);
    const old = ledger.snapshot().records.find((r) => r.sourceUrl === PAGE_A)!;
    expect(old.freshness).toBe('STALE');
  });

  it('8. a same-origin navigation that replaces the document invalidates too', () => {
    const ledger = ledgerWithPageA();
    // Same host, different document — the generation is what matters, not the host.
    ledger.advance(3, 'https://en.wikipedia.org/wiki/Other');
    expect(ledger.verifiedKeysAtGeneration(3)).toEqual([]);
  });

  it('9. a provider ANSWER cannot bypass freshness', () => {
    const ledger = ledgerWithPageA();
    const staleId = ledger.snapshot().records[0]!.id;
    ledger.advance(3, PAGE_B); // everything the model could cite is now STALE
    const verdict = verifyTerminalProposal(
      { kind: 'ANSWER', reason: 'I know.', answer: 'Alpha was founded in 1591.', cited_evidence: [staleId] },
      ledger,
      TASK
    );
    expect(verdict.status).not.toBe('ANSWER');
    expect(verdict.supportedRecordIds).toEqual([]);
    expect(verdict.rejections).toContain('UNRESOLVED_CITATION');
    expect(verdict.downgraded).toBe(true);
  });

  it('10. a provider “SUCCESS” claim cannot bypass freshness either', () => {
    // The proposal status union cannot express SUCCESS at all (A1), and the
    // freshness gate the goal verifier reads is the same generation rule.
    const ledger = ledgerWithPageA();
    ledger.advance(3, PAGE_B);
    expect(ledger.verifiedKeysAtGeneration(3)).toEqual([]);
    const verdict = verifyTerminalProposal(
      { kind: 'ANSWER', reason: 'Done.', answer: 'All set.', cited_evidence: [] },
      ledger,
      TASK
    );
    expect(verdict.status).not.toBe('ANSWER');
    expect(verdict.downgraded).toBe(true);
  });

  it('11. freshness telemetry carries keys and statuses only — no claim text', () => {
    const ledger = ledgerWithPageA();
    const published = ledger.verifiedKeysAtGeneration(2);
    const serialized = JSON.stringify({ published });
    // Keys are normalized subject terms, never the claim…
    expect(serialized).not.toContain('1591');
    expect(serialized).not.toContain('founded');
    // …and an observation whose claim carries a credential can never become a
    // record at all, so it can never appear in freshness state.
    const rejected = ledger.record({
      claim: 'password = hunter2SuperSecret',
      key: 'password',
      sourceUrl: PAGE_A,
      pageGeneration: 2,
      evidenceType: 'PAGE_TEXT',
      confidence: 0.9,
    });
    expect(rejected).toBeNull();
    expect(JSON.stringify({ keys: ledger.verifiedKeysAtGeneration(2) })).not.toContain('hunter2');
  });
});
