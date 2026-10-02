/**
 * PrivAgent — post-17.9 standalone audit: planner fact fabrication.
 *
 * Investigated question: can PrivAgent waste reasoning cycles after a
 * legitimate navigation when the resulting page lacks the intended affordance?
 *
 * Two deterministic, LOCAL (no model, no provider, no browser) defects were
 * demonstrated against the exact task from the real-browser run
 * "open the store catalog at http://localhost:4174 and open the first product listed":
 *
 *   F1  taskDecomposer.extractEntitiesAndConstraints() stripped punctuation
 *       from the WHOLE prompt and took the first three non-stopword tokens,
 *       manufacturing "store catalog httplocalhost4174" — a mangled URL —
 *       as the target product entity. That became the SEARCH subgoal's
 *       targetEntity, a value no affordance on any page can match. Fixed by
 *       removing URL substrings BEFORE tokenising: a URL is an address, not
 *       page content.
 *
 *   F3  goalParser's currency extractor used `lower.includes('rs')`, which
 *       matches "fi-RS-t". Fixed with a word boundary.
 *
 * These tests pin both fixes with POSITIVE and NEGATIVE controls, and pin the
 * investigation's security/observation invariants so it is visible that none of
 * them moved: navigation remains observational evidence only, a no-effect
 * scroll produces no false progress, repeated states stay bounded, and PII
 * behaviour is unchanged.
 */
import { describe, it, expect } from 'vitest';
import { decomposeTask } from '../extension/src/hierarchicalPlanning/taskDecomposer';
import { parseUserGoal } from '../extension/src/agent/goalParser';
import { verifyActionEffect } from '../extension/src/agent/effectVerifier';
import { detectLoop, DEFAULT_LONG_HORIZON_BOUNDS } from '../extension/src/agent/longHorizon';
import { scanForRawSensitiveValues } from '../extension/src/privacy/rawValueScanner';

const REAL_TASK = 'open the store catalog at http://localhost:4174 and open the first product listed';

function entityOf(prompt: string): string | null {
  const r = decomposeTask(prompt, { currentUrl: 'http://localhost:4174/' } as any);
  const sg = (r as any).subgoals?.find((s: any) => s.category === 'SEARCH');
  return sg?.targetEntity ?? null;
}

describe('F1 — a URL is an address, never a target entity', () => {
  it('POSITIVE: the mangled-URL entity is gone from the real task', () => {
    const e = entityOf(REAL_TASK);
    expect(e).not.toBeNull();
    // The fabricated host/port fragment must not appear anywhere.
    expect(e).not.toContain('httplocalhost4174');
    expect(e).not.toMatch(/localhost/i);
    expect(e).not.toMatch(/\d{4}/);
  });

  it('NEGATIVE control: a quoted product is still extracted verbatim', () => {
    const e = entityOf('open the store catalog and open the first product "Alpha Widget" listed');
    expect(e).toBe('Alpha Widget');
  });

  it('NEGATIVE control: a prompt with no URL is byte-identical to before the fix', () => {
    // The fix must not alter prompts that never contained an address.
    expect(entityOf('open the store catalog and open the first product listed')).toBe(
      'store catalog first'
    );
  });

  it('NEGATIVE control: a bare product phrase with no address is still extracted', () => {
    expect(entityOf('search for running shoes')).toBe('running shoes');
  });

  it('POSITIVE: an https URL is stripped the same way', () => {
    const e = entityOf('open https://shop.example.com/store and find the first product');
    expect(e).not.toContain('example');
    expect(e).not.toContain('https');
  });

  it('the fabricated entity never became a subgoal target in ANY subgoal', () => {
    const r = decomposeTask(REAL_TASK, { currentUrl: 'http://localhost:4174/' } as any);
    for (const sg of (r as any).subgoals ?? []) {
      expect(String(sg.targetEntity ?? '')).not.toContain('httplocalhost4174');
      expect(String(sg.description ?? '')).not.toContain('httplocalhost4174');
    }
  });
});

