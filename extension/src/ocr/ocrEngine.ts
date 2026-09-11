import { createWorker, Worker } from 'tesseract.js';
import { InternalOCRLine, InternalOCRResult, InternalOCRWord, OCREngine, OCRWordBox } from './types';

export interface LocalOCREngineOptions {
  workerPath?: string;
  corePath?: string;
  langPath?: string;
}

/**
 * On-Device Local OCR Engine powered by local Tesseract.js WebAssembly.
 * Guarantees that OCR processing occurs entirely inside the extension/browser.
 * Zero data or screenshots are uploaded to any external server.
 */
export class LocalOCREngine implements OCREngine {
  private worker: Worker | null = null;
  private initializing: Promise<void> | null = null;
  private options: LocalOCREngineOptions;

  constructor(options?: LocalOCREngineOptions) {
    const isExtension = typeof chrome !== 'undefined' && !!chrome.runtime?.getURL;
    this.options = {
      workerPath: options?.workerPath ?? (isExtension ? chrome.runtime.getURL('assets/ocr/worker.min.js') : 'assets/ocr/worker.min.js'),
      corePath: options?.corePath ?? (isExtension ? chrome.runtime.getURL('assets/ocr/tesseract-core-simd.wasm.js') : 'assets/ocr/tesseract-core-simd.wasm.js'),
      langPath: options?.langPath ?? (isExtension ? chrome.runtime.getURL('assets/ocr/') : 'assets/ocr/'),
    };
  }

  public isInitialized(): boolean {
    return this.worker !== null;
  }

  public async init(): Promise<void> {
    if (this.worker) return;
    if (this.initializing) return this.initializing;

    this.initializing = (async () => {
      try {
        console.info('[PrivAgent OCR] Initializing local Tesseract WebAssembly worker...');
        this.worker = await createWorker('eng', 1, {
          workerPath: this.options.workerPath,
          corePath: this.options.corePath,
          langPath: this.options.langPath,
          // CRITICAL: Must be false for Chrome extensions.
          // When true (the default), Tesseract wraps the worker in a blob:// URL.
          // The blob worker then calls importScripts('chrome-extension://...') which
          // violates CSP because blob workers do not inherit 'self' from the
          // extension origin. Setting false spawns the Worker directly from the
          // chrome-extension:// URL, which is covered by 'self' in the manifest CSP.
          workerBlobURL: false,
          logger: () => {}, // suppress telemetry
          errorHandler: (err) => console.error('[PrivAgent OCR Error]', err),
        });
        console.info('[PrivAgent OCR] Local OCR worker initialized successfully.');
      } catch (err) {
        console.error('[PrivAgent OCR] Failed to initialize local OCR worker:', err);
        this.worker = null;
        throw err;
      } finally {
        this.initializing = null;
      }
    })();

    return this.initializing;
  }

  public async recognize(
    source: HTMLImageElement | HTMLCanvasElement | ImageData | string
  ): Promise<InternalOCRResult> {
    if (!this.worker) {
      await this.init();
    }
    if (!this.worker) {
      throw new Error('PrivAgent OCR Engine worker failed to initialize.');
    }

    const startTime = performance.now();
    const { data } = await this.worker.recognize(source);
    const latencyMs = performance.now() - startTime;

    const words: InternalOCRWord[] = [];
    const lines: InternalOCRLine[] = [];

    // Extract word-level bounding boxes and confidence
    if (Array.isArray(data.words)) {
      for (const w of data.words) {
        if (!w.text || !w.bbox) continue;
        const bbox: OCRWordBox = {
          x0: Math.round(w.bbox.x0),
          y0: Math.round(w.bbox.y0),
          x1: Math.round(w.bbox.x1),
          y1: Math.round(w.bbox.y1),
        };
        words.push({
          text: w.text.trim(),
          confidence: (w.confidence ?? 0) / 100,
          bbox,
        });
      }
    }

    // Extract line-level bounding boxes and context
    if (Array.isArray(data.lines)) {
      for (const l of data.lines) {
        if (!l.text || !l.bbox) continue;
        const lineBbox: OCRWordBox = {
          x0: Math.round(l.bbox.x0),
          y0: Math.round(l.bbox.y0),
          x1: Math.round(l.bbox.x1),
          y1: Math.round(l.bbox.y1),
        };

        const lineWords: InternalOCRWord[] = [];
        if (Array.isArray(l.words)) {
          for (const lw of l.words) {
            if (!lw.text || !lw.bbox) continue;
            lineWords.push({
              text: lw.text.trim(),
              confidence: (lw.confidence ?? 0) / 100,
              bbox: {
                x0: Math.round(lw.bbox.x0),
                y0: Math.round(lw.bbox.y0),
                x1: Math.round(lw.bbox.x1),
                y1: Math.round(lw.bbox.y1),
              },
            });
          }
        }

        lines.push({
          text: l.text.trim(),
          confidence: (l.confidence ?? 0) / 100,
          bbox: lineBbox,
          words: lineWords,
        });
      }
    }

    return {
      lines,
      words,
      fullText: data.text ?? '',
      latencyMs,
    };
  }

  public async terminate(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
  }
}

/**
 * Mock OCR Engine for lightning-fast and deterministic automated unit tests.
 */
export class MockOCREngine implements OCREngine {
  private initialized = false;
  private mockResult: InternalOCRResult;

  constructor(mockResult?: Partial<InternalOCRResult>) {
    this.mockResult = {
      lines: mockResult?.lines ?? [],
      words: mockResult?.words ?? [],
      fullText: mockResult?.fullText ?? '',
      latencyMs: mockResult?.latencyMs ?? 15,
    };
  }

  public setMockResult(result: Partial<InternalOCRResult>): void {
    this.mockResult = {
      lines: result.lines ?? [],
      words: result.words ?? [],
      fullText: result.fullText ?? '',
      latencyMs: result.latencyMs ?? 15,
    };
  }

  public isInitialized(): boolean {
    return this.initialized;
  }

  public async init(): Promise<void> {
    this.initialized = true;
  }

  public async recognize(): Promise<InternalOCRResult> {
    if (!this.initialized) await this.init();
    return this.mockResult;
  }

  public async terminate(): Promise<void> {
    this.initialized = false;
  }
}
