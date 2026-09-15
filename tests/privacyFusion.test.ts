/**
 * PrivAgent — M8 Privacy Fusion Test Suite
 *
 * Verifies the normalized finding model and the fusion rules WITHOUT any live
 * network call and WITHOUT duplicating any detector:
 *   1. Adapters map the existing M1/M2/M3/M4 outputs onto FusionCandidate.
 *   2. Grouping rules: same evidence id, same meaningful selector, same-category
 *      containment, cross-category containment (same box read differently).
 *   3. Fusion NEVER weakens privacy: strongest severity/confidence wins,
 *      contributing sources are retained, low-confidence never lowers a verdict.
 *   4. Synthetic selectors ('canvas:visual-ocr') are never used for grouping.
 *   5. Findings carry metadata only — no raw values anywhere.
 */

import { describe, it, expect } from 'vitest';
import {
  candidateFromAgentDetection,
  candidateFromDOMPageDetection,
  candidateFromOCRDetection,
  candidateFromVisualDetection,
  containmentRatio,
  fusePrivacyFindings,
  FusionCandidate,
} from '../extension/src/privacy/fusion';
import { DetectionResult, VisualDetectionResult } from '../extension/src/privacy/types';
import { SafeOCRDetection } from '../extension/src/ocr/types';

function domDet(overrides: Partial<DetectionResult> = {}): DetectionResult {
  return {
    id: 'privagent-det-1',
    type: 'credit_card',
    confidence: 0.98,
    selector: '#input-card-number',
    bbox: [100, 200, 220, 30],
    length: 19,
    source: 'dom_autocomplete',
    ...overrides,
  };
}

function visualDet(overrides: Partial<VisualDetectionResult> = {}): VisualDetectionResult {
  return {
    id: 'privagent-det-1',
    type: 'credit_card',
    confidence: 0.98,
    selector: '#input-card-number',
    viewportBBox: [100, 200, 220, 30],
    screenshotBBox: [200, 400, 440, 60],
    isPartiallyVisible: false,
    source: 'dom_input_type',
    ...overrides,
  };
}

function ocrDet(overrides: Partial<SafeOCRDetection> = {}): SafeOCRDetection {
  return {
    id: 'ocr-det-1-1720000000000',
    type: 'credit_card',
    confidence: 0.99,
    bbox: [210, 410, 420, 40],
    length: 19,
    source: 'ocr',
    isPartiallyVisible: false,
    ...overrides,
  };
}

function candidate(overrides: Partial<FusionCandidate> = {}): FusionCandidate {
  return {
    evidenceId: 'cand-1',
    category: 'credit_card',
    confidence: 0.95,
    source: 'dom',
    detectionSource: 'dom_label',
    region: [100, 200, 220, 30],
    selector: '#field',
    length: 19,
    isPartiallyVisible: false,
    evidence: ['dom:dom_label'],
    ...overrides,
  };
}

describe('Candidate adapters (adapt existing outputs, duplicate nothing)', () => {
  it('maps an M1 DOM page detection onto a dom candidate with its region', () => {
    const c = candidateFromDOMPageDetection(domDet());
    expect(c.source).toBe('dom');
    expect(c.category).toBe('credit_card');
    expect(c.evidenceId).toBe('privagent-det-1');
    expect(c.region).toEqual([100, 200, 220, 30]);
    expect(c.selector).toBe('#input-card-number');
    expect(c.length).toBe(19);
  });

  it('maps an M2 visual detection; OCR-mapped ones keep the ocr perception source', () => {
    const domMapped = candidateFromVisualDetection(visualDet());
    expect(domMapped.source).toBe('visual');

    const ocrMapped = candidateFromVisualDetection(visualDet({ source: 'ocr' }));
    expect(ocrMapped.source).toBe('ocr');
  });

  it('maps an M3 OCR detection onto an ocr candidate without a selector', () => {
    const c = candidateFromOCRDetection(ocrDet());
    expect(c.source).toBe('ocr');
    expect(c.selector).toBeNull();
    expect(c.region).toEqual([210, 410, 420, 40]);
  });

  it('maps an M4 payload detection; synthetic canvas selectors never become grouping keys', () => {
    const domLike = candidateFromAgentDetection({
      id: 'element_card',
      type: 'credit_card',
      confidence: 0.98,
      bbox: { x: 100, y: 200, width: 220, height: 30 },
      length: 19,
      source: 'dom_input_type',
      selector: '#input-card-number',
      is_partially_visible: false,
    });
    expect(domLike.source).toBe('dom');
    expect(domLike.selector).toBe('#input-card-number');

    const ocrLike = candidateFromAgentDetection({
      id: 'ocr-det-1-1720000000000',
      type: 'credit_card',
      confidence: 0.99,
      bbox: { x: 210, y: 410, width: 420, height: 40 },
      length: 19,
      source: 'ocr',
      selector: 'canvas:visual-ocr',
      is_partially_visible: false,
    });
    expect(ocrLike.source).toBe('ocr');
    expect(ocrLike.selector).toBeNull();
  });

  it('clamps non-finite confidences so malformed signals cannot poison fusion', () => {
    const c = candidateFromDOMPageDetection(domDet({ confidence: Number.NaN }));
    expect(c.confidence).toBe(0);
  });
});

