/**
 * PrivAgent — Service Worker Offscreen OCR Client (Phase 17.3)
 *
 * Implements `OCREngine` by delegating recognition requests to the dedicated
 * Chrome Offscreen Document (`offscreen.html`).
 *
 * Security & Lifecycle Invariants:
 *  - Worker lifecycle is isolated in the offscreen document.
 *  - Requests have bounded timeout (15s); if timed out or failed, fails closed cleanly.
 *  - Offscreen document is created on-demand and reusable across perception steps.
 *  - Zero external network requests: all WASM and dictionary data loaded locally.
 */

import { InternalOCRResult, OCREngine } from './types';

export interface OffscreenOCREngineOptions {
  timeoutMs?: number;
  fallbackEngine?: OCREngine;
}

export class OffscreenOCREngine implements OCREngine {
  private initialized = false;
  private initializingPromise: Promise<void> | null = null;
  private timeoutMs: number;
  private fallbackEngine?: OCREngine;

  constructor(options?: OffscreenOCREngineOptions) {
    this.timeoutMs = options?.timeoutMs ?? 15_000;
    this.fallbackEngine = options?.fallbackEngine;
  }

  public isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Ensures the offscreen document exists and is ready to process OCR.
   */
  public async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initializingPromise) return this.initializingPromise;

    this.initializingPromise = (async () => {
      // 1. Check if running in a real Chrome extension environment with chrome.offscreen
      if (typeof chrome === 'undefined' || !chrome.offscreen) {
        if (this.fallbackEngine) {
          await this.fallbackEngine.init();
          this.initialized = true;
          return;
        }
        throw new Error('chrome.offscreen API is not available in current environment');
      }

      try {
        const offscreenUrl = typeof chrome.runtime?.getURL === 'function'
          ? chrome.runtime.getURL('offscreen.html')
          : 'offscreen.html';

        // Check if offscreen document already exists
        let hasDoc = false;
        if (typeof chrome.offscreen.hasDocument === 'function') {
          hasDoc = await chrome.offscreen.hasDocument();
        } else if (chrome.runtime?.getContexts) {
          try {
            const contexts = await chrome.runtime.getContexts({
              contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
            });
            hasDoc = contexts.length > 0;
          } catch {
            hasDoc = false;
          }
        }

        if (!hasDoc) {
          await chrome.offscreen.createDocument({
            url: offscreenUrl,
            reasons: [
              chrome.offscreen.Reason.WORKERS || 'WORKERS',
              chrome.offscreen.Reason.DOM_SCRAPING || 'DOM_SCRAPING',
            ] as any,
            justification: 'On-device local WebAssembly OCR perception for non-DOM visual content',
          });
        }

        // Verify offscreen document responds
        await this.pingOffscreen();
        this.initialized = true;
      } catch (err: any) {
        const msg = String(err?.message || err);
        if (msg.includes('Only a single offscreen document may be created')) {
          // Document already created concurrently
          this.initialized = true;
        } else {
          console.error('[PrivAgent OffscreenOCREngine] Initialization failed:', err);
          if (this.fallbackEngine) {
            console.warn('[PrivAgent OffscreenOCREngine] Falling back to configured fallback engine');
            await this.fallbackEngine.init();
            this.initialized = true;
            return;
          }
          throw err;
        }
      } finally {
        this.initializingPromise = null;
      }
    })();

    return this.initializingPromise;
  }

  private async pingOffscreen(): Promise<boolean> {
    try {
      const res: any = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Offscreen ping timed out')), 2000);
        chrome.runtime.sendMessage({ type: 'PRIVAGENT_OFFSCREEN_OCR_PING' }, (response) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });
      return res?.type === 'PRIVAGENT_OFFSCREEN_OCR_PONG';
    } catch {
      return false;
    }
  }

  /**
   * Dispatches screenshot to offscreen document and awaits recognition result.
   */
  public async recognize(source: string | any): Promise<InternalOCRResult> {
    if (!this.initialized) {
      await this.init();
    }

    if (this.fallbackEngine && (typeof chrome === 'undefined' || !chrome.offscreen)) {
      return this.fallbackEngine.recognize(source);
    }

    const dataUrl: string = typeof source === 'string' ? source : (source?.src || source?.toDataURL?.() || '');
    if (!dataUrl || !dataUrl.startsWith('data:image/')) {
      throw new Error('Invalid image source: expected valid data:image/* URL for OCR recognition');
    }

    const requestId = `ocr-req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return new Promise<InternalOCRResult>((resolve, reject) => {
      let settled = false;

      const timeoutTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`Offscreen OCR recognition timed out after ${this.timeoutMs}ms`));
        }
      }, this.timeoutMs);

      try {
        chrome.runtime.sendMessage(
          {
            type: 'PRIVAGENT_OFFSCREEN_OCR_REQUEST',
            requestId,
            dataUrl,
          },
          (response) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutTimer);

            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message || 'chrome.runtime.sendMessage failed'));
              return;
            }

            if (!response || response.type !== 'PRIVAGENT_OFFSCREEN_OCR_RESPONSE') {
              reject(new Error('Invalid response received from offscreen OCR worker'));
              return;
            }

            if (!response.success || !response.result) {
              reject(new Error(response.error || 'Offscreen OCR recognition returned failure'));
              return;
            }

            resolve(response.result);
          }
        );
      } catch (sendErr) {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutTimer);
          reject(sendErr);
        }
      }
    });
  }

  /**
   * Shuts down the offscreen worker and closes document.
   */
  public async terminate(): Promise<void> {
    if (this.fallbackEngine) {
      await this.fallbackEngine.terminate();
    }
    if (typeof chrome !== 'undefined' && chrome.offscreen && typeof chrome.offscreen.closeDocument === 'function') {
      try {
        await chrome.runtime.sendMessage({ type: 'PRIVAGENT_OFFSCREEN_OCR_TERMINATE' });
      } catch {
        // ignore
      }
      try {
        await chrome.offscreen.closeDocument();
      } catch {
        // ignore if already closed
      }
    }
    this.initialized = false;
  }
}
