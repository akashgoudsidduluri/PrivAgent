import { describe, it, expect } from 'vitest';
import {
  verifyCandidateAgainstConstraints,
  extractCandidatesFromContext,
} from '../extension/src/agent/goalVerifier';
import { StructuredConstraints } from '../extension/src/agent/agentState';
import { AgentContextPayload } from '../extension/src/privacy/types';

describe('PrivAgent Phase 8 — Candidate Verification Engine', () => {
  const constraints: StructuredConstraints = {
    category: 'bag',
    style: 'baggy',
    color: 'black',
    size: 'XXL',
    maxPrice: 1000,
  };

  it('verifies product matching all constraints correctly', () => {
    const candidate = {
      title: 'XXL Black Baggy Travel Duffel Bag',
      price: 899,
      size: 'XXL',
      color: 'black',
      category: 'bag',
    };

    const res = verifyCandidateAgainstConstraints(candidate, constraints);
    expect(res.matches).toBe(true);
    expect(res.notes).toContain('All constraints verified');
  });

  it('strictly rejects candidate that exceeds max price (1499 > 1000)', () => {
    const candidate = {
      title: 'XXL Black Baggy Travel Bag',
      price: 1499,
      size: 'XXL',
      color: 'black',
      category: 'bag',
    };

    const res = verifyCandidateAgainstConstraints(candidate, constraints);
    expect(res.matches).toBe(false);
    expect(res.notes).toContain('exceeds max 1000');
  });

  it('strictly rejects candidate with wrong color (blue != black)', () => {
    const candidate = {
      title: 'XXL Blue Baggy Travel Bag',
      price: 950,
      size: 'XXL',
      color: 'blue',
      category: 'bag',
    };

    const res = verifyCandidateAgainstConstraints(candidate, constraints);
    expect(res.matches).toBe(false);
    expect(res.notes).toContain('does not match');
  });

  it('enforces UNKNOWN !== MATCH: missing size or price cannot assume match', () => {
    const candidateWithoutSize = {
      title: 'Black Baggy Travel Bag',
      price: 799,
      color: 'black',
      category: 'bag',
    };

    const res = verifyCandidateAgainstConstraints(candidateWithoutSize, constraints);
    expect(res.matches).toBe(false);
    expect(res.notes).toContain("Size 'unknown' does not match 'XXL'");
  });

  it('extracts candidate items from context detections safely without PII', () => {
    const mockContext: AgentContextPayload = {
      url: 'http://localhost:4174/results.html',
      timestamp: Date.now(),
      viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
      screenshot_dimensions: null,
      detections: [
        {
          id: 'det-bag-1',
          type: 'email',
          confidence: 0.95,
          bbox: { x: 10, y: 10, width: 250, height: 120 },
          length: 25,
          source: 'dom_attribute',
          selector: '#product-xxl-black-baggy-bag-899',
          is_partially_visible: false,
        },
        {
          id: 'det-bag-2',
          type: 'email',
          confidence: 0.9,
          bbox: { x: 10, y: 150, width: 250, height: 120 },
          length: 25,
          source: 'dom_attribute',
          selector: '#product-office-bag-1499',
          is_partially_visible: false,
        },
      ],
      total_elements_scanned: 2,
      sensitive_elements_detected: 0,
      sanitized_status: 'sanitized_only',
      ocr_metrics: null,
    };

    const candidates = extractCandidatesFromContext(mockContext, constraints);
    expect(candidates.length).toBe(2);

    const qualifying = candidates.filter((c) => c.matchesConstraints);
    expect(qualifying.length).toBe(1);
    expect(qualifying[0]?.price).toBe(899);
    expect(qualifying[0]?.size).toBe('XXL');
    expect(qualifying[0]?.color).toBe('black');
  });
});
