/**
 * PrivAgent — Offscreen Local OCR Worker (Phase 17.3)
 *
 * Runs inside Chrome's Offscreen Document context (chrome.offscreen).
 * Has full access to DOM, HTMLImageElement, HTMLCanvasElement, Web Workers,
 * and WebAssembly inside the extension origin (`chrome-extension://...`).
 *
 * Privacy Invariants:
 *  - 100% on-device processing.
 *  - Zero network transmission.
 *  - Raw screenshot data is processed locally in memory and never persisted.
 */

import { LocalOCREngine } from '../ocr/ocrEngine';
import { InternalOCRResult } from '../ocr/types';

let ocrEngine: LocalOCREngine | null = null;

function getOrCreateEngine(): LocalOCREngine {
  if (!ocrEngine) {
    ocrEngine = new LocalOCREngine();
  }
  return ocrEngine;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === 'PRIVAGENT_OFFSCREEN_OCR_PING') {
    sendResponse({
      type: 'PRIVAGENT_OFFSCREEN_OCR_PONG',
      initialized: ocrEngine?.isInitialized() ?? false,
    });
    return false;
  }

  if (message.type === 'PRIVAGENT_OFFSCREEN_OCR_REQUEST') {
    const { requestId, dataUrl } = message;
    if (!requestId || !dataUrl || typeof dataUrl !== 'string') {
      sendResponse({
        type: 'PRIVAGENT_OFFSCREEN_OCR_RESPONSE',
        requestId,
        success: false,
        error: 'Invalid OCR request: missing requestId or dataUrl',
      });
      return false;
    }

    (async () => {
      try {
        const engine = getOrCreateEngine();
        const result: InternalOCRResult = await engine.recognize(dataUrl);
        sendResponse({
          type: 'PRIVAGENT_OFFSCREEN_OCR_RESPONSE',
          requestId,
          success: true,
          result,
        });
      } catch (err) {
        console.error('[PrivAgent Offscreen OCR] Recognition failed:', err);
        sendResponse({
          type: 'PRIVAGENT_OFFSCREEN_OCR_RESPONSE',
          requestId,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return true; // Keep message port open for async response
  }

  if (message.type === 'PRIVAGENT_OFFSCREEN_OCR_TERMINATE') {
    (async () => {
      if (ocrEngine) {
        try {
          await ocrEngine.terminate();
        } catch {
          // ignore
        }
        ocrEngine = null;
      }
      sendResponse({ type: 'PRIVAGENT_OFFSCREEN_OCR_TERMINATE_RESPONSE', success: true });
    })();
    return true;
  }

  return false;
});
