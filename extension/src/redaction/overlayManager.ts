import { DetectionResult, RedactionMode } from '../privacy/types';
import { LocalRedactor } from './redactor';

export type DemoViewStage = 'original' | 'detected' | 'sanitized';

const INSPECT_CONTAINER_ID = 'privagent-inspect-root';
const FLOATING_PANEL_ID = 'privagent-floating-panel';

export class OverlayManager {
  private redactor: LocalRedactor;
  private currentStage: DemoViewStage = 'sanitized';
  private inspectContainer: HTMLDivElement | null = null;
  private currentDetections: DetectionResult[] = [];
  private currentMode: RedactionMode = 'blackout';

  constructor(redactor: LocalRedactor) {
    this.redactor = redactor;
  }

  private ensureInspectContainer(): HTMLDivElement {
    let container = document.getElementById(INSPECT_CONTAINER_ID) as HTMLDivElement | null;
    if (!container) {
      container = document.createElement('div');
      container.id = INSPECT_CONTAINER_ID;
      container.style.position = 'absolute';
      container.style.top = '0';
      container.style.left = '0';
      container.style.width = '100%';
      container.style.height = `${Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)}px`;
      container.style.pointerEvents = 'none';
      container.style.zIndex = '2147483639';
      document.body.appendChild(container);
    }
    this.inspectContainer = container;
    return container;
  }

  public setDetections(detections: DetectionResult[], mode: RedactionMode = 'blackout'): void {
    this.currentDetections = detections;
    this.currentMode = mode;
    this.renderStage(this.currentStage);
  }

  public renderStage(stage: DemoViewStage): void {
    this.currentStage = stage;
    const inspectContainer = this.ensureInspectContainer();
    inspectContainer.innerHTML = '';
    this.redactor.clearRedaction();

    if (stage === 'original') {
      // Clean page: no boxes, no redaction
      this.updateFloatingPanelBadge('Stage: 1/3 (Original Page)');
      return;
    }

    if (stage === 'detected') {
      // Stage 2: Show detected bounding boxes with confidence labels
      for (const det of this.currentDetections) {
        const [x, y, w, h] = det.bbox;
        if (w <= 0 || h <= 0) continue;

        const box = document.createElement('div');
        box.className = 'privagent-debug-bbox';
        box.style.position = 'absolute';
        box.style.left = `${x}px`;
        box.style.top = `${y}px`;
        box.style.width = `${w}px`;
        box.style.height = `${h}px`;
        box.style.border = '2px solid #3b82f6';
        box.style.backgroundColor = 'rgba(59, 130, 246, 0.15)';
        box.style.borderRadius = '4px';
        box.style.boxSizing = 'border-box';
        box.style.pointerEvents = 'none';

        const badge = document.createElement('div');
        badge.textContent = `${det.type} (${(det.confidence * 100).toFixed(0)}%)`;
        badge.style.position = 'absolute';
        badge.style.top = '-18px';
        badge.style.left = '0';
        badge.style.backgroundColor = '#1d4ed8';
        badge.style.color = '#ffffff';
        badge.style.fontSize = '10px';
        badge.style.fontWeight = '700';
        badge.style.padding = '1px 6px';
        badge.style.borderRadius = '3px';
        badge.style.whiteSpace = 'nowrap';
        badge.style.boxShadow = '0 2px 4px rgba(0,0,0,0.3)';

        box.appendChild(badge);
        inspectContainer.appendChild(box);
      }
      this.updateFloatingPanelBadge('Stage: 2/3 (Detected Regions)');
      return;
    }

    if (stage === 'sanitized') {
      // Stage 3: Sanitized page with local redaction active
      this.redactor.applyRedaction(this.currentDetections, this.currentMode);
      this.updateFloatingPanelBadge('Stage: 3/3 (Sanitized Context)');
    }
  }

  public renderFloatingPanel(): void {
    let panel = document.getElementById(FLOATING_PANEL_ID);
    if (panel) return;

    panel = document.createElement('div');
    panel.id = FLOATING_PANEL_ID;
    panel.className = 'privagent-demo-bar';
    panel.innerHTML = `
      <div class="privagent-bar-content">
        <div class="privagent-bar-brand">
          <span class="privagent-pulse-dot"></span>
          <strong>PrivAgent Boundary</strong>
          <span id="privagent-stage-badge" class="privagent-stage-pill">Sanitized</span>
        </div>
        <div class="privagent-stage-controls">
          <button type="button" class="privagent-stage-btn" data-stage="original">1. Original</button>
          <button type="button" class="privagent-stage-btn" data-stage="detected">2. Detected</button>
          <button type="button" class="privagent-stage-btn active" data-stage="sanitized">3. Sanitized</button>
        </div>
        <button type="button" class="privagent-bar-close" id="privagent-close-bar" title="Close Bar">&times;</button>
      </div>
    `;

    document.body.appendChild(panel);

    // Attach listeners
    const buttons = panel.querySelectorAll<HTMLButtonElement>('.privagent-stage-btn');
    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        buttons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const stage = btn.getAttribute('data-stage') as DemoViewStage;
        this.renderStage(stage);
      });
    });

    panel.querySelector('#privagent-close-bar')?.addEventListener('click', () => {
      panel?.remove();
    });
  }

  private updateFloatingPanelBadge(text: string): void {
    const badge = document.getElementById('privagent-stage-badge');
    if (badge) {
      badge.textContent = text;
    }
  }

  public getStage(): DemoViewStage {
    return this.currentStage;
  }
}
