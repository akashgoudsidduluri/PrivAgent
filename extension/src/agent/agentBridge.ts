/**
 * PrivAgent — Agent Bridge (Milestone 4)
 *
 * Handles the secure, local-only communication from the Chrome extension
 * to the local FastAPI Agent Safety API (127.0.0.1:8010).
 *
 * Security responsibilities:
 *  1. Enforce that ONLY buildAgentPayload() is used to construct payloads.
 *  2. Run an extension-side pre-flight security check before sending.
 *  3. Verify the sanitized_status sentinel is present and correct.
 *  4. Never send raw screenshots, raw DOM text, or raw OCR text.
 *  5. Never send to any URL other than the fixed local backend.
 *  6. Handle backend-unavailable gracefully (no crash, no data loss).
 */

import {
  AgentContextPayload,
  PrivacyScanReport,
  VisualCaptureReport,
  buildAgentPayload,
} from '../privacy/types';

// Fixed local backend URL — NEVER configurable by user input
const AGENT_API_BASE = 'http://127.0.0.1:8010';
const CONTEXT_ENDPOINT = `${AGENT_API_BASE}/api/v1/context`;
const HEALTH_ENDPOINT = `${AGENT_API_BASE}/api/v1/health`;

// Timeout for backend communication (ms)
const REQUEST_TIMEOUT_MS = 5000;
const HEALTH_TIMEOUT_MS = 2000;

// Forbidden keys that must never appear in the payload
const FORBIDDEN_KEYS = new Set([
  'value', 'text', 'textContent', 'innerText',
  'rawText', 'rawOCR', 'ocrText', 'password',
  'words', 'lines', 'token', 'secret', 'card',
  'cardNumber', 'card_number', 'cvv', 'pan',
  'accountNumber', 'account_number', 'raw', 'input',
  'sensitiveValue', 'sensitive_value', 'pii',
]);

const FORBIDDEN_KEYS_NORMALIZED = new Set(
  Array.from(FORBIDDEN_KEYS).map((k) => k.toLowerCase().replace(/_/g, ''))
);

const REQUIRED_STATUS = 'sanitized_only' as const;

// ── Result types ──────────────────────────────────────────────────────────────

export type AgentBridgeResult =
  | { success: true; message: string; detectionCount: number; receivedAt: number }
  | { success: false; error: string };

export type HealthCheckResult =
  | { online: true; version: string; service: string }
  | { online: false; reason: string };

// ── Extension-side security pre-flight ───────────────────────────────────────

/**
 * Recursively scan an object for forbidden keys.
 * Throws if any forbidden key is found at any depth.
 */
function assertNoForbiddenKeys(obj: unknown, path = '<root>'): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'object') {
    if (Array.isArray(obj)) {
      obj.forEach((item, i) => assertNoForbiddenKeys(item, `${path}[${i}]`));
    } else {
      for (const key of Object.keys(obj as Record<string, unknown>)) {
        const normKey = key.toLowerCase().replace(/_/g, '');
        if (FORBIDDEN_KEYS.has(key) || FORBIDDEN_KEYS_NORMALIZED.has(normKey)) {
          throw new Error(
            `[PrivAgent AgentBridge] Security violation: forbidden key '${key}' at path '${path}.${key}'. ` +
            'Payload blocked — raw PII must never be sent to the agent API.'
          );
        }
        assertNoForbiddenKeys((obj as Record<string, unknown>)[key], `${path}.${key}`);
      }
    }
  }
}

/**
 * Extension-side pre-flight security validation.
 * Runs BEFORE the payload is sent to the backend.
 *
 * The backend also runs its own independent validation.
 * This is defense in depth — two separate security boundaries.
 */
