/**
 * PrivAgent — M8 Context Minimization Test Suite
 *
 * Verifies the minimized-context pipeline end to end (offline, no network):
 *
 *   TASK + sanitized payload → fusion → policy → task-relevance → bound
 *        → FIREWALL → minimized payload + model-facing view + report
 *
 * Guarantees tested:
 *   1. Fused duplicates collapse into one exported detection whose representative
 *      id is the DOM id (M5 target grounding keeps working).
 *   2. Fail-closed findings are DROPPED, never downgraded.
 *   3. Task-relevant findings rank before irrelevant ones (deterministic).
 *   4. The exported set is bounded by maxDetections.
 *   5. The result passes the raw-value firewall (no PII-shaped values escape).
 *   6. The model-facing view structurally excludes selectors, lengths, counters,
 *      OCR text and images.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_CONTEXT_DETECTIONS,
  buildModelFacingContext,
  extractTaskTerms,
  minimizeAgentContext,
} from '../extension/src/privacy/contextMinimizer';
import { AgentContextPayload } from '../extension/src/privacy/types';
import { PrivacyBoundaryError } from '../extension/src/privacy/rawValueScanner';

function detection(overrides: Record<string, unknown> = {}): AgentContextPayload['detections'][number] {
  return {
    id: 'element_card',
    type: 'credit_card',
    confidence: 0.98,
    bbox: { x: 100, y: 200, width: 220, height: 30 },
    length: 19,
    source: 'dom_autocomplete',
    selector: '#input-card-number',
    is_partially_visible: false,
    ...overrides,
  } as AgentContextPayload['detections'][number];
}

function payload(overrides: Partial<AgentContextPayload> = {}): AgentContextPayload {
  return {
    url: 'https://bank.example.com/portal',
    timestamp: 1720000000000,
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: null,
    detections: [detection()],
    total_elements_scanned: 15,
    sensitive_elements_detected: 1,
    sanitized_status: 'sanitized_only',
    ocr_metrics: null,
    ...overrides,
  };
}

describe('Task-term extraction (deterministic, explainable)', () => {
  it('lowercases, splits and removes stopwords/short tokens', () => {
    expect(extractTaskTerms('Open the account details and find the recent transactions')).toEqual([
      'account', 'details', 'transactions',
    ]);
  });

  it('returns an empty list for empty or missing tasks', () => {
    expect(extractTaskTerms('')).toEqual([]);
    expect(extractTaskTerms(undefined)).toEqual([]);
  });

  it('deduplicates repeated terms', () => {
    expect(extractTaskTerms('card card CARD')).toEqual(['card']);
  });
});

describe('Fusion inside minimization', () => {
  it('collapses a DOM detection and its OCR twin into ONE exported detection', () => {
    const result = minimizeAgentContext(
      payload({
        detections: [
          detection({ id: 'element_card', type: 'credit_card', source: 'dom_autocomplete' }),
          detection({
            id: 'ocr-det-1-1720000000000',
            type: 'credit_card',
            confidence: 0.99,
            source: 'ocr',
            selector: 'canvas:visual-ocr',
            bbox: { x: 105, y: 202, width: 210, height: 26 },
          }),
        ],
      }),
      { task: 'Find the card field' }
    );
    expect(result.report.fused_groups).toBe(1);
    expect(result.report.collapsed_duplicates).toBe(1);
    expect(result.payload.detections).toHaveLength(1);
    // Representative id prefers the DOM id so M5 grounding still works.
    expect(result.payload.detections[0]!.id).toBe('element_card');
  });

  it('reports perception-source counts accurately', () => {
    const result = minimizeAgentContext(
      payload({
        detections: [
          detection({ id: 'a', source: 'dom_input_type', selector: '#one', bbox: { x: 0, y: 0, width: 100, height: 20 } }),
          detection({
            id: 'ocr-1-1720000000000',
            type: 'credit_card',
            source: 'ocr',
            selector: 'canvas:visual-ocr',
            bbox: { x: 200, y: 0, width: 100, height: 20 },
          }),
        ],
      }),
      { task: '' }
    );
    expect(result.report.sources).toEqual({ dom: 1, ocr: 1, visual: 0 });
  });
});

describe('Fail-closed dropping (stricter direction only)', () => {
  it('drops unknown-category findings instead of exporting them', () => {
    const result = minimizeAgentContext(
      payload({
        detections: [
          // Disjoint geometry: no fusion with the card field.
          detection({ id: 'unknown_el', type: 'mystery_type' as never, confidence: 0.9, bbox: { x: 500, y: 500, width: 100, height: 20 }, selector: '#mystery' }),
          detection({ id: 'element_card' }),
        ],
      }),
      { task: '' }
    );
    // Unknown category fails closed at the policy layer → dropped, never exported.
    expect(result.payload.detections.map((d) => d.id)).toEqual(['element_card']);
    expect(result.report.dropped_ids).toContain('finding-mystery_type-1');
    expect(result.report.dropped_reasons.join(' ')).toContain('policy_fail_closed');
    expect(result.report.fail_closed_dropped).toBeGreaterThanOrEqual(1);
  });

  it('drops sub-threshold confidence findings via the policy fail-closed escalation', () => {
    const result = minimizeAgentContext(
      payload({ detections: [detection({ confidence: 0.2 })] }),
      { task: '' }
    );
    expect(result.payload.detections).toHaveLength(0);
    expect(result.report.fail_closed_dropped).toBeGreaterThanOrEqual(1);
  });

  it('never exports more than what was detected and keeps counters intact', () => {
    const input = payload({
      detections: [
        detection(),
        detection({ id: 'element_pwd', type: 'password', confidence: 1, selector: '#pwd', length: 10 }),
      ],
    });
    const result = minimizeAgentContext(input, { task: '' });
    expect(result.payload.sanitized_status).toBe('sanitized_only');
    // Raw detection counters are copied verbatim from the sanitized input.
    expect(result.payload.sensitive_elements_detected).toBe(input.sensitive_elements_detected);
    expect(result.payload.detections.length).toBeLessThanOrEqual(result.report.findings_detected);
  });
});

describe('Task-relevant ranking (deterministic)', () => {
  it('ranks task-relevant findings before irrelevant ones at equal severity', () => {
    const result = minimizeAgentContext(
      payload({
        detections: [
          detection({ id: 'element_email', type: 'email', confidence: 0.95, selector: '#contact-email', bbox: { x: 0, y: 0, width: 100, height: 20 } }),
          detection({ id: 'element_transactions', type: 'account_number', confidence: 0.95, selector: '#account-transactions', bbox: { x: 0, y: 50, width: 100, height: 20 } }),
        ],
      }),
      { task: 'find the account transactions' }
    );
    expect(result.report.task_relevant_ids).toContain('finding-account_number-2');
    // account_number (high) sorts above email (medium); within same severity,
    // the task-relevant one comes first.
    const ids = result.payload.detections.map((d) => d.id);
    expect(ids[0]).toBe('element_transactions');
  });

  it('the task string itself is the only free text exported in modelView', () => {
    const result = minimizeAgentContext(payload(), { task: 'open the account details' });
    expect(result.modelView.task).toBe('open the account details');
    expect(result.modelView.task_terms).toEqual(['account', 'details']);
  });
});

describe('Bounding', () => {
  it('caps exported detections at maxDetections and records the drops', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      detection({
        id: `element_${i}`,
        selector: `#field-${i}`,
        type: 'email',
        confidence: 0.95,
        bbox: { x: i * 300, y: 0, width: 100, height: 20 },
      })
    );
    const result = minimizeAgentContext(payload({ detections: many }), { task: '', maxDetections: 5 });
    expect(result.payload.detections).toHaveLength(5);
    expect(result.report.bounded).toBe(true);
    expect(result.report.dropped_reasons.join(' ')).toContain('bounded_by_max_detections');
  });

  it('exposes the default ceiling constant', () => {
    expect(DEFAULT_MAX_CONTEXT_DETECTIONS).toBeGreaterThan(0);
  });
});

describe('Model-facing view (structural minimization)', () => {
  it('exports only allowlisted element metadata — no selectors, lengths, counters, OCR or images', () => {
    const view = buildModelFacingContext(
      payload({
        detections: [detection(), detection({ id: 'element_pwd', type: 'password', confidence: 1, selector: '#pwd', length: 10 })],
        ocr_metrics: { regions_scanned: 5, sensitive_detected: 2, latency_ms: 10 },
      }),
      'find the card'
    );
    expect(view.sanitization).toBe('minimized_sanitized_only');
    expect(view.elements).toHaveLength(2);
    for (const element of view.elements) {
      expect(Object.keys(element).sort()).toEqual(
        ['bbox', 'category', 'confidence', 'id', 'redacted', 'severity', 'sources'].sort()
      );
      expect(typeof element.id).toBe('string');
      expect(element.redacted).toBe(true); // card + password both mustRedact
    }
    const serialized = JSON.stringify(view);
    for (const forbidden of ['#input-card-number', '"length"', 'total_elements', 'ocr_metrics', 'selector', 'base64']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('marks non-redact categories (phone/email/name) as not locally redacted', () => {
    const view = buildModelFacingContext(payload({ detections: [detection({ type: 'phone', selector: '#phone' })] }));
    expect(view.elements[0]!.redacted).toBe(false);
    expect(view.elements[0]!.severity).toBe('medium');
  });
});

describe('Firewall: minimized output is scanned before hand-off', () => {
  it('a PII-shaped value smuggled into a detection is rejected (fail closed)', () => {
    const smuggled = payload({
      detections: [detection({ selector: 'rahul.sharma@example.com' })],
    });
    expect(() => minimizeAgentContext(smuggled, { task: '' })).toThrow(PrivacyBoundaryError);
  });

  it('known raw values supplied by the caller cannot survive minimization', () => {
    const known = '4111111111111111';
    const withRaw = payload({
      detections: [detection({ selector: `x-${known}` })],
    });
    // The zero-leakage check reuses the OCR boundary's Error type; either way
    // minimization MUST throw rather than return a leaking payload.
    expect(() =>
      minimizeAgentContext(withRaw, { task: '', knownRawValues: [known] })
    ).toThrow(/Raw sensitive/);
  });

  it('a clean minimized payload passes the firewall and stays a valid M4 payload', () => {
    const result = minimizeAgentContext(
      payload({
        detections: [
          detection(),
          detection({ id: 'element_email', type: 'email', confidence: 0.95, selector: '#contact-email', bbox: { x: 0, y: 60, width: 200, height: 20 } }),
        ],
      }),
      { task: 'open the account details' }
    );
    expect(result.payload.sanitized_status).toBe('sanitized_only');
    expect(result.payload.detections.length).toBe(2);
    expect(result.report.sanitized_only).toBe(true);
  });
});
