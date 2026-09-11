import { describe, it, expect } from 'vitest';
import {
  verifySafeOCRDetection,
  verifySafeOCRDetections,
  assertZeroLeakageInPayload,
} from '../extension/src/ocr/ocrSecurityBoundary';
import { detectSensitiveOCRRegions } from '../extension/src/ocr/ocrDetector';
import { InternalOCRResult, SafeOCRDetection } from '../extension/src/ocr/types';

describe('PrivAgent OCR Security Boundary Invariants', () => {
  it('should PASS valid SafeOCRDetection with metadata only', () => {
    const validDet: SafeOCRDetection = {
      id: 'ocr-det-1',
      type: 'email',
      confidence: 0.95,
      bbox: [100, 200, 150, 25],
      length: 24,
      source: 'ocr',
      isPartiallyVisible: false,
    };

    expect(verifySafeOCRDetection(validDet)).toBe(true);
  });

  it('should REJECT SafeOCRDetection containing forbidden raw text keys', () => {
    const forbiddenKeys = ['text', 'value', 'textContent', 'innerText', 'rawText', 'rawOCR', 'ocrText', 'words'];

    for (const key of forbiddenKeys) {
      const dirtyDet: any = {
        id: 'ocr-det-bad',
        type: 'email',
        confidence: 0.95,
        bbox: [100, 200, 150, 25],
        length: 24,
        source: 'ocr',
        [key]: 'secret@domain.com',
      };

      expect(verifySafeOCRDetection(dirtyDet)).toBe(false);
    }
  });

  it('should verify an array of detections strictly', () => {
    const safeDets: SafeOCRDetection[] = [
      { id: '1', type: 'email', confidence: 0.9, bbox: [10, 20, 50, 20], length: 15, source: 'ocr', isPartiallyVisible: false },
      { id: '2', type: 'credit_card', confidence: 0.98, bbox: [10, 60, 100, 20], length: 16, source: 'ocr', isPartiallyVisible: false },
    ];

    expect(verifySafeOCRDetections(safeDets)).toBe(true);

    const contaminated = [...safeDets, { ...safeDets[0], text: 'leaked' } as any];
    expect(verifySafeOCRDetections(contaminated)).toBe(false);
  });

  it('should assert that JSON serialization of OCR detection output contains ZERO raw sensitive values', () => {
    const rawEmail = 'rahul.sharma@example.com';
    const rawCard = '4111 1111 1111 1111';
    const rawPAN = 'ABCDE1234F';
    const rawPhone = '+91 98765 43210';

    const rawOCRResult: InternalOCRResult = {
      lines: [
        {
          text: `Email: ${rawEmail} Card: ${rawCard}`,
          confidence: 0.95,
          bbox: { x0: 20, y0: 50, x1: 500, y1: 80 },
          words: [
            { text: 'Email:', confidence: 0.95, bbox: { x0: 20, y0: 50, x1: 60, y1: 80 } },
            { text: rawEmail, confidence: 0.96, bbox: { x0: 70, y0: 50, x1: 250, y1: 80 } },
            { text: 'Card:', confidence: 0.95, bbox: { x0: 260, y0: 50, x1: 300, y1: 80 } },
            { text: '4111', confidence: 0.97, bbox: { x0: 310, y0: 50, x1: 350, y1: 80 } },
            { text: '1111', confidence: 0.97, bbox: { x0: 360, y0: 50, x1: 400, y1: 80 } },
            { text: '1111', confidence: 0.97, bbox: { x0: 410, y0: 50, x1: 450, y1: 80 } },
            { text: '1111', confidence: 0.97, bbox: { x0: 460, y0: 50, x1: 500, y1: 80 } },
          ],
        },
      ],
      words: [
        { text: rawPAN, confidence: 0.98, bbox: { x0: 20, y0: 100, x1: 150, y1: 130 } },
      ],
      fullText: `Email: ${rawEmail} Card: ${rawCard} PAN: ${rawPAN}`,
      latencyMs: 16,
    };

    // Classify into safe detections
    const safeDetections = detectSensitiveOCRRegions(rawOCRResult, { width: 1000, height: 800 });

    expect(safeDetections.length).toBeGreaterThanOrEqual(2);

    // Verify all returned detections strictly follow security boundary
    expect(verifySafeOCRDetections(safeDetections)).toBe(true);

    // Serialize payload to JSON as it would be exported
    const jsonOutput = JSON.stringify(safeDetections);

    // Check that none of the raw secrets appear in the serialized JSON
    expect(jsonOutput).not.toContain(rawEmail);
    expect(jsonOutput).not.toContain(rawCard);
    expect(jsonOutput).not.toContain(rawPAN);
    expect(jsonOutput).not.toContain(rawPhone);

    // Using security invariant helper
    expect(() => {
      assertZeroLeakageInPayload(safeDetections, [rawEmail, rawCard, rawPAN, rawPhone]);
    }).not.toThrow();

    // Verify helper catches deliberate leakage
    const leakedPayload = { detections: safeDetections, leak: rawEmail };
    expect(() => {
      assertZeroLeakageInPayload(leakedPayload, [rawEmail]);
    }).toThrow(/Raw sensitive OCR value leaked/);
  });
});
