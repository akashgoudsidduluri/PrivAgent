export type SensitiveEntityType = 
  | 'password' 
  | 'email' 
  | 'phone' 
  | 'credit_card' 
  | 'account_number' 
  | 'person_name'
  | 'pan'
  | 'otp'
  | 'cvv'
  | 'address';

export const SENSITIVE_ENTITY_TYPES: ReadonlySet<string> = new Set<SensitiveEntityType>([
  'password',
  'email',
  'phone',
  'credit_card',
  'account_number',
  'person_name',
  'pan',
  'otp',
  'cvv',
  'address',
]);

export function isSensitiveEntityType(type: string): type is SensitiveEntityType {
  return SENSITIVE_ENTITY_TYPES.has(type as SensitiveEntityType);
}

export type InteractiveEntityType =
  | 'button'
  | 'link'
  | 'input'
  | 'search'
  | 'select'
  | 'form'
  | 'heading'
  | 'element';

export type DetectionEntityType = SensitiveEntityType | InteractiveEntityType;

export type DetectionSource = 
  | 'dom_input_type' 
  | 'dom_autocomplete' 
  | 'dom_attribute' 
  | 'dom_label' 
  | 'text_pattern'
  | 'ocr';

export type RedactionMode = 'blackout' | 'blur' | 'mask';

/**
 * Strict Security Boundary Invariant:
 * DetectionResult MUST NEVER contain raw PII values (value, textContent, innerText).
 * Only coordinate geometry, selector, classification, statistical length, and sanitized labels are permitted.
 */
export interface DetectionResult {
  id: string;
  type: DetectionEntityType;
  confidence: number;
  selector: string;
  bbox: [number, number, number, number]; // [x, y, width, height]
  length: number;
  source: DetectionSource;
  label?: string;
}

export interface PrivacyScanReport {
  timestamp: number;
  url: string;
  scanLatencyMs: number;
  redactionLatencyMs: number;
  totalElementsScanned: number;
  sensitiveElementsDetected: number;
  elementsProtected: number;
  leakageCount: 0;
  categories: Record<SensitiveEntityType, number>;
  detections: DetectionResult[];
  status: 'Sanitized Context — Local Privacy Check Passed' | 'Scanning' | 'Error' | 'Excluded Site';
  redactionMode: RedactionMode;
}

export interface CaptureMetadata {
  viewportWidth: number;
  viewportHeight: number;
  screenshotWidth: number;
  screenshotHeight: number;
  devicePixelRatio: number;
  scaleX: number;
  scaleY: number;
  scrollX: number;
  scrollY: number;
  capturedAt: number;
}

export interface VisualDetectionResult {
  id: string;
  type: SensitiveEntityType;
  confidence: number;
  selector: string;
  viewportBBox: [number, number, number, number]; // [clientX, clientY, w, h]
  screenshotBBox: [number, number, number, number]; // [sx, sy, sw, sh]
  isPartiallyVisible: boolean;
  source: DetectionSource;
}

export interface VisualCaptureReport {
  captureMetadata: CaptureMetadata;
  visualDetections: VisualDetectionResult[];
  totalDetected: number;
  totalPartiallyVisible: number;
  totalOffscreenFiltered: number;
  ocrRegionsScanned: number;
  sensitiveOCRDetected: number;
  ocrLatencyMs: number;
  domSensitiveDetected: number;
  status: 'Local Visual Context Prepared';
}

export type ExtensionMessage =
  | { type: 'PRIVAGENT_SCAN_REQUEST'; mode?: RedactionMode }
  | { type: 'PRIVAGENT_SCAN_RESPONSE'; report: PrivacyScanReport }
  | { type: 'PRIVAGENT_SET_REDACTION_MODE'; mode: RedactionMode }
  | { type: 'PRIVAGENT_TOGGLE_REDACTION'; enabled: boolean }
  | { type: 'PRIVAGENT_GET_STATE' }
  | { type: 'PRIVAGENT_STATE_RESPONSE'; report: PrivacyScanReport | null; isRedactionActive: boolean }
  | { type: 'PRIVAGENT_CAPTURE_SCREENSHOT' }
  | { type: 'PRIVAGENT_CAPTURE_SCREENSHOT_RESPONSE'; dataUrl?: string; error?: string }
  | { type: 'PRIVAGENT_GET_VIEWPORT_GEOMETRY' }
  | { 
      type: 'PRIVAGENT_GET_VIEWPORT_GEOMETRY_RESPONSE'; 
      viewportWidth: number; 
      viewportHeight: number; 
      scrollX: number; 
      scrollY: number; 
      devicePixelRatio: number; 
    }
  | { type: 'PRIVAGENT_EXECUTE_ACTION'; action: import('../agent/actionTypes').BrowserAction }
  | { type: 'PRIVAGENT_EXECUTE_ACTION_RESPONSE'; result: import('../agent/actionTypes').ActionExecutionResult };