describe('F3 — currency extraction must respect word boundaries', () => {
  it('POSITIVE: a standalone "rs" still selects ₹', () => {
    expect(parseUserGoal('find a bag under rs 500').constraints.currency).toBe('₹');
  });

  it('NEGATIVE control: "first" must not fabricate a currency', () => {
    // "fi-RS-t" contained "rs" before the fix.
    expect(parseUserGoal('open the first product listed').constraints.currency).toBeUndefined();
  });

  it('NEGATIVE control: the real task fabricates no currency', () => {
    expect(parseUserGoal(REAL_TASK).constraints.currency).toBeUndefined();
  });

  it('NEGATIVE control: other words containing "rs" are not currencies', () => {
    for (const w of ['various', 'shirts', 'cars']) {
      expect(parseUserGoal(`show me ${w}`).constraints.currency).toBeUndefined();
    }
  });

  it('NEGATIVE control: real currency symbols are still detected', () => {
    expect(parseUserGoal('find a bag under ₹500').constraints.currency).toBe('₹');
    expect(parseUserGoal('find a bag under $500').constraints.currency).toBe('$');
    expect(parseUserGoal('find a bag under €500').constraints.currency).toBe('€');
  });
});

describe('INVARIANTS — the investigation must not have moved these', () => {
  it('navigation effect is reported from the OBSERVED URL, never the requested one', () => {
    const result = verifyActionEffect(
      { action: 'navigate', url: 'http://localhost:4174/results.html' } as any,
      { url: 'http://localhost:4174/', scrollX: 0, scrollY: 0, timestamp: 1 },
      { url: 'http://localhost:4174/search.html', scrollX: 0, scrollY: 0, timestamp: 2 }
    );
    // The action REQUESTED results.html; the browser OBSERVED search.html.
    // The verdict must reflect the observation, and must not claim the request.
    expect(result.diagnostics.urlChanged).toBe(true);
    expect(result.details).toContain('search.html');
    expect(result.details).not.toContain('results.html');
  });

  it('a scroll at the page bottom produces NO effect and no progress', () => {
    const result = verifyActionEffect(
      { action: 'scroll', direction: 'down', amount: 500 } as any,
      { url: 'http://localhost:4174/search.html', scrollX: 0, scrollY: 0, timestamp: 1 },
      { url: 'http://localhost:4174/search.html', scrollX: 0, scrollY: 0, timestamp: 2 }
    );
    expect(result.status).toBe('ACTION_NO_EFFECT');
    expect(result.hasEffect).toBe(false);
    expect(result.shouldRecover).toBe(true);
  });

  it('repeated identical observations are bounded by the loop detector', () => {
    const fingerprints = ['a', 'b', 'a', 'a', 'a'];
    const d = detectLoop(fingerprints, DEFAULT_LONG_HORIZON_BOUNDS);
    // Bounded by design: the detector fires, it does not run forever.
    expect(d.loop).toBe(true);
    expect(d.kind).toBe('REPEATED_STATE');
    expect(d.occurrences).toBeGreaterThan(DEFAULT_LONG_HORIZON_BOUNDS.maxRepeatedStates);
  });

  it('a single observation is never a loop', () => {
    expect(detectLoop(['a'], DEFAULT_LONG_HORIZON_BOUNDS).loop).toBe(false);
  });

  it('PII-bearing prompts are unaffected by the planner fixes', () => {
    // The entity extractor is not a privacy boundary; M5 and the scanners are.
    // This pins that the fix neither weakened nor bypassed those.
    const payload = 'email jane.doe@example.com card 4111 1111 1111 1111';
    expect(scanForRawSensitiveValues(payload).length).toBeGreaterThan(0);
    expect(scanForRawSensitiveValues('open the store catalog at http://localhost:4174').length).toBe(0);
  });
});
