/**
 * PrivAgent 2.0 — Spatial OCR Layer (Subphase P2.2)
 *
 * Extends the existing OCR subsystem to produce generation-stamped, spatially-bounded
 * OCR regions with strict M8 privacy firewall integration.
 *
 * CRITICAL PRIVACY INVARIANTS:
 *  1. Zero Sensitive Text Leakage: Raw text for passwords, CVVs, card numbers, OTPs,
 *     account numbers, PANs, tokens, and secrets NEVER crosses into remote context.
 *  2. No Category Whitelisting: No OCR category is whitelisted as "safe" without passing
 *     through M8 privacy scanning and classification.
 *  3. Generation Stamped: Every OCRRegion contains pageGeneration and source: 'ocr'.
 *  4. Single Privacy Authority: Reuses M8 privacyDecision and rawValueScanner rather than
 *     implementing a competing privacy engine.
 */

import { SensitiveEntityType } from '../privacy/types';
import { scanForRawSensitiveValues } from '../privacy/rawValueScanner';
import { PATTERNS, KEYWORDS, isValidLuhn, matchesKeyword } from '../privacy/patterns';
import {
  fusePrivacyFindings,
  PrivacyFinding,
  candidateFromOCRDetection,
  candidateFromDOMPageDetection,
} from '../privacy/fusion';
import { DetectionResult } from '../privacy/types';
import { InternalOCRResult, SafeOCRDetection } from './types';
import { detectSensitiveOCRRegions } from './ocrDetector';
import { SafeOCRRegion } from '../worldModel/types';

export type VisualTextClassification = 'safe' | 'sensitive' | 'unknown';

export interface OCRRegion {
  id: string;
  bbox: [number, number, number, number]; // [x, y, w, h] in viewport / screenshot pixels
  confidence: number;
  textClassification: VisualTextClassification;
  sensitivity: VisualTextClassification;
  pageGeneration: number;
  source: 'ocr';
  sensitiveType?: SensitiveEntityType;
  safeText?: string; // ONLY populated if textClassification === 'safe'
  isPartiallyVisible?: boolean;
}

export interface ProcessSpatialOCROptions {
  pageGeneration: number;
  imageDimensions: { width: number; height: number };
}

/**
 * Classifies an OCR text segment through the existing M8 privacy firewall.
 */
export function classifyOCRTextPrivacy(text: string): {
  classification: VisualTextClassification;
  sensitiveType?: SensitiveEntityType;
  rationale: string;
} {
  if (!text || !text.trim()) {
    return { classification: 'unknown', rationale: 'Empty text fragment' };
  }

  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // 1. Check Indian PAN pattern (e.g. ABCDE1234F)
  if (PATTERNS.PAN.test(trimmed) || matchesKeyword(trimmed, KEYWORDS.PAN)) {
    return {
      classification: 'sensitive',
      sensitiveType: 'pan',
      rationale: 'Matched Indian PAN pattern or keyword',
    };
  }

  // 2. Check Credit Card (Luhn or regex)
  const digitRuns = trimmed.replace(/[-\s]/g, '').match(/\d{13,19}/g);
  if (
    (digitRuns && digitRuns.some(run => isValidLuhn(run))) ||
    matchesKeyword(trimmed, KEYWORDS.CREDIT_CARD) ||
    PATTERNS.CREDIT_CARD.test(trimmed)
  ) {
    return {
      classification: 'sensitive',
      sensitiveType: 'credit_card',
      rationale: 'Matched credit card pattern or keyword',
    };
  }

  // 3. Check CVV / Security code
  if (matchesKeyword(trimmed, KEYWORDS.CVV)) {
    return {
      classification: 'sensitive',
      sensitiveType: 'cvv',
      rationale: 'Matched CVV keyword',
    };
  }

  // 4. Check OTP / One-time code
  if (matchesKeyword(trimmed, KEYWORDS.OTP)) {
    return {
      classification: 'sensitive',
      sensitiveType: 'otp',
      rationale: 'Matched OTP keyword context',
    };
  }

  // 5. Check Password / Credentials
  if (matchesKeyword(trimmed, KEYWORDS.PASSWORD)) {
    return {
      classification: 'sensitive',
      sensitiveType: 'password',
      rationale: 'Matched password/credential keyword',
    };
  }

  // 6. Check Email & Phone
  if (PATTERNS.EMAIL.test(trimmed)) {
    return {
      classification: 'sensitive',
      sensitiveType: 'email',
      rationale: 'Matched email pattern',
    };
  }
  if (PATTERNS.PHONE.test(trimmed) || matchesKeyword(trimmed, KEYWORDS.PHONE)) {
    return {
      classification: 'sensitive',
      sensitiveType: 'phone',
      rationale: 'Matched phone pattern or keyword',
    };
  }

  // 7. Check raw value scanner for any remaining PII rule violation
  const rawFindings = scanForRawSensitiveValues(trimmed);
  if (rawFindings.length > 0 && rawFindings[0]) {
    const finding = rawFindings[0];
    let sType: SensitiveEntityType = 'password';
    if (finding.rule === 'credit_card') sType = 'credit_card';
    else if (finding.rule === 'email') sType = 'email';
    else if (finding.rule === 'phone') sType = 'phone';
    else if (finding.rule === 'pan') sType = 'pan';

    return {
      classification: 'sensitive',
      sensitiveType: sType,
      rationale: `Matched sensitive raw value pattern: ${finding.rule}`,
    };
  }

  // 8. Benign text passing all scanners
  return {
    classification: 'safe',
    rationale: 'Passed M8 raw scanner with zero sensitive matches',
  };
}