// ── Milestone 4: Agent Context Payload ────────────────────────────────────────

/** Safe bounding box — matches backend Pydantic BoundingBox. Screenshot pixels. */
export interface AgentBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Allowlisted safe detection — ONLY metadata, no raw values. */
export interface AgentDetection {
  id: string;
  type: DetectionEntityType;
  confidence: number;
  bbox: AgentBoundingBox;
  length: number;         // character count only, not the actual value
  source: DetectionSource;
  selector: string;
  is_partially_visible: boolean;
  label?: string;
}

export interface AgentViewport {
  width: number;
  height: number;
  scroll_x: number;
  scroll_y: number;
}

export interface AgentScreenshotDimensions {
  width: number;
  height: number;
}

/** OCR metrics — no raw text, only counts and timing. */
export interface AgentOCRMetrics {
  regions_scanned: number;
  sensitive_detected: number;
  latency_ms: number;
}

/**
 * The formal typed agent context payload — the contract between the local
 * privacy engine and the backend Agent Safety API.
 *
 * Security invariant: NEVER contains raw PII strings.
 * Constructed exclusively via buildAgentPayload() using an explicit allowlist.
 */
export interface AgentContextPayload {
  url: string;
  timestamp: number;
  viewport: AgentViewport;
  screenshot_dimensions: AgentScreenshotDimensions | null;
  detections: AgentDetection[];
  total_elements_scanned: number;
  sensitive_elements_detected: number;
  sanitized_status: 'sanitized_only';
  ocr_metrics: AgentOCRMetrics | null;
  page_type?: string;
}

/**
 * Build a sanitized AgentContextPayload using an EXPLICIT ALLOWLIST.
 *
 * ⚠️  NEVER call { ...report } or JSON.stringify(report) directly.
 *      This function is the ONLY authorized way to produce an agent payload.
 *      Every field is explicitly copied to prevent raw PII from leaking.
 *
 * Returns null if the DOM scan report does not carry the required status sentinel.
 */
export function buildAgentPayload(
  domScanReport: PrivacyScanReport,
  visualReport: VisualCaptureReport | null,
): AgentContextPayload | null {
  if (domScanReport.status !== 'Sanitized Context — Local Privacy Check Passed') {
    return null;
  }

  const detections: AgentDetection[] = [];

  if (visualReport) {
    for (const det of visualReport.visualDetections) {
      const [sx, sy, sw, sh] = det.screenshotBBox;
      detections.push({
        id: det.id,
        type: det.type,
        confidence: det.confidence,
        bbox: { x: sx, y: sy, width: sw, height: sh },
        length: 0,  // not available at visual pipeline level
        source: det.source,
        selector: det.selector,
        is_partially_visible: det.isPartiallyVisible,
      });
    }
  } else {
    for (const det of domScanReport.detections) {
      const [bx, by, bw, bh] = det.bbox;
      detections.push({
        id: det.id,
        type: det.type,
        confidence: det.confidence,
        bbox: { x: bx, y: by, width: bw, height: bh },
        length: det.length,
        source: det.source,
        selector: det.selector,
        is_partially_visible: false,
        label: det.label,
      });
    }
  }

  const viewport: AgentViewport = visualReport
    ? {
        width: visualReport.captureMetadata.viewportWidth,
        height: visualReport.captureMetadata.viewportHeight,
        scroll_x: visualReport.captureMetadata.scrollX,
        scroll_y: visualReport.captureMetadata.scrollY,
      }
    : { width: 0, height: 0, scroll_x: 0, scroll_y: 0 };

  const screenshot_dimensions: AgentScreenshotDimensions | null = visualReport
    ? {
        width: visualReport.captureMetadata.screenshotWidth,
        height: visualReport.captureMetadata.screenshotHeight,
      }
    : null;

  const ocr_metrics: AgentOCRMetrics | null = visualReport
    ? {
        regions_scanned: visualReport.ocrRegionsScanned,
        sensitive_detected: visualReport.sensitiveOCRDetected,
        latency_ms: visualReport.ocrLatencyMs,
      }
    : null;

  // Explicit allowlist — only approved fields, named one by one
  return {
    url: domScanReport.url,
    timestamp: domScanReport.timestamp,
    viewport,
    screenshot_dimensions,
    detections,
    total_elements_scanned: domScanReport.totalElementsScanned,
    sensitive_elements_detected: domScanReport.sensitiveElementsDetected,
    sanitized_status: 'sanitized_only',
    ocr_metrics,
  };
}
