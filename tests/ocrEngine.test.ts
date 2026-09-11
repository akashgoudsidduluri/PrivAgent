import { describe, it, expect } from 'vitest';
import { MockOCREngine } from '../extension/src/ocr/ocrEngine';
import { InternalOCRResult } from '../extension/src/ocr/types';

describe('PrivAgent Local OCR Engine', () => {
  it('should initialize and terminate cleanly', async () => {
    const engine = new MockOCREngine();
    expect(engine.isInitialized()).toBe(false);

    await engine.init();
    expect(engine.isInitialized()).toBe(true);

    await engine.terminate();
    expect(engine.isInitialized()).toBe(false);
  });

  it('should return normalized OCR result with word and line bounding boxes', async () => {
    const sampleResult: Partial<InternalOCRResult> = {
      lines: [
        {
          text: 'Account Number: 1234 5678 9012',
          confidence: 0.94,
          bbox: { x0: 40, y0: 100, x1: 300, y1: 125 },
          words: [
            { text: 'Account', confidence: 0.95, bbox: { x0: 40, y0: 100, x1: 100, y1: 125 } },
            { text: 'Number:', confidence: 0.93, bbox: { x0: 105, y0: 100, x1: 160, y1: 125 } },
            { text: '1234', confidence: 0.95, bbox: { x0: 170, y0: 100, x1: 200, y1: 125 } },
            { text: '5678', confidence: 0.94, bbox: { x0: 205, y0: 100, x1: 235, y1: 125 } },
            { text: '9012', confidence: 0.96, bbox: { x0: 240, y0: 100, x1: 270, y1: 125 } },
          ],
        },
      ],
      words: [
        { text: 'Account', confidence: 0.95, bbox: { x0: 40, y0: 100, x1: 100, y1: 125 } },
        { text: 'Number:', confidence: 0.93, bbox: { x0: 105, y0: 100, x1: 160, y1: 125 } },
        { text: '1234', confidence: 0.95, bbox: { x0: 170, y0: 100, x1: 200, y1: 125 } },
        { text: '5678', confidence: 0.94, bbox: { x0: 205, y0: 100, x1: 235, y1: 125 } },
        { text: '9012', confidence: 0.96, bbox: { x0: 240, y0: 100, x1: 270, y1: 125 } },
      ],
      fullText: 'Account Number: 1234 5678 9012',
      latencyMs: 18.5,
    };

    const engine = new MockOCREngine(sampleResult);
    const result = await engine.recognize();

    expect(result.words.length).toBe(5);
    expect(result.lines.length).toBe(1);
    expect(result.fullText).toBe('Account Number: 1234 5678 9012');
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(result.words[0].bbox).toEqual({ x0: 40, y0: 100, x1: 100, y1: 125 });
  });

  it('should handle empty OCR results gracefully without crashing', async () => {
    const engine = new MockOCREngine({ words: [], lines: [], fullText: '', latencyMs: 2.1 });
    const result = await engine.recognize();

    expect(result.words).toEqual([]);
    expect(result.lines).toEqual([]);
    expect(result.fullText).toBe('');
    expect(result.latencyMs).toBe(2.1);
  });
});
