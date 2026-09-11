import {
  KEYWORDS,
  PATTERNS,
  isPotentialAccountNumber,
  isPotentialCVV,
  isPotentialOTP,
  isValidLuhn,
  isValidPAN,
  matchesKeyword,
} from '../privacy/patterns';
import { SensitiveEntityType } from '../privacy/types';
import { verifySafeOCRDetection } from './ocrSecurityBoundary';
import { InternalOCRLine, InternalOCRResult, InternalOCRWord, OCRWordBox, SafeOCRDetection } from './types';

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Merges multiple OCR bounding boxes into a single enclosing bounding box.
 */
function mergeBoxes(boxes: OCRWordBox[]): OCRWordBox {
  if (boxes.length === 0) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;

  for (const b of boxes) {
    if (b.x0 < x0) x0 = b.x0;
    if (b.y0 < y0) y0 = b.y0;
    if (b.x1 > x1) x1 = b.x1;
    if (b.y1 > y1) y1 = b.y1;
  }

  return { x0, y0, x1, y1 };
}

/**
 * Clamps and normalizes an OCR bounding box against authoritative image bitmap dimensions.
 */
function clampBoxToImage(
  box: OCRWordBox,
  dims: ImageDimensions
): { bbox: [number, number, number, number]; isPartiallyVisible: boolean } | null {
  const origW = box.x1 - box.x0;
  const origH = box.y1 - box.y0;
  if (origW <= 0 || origH <= 0) return null;

  // Completely outside
  if (box.x1 <= 0 || box.y1 <= 0 || box.x0 >= dims.width || box.y0 >= dims.height) {
    return null;
  }

  const clLeft = Math.max(0, Math.min(box.x0, dims.width));
  const clTop = Math.max(0, Math.min(box.y0, dims.height));
  const clRight = Math.max(0, Math.min(box.x1, dims.width));
  const clBottom = Math.max(0, Math.min(box.y1, dims.height));

  const clWidth = clRight - clLeft;
  const clHeight = clBottom - clTop;

  if (clWidth <= 0 || clHeight <= 0) return null;

  const isPartiallyVisible =
    clLeft !== box.x0 ||
    clTop !== box.y0 ||
    clRight !== box.x1 ||
    clBottom !== box.y1;

  return {
    bbox: [clLeft, clTop, clWidth, clHeight],
    isPartiallyVisible,
  };
}

/**
 * Detects sensitive visual regions from OCR results and produces safe, sanitized metadata.
 * Strips raw OCR text immediately upon classification.
 */