/**
 * Processes an InternalOCRResult into normalized, privacy-classified OCRRegion entries.
 */
export function processSpatialOCRResult(
  ocrResult: InternalOCRResult,
  options: ProcessSpatialOCROptions
): OCRRegion[] {
  const { pageGeneration, imageDimensions } = options;
  const regions: OCRRegion[] = [];

  // 1. First run the existing M3 sensitive detector for ground-truth sensitive detections
  const sensitiveDetections = detectSensitiveOCRRegions(ocrResult, imageDimensions);
  const sensitiveMap = new Map<string, SafeOCRDetection>();
  sensitiveDetections.forEach(det => {
    sensitiveMap.set(det.id, det);
  });

  // 2. Process all OCR lines
  ocrResult.lines.forEach((line, lineIdx) => {
    const rawText = line.text || '';
    const bbox: [number, number, number, number] = [
      Math.max(0, line.bbox.x0),
      Math.max(0, line.bbox.y0),
      Math.max(0, line.bbox.x1 - line.bbox.x0),
      Math.max(0, line.bbox.y1 - line.bbox.y0),
    ];

    if (bbox[2] < 4 || bbox[3] < 4) return; // Skip degenerate boxes

    const id = `ocr-g${pageGeneration}-l${lineIdx + 1}`;
    const privacyCheck = classifyOCRTextPrivacy(rawText);

    if (privacyCheck.classification === 'sensitive') {
      // STRICT INVARIANT: sensitive OCR never stores rawText in safeText
      regions.push({
        id,
        bbox,
        confidence: Math.round(line.confidence * 100) / 100,
        textClassification: 'sensitive',
        sensitivity: 'sensitive',
        pageGeneration,
        source: 'ocr',
        sensitiveType: privacyCheck.sensitiveType || 'password',
        safeText: undefined, // Wiped locally
      });
    } else if (privacyCheck.classification === 'safe') {
      // Safe visual text preview (bounded to 40 chars)
      regions.push({
        id,
        bbox,
        confidence: Math.round(line.confidence * 100) / 100,
        textClassification: 'safe',
        sensitivity: 'safe',
        pageGeneration,
        source: 'ocr',
        safeText: rawText.trim().slice(0, 40),
      });
    } else {
      regions.push({
        id,
        bbox,
        confidence: Math.round(line.confidence * 100) / 100,
        textClassification: 'unknown',
        sensitivity: 'unknown',
        pageGeneration,
        source: 'ocr',
        safeText: undefined,
      });
    }
  });

  return regions;
}

/**
 * Converts local OCRRegion entries to safe metadata suitable for remote reasoners.
 * Guarantees zero sensitive raw text crosses the boundary.
 */
export function convertToSafeOCRRegions(regions: OCRRegion[]): SafeOCRRegion[] {
  return regions.map(r => ({
    id: r.id,
    bbox: r.bbox,
    confidence: r.confidence,
    isSensitive: r.sensitivity === 'sensitive',
    sensitiveType: r.sensitiveType,
  }));
}

/**
 * Integrates OCR findings with existing M8 privacy fusion across DOM detections.
 */
export function fuseSpatialOCRWithDOM(
  ocrRegions: OCRRegion[],
  domDetections: DetectionResult[]
): PrivacyFinding[] {
  const ocrCandidates = ocrRegions
    .filter(r => r.sensitivity === 'sensitive' && r.sensitiveType)
    .map(r =>
      candidateFromOCRDetection({
        id: r.id,
        type: r.sensitiveType!,
        confidence: r.confidence,
        bbox: r.bbox,
        length: 10,
        source: 'ocr',
        isPartiallyVisible: Boolean(r.isPartiallyVisible),
      })
    );

  const domCandidates = domDetections.map(d => candidateFromDOMPageDetection(d));

  const result = fusePrivacyFindings([...domCandidates, ...ocrCandidates]);
  return result.findings;
}
