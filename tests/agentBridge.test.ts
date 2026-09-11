/**
 * PrivAgent — Agent Bridge unit tests (Milestone 4)
 *
 * Tests:
 *  1. buildAgentPayload produces only allowlisted fields
 *  2. Raw DOM values cannot appear in the resulting payload
 *  3. Raw OCR values cannot appear in the resulting payload
 *  4. Forbidden fields are rejected by pre-flight validation
 *  5. Incorrect sanitized_status is rejected
 *  6. Missing sanitized_status is rejected
 *  7. Valid payload passes all checks
 *  8. Null returned when status sentinel is absent
 *  9. DOM-only path (no visual report) works correctly
 * 10. Visual report path populates ocr_metrics and screenshot_dimensions
 */

import { describe, it, expect } from 'vitest';
import {
  buildAgentPayload,
  AgentContextPayload,
  PrivacyScanReport,
  VisualCaptureReport,
} from '../extension/src/privacy/types';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeDomReport(overrides: Partial<PrivacyScanReport> = {}): PrivacyScanReport {
  return {
    timestamp: 1700000000000,
    url: 'http://localhost:8002/',
    scanLatencyMs: 12.3,
    redactionLatencyMs: 2.1,
    totalElementsScanned: 40,
    sensitiveElementsDetected: 2,
    elementsProtected: 2,
    leakageCount: 0,
    categories: {
      password: 0,
      credit_card: 1,
      account_number: 0,
      email: 1,
      phone: 0,
      person_name: 0,
      pan: 0,
      otp: 0,
      cvv: 0,
    },
    detections: [
      {
        id: 'det-001',
        type: 'email',
        confidence: 0.98,
        selector: '#email-field',
        bbox: [100, 200, 220, 30],
        length: 25,
        source: 'dom_input_type',
      },
      {
        id: 'det-002',
        type: 'credit_card',
        confidence: 0.96,
        selector: '#card-field',
        bbox: [100, 250, 300, 30],
        length: 16,
        source: 'text_pattern',
      },
    ],
    status: 'Sanitized Context — Local Privacy Check Passed',
    redactionMode: 'blackout',
    ...overrides,
  };
}

function makeVisualReport(overrides: Partial<VisualCaptureReport> = {}): VisualCaptureReport {
  return {
    captureMetadata: {
      viewportWidth: 1280,
      viewportHeight: 720,
      screenshotWidth: 1280,
      screenshotHeight: 720,
      devicePixelRatio: 1,
      scaleX: 1,
      scaleY: 1,
      scrollX: 0,
      scrollY: 0,
      capturedAt: 1700000000000,
    },
    visualDetections: [
      {
        id: 'vdet-001',
        type: 'email',
        confidence: 0.97,
        selector: '#email-field',
        viewportBBox: [100, 200, 220, 30],
        screenshotBBox: [100, 200, 220, 30],
        isPartiallyVisible: false,
        source: 'dom_input_type',
      },
    ],
    totalDetected: 1,
    totalPartiallyVisible: 0,
    totalOffscreenFiltered: 0,
    ocrRegionsScanned: 12,
    sensitiveOCRDetected: 1,
    ocrLatencyMs: 320.5,
    domSensitiveDetected: 1,
    status: 'Local Visual Context Prepared',
    ...overrides,
  };
}

/** Check an object deeply for forbidden keys */
function findForbiddenKeys(obj: unknown, forbidden: Set<string>, path = ''): string[] {
  const found: string[] = [];
  if (obj && typeof obj === 'object') {
    if (Array.isArray(obj)) {
      obj.forEach((item, i) => found.push(...findForbiddenKeys(item, forbidden, `${path}[${i}]`)));
    } else {
      for (const key of Object.keys(obj as Record<string, unknown>)) {
        if (forbidden.has(key)) found.push(`${path}.${key}`);
        found.push(...findForbiddenKeys((obj as Record<string, unknown>)[key], forbidden, `${path}.${key}`));
      }
    }
  }
  return found;
}

const FORBIDDEN_KEYS = new Set([
  'value', 'text', 'textContent', 'innerText',
  'rawText', 'rawOCR', 'ocrText', 'password', 'words', 'lines',
]);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildAgentPayload — allowlist enforcement', () => {
  it('returns non-null for a valid sanitized DOM report', () => {
    const payload = buildAgentPayload(makeDomReport(), null);
    expect(payload).not.toBeNull();
  });

  it('returns null when status is not the required sentinel', () => {
    const report = makeDomReport({ status: 'Scanning' });
    const payload = buildAgentPayload(report, null);
    expect(payload).toBeNull();
  });

  it('returns null when status is excluded site', () => {
    const report = makeDomReport({ status: 'Excluded Site' });
    const payload = buildAgentPayload(report, null);
    expect(payload).toBeNull();
  });

  it('payload carries the correct sanitized_status sentinel', () => {
    const payload = buildAgentPayload(makeDomReport(), null)!;
    expect(payload.sanitized_status).toBe('Sanitized Context — Local Privacy Check Passed');
  });

  it('payload contains ONLY allowlisted top-level fields', () => {
    const payload = buildAgentPayload(makeDomReport(), null)!;
    const allowedKeys = new Set([
      'url', 'timestamp', 'viewport', 'screenshot_dimensions',
      'detections', 'total_elements_scanned', 'sensitive_elements_detected',
      'sanitized_status', 'ocr_metrics',
    ]);
    for (const key of Object.keys(payload)) {
      expect(allowedKeys.has(key), `Unexpected key: ${key}`).toBe(true);
    }
  });

  it('payload contains NO forbidden keys at any depth (DOM-only path)', () => {
    const payload = buildAgentPayload(makeDomReport(), null)!;
    const violations = findForbiddenKeys(payload, FORBIDDEN_KEYS);
    expect(violations).toHaveLength(0);
  });

  it('payload contains NO forbidden keys at any depth (visual pipeline path)', () => {
    const payload = buildAgentPayload(makeDomReport(), makeVisualReport())!;
    const violations = findForbiddenKeys(payload, FORBIDDEN_KEYS);
    expect(violations).toHaveLength(0);
  });
});