export function detectSensitiveOCRRegions(
  ocrResult: InternalOCRResult,
  imageDimensions: ImageDimensions
): SafeOCRDetection[] {
  const detections: SafeOCRDetection[] = [];
  let idCounter = 1;

  const addDetection = (
    type: SensitiveEntityType,
    confidence: number,
    rawBox: OCRWordBox,
    rawLength: number
  ) => {
    const clamped = clampBoxToImage(rawBox, imageDimensions);
    if (!clamped) return;

    const safeDet: SafeOCRDetection = {
      id: `ocr-det-${idCounter++}-${Date.now()}`,
      type,
      confidence: Math.min(1.0, Math.max(0.1, Number(confidence.toFixed(2)))),
      bbox: clamped.bbox,
      length: rawLength,
      source: 'ocr',
      isPartiallyVisible: clamped.isPartiallyVisible,
    };

    if (verifySafeOCRDetection(safeDet)) {
      detections.push(safeDet);
    } else {
      console.error('[PrivAgent OCR] Security check rejected unsafe detection metadata.');
    }
  };

  // Collect all words across ocrResult.words and line.words for exhaustive word-level analysis
  const allWords: InternalOCRWord[] = [...ocrResult.words];
  for (const line of ocrResult.lines) {
    if (Array.isArray(line.words)) {
      for (const lw of line.words) {
        if (!allWords.some(w => w.text === lw.text && w.bbox.x0 === lw.bbox.x0 && w.bbox.y0 === lw.bbox.y0)) {
          allWords.push(lw);
        }
      }
    }
  }

  // ── Step 1: Word-Level Analysis ──────────────────────────────────────────
  for (const word of allWords) {
    const text = word.text;
    if (!text || text.length < 3) continue;

    // 1.1 Email
    if (PATTERNS.EMAIL.test(text)) {
      addDetection('email', Math.max(0.95, word.confidence), word.bbox, text.length);
      continue;
    }

    // 1.2 Indian PAN (5 letters + 4 digits + 1 letter, e.g. ABCDE1234F)
    if (isValidPAN(text)) {
      addDetection('pan', Math.max(0.95, word.confidence), word.bbox, text.length);
      continue;
    }

    // 1.3 Contiguous Credit Card (13-19 digits without spaces)
    const digitsOnly = text.replace(/\D/g, '');
    if (digitsOnly.length >= 13 && digitsOnly.length <= 19 && isValidLuhn(digitsOnly)) {
      addDetection('credit_card', Math.max(0.98, word.confidence), word.bbox, text.length);
      continue;
    }

    // 1.4 Standalone Phone (10 digits starting with 6-9)
    if (/^[6-9]\d{9}$/.test(digitsOnly) && text.length >= 10 && text.length <= 14) {
      addDetection('phone', Math.max(0.92, word.confidence), word.bbox, text.length);
      continue;
    }
  }

  // ── Step 2: Line-Level Contextual & Multi-Word Analysis ───────────────────
  for (const line of ocrResult.lines) {
    const lineText = line.text;
    if (!lineText || lineText.length < 3) continue;

    // 2.0 Email at Line level (handles multi-token or joined text)
    const emailMatch = lineText.match(PATTERNS.EMAIL);
    if (emailMatch) {
      const emailCandidate = emailMatch[0].trim();
      const matchingWords = (line.words || []).filter(w => emailCandidate.includes(w.text) || w.text.includes(emailCandidate));
      const box = matchingWords.length > 0 ? mergeBoxes(matchingWords.map(w => w.bbox)) : line.bbox;
      addDetection('email', Math.max(0.95, line.confidence), box, emailCandidate.length);
    }

    // 2.1 Multi-word Credit Card on single line (e.g. "4111 1111 1111 1111")
    const cardMatch = lineText.match(PATTERNS.CREDIT_CARD);
    if (cardMatch) {
      const candidate = cardMatch[0].trim();
      if (isValidLuhn(candidate)) {
        // Find which words in this line belong to the credit card match
        const matchingWords = (line.words || []).filter(w => candidate.includes(w.text));
        const box = matchingWords.length > 0 ? mergeBoxes(matchingWords.map(w => w.bbox)) : line.bbox;
        addDetection('credit_card', Math.max(0.98, line.confidence), box, candidate.length);
      }
    }

    // 2.2 Multi-word Phone Number (e.g. "+91 98765 43210" or "987-654-3210")
    const phoneMatch = lineText.match(PATTERNS.PHONE);
    if (phoneMatch) {
      const phoneCandidate = phoneMatch[0].trim();
      const phoneDigits = phoneCandidate.replace(/\D/g, '');
      if (phoneDigits.length >= 10 && phoneDigits.length <= 13) {
        const matchingWords = line.words.filter(w => phoneCandidate.includes(w.text));
        const box = matchingWords.length > 0 ? mergeBoxes(matchingWords.map(w => w.bbox)) : line.bbox;
        addDetection('phone', Math.max(0.90, line.confidence), box, phoneCandidate.length);
      }
    }

    // 2.3 Bank Account Number with Context
    if (matchesKeyword(lineText, KEYWORDS.ACCOUNT_NUMBER)) {
      for (const w of line.words) {
        if (isPotentialAccountNumber(w.text, lineText)) {
          addDetection('account_number', Math.max(0.90, w.confidence), w.bbox, w.text.length);
        }
      }
    }

    // 2.4 CVV with Context (e.g. "CVV: 893")
    if (matchesKeyword(lineText, KEYWORDS.CVV)) {
      for (const w of line.words) {
        if (isPotentialCVV(w.text, lineText)) {
          addDetection('cvv', Math.max(0.92, w.confidence), w.bbox, w.text.length);
        }
      }
    }

    // 2.5 OTP with Context (e.g. "OTP is 492019")
    if (matchesKeyword(lineText, KEYWORDS.OTP)) {
      for (const w of line.words) {
        if (isPotentialOTP(w.text, lineText)) {
          addDetection('otp', Math.max(0.92, w.confidence), w.bbox, w.text.length);
        }
      }
    }
  }

  // De-duplicate detections covering overlapping coordinates of the same category
  return deduplicateDetections(detections);
}

/**
 * Deduplicates detections that significantly overlap and share the same entity type.
 */
function deduplicateDetections(detections: SafeOCRDetection[]): SafeOCRDetection[] {
  const result: SafeOCRDetection[] = [];

  for (const det of detections) {
    const duplicate = result.find(existing => {
      if (existing.type !== det.type) return false;
      const [x1, y1, w1, h1] = existing.bbox;
      const [x2, y2, w2, h2] = det.bbox;

      // Check center proximity and bounding overlap
      const xOverlap = Math.max(0, Math.min(x1 + w1, x2 + w2) - Math.max(x1, x2));
      const yOverlap = Math.max(0, Math.min(y1 + h1, y2 + h2) - Math.max(y1, y2));
      const overlapArea = xOverlap * yOverlap;
      const minArea = Math.min(w1 * h1, w2 * h2);

      return minArea > 0 && overlapArea / minArea > 0.6;
    });

    if (!duplicate) {
      result.push(det);
    }
  }

  return result;
}
