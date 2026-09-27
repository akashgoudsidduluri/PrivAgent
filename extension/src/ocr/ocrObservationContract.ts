/**
 * PrivAgent — Phase 17.3: OCR Observation Contract & Provenance Engine
 *
 * ── The Observation Invariant ─────────────────────────────────────────────
 *
 *   "unobservable"  is NOT  "zero"
 *   "stale"         is NOT  "fresh"
 *   an OCR GUESS    is NOT  an observation
 *   pageGeneration  is NOT  document identity
 *
 * Every OCR reading must carry explicit provenance. OCR is a PERCEPTION SOURCE,
 * not an authorization source. It must respect the Phase 17.1 Observation
 * Contract four-state model:
 *
 *   OBSERVED       — real OCR reading executed on a verified screenshot from the target tab
 *   UNAVAILABLE    — screenshot capture failed, OCR engine failed/timed out, or bounds invalid
 *   STALE          — screenshot/OCR belongs to another tab or prior document
 *   NOT_APPLICABLE — OCR was not requested or target document has no visual content
 *
 * Fail Closed: Any OCR finding whose geometry cannot be mapped reliably, whose
 * provenance is ambiguous, or which fails privacy screening is marked UNAVAILABLE.
 */

import { ObservationState } from '../agent/effectVerifier';

export type { ObservationState };

export interface ScreenshotProvenance {
  /** Target tab ID the screenshot was requested for. */
  tabId: number;
  /** Authoritative document URL at capture time (from chrome.tabs.get). */
  documentUrl: string;
  /** Monotonic page generation counter at capture time. */
  pageGeneration: number;
  /** High-resolution timestamp when captureVisibleTab executed. */
  capturedAt: number;
  /** Bitmap dimensions of the acquired screenshot. */
  screenshotDimensions: { width: number; height: number };
  /** Observed live viewport geometry from the content script. */
  viewportGeometry: {
    viewportWidth: number;
    viewportHeight: number;
    scrollX: number;
    scrollY: number;
    devicePixelRatio: number;
  };
  /** Device scale factors: screenshot / viewport. */
  scaleFactors: { scaleX: number; scaleY: number };
}

/**
 * Normalized OCR observation contract carried by the WorldModel and Context.
 */
export interface OCRObservation {
  /** The observation state. Never guessed, never defaulted to OBSERVED. */
  state: ObservationState;
  /** Complete screenshot provenance when state === 'OBSERVED'. */
  provenance: ScreenshotProvenance | null;
  /** Timestamp when OCR recognition completed. */
  completedAt: number | null;
  /** Total OCR lines/words scanned. */
  totalTokensScanned: number;
  /** Count of sensitive regions discovered in OCR text (PII/credentials). */
  sensitiveRegionsCount: number;
  /** Count of verified safe non-DOM text regions discovered. */
  safeRegionsCount: number;
  /** Execution latency of local OCR in milliseconds. */
  ocrLatencyMs: number;
  /** Diagnostic reason when state !== 'OBSERVED'. */
  failureReason?: string;
}

/** Maximum allowed age for an OCR observation before it is treated as STALE (15s). */
export const MAX_OCR_OBSERVATION_AGE_MS = 15_000;

/**
 * Normalizes document URLs for cross-document identity verification.
 * Strips transient hash fragments while preserving host, path, and search query.
 */
export function normalizeDocumentIdentity(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    // Ignore hash changes (#section), but treat path and query differences as distinct documents
    return `${u.protocol}//${u.host}${u.pathname}${u.search}`;
  } catch {
    return url.split('#')[0] || null;
  }
}

/**
 * Verifies whether two document identities describe the same document.
 */
export function isSameDocumentIdentity(urlA: string | null | undefined, urlB: string | null | undefined): boolean {
  const normA = normalizeDocumentIdentity(urlA);
  const normB = normalizeDocumentIdentity(urlB);
  if (!normA || !normB) return false;
  return normA === normB;
}

/**
 * Validates screenshot geometry and returns scale factors if valid, or null if degenerate.
 */
export function validateScreenshotGeometry(
  screenshotDims: { width?: number; height?: number; screenshotWidth?: number; screenshotHeight?: number } | null | undefined,
  viewportGeo: { viewportWidth: number; viewportHeight: number } | null | undefined
): { scaleX: number; scaleY: number } | null {
  if (!screenshotDims || !viewportGeo) return null;
  const sw = screenshotDims.width ?? screenshotDims.screenshotWidth ?? 0;
  const sh = screenshotDims.height ?? screenshotDims.screenshotHeight ?? 0;
  const vw = viewportGeo.viewportWidth;
  const vh = viewportGeo.viewportHeight;

  if (!Number.isFinite(sw) || !Number.isFinite(sh) || sw <= 0 || sh <= 0) {
    return null;
  }
  if (!Number.isFinite(vw) || !Number.isFinite(vh) || vw <= 0 || vh <= 0) {
    return null;
  }

  const scaleX = sw / vw;
  const scaleY = sh / vh;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
    return null;
  }

  return { scaleX, scaleY };
}

/**
 * Verifies whether an OCR observation is currently fresh and valid for a given target.
 * Fail Closed: If tab, URL, pageGeneration, or timestamp fails, returns false.
 */
export function isOCRObservationFresh(
  observation: OCRObservation | null | undefined,
  currentTargetTabId: number,
  currentDocumentUrl: string,
  currentPageGeneration: number,
  now: number = Date.now()
): boolean {
  if (!observation || observation.state !== 'OBSERVED') {
    return false;
  }
  const prov = observation.provenance;
  if (!prov) return false;

  // 1. Target tab identity check
  if (prov.tabId !== currentTargetTabId) {
    return false;
  }

  // 2. Document identity check (pageGeneration is NOT document identity)
  if (!isSameDocumentIdentity(prov.documentUrl, currentDocumentUrl)) {
    return false;
  }

  // 3. Monotonic negative drift check
  // Note: pageGeneration is NOT document identity; authoritative document identity is
  // established via isSameDocumentIdentity above. Same-document repeated observations
  // remain valid even if the observation generation changes.
  if (prov.pageGeneration > currentPageGeneration) {
    return false;
  }

  // 4. Observation TTL check
  if (now - prov.capturedAt > MAX_OCR_OBSERVATION_AGE_MS) {
    return false;
  }

  return true;
}

/**
 * Factory for creating an UNAVAILABLE OCR observation.
 */
export function createUnavailableOCRObservation(
  reason: string,
  tabId: number | null = null,
  documentUrl: string | null = null
): OCRObservation {
  return {
    state: 'UNAVAILABLE',
    provenance: null,
    completedAt: null,
    totalTokensScanned: 0,
    sensitiveRegionsCount: 0,
    safeRegionsCount: 0,
    ocrLatencyMs: 0,
    failureReason: reason,
  };
}

/**
 * Factory for creating a STALE OCR observation.
 */
export function createStaleOCRObservation(
  priorObservation: OCRObservation,
  staleReason: string
): OCRObservation {
  return {
    ...priorObservation,
    state: 'STALE',
    failureReason: staleReason,
  };
}
