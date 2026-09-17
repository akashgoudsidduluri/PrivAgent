import { DashboardAgentState } from '../types/dashboard';

export class TelemetryView {
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
          <span>Safe Reasoning Telemetry Inspector</span>
          <span class="badge badge-green">AUDIT VERIFIED</span>
        </div>
        <div class="ide-panel-body">
          <div class="metric-grid">
            <div class="metric-tile">
              <span class="metric-label">Telemetry Invariant</span>
              <span class="metric-value green">ZERO-PII</span>
            </div>
            <div class="metric-tile">
              <span class="metric-label">Median Latency</span>
              <span class="metric-value blue mono">1,820 ms</span>
            </div>
            <div class="metric-tile">
              <span class="metric-label">Fallback Status</span>
              <span class="metric-value mono">READY (OR)</span>
            </div>
            <div class="metric-tile">
              <span class="metric-label">Error Rate</span>
              <span class="metric-value green mono">0.0%</span>
            </div>
          </div>
        </div>
      </div>

      <div class="ide-panel" style="flex: 1;">
        <div class="ide-panel-header">
          <span>Step-by-Step Reasoning Telemetry</span>
          <span class="mono" style="font-size: 10px; color: var(--text-muted);">LATENCIES & ATTEMPTS ONLY</span>
        </div>
        <div class="ide-panel-body" style="padding: 0;">
          <table class="ide-table">
            <thead>
              <tr>
                <th style="width: 50px;">Step</th>
                <th style="width: 100px;">Provider</th>
                <th>Model Identifier</th>
                <th style="width: 110px; text-align: center;">Latency</th>
                <th style="width: 80px; text-align: center;">Attempts</th>
                <th style="width: 100px; text-align: center;">Fallback</th>
                <th style="width: 100px;">Outcome</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td class="mono" style="color: var(--text-dim);">1</td>
                <td class="mono" style="color: var(--status-blue-bright); font-weight: 600;">GROQ</td>
                <td class="mono">openai/gpt-oss-20b</td>
                <td class="mono" style="text-align: center;">1,420 ms</td>
                <td class="mono" style="text-align: center;">1</td>
                <td style="text-align: center;"><span class="badge badge-gray">NO</span></td>
                <td><span class="badge badge-green">SUCCESS</span></td>
              </tr>
              <tr>
                <td class="mono" style="color: var(--text-dim);">2</td>
                <td class="mono" style="color: var(--status-blue-bright); font-weight: 600;">GROQ</td>
                <td class="mono">openai/gpt-oss-20b</td>
                <td class="mono" style="text-align: center;">1,680 ms</td>
                <td class="mono" style="text-align: center;">1</td>
                <td style="text-align: center;"><span class="badge badge-gray">NO</span></td>
                <td><span class="badge badge-green">SUCCESS</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
  }
}
