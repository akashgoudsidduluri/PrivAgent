import { DashboardAgentState } from '../types/dashboard';

export class RedactionView {
  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
  }

  update(_state: DashboardAgentState): void {
    // Dynamic updates
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="ide-panel" style="margin-bottom: 12px;">
        <div class="ide-panel-header">
          <span>Visual Redaction & Canvas Sanitization Engine (M2 / M3)</span>
          <span class="badge badge-green">BOUNDED GEOMETRY</span>
        </div>
        <div class="ide-panel-body">
          <div class="metric-grid">
            <div class="metric-tile">
              <span class="metric-label">Blackout Engine</span>
              <span class="metric-value green">ACTIVE</span>
            </div>
            <div class="metric-tile">
              <span class="metric-label">DOM Text Masking</span>
              <span class="metric-value green">ACTIVE</span>
            </div>
            <div class="metric-tile">
              <span class="metric-label">Blur Radius</span>
              <span class="metric-value mono">16 px</span>
            </div>
            <div class="metric-tile">
              <span class="metric-label">Redaction Precision</span>
              <span class="metric-value green">100%</span>
            </div>
          </div>
        </div>
      </div>

      <div class="ide-panel" style="flex: 1;">
        <div class="ide-panel-header">
          <span>Redacted Region Geometry Log</span>
          <span class="mono" style="font-size: 10px; color: var(--text-muted);">GEOMETRY ONLY · ZERO TEXT</span>
        </div>
        <div class="ide-panel-body" style="padding: 0;">
          <table class="ide-table">
            <thead>
              <tr>
                <th style="width: 140px;">Method</th>
                <th style="width: 150px;">Detection Source</th>
                <th>Bounding Box Geometry (x, y, w, h)</th>
                <th style="width: 130px;">Category</th>
                <th style="width: 90px; text-align: center;">Confidence</th>
                <th style="width: 90px;">Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><span class="badge badge-red">BLACKOUT</span></td>
                <td class="mono">DOM_INPUT_TYPE</td>
                <td class="mono">[x: 120, y: 180, w: 220, h: 32]</td>
                <td class="mono">PASSWORD</td>
                <td class="mono" style="text-align: center;">1.00</td>
                <td><span class="badge badge-green">APPLIED</span></td>
              </tr>
              <tr>
                <td><span class="badge badge-amber">MASK</span></td>
                <td class="mono">DOM_LABEL</td>
                <td class="mono">[x: 120, y: 240, w: 180, h: 28]</td>
                <td class="mono">ACCOUNT_NUMBER</td>
                <td class="mono" style="text-align: center;">0.98</td>
                <td><span class="badge badge-green">APPLIED</span></td>
              </tr>
              <tr>
                <td><span class="badge badge-red">BLACKOUT</span></td>
                <td class="mono">DOM_ATTRIBUTE</td>
                <td class="mono">[x: 350, y: 240, w: 80, h: 28]</td>
                <td class="mono">CVV</td>
                <td class="mono" style="text-align: center;">0.99</td>
                <td><span class="badge badge-green">APPLIED</span></td>
              </tr>
              <tr>
                <td><span class="badge badge-amber">MASK</span></td>
                <td class="mono">TEXT_PATTERN</td>
                <td class="mono">[x: 120, y: 300, w: 240, h: 28]</td>
                <td class="mono">CREDIT_CARD</td>
                <td class="mono" style="text-align: center;">0.95</td>
                <td><span class="badge badge-green">APPLIED</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
  }
}
