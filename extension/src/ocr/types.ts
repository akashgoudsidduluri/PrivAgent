import { SensitiveEntityType } from '../privacy/types';

/**
 * Bounding box coordinate rectangle for an OCR token or line.
 * (x0, y0) is top-left, (x1, y1) is bottom-right in pixel coordinates of the input bitmap.
 */
export interface OCRWordBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Strictly INTERNAL representation of an individual OCR word token.
 * NEVER exposed beyond the local OCR classification stage.
 * @internal
 */
export interface InternalOCRWord {
  text: string;
  confidence: number;
  bbox: OCRWordBox;
}

/**
 * Strictly INTERNAL representation of an OCR recognized line.
 * NEVER exposed beyond the local OCR classification stage.
 * @internal
 */
export interface InternalOCRLine {
  text: string;
  confidence: number;
  bbox: OCRWordBox;
  words: InternalOCRWord[];
}

/**
 * Complete internal result emitted by the Local OCR Engine.
 * Must be consumed by the OCR Sensitive Classifier and immediately discarded.
 * @internal
 */
export interface InternalOCRResult {
  lines: InternalOCRLine[];
  words: InternalOCRWord[];
  fullText: string;
  latencyMs: number;
}

/**
 * Safe, sanitized visual detection resulting from OCR classification.
 * Guaranteed to contain ZERO raw text, words, or character values.
 */
export interface SafeOCRDetection {
  id: string;
  type: SensitiveEntityType;
  confidence: number;
  /** Authoritative pixel coordinates on the captured screenshot bitmap: [sx, sy, sw, sh] */
  bbox: [number, number, number, number];
  length: number;
  source: 'ocr';
  isPartiallyVisible: boolean;
}

/**
 * Pluggable OCR Engine Interface.
 * Allows switching between Local Tesseract WebWorker and Mock/Test engines.
 */
export interface OCREngine {
  init(): Promise<void>;
  recognize(source: HTMLImageElement | HTMLCanvasElement | ImageData | string): Promise<InternalOCRResult>;
  terminate(): Promise<void>;
  isInitialized(): boolean;
}
