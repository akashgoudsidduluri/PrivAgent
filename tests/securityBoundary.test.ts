import { describe, it, expect } from 'vitest';
import { verifySanitizedPayload, createSanitizedExport } from '../extension/src/privacy/securityBoundary';
import { PrivacyScanReport } from '../extension/src/privacy/types';

describe('PrivAgent Security Boundary Invariants', () => {
  const mockValidReport: PrivacyScanReport = {
    timestamp: Date.now(),
    url: 'http://localhost:4173',
    scanLatencyMs: 12.4,
    redactionLatencyMs: 3.1,
    totalElementsScanned: 48,
    sensitiveElementsDetected: 2,
    elementsProtected: 2,
    leakageCount: 0,
    categories: {
      password: 1,
      email: 1,
      phone: 0,
      credit_card: 0,
      account_number: 0,
      person_name: 0,
      pan: 0,
      otp: 0,
      cvv: 0,
    },
    detections: [
      {
        id: 'privagent-det-1',
        type: 'password',
        confidence: 1.0,
        selector: '#pwd',
        bbox: [100, 200, 250, 40],
        length: 15,
        source: 'dom_input_type',
      },
      {
        id: 'privagent-det-2',
        type: 'email',
        confidence: 0.98,
        selector: '#mail',
        bbox: [100, 260, 250, 40],
        length: 24,
        source: 'dom_autocomplete',
      },
    ],
    status: 'Sanitized Context — Local Privacy Check Passed',
    redactionMode: 'blackout',
  };

  it('should pass validation when zero raw PII values are present', () => {
    expect(verifySanitizedPayload(mockValidReport)).toBe(true);
  });

  it('should REJECT and block payload if a forbidden "value" key is present', () => {
    const leakyReport = {
      ...mockValidReport,
      detections: [
        {
          ...mockValidReport.detections[0],
          value: 'DemoPassword123', // LEAK
        },
      ],
    };

    expect(verifySanitizedPayload(leakyReport)).toBe(false);
    expect(() => createSanitizedExport(leakyReport as any)).toThrow(/Unsanitized context detected/);
  });

  it('should REJECT payload if a forbidden "textContent" or "password" key is present', () => {
    const leakyReport = {
      ...mockValidReport,
      password: 'DemoPassword123',
    };
    expect(verifySanitizedPayload(leakyReport)).toBe(false);
  });

  it('should REJECT payload if token, secret, card, cardnumber, cvv, pan, or accountnumber is present', () => {
    const forbiddenKeys = ['token', 'secret', 'card', 'cardNumber', 'cvv', 'pan', 'accountNumber'];
    for (const key of forbiddenKeys) {
      const leakyReport = {
        ...mockValidReport,
        [key]: 'synthetic_secret_val',
      };
      expect(verifySanitizedPayload(leakyReport)).toBe(false);
    }
  });

  it('should create a frozen, sanitized export', () => {
    const exported = createSanitizedExport(mockValidReport);
    expect(Object.isFrozen(exported)).toBe(true);
    expect(exported.status).toBe('Sanitized Context — Local Privacy Check Passed');
    expect(exported.leakageCount).toBe(0);
  });
});