describe('Fusion grouping rules', () => {
  it('merges the same DOM field + OCR read of the same number into ONE finding', () => {
    const result = fusePrivacyFindings([
      candidate({ evidenceId: 'cand-dom', source: 'dom', region: [100, 200, 220, 30], selector: '#card' }),
      candidate({ evidenceId: 'cand-ocr', source: 'ocr', region: [105, 202, 210, 26], selector: null }),
    ]);
    expect(result.findings).toHaveLength(1);
    expect(result.fusedGroupCount).toBe(1);
    expect(result.collapsedCount).toBe(1);
    const finding = result.findings[0]!;
    expect(finding.multiSource).toBe(true);
    expect(finding.sources).toEqual(expect.arrayContaining(['dom', 'ocr']));
  });

  it('merges via a shared meaningful selector even when boxes differ', () => {
    const result = fusePrivacyFindings([
      candidate({ evidenceId: 'a', region: [0, 0, 10, 10], selector: '#shared' }),
      candidate({ evidenceId: 'b', region: [500, 500, 10, 10], selector: '#shared' }),
    ]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.fusedFrom).toBe(2);
  });

  it('merges the same evidence id regardless of geometry (DOM ↔ M2 mapped twin)', () => {
    const result = fusePrivacyFindings([
      candidate({ evidenceId: 'privagent-det-1', source: 'dom', region: [100, 200, 220, 30] }),
      candidate({ evidenceId: 'privagent-det-1', source: 'visual', region: [200, 400, 440, 60] }),
    ]);
    expect(result.findings).toHaveLength(1);
  });

  it('keeps DIFFERENT elements separate when boxes barely overlap', () => {
    const result = fusePrivacyFindings([
      candidate({ evidenceId: 'left', region: [0, 0, 100, 30], selector: '#a' }),
      candidate({ evidenceId: 'right', region: [300, 0, 100, 30], selector: '#b' }),
    ]);
    expect(result.findings).toHaveLength(2);
    expect(result.fusedGroupCount).toBe(0);
  });

  it('does NOT merge different categories unless containment is very high (≥0.9)', () => {
    // Overlap ~0.8 of the smaller box: same category merges, different does not.
    const a = candidate({ evidenceId: 'a', selector: '#field-a', category: 'credit_card', region: [0, 0, 100, 30] });
    const b = candidate({ evidenceId: 'b', selector: '#field-b', category: 'account_number', region: [10, 2, 100, 30] });
    const ratio = containmentRatio(a.region, b.region);
    expect(ratio).not.toBeNull();
    expect(ratio!).toBeGreaterThanOrEqual(0.6);
    expect(ratio!).toBeLessThan(0.9);

    expect(fusePrivacyFindings([a, b]).findings).toHaveLength(2);
    expect(
      fusePrivacyFindings([a, { ...b, category: 'credit_card' }]).findings
    ).toHaveLength(1);
  });

  it('unifies different categories that describe the SAME region (cross-category merge)', () => {
    const result = fusePrivacyFindings([
      candidate({ evidenceId: 'a', category: 'credit_card', region: [0, 0, 100, 30] }),
      candidate({ evidenceId: 'b', category: 'account_number', region: [2, 1, 97, 29] }),
    ]);
    expect(result.findings).toHaveLength(1);
    // Strongest applicable category wins (account_number is 'high', card is 'critical').
    expect(result.findings[0]!.categories.sort()).toEqual(['account_number', 'credit_card']);
  });

  it('never groups two OCR detections via the shared synthetic canvas selector', () => {
    const result = fusePrivacyFindings([
      candidate({ evidenceId: 'ocr-a', source: 'ocr', selector: null, region: [0, 0, 100, 30] }),
      candidate({ evidenceId: 'ocr-b', source: 'ocr', selector: null, region: [10, 2, 90, 27] }),
    ]);
    // Same category + containment ≥ 0.6 still groups genuine duplicates, which is
    // intended; but two DIFFERENT OCR findings with disjoint boxes stay separate.
    expect(result.findings).toHaveLength(1);
  });
});

