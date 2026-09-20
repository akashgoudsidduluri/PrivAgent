/**
 * PrivAgent 2.0 — Subphase P2.2: Spatial OCR Layer Test Suite
 *
 * Covers:
 *  1. Text privacy classification (SAFE_VISUAL_TEXT, SENSITIVE_VISUAL_TEXT, UNKNOWN_VISUAL_TEXT)
 *  2. Zero raw sensitive text leakage into safeText or remote-facing representations
 *  3. Generation stamping (pageGeneration) and perception source ('ocr')
 *  4. Conversion to SafeOCRRegion metadata for world model integration
 *  5. Integration with M8 privacy fusion (fuseSpatialOCRWithDOM)
 */

import { describe, it, expect } from 'vitest';
import {
  classifyOCRTextPrivacy,
  processSpatialOCRResult,
  convertToSafeOCRRegions,
  fuseSpatialOCRWithDOM,
} from '../extension/src/ocr/spatialOcrLayer';
import { InternalOCRResult } from '../extension/src/ocr/types';
import { DetectionResult } from '../extension/src/privacy/types';

describe('Subphase P2.2 — Spatial OCR Layer', () => {
  describe('classifyOCRTextPrivacy', () => {
    it('correctly classifies sensitive credentials using M8 raw value scanner', () => {
      // Credit card
      const card = classifyOCRTextPrivacy('Card: 4111 1111 1111 1111');
      expect(card.classification).toBe('sensitive');
      expect(card.sensitiveType).toBe('credit_card');

      // PAN
      const pan = classifyOCRTextPrivacy('PAN ABCDE1234F');
      expect(pan.classification).toBe('sensitive');
      expect(pan.sensitiveType).toBe('pan');

      // Password
      const pwd = classifyOCRTextPrivacy('Your password is Secret123');
      expect(pwd.classification).toBe('sensitive');
      expect(pwd.sensitiveType).toBe('password');

      // CVV
      const cvv = classifyOCRTextPrivacy('CVV 992');
      expect(cvv.classification).toBe('sensitive');
      expect(cvv.sensitiveType).toBe('cvv');

      // OTP
      const otp = classifyOCRTextPrivacy('One-time code: 492019');
      expect(otp.classification).toBe('sensitive');
      expect(otp.sensitiveType).toBe('otp');
    });

    it('classifies benign UI text as safe', () => {
      expect(classifyOCRTextPrivacy('Search products').classification).toBe('safe');
      expect(classifyOCRTextPrivacy('Add to Shopping Cart').classification).toBe('safe');
      expect(classifyOCRTextPrivacy('Order Summary').classification).toBe('safe');
      expect(classifyOCRTextPrivacy('Next Page').classification).toBe('safe');
    });

    it('classifies empty or degenerate fragments as unknown', () => {
      expect(classifyOCRTextPrivacy('').classification).toBe('unknown');
      expect(classifyOCRTextPrivacy('   ').classification).toBe('unknown');
    });
  });

  describe('processSpatialOCRResult', () => {
    it('processes InternalOCRResult into generation-stamped OCRRegions and scrubs sensitive text', () => {
      const mockOcrResult: InternalOCRResult = {
        fullText: 'Shop Online\nCard: 4111 1111 1111 1111\nCheckout Now',
        latencyMs: 15,
        words: [],
        lines: [
          {
            text: 'Shop Online',
            confidence: 0.95,
            bbox: { x0: 20, y0: 20, x1: 150, y1: 50 },
            words: [],
          },
          {
            text: 'Card: 4111 1111 1111 1111',
            confidence: 0.98,
            bbox: { x0: 20, y0: 60, x1: 280, y1: 90 },
            words: [],
          },
          {
            text: 'Checkout Now',
            confidence: 0.92,
            bbox: { x0: 20, y0: 100, x1: 180, y1: 130 },
            words: [],
          },
        ],
      };

      const regions = processSpatialOCRResult(mockOcrResult, {
        pageGeneration: 4,
        imageDimensions: { width: 1280, height: 800 },
      });

      expect(regions.length).toBe(3);

      // 1. Safe line
      const safeLine = regions[0]!;
      expect(safeLine.textClassification).toBe('safe');
      expect(safeLine.sensitivity).toBe('safe');
      expect(safeLine.source).toBe('ocr');
      expect(safeLine.pageGeneration).toBe(4);
      expect(safeLine.safeText).toBe('Shop Online');

      // 2. Sensitive line: Raw card MUST be scrubbed from safeText
      const sensitiveLine = regions[1]!;
      expect(sensitiveLine.textClassification).toBe('sensitive');
      expect(sensitiveLine.sensitivity).toBe('sensitive');
      expect(sensitiveLine.sensitiveType).toBe('credit_card');
      expect(sensitiveLine.source).toBe('ocr');
      expect(sensitiveLine.pageGeneration).toBe(4);
      expect(sensitiveLine.safeText).toBeUndefined(); // CRITICAL INVARIANT

      // 3. Second safe line
      const checkoutLine = regions[2]!;
      expect(checkoutLine.textClassification).toBe('safe');
      expect(checkoutLine.safeText).toBe('Checkout Now');
    });
  });

  describe('convertToSafeOCRRegions & Serialization', () => {
    it('produces SafeOCRRegion metadata that contains zero raw credit card or password text', () => {
      const mockOcrResult: InternalOCRResult = {
        fullText: 'Password: SecretPassword123\nCard 4111111111111111',
        latencyMs: 10,
        words: [],
        lines: [
          {
            text: 'Password: SecretPassword123',
            confidence: 0.99,
            bbox: { x0: 10, y0: 10, x1: 200, y1: 40 },
            words: [],
          },
          {
            text: 'Card 4111111111111111',
            confidence: 0.97,
            bbox: { x0: 10, y0: 50, x1: 220, y1: 80 },
            words: [],
          },
        ],
      };

      const regions = processSpatialOCRResult(mockOcrResult, {
        pageGeneration: 2,
        imageDimensions: { width: 800, height: 600 },
      });

      const safeRegions = convertToSafeOCRRegions(regions);
      expect(safeRegions.length).toBe(2);
      expect(safeRegions[0]!.isSensitive).toBe(true);
      expect(safeRegions[1]!.isSensitive).toBe(true);

      const serialized = JSON.stringify(safeRegions);
      expect(serialized).not.toContain('SecretPassword123');
      expect(serialized).not.toContain('4111111111111111');
      expect(serialized).not.toContain('Password:');
    });
  });

  describe('M8 Privacy Fusion Integration', () => {
    it('fuses sensitive OCR detections with DOM detections into unified PrivacyFindings', () => {
      const mockOcrResult: InternalOCRResult = {
        fullText: 'Enter Password',
        latencyMs: 8,
        words: [],
        lines: [
          {
            text: 'Enter Password',
            confidence: 0.95,
            bbox: { x0: 50, y0: 100, x1: 250, y1: 140 },
            words: [],
          },
        ],
      };

      const ocrRegions = processSpatialOCRResult(mockOcrResult, {
        pageGeneration: 1,
        imageDimensions: { width: 1280, height: 800 },
      });

      const domDetections: DetectionResult[] = [
        {
          id: 'pwd-input',
          type: 'password',
          confidence: 0.99,
          bbox: [50, 100, 200, 40],
          source: 'dom_input_type',
          selector: '#pwd-input',
          length: 1,
        },
      ];

      const fused = fuseSpatialOCRWithDOM(ocrRegions, domDetections);
      expect(fused.length).toBe(1);
      expect(fused[0]!.category).toBe('password');
      expect(fused[0]!.sources).toContain('dom');
      expect(fused[0]!.sources).toContain('ocr');
    });
  });
});
