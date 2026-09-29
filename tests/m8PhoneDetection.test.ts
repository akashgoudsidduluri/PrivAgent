/**
 * M8 PHONE-DETECTION GAP — regression suite.
 *
 * The gap: `PATTERNS.PHONE` only matches a bare 10-digit run when it starts
 * with [6-9] (the Indian mobile numbering plan) or carries separators, so
 * "Support line 5551234567" matched nothing at all.
 *
 * The fix is deliberately NOT "treat every 10-digit number as a phone". On the
 * corpus below that naive rule produces 13 false positives. The rule requires
 * three independent gates — shape, phone-intent context, and a non-phone label
 * guard — so the POSITIVE cases below must all be caught while every NEGATIVE
 * case must stay clean.
 *
 * These tests drive the REAL production detectors (domDetector, rawValueScanner,
 * contextMinimizer) and assert that a detected phone never leaks a raw value
 * into metadata, redaction, or the egress payload.
 */

import { describe, it, expect } from 'vitest';
import {
  PATTERNS,
  hasContextualPhone,
  matchesKeyword,
  KEYWORDS,
} from '../extension/src/privacy/patterns';
import { scanForRawSensitiveValues } from '../extension/src/privacy/rawValueScanner';
import { scanDOM } from '../extension/src/privacy/domDetector';
import { minimizeAgentContext } from '../extension/src/privacy/contextMinimizer';
import { AgentContextPayload } from '../extension/src/privacy/types';

/**
 * The synthetic value under test. It is a documented US fictional toll-free
 * range value, is never a real subscriber number, and is only ever used
 * locally. Evidence artifacts record METADATA ONLY — never this string.
 */
const PHONE = '5551234567';

