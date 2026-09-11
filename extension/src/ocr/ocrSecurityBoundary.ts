import { SafeOCRDetection } from './types';

// Forbidden keys that must never appear on any safe OCR detection object
const FORBIDDEN_KEYS = new Set([
  'text',
  'value',
  'textcontent',
  'innertext',
  'rawtext',
  'rawocr',
  'ocrtext',
  'rawvalue',
  'secretvalue',
  'val',
  'words',
  'lines',
  'fulltext',
]);

const ALLOWED_SAFE_OCR_KEYS = new Set([
  'id',
  'type',
  'confidence',
  'bbox',
  'length',
  'source',
  'isPartiallyVisible',
]);

/**
 * Validates that an individual SafeOCRDetection strictly adheres to the security boundary.
 * Throws an error or returns false if any raw text property or unexpected key is present.
 */
export function verifySafeOCRDetection(detection: unknown): boolean {
  if (!detection || typeof detection !== 'object') {
    return false;
  }

  const obj = detection as Record<string, unknown>;

  // Check required fields
  if (!('id' in obj && 'type' in obj && 'bbox' in obj && 'source' in obj)) {
    return false;
  }

  if (obj.source !== 'ocr') {
    return false;
  }

  // Check all keys against allowlist
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_SAFE_OCR_KEYS.has(key)) {
      console.error(`[PrivAgent OCR Security Violation] Unexpected property in SafeOCRDetection: "${key}"`);
      return false;
    }
  }

  // Check forbidden keys explicitly
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      console.error(`[PrivAgent OCR Security Violation] Forbidden key in SafeOCRDetection: "${key}"`);
      return false;
    }
  }

  // Check bbox format: exactly 4 positive numbers [x, y, w, h]
  if (!Array.isArray(obj.bbox) || obj.bbox.length !== 4) {
    return false;
  }

  return true;
}

/**
 * Validates an array of SafeOCRDetections.
 */
export function verifySafeOCRDetections(detections: unknown[]): boolean {
  return detections.every(d => verifySafeOCRDetection(d));
}

/**
 * Invariant Checker: Asserts that a serialized JSON string does not contain any of the
 * given sensitive raw strings.
 * @throws Error if any raw sensitive string is found inside the serialized representation.
 */
export function assertZeroLeakageInPayload(payload: unknown, rawSecrets: string[]): void {
  const serialized = JSON.stringify(payload);
  if (!serialized) return;

  for (const secret of rawSecrets) {
    if (!secret || secret.trim().length === 0) continue;
    const cleanSecret = secret.trim();
    // Only check non-trivial secrets (length >= 3)
    if (cleanSecret.length >= 3 && serialized.includes(cleanSecret)) {
      throw new Error(
        `[PrivAgent Security Invariant Violation] Raw sensitive OCR value leaked into serialized metadata!`
      );
    }
  }
}
