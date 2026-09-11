import { describe, it, expect, beforeEach } from 'vitest';
import { detectSensitiveOCRRegions } from '../extension/src/ocr/ocrDetector';
import { InternalOCRResult } from '../extension/src/ocr/types';
import { VisualCanvasRedactor } from '../extension/src/capture/visualRedactor';
import { VisualDetectionResult } from '../extension/src/privacy/types';
import { assertZeroLeakageInPayload } from '../extension/src/ocr/ocrSecurityBoundary';

describe('PrivAgent Milestone 3 OCR Integration Pipeline', () => {
  beforeEach(() => {
    // Stub HTMLCanvasElement for jsdom environment if necessary
    if (typeof HTMLCanvasElement !== 'undefined') {
      HTMLCanvasElement.prototype.getContext = function (contextType: string) {
        if (contextType === '2d') {
          return {
            drawImage: () => {},
            fillRect: () => {},
            strokeRect: () => {},
            fillText: () => {},
            measureText: (text: string) => ({ width: text.length * 7 }),
            save: () => {},
            restore: () => {},
            beginPath: () => {},
            moveTo: () => {},
            lineTo: () => {},
            stroke: () => {},
            fill: () => {},
            getImageData: () => ({ data: new Uint8ClampedArray(4) }),
            putImageData: () => {},
            filter: 'none',
          } as unknown as CanvasRenderingContext2D;
        }
        return null;
      } as any;
    }
  });

  it('should run end-to-end from raw OCR output to visual canvas redaction without leakage', () => {
    const rawSecrets = [
      'rahul.sharma@example.com',
      '4111 1111 1111 1111',
      'ABCDE1234F',
    ];

    // 1. Raw OCR result emitted internally from OCR engine on synthetic canvas
    const ocrResult: InternalOCRResult = {
      lines: [
        {
          text: 'Account Email: rahul.sharma@example.com',
          confidence: 0.95,
          bbox: { x0: 20, y0: 30, x1: 400, y1: 60 },
          words: [
            { text: 'Account', confidence: 0.92, bbox: { x0: 20, y0: 30, x1: 90, y1: 60 } },
            { text: 'Email:', confidence: 0.90, bbox: { x0: 95, y0: 30, x1: 140, y1: 60 } },
            { text: 'rahul.sharma@example.com', confidence: 0.96, bbox: { x0: 150, y0: 30, x1: 390, y1: 60 } },
          ],
        },
        {
          text: 'Card Number: 4111 1111 1111 1111',
          confidence: 0.96,
          bbox: { x0: 20, y0: 80, x1: 360, y1: 110 },
          words: [
            { text: 'Card', confidence: 0.92, bbox: { x0: 20, y0: 80, x1: 60, y1: 110 } },
            { text: 'Number:', confidence: 0.90, bbox: { x0: 65, y0: 80, x1: 120, y1: 110 } },
            { text: '4111', confidence: 0.97, bbox: { x0: 130, y0: 80, x1: 175, y1: 110 } },
            { text: '1111', confidence: 0.97, bbox: { x0: 185, y0: 80, x1: 230, y1: 110 } },
            { text: '1111', confidence: 0.97, bbox: { x0: 240, y0: 80, x1: 285, y1: 110 } },
            { text: '1111', confidence: 0.97, bbox: { x0: 295, y0: 80, x1: 340, y1: 110 } },
          ],
        },
      ],
      words: [
        { text: 'ABCDE1234F', confidence: 0.96, bbox: { x0: 20, y0: 130, x1: 160, y1: 160 } },
      ],
      fullText: 'Account Email: rahul.sharma@example.com\nCard Number: 4111 1111 1111 1111\nPAN: ABCDE1234F',
      latencyMs: 14.2,
    };

    // 2. Sensitive visual detection & boundary stripping
    const safeOcrDetections = detectSensitiveOCRRegions(ocrResult, { width: 800, height: 600 });
    expect(safeOcrDetections.length).toBe(3);

    // Verify security boundary holds
    assertZeroLeakageInPayload(safeOcrDetections, rawSecrets);

    // 3. Map into VisualDetectionResult format
    const visualDetections: VisualDetectionResult[] = safeOcrDetections.map(det => ({
      id: det.id,
      type: det.type,
      confidence: det.confidence,
      selector: 'canvas:visual-ocr',
      viewportBBox: det.bbox,
      screenshotBBox: det.bbox,
      isPartiallyVisible: det.isPartiallyVisible,
      source: det.source,
    }));

    // 4. Feed unified detections into VisualCanvasRedactor
    const redactor = new VisualCanvasRedactor();
    const mockImage = { width: 800, height: 600 } as HTMLImageElement;

    // Test blackout mode
    const blackoutCanvas = redactor.renderSanitizedCanvas(mockImage, visualDetections, {
      mode: 'blackout',
      drawDebugOverlay: false,
    });
    expect(blackoutCanvas).toBeDefined();

    // Test blur mode
    const blurCanvas = redactor.renderSanitizedCanvas(mockImage, visualDetections, {
      mode: 'blur',
      drawDebugOverlay: false,
    });
    expect(blurCanvas).toBeDefined();

    // Test mask mode
    const maskCanvas = redactor.renderSanitizedCanvas(mockImage, visualDetections, {
      mode: 'mask',
      drawDebugOverlay: false,
    });
    expect(maskCanvas).toBeDefined();

    // Test debug overlay mode (with [OCR] tags)
    const debugCanvas = redactor.renderSanitizedCanvas(mockImage, visualDetections, {
      mode: 'blackout',
      drawDebugOverlay: true,
    });
    expect(debugCanvas).toBeDefined();
  });
});