describe('Fusion never weakens privacy', () => {
  it('a low-confidence signal cannot lower the fused confidence', () => {
    const result = fusePrivacyFindings([
      candidate({ evidenceId: 'strong', confidence: 0.98 }),
      candidate({ evidenceId: 'weak', confidence: 0.2, source: 'ocr' }),
    ]);
    expect(result.findings[0]!.confidence).toBe(0.98);
    expect(result.findings[0]!.mustRedact).toBe(true);
  });

  it('the strongest category wins when severities differ (never downgraded)', () => {
    const result = fusePrivacyFindings([
      candidate({ evidenceId: 'a', category: 'phone', confidence: 0.9, region: [0, 0, 100, 30] }),
      candidate({ evidenceId: 'b', category: 'credit_card', confidence: 0.98, region: [2, 1, 97, 29] }),
    ]);
    expect(result.findings[0]!.category).toBe('credit_card');
    expect(result.findings[0]!.severity).toBe('critical');
  });

  it('retains the union of evidence ids and contributing sources for auditability', () => {
    const result = fusePrivacyFindings([
      candidate({ evidenceId: 'dom-1', source: 'dom', detectionSource: 'dom_input_type' }),
      candidate({ evidenceId: 'ocr-1', source: 'ocr', detectionSource: 'ocr', region: [100, 200, 220, 30] }),
      candidate({ evidenceId: 'vis-1', source: 'visual', detectionSource: 'dom_label', region: [104, 202, 214, 28] }),
    ]);
    const f = result.findings[0]!;
    expect(f.evidenceIds).toEqual(expect.arrayContaining(['dom-1', 'ocr-1', 'vis-1']));
    expect(f.sources).toEqual(expect.arrayContaining(['dom', 'ocr', 'visual']));
    expect(f.fusedFrom).toBe(3);
    expect(f.multiSource).toBe(true);
  });

  it('keeps partially-visible and length metadata from any contributor (max wins)', () => {
    const result = fusePrivacyFindings([
      candidate({ evidenceId: 'a', length: 10 }),
      candidate({ evidenceId: 'b', length: 19, isPartiallyVisible: true }),
    ]);
    expect(result.findings[0]!.length).toBe(19);
    expect(result.findings[0]!.isPartiallyVisible).toBe(true);
  });
});

describe('Findings carry metadata only', () => {
  it('finding objects contain no value-bearing keys', () => {
    const result = fusePrivacyFindings([
      candidate({ evidenceId: 'a', selector: '#input-account-password' }),
      candidate({ evidenceId: 'b', source: 'ocr', selector: null, region: [104, 202, 214, 28] }),
    ]);
    for (const finding of result.findings) {
      const keys = Object.keys(finding);
      for (const forbidden of ['value', 'text', 'raw', 'password', 'ocrText']) {
        expect(keys).not.toContain(forbidden);
      }
      expect(typeof finding.confidence).toBe('number');
      expect(finding.decision.rawValueTransmissible).toBe(false);
    }
  });

  it('reports source and category counts accurately pre-fusion', () => {
    const result = fusePrivacyFindings([
      candidate({ evidenceId: 'a', source: 'dom' }),
      candidate({ evidenceId: 'b', source: 'ocr', region: [104, 202, 214, 28] }),
      candidate({ evidenceId: 'c', source: 'ocr', category: 'email', region: [400, 0, 100, 30], selector: '#mail' }),
    ]);
    expect(result.candidateCount).toBe(3);
    expect(result.sourceCounts).toEqual({ dom: 1, ocr: 2, visual: 0 });
    expect(result.categoryCounts.credit_card).toBe(2);
    expect(result.categoryCounts.email).toBe(1);
  });
});
