import { DetectionResult, PrivacyScanReport } from './types';

// Forbidden property keys that directly leak raw input/text data
const FORBIDDEN_VALUE_KEYS = new Set([
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
]);

// Sensitive credential keys that must never carry raw values
const CREDENTIAL_KEYS = new Set([
  'password',
  'secret',
  'token',
  'card',
  'cardnumber',
  'cvv',
  'pan',
  'accountnumber',
]);

// Strict allowlist for DetectionResult objects
const ALLOWED_DETECTION_KEYS = new Set([
  'id',
  'type',
  'confidence',
  'selector',
  'bbox',
  'length',
  'source',
  'viewportBBox',
  'screenshotBBox',
  'isPartiallyVisible',
  'label',
]);

/**
 * Validates that an object strictly complies with the local privacy boundary.
 * Rejects payloads if forbidden keys exist or if detections contain non-metadata fields.
 */
export function verifySanitizedPayload(data: unknown): boolean {
  if (!data || typeof data !== 'object') {
    return true;
  }

  if (Array.isArray(data)) {
    return data.every(item => verifySanitizedPayload(item));
  }

  const obj = data as Record<string, unknown>;

  // If this object is a DetectionResult, enforce strict allowlist of keys
  if ('type' in obj && 'bbox' in obj && 'selector' in obj) {
    for (const key of Object.keys(obj)) {
      if (!ALLOWED_DETECTION_KEYS.has(key)) {
        console.error(`[PrivAgent Security Violation] Forbidden key in DetectionResult: "${key}"`);
        return false;
      }
    }
  }

  for (const [key, val] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    
    // Check forbidden raw value keys
    if (FORBIDDEN_VALUE_KEYS.has(lowerKey)) {
      console.error(`[PrivAgent Security Violation] Raw text/value property detected: "${key}"`);
      return false;
    }

    // Check if an accidental credential was placed directly (only numbers allowed in category counts)
    if (CREDENTIAL_KEYS.has(lowerKey) && typeof val !== 'number') {
      console.error(`[PrivAgent Security Violation] Direct credential leaked under key "${key}"`);
      return false;
    }

    if (typeof val === 'object' && val !== null) {
      if (!verifySanitizedPayload(val)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Creates a sanitized, hardened export payload from a scan report.
 * Guaranteed to omit raw DOM text/values.
 */
export function createSanitizedExport(report: PrivacyScanReport): Readonly<PrivacyScanReport> {
  const isSafe = verifySanitizedPayload(report);
  if (!isSafe) {
    throw new Error('PrivAgent Security Boundary Error: Unsanitized context detected. Transmission blocked.');
  }

  const sanitizedDetections: DetectionResult[] = report.detections.map(d => ({
    id: d.id,
    type: d.type,
    confidence: d.confidence,
    selector: d.selector,
    bbox: [d.bbox[0], d.bbox[1], d.bbox[2], d.bbox[3]],
    length: d.length,
    source: d.source,
  }));

  const sanitizedReport: PrivacyScanReport = {
    timestamp: report.timestamp,
    url: report.url,
    scanLatencyMs: report.scanLatencyMs,
    redactionLatencyMs: report.redactionLatencyMs,
    totalElementsScanned: report.totalElementsScanned,
    sensitiveElementsDetected: report.sensitiveElementsDetected,
    elementsProtected: report.elementsProtected,
    leakageCount: 0,
    categories: { ...report.categories },
    detections: sanitizedDetections,
    status: 'Sanitized Context — Local Privacy Check Passed',
    redactionMode: report.redactionMode,
  };

  return Object.freeze(sanitizedReport);
}

/**
 * Safe Audit Logger.
 * Strictly logs metadata ONLY. Never logs sensitive text.
 */
export function logSafeAudit(detection: DetectionResult, isRedacted: boolean): void {
  console.info(
    `[PrivAgent Audit] Type: ${detection.type} | Confidence: ${detection.confidence.toFixed(2)} | ` +
    `Selector: ${detection.selector} | BBox: [${detection.bbox.join(', ')}] | Redacted: ${isRedacted ? 'yes' : 'no'}`
  );
}
