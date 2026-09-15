/**
 * PrivAgent — M8 Raw-Value Firewall Test Suite
 *
 * The LAST line of defense before anything is handed to a reasoning provider.
 * An independent scan of an outgoing object for:
 *   (a) forbidden keys (value, text, password, rawOCR, cvv, ...) and
 *   (b) VALUES that look like raw sensitive data (email, phone, Luhn-valid
 *       card, PAN, labelled credentials, credential tokens, raw media).
 *
 * Guarantee style mirrors the existing M4/M7 network-boundary tests: the scan
 * operates on the SERIALIZED shape, violations carry only a path + rule code —
 * never the offending value.
 */

import { describe, it, expect } from 'vitest';
import {
  FORBIDDEN_PAYLOAD_KEYS,
  STRUCTURAL_VALUE_KEYS,
  PrivacyBoundaryError,
  assertNoRawSensitiveValues,
  findKnownRawValueLeaks,
  scanForRawSensitiveValues,
} from '../extension/src/privacy/rawValueScanner';

describe('Forbidden key detection', () => {
  it('flags every canonical forbidden key at any depth', () => {
    for (const key of FORBIDDEN_PAYLOAD_KEYS) {
      const violations = scanForRawSensitiveValues({ nested: { [key]: 'x' } });
      expect(violations).toContainEqual({ path: '<root>.nested.' + key, rule: 'forbidden_key' });
    }
  });

  it('normalizes snake_case and case variants of forbidden keys', () => {
    expect(scanForRawSensitiveValues({ card_number: 'x' }).some((v) => v.rule === 'forbidden_key')).toBe(true);
    expect(scanForRawSensitiveValues({ RawText: 'x' }).some((v) => v.rule === 'forbidden_key')).toBe(true);
  });

  it('allows all keys of a legitimate sanitized payload', () => {
    const payload = {
      url: 'https://bank.example.com/portal',
      timestamp: 1720000000000,
      viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
      screenshot_dimensions: { width: 2560, height: 1600 },
      detections: [
        {
          id: 'element_card',
          type: 'credit_card',
          confidence: 0.98,
          bbox: { x: 100, y: 200, width: 220, height: 30 },
          length: 19,
          source: 'dom_autocomplete',
          selector: '#input-card-number',
          is_partially_visible: false,
        },
      ],
      total_elements_scanned: 15,
      sensitive_elements_detected: 1,
      sanitized_status: 'sanitized_only',
      ocr_metrics: { regions_scanned: 12, sensitive_detected: 2, latency_ms: 311.4 },
    };
    expect(scanForRawSensitiveValues(payload)).toEqual([]);
  });
});

describe('PII-shaped value detection', () => {
  it('detects an email value anywhere', () => {
    const violations = scanForRawSensitiveValues({ note: 'contact rahul.sharma@example.com today' });
    expect(violations.some((v) => v.rule === 'email')).toBe(true);
  });

  it('detects a PAN value (strong rule, even in structural fields)', () => {
    const violations = scanForRawSensitiveValues({ selector: 'ABCDE1234F' });
    expect(violations.some((v) => v.rule === 'pan')).toBe(true);
  });

  it('detects a Luhn-valid card number in value-bearing fields', () => {
    const violations = scanForRawSensitiveValues({ note: 'pay with 4111 1111 1111 1111 please' });
    expect(violations.some((v) => v.rule === 'credit_card')).toBe(true);
  });

  it('detects a labelled credential and credential-token shapes', () => {
    const labelled = scanForRawSensitiveValues({ note: 'password: hunter2' });
    expect(labelled.some((v) => v.rule === 'labelled_credential')).toBe(true);

    const token = scanForRawSensitiveValues({ note: 'Bearer Abcdefg12345' });
    expect(token.some((v) => v.rule === 'credential_token')).toBe(true);
  });

  it('detects raw media (data URLs / base64 blobs)', () => {
    const violations = scanForRawSensitiveValues({
      note: 'data:image/png;base64,' + 'A'.repeat(60),
    });
    expect(violations.some((v) => v.rule === 'raw_media')).toBe(true);
  });

  it('detects a bare digit run as an account-number shape in value fields', () => {
    const violations = scanForRawSensitiveValues({ note: '123456789012' });
    expect(violations.some((v) => v.rule === 'account_number')).toBe(true);
  });

  it('does NOT fail on safe UI metadata values', () => {
    const violations = scanForRawSensitiveValues({
      url: 'http://localhost:4173/account',
      selector: '#input-account-password',
      id: 'element_card',
      task: 'Open the account details and find the recent transactions',
      note: 'three fields remain redacted',
    });
    expect(violations).toEqual([]);
  });

  it('applies only strong rules to structural keys (ids may embed timestamps)', () => {
    // The OCR id format embeds a 13-digit epoch — must not trip digit-run rules.
    const violations = scanForRawSensitiveValues({ id: 'ocr-det-1-1720000000000' });
    expect(violations).toEqual([]);
  });

  it('respects extraStructuralKeys overrides', () => {
    const opts = { extraStructuralKeys: ['note'] };
    expect(scanForRawSensitiveValues({ note: '9876543210' }, opts)).toEqual([]);
    expect(
      scanForRawSensitiveValues({ note: '9876543210' }).some((v) => v.rule === 'phone')
    ).toBe(true);
  });
});

describe('assertNoRawSensitiveValues (fail-closed gate)', () => {
  it('throws PrivacyBoundaryError listing rule codes, not values', () => {
    try {
      assertNoRawSensitiveValues({ a: { b: 'rahul.sharma@example.com' } });
      expect.unreachable('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PrivacyBoundaryError);
      const e = err as PrivacyBoundaryError;
      expect(e.violations.some((v) => v.rule === 'email')).toBe(true);
      expect(e.message).not.toContain('rahul.sharma@example.com');
    }
  });

  it('passes clean payloads silently', () => {
    expect(() =>
      assertNoRawSensitiveValues({ sanitized_status: 'sanitized_only', detections: [] })
    ).not.toThrow();
  });
});

describe('Known-value zero-leakage helper', () => {
  it('finds known raw values anywhere in the serialized object', () => {
    const leaks = findKnownRawValueLeaks(
      { detections: [{ selector: 'x-4111111111111111' }] },
      ['4111111111111111']
    );
    expect(leaks).toEqual(['4111111111111111']);
  });

  it('returns no leaks for clean payloads', () => {
    expect(findKnownRawValueLeaks({ note: 'all clear' }, ['4111111111111111'])).toEqual([]);
  });
});

describe('Structural key set is exported and used by the scan', () => {
  it('includes the id/selector/url structural exemptions', () => {
    for (const key of ['id', 'selector', 'url']) {
      expect(STRUCTURAL_VALUE_KEYS.has(key)).toBe(true);
    }
  });
});