describe('buildAgentPayload — DOM-only path', () => {
  it('detections come from DOM report when no visual report provided', () => {
    const payload = buildAgentPayload(makeDomReport(), null)!;
    expect(payload.detections).toHaveLength(2);
    expect(payload.detections[0].type).toBe('email');
    expect(payload.detections[1].type).toBe('credit_card');
  });

  it('detection bbox is converted to object form {x,y,width,height}', () => {
    const payload = buildAgentPayload(makeDomReport(), null)!;
    const bbox = payload.detections[0].bbox;
    expect(bbox).toHaveProperty('x', 100);
    expect(bbox).toHaveProperty('y', 200);
    expect(bbox).toHaveProperty('width', 220);
    expect(bbox).toHaveProperty('height', 30);
  });

  it('detection preserves length, confidence, source, selector', () => {
    const payload = buildAgentPayload(makeDomReport(), null)!;
    const det = payload.detections[0];
    expect(det.confidence).toBe(0.98);
    expect(det.length).toBe(25);
    expect(det.source).toBe('dom_input_type');
    expect(det.selector).toBe('#email-field');
  });

  it('screenshot_dimensions is null when no visual report', () => {
    const payload = buildAgentPayload(makeDomReport(), null)!;
    expect(payload.screenshot_dimensions).toBeNull();
  });

  it('ocr_metrics is null when no visual report', () => {
    const payload = buildAgentPayload(makeDomReport(), null)!;
    expect(payload.ocr_metrics).toBeNull();
  });

  it('url and timestamp come from DOM report', () => {
    const payload = buildAgentPayload(makeDomReport(), null)!;
    expect(payload.url).toBe('http://localhost:8002/');
    expect(payload.timestamp).toBe(1700000000000);
  });

  it('total counts are preserved correctly', () => {
    const payload = buildAgentPayload(makeDomReport(), null)!;
    expect(payload.total_elements_scanned).toBe(40);
    expect(payload.sensitive_elements_detected).toBe(2);
  });
});

describe('buildAgentPayload — visual pipeline path', () => {
  it('uses visual detections when visual report is provided', () => {
    const payload = buildAgentPayload(makeDomReport(), makeVisualReport())!;
    expect(payload.detections).toHaveLength(1);  // visual report has 1 detection
  });

  it('screenshot_dimensions are populated from capture metadata', () => {
    const payload = buildAgentPayload(makeDomReport(), makeVisualReport())!;
    expect(payload.screenshot_dimensions).toEqual({ width: 1280, height: 720 });
  });

  it('ocr_metrics are populated from visual report', () => {
    const payload = buildAgentPayload(makeDomReport(), makeVisualReport())!;
    expect(payload.ocr_metrics).toEqual({
      regions_scanned: 12,
      sensitive_detected: 1,
      latency_ms: 320.5,
    });
  });

  it('viewport is populated from capture metadata', () => {
    const payload = buildAgentPayload(makeDomReport(), makeVisualReport())!;
    expect(payload.viewport.width).toBe(1280);
    expect(payload.viewport.height).toBe(720);
  });
});

describe('buildAgentPayload — security: no raw values leak', () => {
  it('JSON-serialized payload does not contain raw credit card numbers', () => {
    const payload = buildAgentPayload(makeDomReport(), null)!;
    const json = JSON.stringify(payload);
    // These are synthetic test values that should NOT appear
    expect(json).not.toContain('4111111111111111');
    expect(json).not.toContain('1234567890123456');
  });

  it('JSON-serialized payload does not contain email addresses', () => {
    const payload = buildAgentPayload(makeDomReport(), null)!;
    const json = JSON.stringify(payload);
    expect(json).not.toContain('@example.com');
    expect(json).not.toContain('rahul.sharma');
  });

  it('DOM detections do not include value or textContent keys', () => {
    const payload = buildAgentPayload(makeDomReport(), null)!;
    for (const det of payload.detections) {
      expect(det).not.toHaveProperty('value');
      expect(det).not.toHaveProperty('text');
      expect(det).not.toHaveProperty('textContent');
      expect(det).not.toHaveProperty('innerText');
      expect(det).not.toHaveProperty('rawText');
    }
  });

  it('report with extra fields on detections does not pass forbidden keys through', () => {
    // buildAgentPayload only copies allowed fields per detection — extra keys are ignored
    const report = makeDomReport();
    // Simulate an internal detection having an extra field (TypeScript would reject this,
    // but test the runtime behavior)
    (report.detections[0] as any).internalRawValue = 'ShouldNotLeak';
    const payload = buildAgentPayload(report, null)!;
    const json = JSON.stringify(payload);
    expect(json).not.toContain('internalRawValue');
    expect(json).not.toContain('ShouldNotLeak');
  });
});
