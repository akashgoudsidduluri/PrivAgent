import { describe, it, expect } from 'vitest';
import { detectSensitiveOCRRegions } from '../extension/src/ocr/ocrDetector';
import { InternalOCRResult } from '../extension/src/ocr/types';

const defaultDims = { width: 1000, height: 800 };

describe('PrivAgent OCR Sensitive Data Detector', () => {
  it('should detect synthetic email in canvas OCR words', () => {
    const ocrResult: InternalOCRResult = {
      lines: [
        {
          text: 'Contact: rahul.sharma@example.com for assistance',
          confidence: 0.94,
          bbox: { x0: 50, y0: 100, x1: 500, y1: 130 },
          words: [
            { text: 'Contact:', confidence: 0.95, bbox: { x0: 50, y0: 100, x1: 120, y1: 130 } },
            { text: 'rahul.sharma@example.com', confidence: 0.96, bbox: { x0: 130, y0: 100, x1: 380, y1: 130 } },
            { text: 'for', confidence: 0.90, bbox: { x0: 390, y0: 100, x1: 420, y1: 130 } },
            { text: 'assistance', confidence: 0.92, bbox: { x0: 430, y0: 100, x1: 500, y1: 130 } },
          ],
        },
      ],
      words: [
        { text: 'Contact:', confidence: 0.95, bbox: { x0: 50, y0: 100, x1: 120, y1: 130 } },
        { text: 'rahul.sharma@example.com', confidence: 0.96, bbox: { x0: 130, y0: 100, x1: 380, y1: 130 } },
      ],
      fullText: 'Contact: rahul.sharma@example.com for assistance',
      latencyMs: 12,
    };

    const detections = detectSensitiveOCRRegions(ocrResult, defaultDims);
    expect(detections.length).toBe(1);
    expect(detections[0]!.type).toBe('email');
    expect(detections[0]!.source).toBe('ocr');
    expect(detections[0]!.bbox).toEqual([130, 100, 250, 30]); // [x, y, w, h]
  });

  it('should detect Indian PAN card number (e.g. ABCDE1234F)', () => {
    const ocrResult: InternalOCRResult = {
      lines: [],
      words: [
        { text: 'PAN:', confidence: 0.90, bbox: { x0: 40, y0: 200, x1: 80, y1: 225 } },
        { text: 'ABCDE1234F', confidence: 0.97, bbox: { x0: 90, y0: 200, x1: 220, y1: 225 } },
      ],
      fullText: 'PAN: ABCDE1234F',
      latencyMs: 8,
    };

    const detections = detectSensitiveOCRRegions(ocrResult, defaultDims);
    expect(detections.length).toBe(1);
    expect(detections[0]!.type).toBe('pan');
    expect(detections[0]!.confidence).toBeGreaterThanOrEqual(0.95);
    expect(detections[0]!.bbox).toEqual([90, 200, 130, 25]);
  });

  it('should detect multi-word credit card with Luhn verification', () => {
    const ocrResult: InternalOCRResult = {
      lines: [
        {
          text: 'Card: 4111 1111 1111 1111',
          confidence: 0.95,
          bbox: { x0: 20, y0: 300, x1: 320, y1: 335 },
          words: [
            { text: 'Card:', confidence: 0.92, bbox: { x0: 20, y0: 300, x1: 60, y1: 335 } },
            { text: '4111', confidence: 0.97, bbox: { x0: 70, y0: 300, x1: 120, y1: 335 } },
            { text: '1111', confidence: 0.97, bbox: { x0: 130, y0: 300, x1: 180, y1: 335 } },
            { text: '1111', confidence: 0.97, bbox: { x0: 190, y0: 300, x1: 240, y1: 335 } },
            { text: '1111', confidence: 0.97, bbox: { x0: 250, y0: 300, x1: 300, y1: 335 } },
          ],
        },
      ],
      words: [],
      fullText: 'Card: 4111 1111 1111 1111',
      latencyMs: 14,
    };

    const detections = detectSensitiveOCRRegions(ocrResult, defaultDims);
    expect(detections.length).toBe(1);
    expect(detections[0]!.type).toBe('credit_card');
    expect(detections[0]!.confidence).toBeGreaterThanOrEqual(0.98);
  });

  it('should REJECT fake card numbers that fail Luhn validation', () => {
    const ocrResult: InternalOCRResult = {
      lines: [
        {
          text: 'Number: 4111 1111 1111 1112', // Luhn fails
          confidence: 0.95,
          bbox: { x0: 20, y0: 300, x1: 320, y1: 335 },
          words: [
            { text: 'Number:', confidence: 0.92, bbox: { x0: 20, y0: 300, x1: 60, y1: 335 } },
            { text: '4111', confidence: 0.97, bbox: { x0: 70, y0: 300, x1: 120, y1: 335 } },
            { text: '1111', confidence: 0.97, bbox: { x0: 130, y0: 300, x1: 180, y1: 335 } },
            { text: '1111', confidence: 0.97, bbox: { x0: 190, y0: 300, x1: 240, y1: 335 } },
            { text: '1112', confidence: 0.97, bbox: { x0: 250, y0: 300, x1: 300, y1: 335 } },
          ],
        },
      ],
      words: [],
      fullText: 'Number: 4111 1111 1111 1112',
      latencyMs: 10,
    };

    const detections = detectSensitiveOCRRegions(ocrResult, defaultDims);
    // Should NOT classify as credit_card because Luhn failed
    expect(detections.filter(d => d.type === 'credit_card')).toHaveLength(0);
  });

  it('should detect Indian phone numbers with country code (+91 98765 43210)', () => {
    const ocrResult: InternalOCRResult = {
      lines: [
        {
          text: 'Mobile: +91 98765 43210',
          confidence: 0.92,
          bbox: { x0: 30, y0: 400, x1: 280, y1: 430 },
          words: [
            { text: 'Mobile:', confidence: 0.90, bbox: { x0: 30, y0: 400, x1: 90, y1: 430 } },
            { text: '+91', confidence: 0.93, bbox: { x0: 100, y0: 400, x1: 130, y1: 430 } },
            { text: '98765', confidence: 0.94, bbox: { x0: 140, y0: 400, x1: 200, y1: 430 } },
            { text: '43210', confidence: 0.94, bbox: { x0: 210, y0: 400, x1: 270, y1: 430 } },
          ],
        },
      ],
      words: [],
      fullText: 'Mobile: +91 98765 43210',
      latencyMs: 11,
    };

    const detections = detectSensitiveOCRRegions(ocrResult, defaultDims);
    expect(detections.length).toBe(1);
    expect(detections[0]!.type).toBe('phone');
  });

  it('should detect bank account numbers when accompanied by account keyword context', () => {
    const ocrResult: InternalOCRResult = {
      lines: [
        {
          text: 'Account No: 123456789012',
          confidence: 0.91,
          bbox: { x0: 40, y0: 500, x1: 300, y1: 530 },
          words: [
            { text: 'Account', confidence: 0.92, bbox: { x0: 40, y0: 500, x1: 100, y1: 530 } },
            { text: 'No:', confidence: 0.90, bbox: { x0: 105, y0: 500, x1: 135, y1: 530 } },
            { text: '123456789012', confidence: 0.95, bbox: { x0: 145, y0: 500, x1: 280, y1: 530 } },
          ],
        },
      ],
      words: [],
      fullText: 'Account No: 123456789012',
      latencyMs: 9,
    };

    const detections = detectSensitiveOCRRegions(ocrResult, defaultDims);
    expect(detections.some(d => d.type === 'account_number')).toBe(true);
  });

  it('should NOT classify random numbers as account numbers without context', () => {
    const ocrResult: InternalOCRResult = {
      lines: [
        {
          text: 'Tracking Serial: 998877665544',
          confidence: 0.90,
          bbox: { x0: 40, y0: 500, x1: 300, y1: 530 },
          words: [
            { text: 'Tracking', confidence: 0.90, bbox: { x0: 40, y0: 500, x1: 110, y1: 530 } },
            { text: 'Serial:', confidence: 0.90, bbox: { x0: 115, y0: 500, x1: 165, y1: 530 } },
            { text: '998877665544', confidence: 0.92, bbox: { x0: 175, y0: 500, x1: 300, y1: 530 } },
          ],
        },
      ],
      words: [],
      fullText: 'Tracking Serial: 998877665544',
      latencyMs: 9,
    };

    const detections = detectSensitiveOCRRegions(ocrResult, defaultDims);
    expect(detections.filter(d => d.type === 'account_number')).toHaveLength(0);
  });

  it('should detect CVV and OTP with surrounding security context', () => {
    const ocrResult: InternalOCRResult = {
      lines: [
        {
          text: 'CVV: 893',
          confidence: 0.93,
          bbox: { x0: 10, y0: 60, x1: 100, y1: 90 },
          words: [
            { text: 'CVV:', confidence: 0.91, bbox: { x0: 10, y0: 60, x1: 50, y1: 90 } },
            { text: '893', confidence: 0.95, bbox: { x0: 55, y0: 60, x1: 95, y1: 90 } },
          ],
        },
        {
          text: 'Your Login OTP is 492019',
          confidence: 0.93,
          bbox: { x0: 10, y0: 120, x1: 250, y1: 150 },
          words: [
            { text: 'Your', confidence: 0.90, bbox: { x0: 10, y0: 120, x1: 50, y1: 150 } },
            { text: 'Login', confidence: 0.90, bbox: { x0: 55, y0: 120, x1: 95, y1: 150 } },
            { text: 'OTP', confidence: 0.93, bbox: { x0: 100, y0: 120, x1: 135, y1: 150 } },
            { text: 'is', confidence: 0.90, bbox: { x0: 140, y0: 120, x1: 155, y1: 150 } },
            { text: '492019', confidence: 0.95, bbox: { x0: 165, y0: 120, x1: 235, y1: 150 } },
          ],
        },
      ],
      words: [],
      fullText: 'CVV: 893\nYour Login OTP is 492019',
      latencyMs: 14,
    };

    const detections = detectSensitiveOCRRegions(ocrResult, defaultDims);
    expect(detections.some(d => d.type === 'cvv')).toBe(true);
    expect(detections.some(d => d.type === 'otp')).toBe(true);
  });

  it('should clamp partially visible OCR boxes and reject completely off-screen boxes', () => {
    const ocrResult: InternalOCRResult = {
      lines: [],
      words: [
        // Partially visible: extends beyond image width (1000)
        {
          text: 'test.user@company.com',
          confidence: 0.95,
          bbox: { x0: 950, y0: 100, x1: 1100, y1: 130 },
        },
        // Completely off-screen: y0 >= 800
        {
          text: 'offscreen@company.com',
          confidence: 0.95,
          bbox: { x0: 50, y0: 850, x1: 250, y1: 880 },
        },
      ],
      fullText: 'test.user@company.com offscreen@company.com',
      latencyMs: 8,
    };

    const detections = detectSensitiveOCRRegions(ocrResult, defaultDims);
    // Only the partially visible one is kept, clamped to width=1000
    expect(detections.length).toBe(1);
    expect(detections[0]!.isPartiallyVisible).toBe(true);
    expect(detections[0]!.bbox[0]).toBe(950);
    expect(detections[0]!.bbox[2]).toBe(50); // 1000 - 950 = 50 width
  });
});
