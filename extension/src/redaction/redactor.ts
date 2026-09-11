import { DetectionResult, RedactionMode } from '../privacy/types';
import { logSafeAudit } from '../privacy/securityBoundary';

export interface RedactionResult {
  elementsProtected: number;
  redactionLatencyMs: number;
  mode: RedactionMode;
}

const REDACTION_CONTAINER_ID = 'privagent-redaction-root';

/**
 * Local Redaction Engine
 * Creates non-destructive visual redaction masks directly on the user's viewport
 * based on the detected bounding boxes.
 */
export class LocalRedactor {
  private container: HTMLDivElement | null = null;
  private currentMode: RedactionMode = 'blackout';

  constructor() {
    this.ensureContainer();
  }

  private ensureContainer(): HTMLDivElement {
    let container = document.getElementById(REDACTION_CONTAINER_ID) as HTMLDivElement | null;
    if (!container) {
      container = document.createElement('div');
      container.id = REDACTION_CONTAINER_ID;
      container.setAttribute('aria-hidden', 'true');
      container.style.position = 'absolute';
      container.style.top = '0';
      container.style.left = '0';
      container.style.width = '100%';
      container.style.height = `${Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)}px`;
      container.style.pointerEvents = 'none';
      container.style.zIndex = '2147483640';
      document.body.appendChild(container);
    }
    this.container = container;
    return container;
  }

  /**
   * Applies visual redaction masks over all detected sensitive bounding boxes.
   */
  public applyRedaction(detections: DetectionResult[], mode: RedactionMode = 'blackout'): RedactionResult {
    const startTime = performance.now();
    this.currentMode = mode;
    const container = this.ensureContainer();
    container.innerHTML = ''; // Clear previous masks

    let count = 0;

    for (const det of detections) {
      const [x, y, w, h] = det.bbox;

      // Skip elements with zero dimension or off-screen invalid coordinates
      if (w <= 0 || h <= 0) continue;

      const maskEl = document.createElement('div');
      maskEl.className = `privagent-mask-box privagent-mode-${mode}`;
      maskEl.dataset.entityType = det.type;
      maskEl.dataset.detectionId = det.id;

      // Common geometry
      maskEl.style.position = 'absolute';
      maskEl.style.left = `${x}px`;
      maskEl.style.top = `${y}px`;
      maskEl.style.width = `${w}px`;
      maskEl.style.height = `${h}px`;
      maskEl.style.boxSizing = 'border-box';
      maskEl.style.pointerEvents = 'auto'; // Block mouse/inspection of underlying text
      maskEl.style.borderRadius = '4px';
      maskEl.style.transition = 'all 0.15s ease';

      if (mode === 'blackout') {
        maskEl.style.backgroundColor = '#05070d';
        maskEl.style.border = '1px solid rgba(239, 68, 68, 0.5)';
        maskEl.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.8)';
        
        // Small pill indicator
        const tag = document.createElement('span');
        tag.textContent = `🛡️ [${det.type.toUpperCase()}]`;
        tag.style.fontSize = '9px';
        tag.style.fontWeight = '700';
        tag.style.color = '#f87171';
        tag.style.fontFamily = 'monospace';
        tag.style.position = 'absolute';
        tag.style.top = '2px';
        tag.style.left = '4px';
        tag.style.lineHeight = '1';
        tag.style.pointerEvents = 'none';
        tag.style.userSelect = 'none';
        maskEl.appendChild(tag);
      } else if (mode === 'blur') {
        maskEl.style.backgroundColor = 'rgba(15, 23, 42, 0.4)';
        maskEl.style.backdropFilter = 'blur(16px)';
        maskEl.style.setProperty('-webkit-backdrop-filter', 'blur(16px)');
        maskEl.style.border = '1px dashed rgba(59, 130, 246, 0.6)';
      } else if (mode === 'mask') {
        maskEl.style.backgroundColor = '#18181b';
        maskEl.style.color = '#e4e4e7';
        maskEl.style.border = '1px solid #3f3f46';
        maskEl.style.display = 'flex';
        maskEl.style.alignItems = 'center';
        maskEl.style.justifyContent = 'center';
        maskEl.style.fontFamily = 'monospace';
        maskEl.style.fontSize = '11px';
        maskEl.style.fontWeight = 'bold';
        maskEl.style.letterSpacing = '0.05em';
        maskEl.style.userSelect = 'none';
        maskEl.textContent = `[REDACTED: ${det.type}]`;
      }

      container.appendChild(maskEl);
      count++;

      // Log safe audit (Strictly zero raw values)
      logSafeAudit(det, true);
    }

    const endTime = performance.now();
    const redactionLatencyMs = Number((endTime - startTime).toFixed(2));

    return {
      elementsProtected: count,
      redactionLatencyMs,
      mode,
    };
  }

  /**
   * Clears all active redaction masks from the page.
   */
  public clearRedaction(): void {
    if (this.container) {
      this.container.innerHTML = '';
    }
  }

  public getMode(): RedactionMode {
    return this.currentMode;
  }
}