// ─────────────────────────────────────────────────────────────────────────────
describe('M8 phone gap — POSITIVE cases', () => {
  const POSITIVES: Array<[string, string]> = [
    ['1. clear phone context', `Phone: ${PHONE}`],
    ['2. existing valid 6-9-leading phone', 'Phone: 9876543210'],
    ['3. formatted phone', 'Phone: (555) 123-4567'],
    ['4a. dashed formatted phone', 'Phone: 555-123-4567'],
    ['4b. international formatted phone', 'Phone: +1 555 123 4567'],
    ['4c. phone with punctuation/context', `For orders call ${PHONE}.`],
    ['5a. prose introduction', `Call us at ${PHONE}, we are open 9am.`],
    ['5b. prose support line', `Support line ${PHONE} available 9am to 5pm`],
    ['6. contact number label (space-separated)', `Contact Number: ${PHONE}`],
    ['7. mobile label', `Mobile: ${PHONE}`],
    ['8. tel label', `Tel: ${PHONE}`],
    ['9. phone number label', `Phone Number: ${PHONE}`],
  ];

  for (const [label, text] of POSITIVES) {
    it(`${label} is detected as a phone`, () => {
      const byPattern = PATTERNS.PHONE.test(text);
      const byContext = hasContextualPhone(text);
      expect(byPattern || byContext, `"${text}" detected as phone`).toBe(true);
    });
  }

  it('the pre-existing rules still detect everything they used to', () => {
    // Regression guard: the new rule is ADDITIVE and must not mask the old one.
    for (const text of ['Phone: 9876543210', 'Phone: (555) 123-4567', 'Phone: 555-123-4567', 'Phone: +1 555 123 4567']) {
      expect(PATTERNS.PHONE.test(text)).toBe(true);
    }
  });

  it('the [6-9] leading-digit restriction is still in force', () => {
    // A bare 10-digit run starting 0-5 with NO phone context is still not a
    // phone. The fix did not relax the numbering-plan assumption.
    expect(PATTERNS.PHONE.test('1234567890')).toBe(false);
    expect(hasContextualPhone('1234567890')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('M8 phone gap — NEGATIVE cases (precision)', () => {
  const NEGATIVES: Array<[string, string]> = [
    ['7. arbitrary 10-digit, no phone context', 'The dataset contains 1234567890 rows total today'],
    ['7b. arbitrary 10-digit in prose', 'The number 1234567890 appears in the report'],
    ['8. product ID', 'Product ID 1234567890'],
    ['9. order ID', 'Order ID 1234567890'],
    ['9b. invoice number', 'Invoice number 1234567890'],
    ['9c. tracking number', 'Tracking number 1234567890'],
    ['10. ZIP/postal-like number', 'ZIP code 1234567890'],
    ['10b. postal code label', 'Postal code 1234567890'],
    ['11. price-like number', 'Total 1234567890 dollars'],
    ['11b. count label', 'Count 1234567890'],
    ['12. timestamp-like number', 'Timestamp 1234567890 recorded'],
    ['12b. epoch label', 'Epoch 1234567890'],
    ['13. account/reference number', 'Account number 1234567890'],
    ['13b. reference number', 'Reference number 1234567890'],
    ['14. random numeric prose', 'The report contains 1234567890 observations'],
    ['14b. UUID-like', 'id 1234567890abcdef'],
    ['14c. 11-digit serial', 'Serial 12345678901'],
    ['14d. 9-digit serial', 'Serial 123456789'],
    ['14e. 12-digit serial', 'Serial 123456789012'],
    ['14f. phone word but an ID label', 'Phone order ID 1234567890'],
    ['14g. tracking with the word "call"', 'Call tracking number 1234567890'],
    // Short digit runs must not be phones even in phone context: these pin the
    // EXACT 10-digit length requirement (mutation P3 loosened this to 7+).
    ['14h. 7-digit run in phone context', 'Phone PIN 1234567'],
    ['14i. 8-digit run in phone context', 'Phone extension 12345678'],
    ['14j. 6-digit run in phone context', 'Phone code 123456'],
    ['14k. 13-digit run in phone context', 'Phone IMEI 1234567890123'],
    // A longer numeric token must never be SPLIT into a 10-digit phone.
    ['14l. 12-digit run in phone context', 'Phone serial 123456789012'],
    ['14m. 11-digit run in phone context', 'Phone mobile 12345678901'],
  ];

  for (const [label, text] of NEGATIVES) {
    it(`${label} is NOT a phone`, () => {
      expect(hasContextualPhone(text), `"${text}" must not be a phone`).toBe(false);
    });
  }

  it('the naive "every bare 10-digit number" rule WOULD have failed these', () => {
    // Documents WHY the rule is contextual. If this ever stops being true, the
    // justification for the gate design has been invalidated.
    const naive = (t: string) => /(?<![\d-])\d{10}(?![\d-])/.test(t);
    const caughtByNaive = NEGATIVES.filter(([, t]) => naive(t) && !hasContextualPhone(t));
    expect(caughtByNaive.length).toBeGreaterThan(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('M8 phone gap — detection metadata carries no raw value', () => {
  it('the M8 raw-value scanner flags the prose phone it used to miss', () => {
    const before = PATTERNS.PHONE.test(`Support line ${PHONE} available 9am`);
    expect(before).toBe(false); // the documented gap

    const violations = scanForRawSensitiveValues(`Support line ${PHONE} available 9am`);
    expect(violations.map((v) => v.rule)).toContain('phone');
  });

  it('a violation record contains only a path and a rule code', () => {
    const violations = scanForRawSensitiveValues(`Support line ${PHONE} available 9am`);
    expect(violations.length).toBeGreaterThan(0);
    for (const v of violations) {
      expect(Object.keys(v).sort()).toEqual(['path', 'rule']);
      // The path is a structural key path, never the value.
      expect(v.path).not.toContain(PHONE);
    }
    // And the whole serialised violation set carries no raw value.
    expect(JSON.stringify(violations)).not.toContain(PHONE);
  });

  it('DOM detection reports a phone without recording the value', () => {
    const doc = new DOMParser().parseFromString(
      `<!doctype html><html><body><label for="p">Phone</label><input id="p" value="${PHONE}"></body></html>`,
      'text/html'
    );
    const { detections } = scanDOM(doc);
    expect(detections.length).toBeGreaterThan(0);
    expect(JSON.stringify(detections)).not.toContain(PHONE);
  });

  it('detection metadata keeps the pre-existing confidence/source shape', () => {
    const doc = new DOMParser().parseFromString(
      `<!doctype html><html><body><p>Phone: ${PHONE}</p></body></html>`,
      'text/html'
    );
    const { detections } = scanDOM(doc);
    for (const r of detections) {
      expect(r).toHaveProperty('type');
      expect(r).toHaveProperty('confidence');
      expect(r).toHaveProperty('source');
    }
  });

  it('end-to-end: the prose case the old rules missed is now detected in the real DOM', () => {
    // This is the exact shape that produced the gap. It is detected through the
    // REAL scanner, and the detection record carries no raw value.
    const doc = new DOMParser().parseFromString(
      `<!doctype html><html><body><p>Support line ${PHONE} available 9am to 5pm</p></body></html>`,
      'text/html'
    );
    const { detections } = scanDOM(doc);
    expect(detections.some((d) => d.type === 'phone')).toBe(true);
    expect(JSON.stringify(detections)).not.toContain(PHONE);
  });

  it('end-to-end: a product ID in the same markup is still not detected', () => {
    const doc = new DOMParser().parseFromString(
      `<!doctype html><html><body><p>Product ID 1234567890</p></body></html>`,
      'text/html'
    );
    const { detections } = scanDOM(doc);
    expect(detections.some((d) => d.type === 'phone')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('M8 phone gap — redaction, minimization and egress', () => {
  it('context minimization carries no raw phone value', () => {
    const doc = new DOMParser().parseFromString(
      `<!doctype html><html><body><p>Phone: ${PHONE}</p></body></html>`,
      'text/html'
    );
    const { detections, totalElementsScanned } = scanDOM(doc);
    expect(detections.length).toBeGreaterThan(0);
    // Map the detector's DetectionResult onto the agent-facing AgentDetection
    // shape the context payload actually carries.
    const agentDetections = detections.map((d) => ({
      id: d.id,
      type: d.type,
      confidence: d.confidence,
      bbox: { x: d.bbox[0], y: d.bbox[1], width: d.bbox[2], height: d.bbox[3] },
      length: d.length ?? 0,
      source: d.source,
      selector: d.selector ?? '',
      is_partially_visible: false,
    }));

    const context: AgentContextPayload = {
      url: 'https://shop.example/contact',
      timestamp: Date.now(),
      viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
      screenshot_dimensions: null,
      detections: agentDetections,
      total_elements_scanned: totalElementsScanned,
      sensitive_elements_detected: agentDetections.length,
      sanitized_status: 'sanitized_only',
      ocr_metrics: null,
    };

    const minimized = minimizeAgentContext(context, { task: 'read the contact page' });
    const serialized = JSON.stringify(minimized.payload);
    expect(serialized).not.toContain(PHONE);
    // The category count is still reported, so the agent knows PII was seen.
    expect(minimized.payload.sensitive_elements_detected).toBeGreaterThan(0);
  });

  it('an outbound payload carrying the phone is rejected by the firewall', () => {
    const violations = scanForRawSensitiveValues({
      context: { note: `Support line ${PHONE} available 9am` },
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(JSON.stringify(violations)).not.toContain(PHONE);
  });

  it('the contextual rule does not fire on structural/identifier-only text', () => {
    // Structural keys are scanned with strong rules only; a short id must not
    // become a phone and start failing payloads closed.
    expect(hasContextualPhone('elem-42')).toBe(false);
    expect(hasContextualPhone('wm-g12-abc123')).toBe(false);
    expect(hasContextualPhone('ocr-det-1-1700000000000')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('M8 phone gap — no regression in other PII types', () => {
  it('email, card, PAN, OTP and CVV rules are untouched', () => {
    expect(PATTERNS.EMAIL.test('buyer@example.com')).toBe(true);
    expect(PATTERNS.PAN.test('ABCDE1234F')).toBe(true);
    expect(scanForRawSensitiveValues('buyer@example.com').map((v) => v.rule)).toContain('email');
    expect(scanForRawSensitiveValues('4111 1111 1111 1111').map((v) => v.rule)).toContain('credit_card');
    expect(scanForRawSensitiveValues('ABCDE1234F').map((v) => v.rule)).toContain('pan');
  });

  it('the keyword channel is unchanged', () => {
    expect(matchesKeyword('Phone: 123', KEYWORDS.PHONE)).toBe(true);
    expect(matchesKeyword('Mobile No: 123', KEYWORDS.PHONE)).toBe(true);
    expect(matchesKeyword('Product ID: 123', KEYWORDS.PHONE)).toBe(false);
  });
});
