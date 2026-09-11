export type SensitiveEntityType = 
  | 'password' 
  | 'email' 
  | 'phone' 
  | 'credit_card' 
  | 'account_number' 
  | 'person_name';

export type DetectionSource = 
  | 'dom_input_type' 
  | 'dom_autocomplete' 
  | 'dom_attribute' 
  | 'dom_label' 
  | 'text_pattern';

export type RedactionMode = 'blackout' | 'blur' | 'mask';

/**
 * Strict Security Boundary Invariant:
 * DetectionResult MUST NEVER contain `value`, `textContent`, or `innerText`.
 * Only coordinate geometry, selector, classification, and statistical length are permitted.
 */
export interface DetectionResult {
  id: string;
  type: SensitiveEntityType;
  confidence: number;
  selector: string;
  bbox: [number, number, number, number]; // [x, y, width, height]
  length: number;
  source: DetectionSource;
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

export type ExtensionMessage =
  | { type: 'PRIVAGENT_SCAN_REQUEST'; mode?: RedactionMode }
  | { type: 'PRIVAGENT_SCAN_RESPONSE'; report: PrivacyScanReport }
  | { type: 'PRIVAGENT_SET_REDACTION_MODE'; mode: RedactionMode }
  | { type: 'PRIVAGENT_TOGGLE_REDACTION'; enabled: boolean }
  | { type: 'PRIVAGENT_GET_STATE' }
  | { type: 'PRIVAGENT_STATE_RESPONSE'; report: PrivacyScanReport | null; isRedactionActive: boolean };
