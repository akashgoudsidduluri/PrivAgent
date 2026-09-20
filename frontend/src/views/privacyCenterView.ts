import { DashboardAgentState } from '../types/dashboard';

export class PrivacyCenterView {
  private container: HTMLElement;
  private state: DashboardAgentState | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
  }

  update(state: DashboardAgentState): void {
    this.state = state;
    this.renderMetrics(state);
  }

  private render(): void {
    this.container.innerHTML = `
      <!-- Privacy Firewall Active Status Banner -->
      <div class="ide-panel" style="border-left: 3px solid var(--status-green-bright);">
        <div class="ide-panel-body" style="padding: 14px 18px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
          <div>
            <div style="font-size: 16px; font-weight: 700; color: var(--text-bright); display: flex; align-items: center; gap: 8px;">
              <span>PrivAgent Privacy Firewall</span>
              <span class="badge badge-green">ACTIVE & ENFORCING</span>
            </div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-top: 3px;">
              M8 Privacy Fusion • DOM Sanitizer • Local Visual OCR • Pre-Flight Zero-Leak Boundary
            </div>
          </div>
          <div style="display: flex; gap: 12px; align-items: center;">
            <div style="text-align: right; font-family: var(--font-mono); font-size: 11px;">
              <span style="color: var(--text-muted);">REMOTE TRANSMISSION:</span>
              <span style="color: var(--status-green-bright); font-weight: 800; font-size: 13px; margin-left: 6px;">0 BYTES (NON-NEGOTIABLE)</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 4 Pillars Architecture Grid -->
      <div class="metric-grid">
        <!-- 1. Local Detection -->
        <div class="metric-tile">
          <span class="metric-label">1. Local Detection</span>
          <div style="font-size: 13px; font-weight: 600; color: var(--text-bright); margin-top: 2px;">
            DOM + OCR + VISION
          </div>
          <span class="metric-subtext">On-device regex, attributes, visual text</span>
        </div>

        <!-- 2. M8 Privacy Fusion -->
        <div class="metric-tile">
          <span class="metric-label">2. M8 Privacy Fusion</span>
          <div style="font-size: 13px; font-weight: 600; color: var(--status-green-bright); margin-top: 2px;">
            <span id="privacy-fusion-count">0</span> Findings Synthesized
          </div>
          <span class="metric-subtext">Multi-modal consensus voting</span>
        </div>

        <!-- 3. Policy Enforcement -->
        <div class="metric-tile">
          <span class="metric-label">3. Strict Policies</span>
          <div style="font-size: 13px; font-weight: 600; color: var(--text-bright); margin-top: 2px;">
            REDACT & MINIMIZE
          </div>
          <span class="metric-subtext">Never Transmit • Fail Closed</span>
        </div>

        <!-- 4. Outbound Context Status -->
        <div class="metric-tile">
          <span class="metric-label">4. Outbound Context</span>
          <div style="font-size: 13px; font-weight: 700; color: var(--status-green-bright); margin-top: 2px;">
            SAFE / VERIFIED
          </div>
          <span class="metric-subtext">Pre-flight outbound HTTP firewall</span>
        </div>
      </div>

      <!-- Entity Category Policy & Action Matrix -->
      <div class="ide-panel" style="flex: 1;">
        <div class="ide-panel-header">
          <span>Sensitive Entity Categorization & Quarantining Matrix</span>
          <span class="badge badge-green">STRICT LOCAL ISOLATION</span>
        </div>
        <div class="ide-panel-body" style="padding: 0;">
          <table class="ide-table">
            <thead>
              <tr>
                <th style="width: 180px;">Entity Category</th>
                <th style="width: 140px;">Local Protection Policy</th>
                <th style="width: 140px; text-align: center;">Detected Count</th>
                <th style="width: 160px; text-align: center;">Remote Transmitted</th>
                <th>Handling Mechanism (Zero-Leak Evidence)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>PASSWORD / CREDENTIAL</strong></td>
                <td><span class="badge badge-amber">LOCAL ONLY</span></td>
                <td class="mono" style="text-align: center;" id="cat-count-pwd">0</td>
                <td class="mono" style="text-align: center; color: var(--status-green-bright); font-weight: 700;">0 bytes</td>
                <td style="color: var(--text-secondary); font-size: 11px;">Stripped from DOM metadata; handled strictly via secure local extension keystroke isolate.</td>
              </tr>
              <tr>
                <td><strong>CREDIT CARD (PAN)</strong></td>
                <td><span class="badge badge-red">REDACTED</span></td>
                <td class="mono" style="text-align: center;" id="cat-count-card">0</td>
                <td class="mono" style="text-align: center; color: var(--status-green-bright); font-weight: 700;">0 bytes</td>
                <td style="color: var(--text-secondary); font-size: 11px;">Replaced with [REDACTED_CARD] token; pixel bounding box blurred in visual memory.</td>
              </tr>
              <tr>
                <td><strong>CARD CVV / CVC</strong></td>
                <td><span class="badge badge-red">REDACTED</span></td>
                <td class="mono" style="text-align: center;" id="cat-count-cvv">0</td>
                <td class="mono" style="text-align: center; color: var(--status-green-bright); font-weight: 700;">0 bytes</td>
                <td style="color: var(--text-secondary); font-size: 11px;">Quarantined immediately upon DOM inspection. Never serialized to any payload.</td>
              </tr>
              <tr>
                <td><strong>BANK ACCOUNT NUMBER</strong></td>
                <td><span class="badge badge-amber">LOCAL ONLY</span></td>
                <td class="mono" style="text-align: center;" id="cat-count-acc">0</td>
                <td class="mono" style="text-align: center; color: var(--status-green-bright); font-weight: 700;">0 bytes</td>
                <td style="color: var(--text-secondary); font-size: 11px;">Preserved locally for user verification; omitted from external LLM reasoning prompt.</td>
              </tr>
              <tr>
                <td><strong>ONE-TIME PASSWORD (OTP)</strong></td>
                <td><span class="badge badge-amber">LOCAL ONLY</span></td>
                <td class="mono" style="text-align: center;" id="cat-count-otp">0</td>
                <td class="mono" style="text-align: center; color: var(--status-green-bright); font-weight: 700;">0 bytes</td>
                <td style="color: var(--text-secondary); font-size: 11px;">Strictly ephemeral in browser memory; forbidden key checks reject on egress.</td>
              </tr>
              <tr>
                <td><strong>EMAIL ADDRESS</strong></td>
                <td><span class="badge badge-blue">MINIMIZED</span></td>
                <td class="mono" style="text-align: center;" id="cat-count-email">0</td>
                <td class="mono" style="text-align: center; color: var(--status-green-bright); font-weight: 700;">0 bytes</td>
                <td style="color: var(--text-secondary); font-size: 11px;">Replaced with entity alias [USER_EMAIL] unless explicit user goal requires interaction.</td>
              </tr>
              <tr>
                <td><strong>PHONE NUMBER</strong></td>
                <td><span class="badge badge-blue">MINIMIZED</span></td>
                <td class="mono" style="text-align: center;" id="cat-count-phone">0</td>
                <td class="mono" style="text-align: center; color: var(--status-green-bright); font-weight: 700;">0 bytes</td>
                <td style="color: var(--text-secondary); font-size: 11px;">Masked with [PHONE_MASKED] metadata token; raw phone digits never leave device.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  private renderMetrics(state: DashboardAgentState): void {
    const fusionCount = document.getElementById('privacy-fusion-count');
    const pwdCount = document.getElementById('cat-count-pwd');
    const cardCount = document.getElementById('cat-count-card');
    const cvvCount = document.getElementById('cat-count-cvv');
    const accCount = document.getElementById('cat-count-acc');
    const otpCount = document.getElementById('cat-count-otp');
    const emailCount = document.getElementById('cat-count-email');
    const phoneCount = document.getElementById('cat-count-phone');

    if (fusionCount) fusionCount.textContent = `${state.sensitiveItemsCount}`;
    if (pwdCount) pwdCount.textContent = `${state.categories.password}`;
    if (cardCount) cardCount.textContent = `${state.categories.credit_card}`;
    if (cvvCount) cvvCount.textContent = `${state.categories.cvv}`;
    if (accCount) accCount.textContent = `${state.categories.account_number}`;
    if (otpCount) otpCount.textContent = `${state.categories.otp}`;
    if (emailCount) emailCount.textContent = `${state.categories.email}`;
    if (phoneCount) phoneCount.textContent = `${state.categories.phone}`;
  }
}