function validatePayloadBeforeSend(payload: AgentContextPayload): void {
  // 1. Status sentinel check
  if (payload.sanitized_status !== REQUIRED_STATUS) {
    throw new Error(
      `[PrivAgent AgentBridge] Invalid sanitized_status: '${payload.sanitized_status}'. ` +
      `Expected: '${REQUIRED_STATUS}'`
    );
  }

  // 2. Recursive forbidden-key scan
  assertNoForbiddenKeys(payload);

  // 3. Structural sanity
  if (typeof payload.url !== 'string' || !payload.url) {
    throw new Error('[PrivAgent AgentBridge] Payload missing url.');
  }
  if (typeof payload.timestamp !== 'number' || payload.timestamp <= 0) {
    throw new Error('[PrivAgent AgentBridge] Payload has invalid timestamp.');
  }
  if (!Array.isArray(payload.detections)) {
    throw new Error('[PrivAgent AgentBridge] Payload detections must be an array.');
  }
  for (const det of payload.detections) {
    if (typeof det.confidence !== 'number' || det.confidence < 0 || det.confidence > 1) {
      throw new Error(
        `[PrivAgent AgentBridge] Detection ${det.id} has invalid confidence: ${det.confidence}`
      );
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check whether the local Agent Safety API is reachable.
 * Uses a short timeout to not block the popup UI.
 */
export async function checkBackendHealth(): Promise<HealthCheckResult> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

    const resp = await fetch(HEALTH_ENDPOINT, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      return { online: false, reason: `Backend returned HTTP ${resp.status}` };
    }

    const data = await resp.json() as { status?: string; version?: string; service?: string };
    return {
      online: true,
      version: data.version ?? '?',
      service: data.service ?? 'PrivAgent Agent API',
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort') || msg.includes('NetworkError') || msg.includes('Failed to fetch')) {
      return { online: false, reason: 'Backend offline or unreachable' };
    }
    return { online: false, reason: msg };
  }
}

/**
 * Build the sanitized agent payload from existing scan results and send it
 * to the local Agent Safety API.
 *
 * Security guarantee:
 *   - Payload is built via buildAgentPayload() (explicit allowlist).
 *   - Extension-side security pre-flight runs before any network call.
 *   - If the pre-flight fails, nothing is sent.
 *   - No screenshots are included.
 *   - No raw text is included.
 *
 * @param domScanReport - The latest PrivacyScanReport from the content script
 * @param visualReport  - The latest VisualCaptureReport (optional, may be null)
 * @param prebuiltPayload - An already-minimized payload (M8 context minimization).
 *   When supplied it is used verbatim instead of rebuilding from the reports, so
 *   the network boundary always carries the minimized context. It is still
 *   subjected to the same pre-flight security checks.
 */
export async function sendSanitizedContext(
  domScanReport: PrivacyScanReport,
  visualReport: VisualCaptureReport | null,
  prebuiltPayload?: AgentContextPayload | null,
): Promise<AgentBridgeResult> {
  // Step 1: Build payload via explicit allowlist (or use the minimized one)
  const payload = prebuiltPayload ?? buildAgentPayload(domScanReport, visualReport);
  if (!payload) {
    return {
      success: false,
      error:
        'Cannot build agent payload: DOM scan report does not carry the required sanitized status. ' +
        'Run a successful scan first.',
    };
  }

  // Step 2: Extension-side security pre-flight
  try {
    validatePayloadBeforeSend(payload);
  } catch (validationErr: unknown) {
    const msg = validationErr instanceof Error ? validationErr.message : String(validationErr);
    console.error('[PrivAgent AgentBridge] Pre-flight security check failed:', msg);
    return { success: false, error: `Security pre-flight failed: ${msg}` };
  }

  // Step 3: Send to local backend
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const resp = await fetch(CONTEXT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      let errorDetail = `HTTP ${resp.status}`;
      try {
        const errBody = await resp.json() as { detail?: string };
        if (errBody.detail) errorDetail += `: ${errBody.detail}`;
      } catch {
        // ignore JSON parse errors on error responses
      }
      return { success: false, error: `Backend rejected payload: ${errorDetail}` };
    }

    const result = await resp.json() as {
      success: boolean;
      message: string;
      detection_count: number;
      received_at: number;
    };

    return {
      success: true,
      message: result.message ?? 'Sanitized context accepted.',
      detectionCount: result.detection_count ?? payload.detections.length,
      receivedAt: result.received_at ?? Date.now(),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort')) {
      return { success: false, error: 'Request timed out. Is the backend running? (python backend/run.py)' };
    }
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
      return { success: false, error: 'Backend unavailable. Start it with: python backend/run.py' };
    }
    return { success: false, error: `Unexpected error: ${msg}` };
  }
}
