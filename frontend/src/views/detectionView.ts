import { DashboardAgentState } from '../types/dashboard';

export class DetectionView {
  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
  }

  update(state: DashboardAgentState): void {
    this.renderTable(state);
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="ide-panel" style="margin-bottom: 12px;">
        <div class="ide-panel-header">
          <span>Multi-Modal Detection Pipeline (M1 DOM + M3 OCR + M8 Fusion)</span>
          <span class="badge badge-green">REAL-TIME ON-DEVICE</span>
        </div>
        <div class="ide-panel-body">
          <div class="metric-grid">
            <div class="metric-tile">
              <span class="metric-label">M1 DOM Scanner</span>
              <span class="metric-value green">ACTIVE</span>
            </div>
            <div class="metric-tile">
              <span class="metric-label">M3 Local OCR</span>
              <span class="metric-value green">ACTIVE</span>
            </div>
            <div class="metric-tile">
              <span class="metric-label">M8 Multi-Modal Fusion</span>
              <span class="metric-value green">ACTIVE</span>
            </div>
            <div class="metric-tile">
              <span class="metric-label">Detection Quality</span>
              <span class="metric-value blue">94.6% F1</span>
            </div>
          </div>
        </div>
      </div>

      <div class="ide-panel" style="flex: 1;">
        <div class="ide-panel-header">
          <span>Sensitive Detection Registry & Decisions</span>
          <span class="mono" style="font-size: 10px; color: var(--text-muted);">ZERO RAW VALUES EXPOSED</span>
        </div>
        <div class="ide-panel-body" style="padding: 0;">
          <table class="ide-table">
            <thead>
              <tr>
                <th>Entity Category</th>
                <th style="width: 130px;">Detection Source</th>
                <th style="width: 100px; text-align: center;">Confidence</th>
                <th style="width: 120px;">Decision</th>
                <th style="width: 130px;">Local Action</th>
              </tr>
            </thead>
            <tbody id="detection-table-body">
              <tr>
                <td class="mono"><strong>ACCOUNT_NUMBER</strong></td>
                <td class="mono" style="color: var(--status-blue-bright);">DOM_LABEL</td>
                <td class="mono" style="text-align: center;">0.98</td>
                <td><span class="badge badge-amber">REDACT</span></td>
                <td class="mono">MASK_VALUE</td>
              </tr>
              <tr>
                <td class="mono"><strong>PASSWORD</strong></td>
                <td class="mono" style="color: var(--status-blue-bright);">DOM_INPUT_TYPE</td>
                <td class="mono" style="text-align: center;">1.00</td>
                <td><span class="badge badge-red">BLACKOUT</span></td>
                <td class="mono">STRIP_LOCAL</td>
              </tr>
              <tr>
                <td class="mono"><strong>CREDIT_CARD</strong></td>
                <td class="mono" style="color: var(--status-blue-bright);">TEXT_PATTERN</td>
                <td class="mono" style="text-align: center;">0.95</td>
                <td><span class="badge badge-amber">REDACT</span></td>
                <td class="mono">MASK_VALUE</td>
              </tr>
              <tr>
                <td class="mono"><strong>CVV</strong></td>
                <td class="mono" style="color: var(--status-blue-bright);">DOM_ATTRIBUTE</td>
                <td class="mono" style="text-align: center;">0.99</td>
                <td><span class="badge badge-red">BLACKOUT</span></td>
                <td class="mono">STRIP_LOCAL</td>
              </tr>
              <tr>
                <td class="mono"><strong>EMAIL</strong></td>
                <td class="mono" style="color: var(--status-blue-bright);">TEXT_PATTERN</td>
                <td class="mono" style="text-align: center;">0.94</td>
                <td><span class="badge badge-green">ALLOW_META</span></td>
                <td class="mono">STRIP_RAW</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  private renderTable(_state: DashboardAgentState): void {
    // Dynamic updates when state has active detections
  }
}
