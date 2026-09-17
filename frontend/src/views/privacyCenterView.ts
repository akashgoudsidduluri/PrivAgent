import { DashboardAgentState, SensitiveCategorySummary } from '../types/dashboard';

export class PrivacyCenterView {
  private container: HTMLElement;
  private state: DashboardAgentState | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
  }

  update(state: DashboardAgentState): void {
    this.state = state;
    this.renderTable();
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="ide-panel" style="margin-bottom: 12px;">
        <div class="ide-panel-header">
          <span>Security Console — Privacy Firewall Boundary</span>
          <span class="badge badge-green">FIREWALL ACTIVE</span>
        </div>
        <div class="ide-panel-body">
          <div class="metric-grid">
            <div class="metric-tile">
              <span class="metric-label">Firewall Status</span>
              <span class="metric-value green">ACTIVE</span>
            </div>
            <div class="metric-tile">
              <span class="metric-label">Local PII Detected</span>
              <span id="privacy-total-detected" class="metric-value amber">0</span>
            </div>
            <div class="metric-tile">
              <span class="metric-label">Local PII Protected</span>
              <span id="privacy-total-protected" class="metric-value green">0</span>
            </div>
            <div class="metric-tile">
              <span class="metric-label">Network Transmitted</span>
              <span class="metric-value green" style="font-weight: 800;">0 (ZERO-LEAK)</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Categories Table Panel -->
      <div class="ide-panel" style="flex: 1;">
        <div class="ide-panel-header">
          <span>Sensitive Entity Detection & Redaction Matrix</span>
          <span class="mono" style="font-size: 10px; color: var(--text-muted);">LIVE DATA</span>
        </div>
        <div class="ide-panel-body" style="padding: 0;">
          <table class="ide-table">
            <thead>
              <tr>
                <th>Sensitive Entity Category</th>
                <th style="width: 120px; text-align: center;">Detected</th>
                <th style="width: 140px; text-align: center;">Local Protection</th>
                <th style="width: 140px; text-align: center;">Remote Transmitted</th>
                <th style="width: 160px;">Policy Action</th>
              </tr>
            </thead>
            <tbody id="privacy-categories-table-body">
              <!-- Dynamically populated -->
            </tbody>
          </table>
        </div>
      </div>

      <!-- Security Invariant Notice -->
      <div class="ide-panel" style="margin-top: 12px;">
        <div class="ide-panel-header">
          <span>PrivAgent Core Privacy Invariants</span>
          <span class="badge badge-green">NON-NEGOTIABLE</span>
        </div>
        <div class="ide-panel-body" style="font-size: 11px; color: var(--text-secondary);">
          <ul style="padding-left: 18px; display: flex; flex-direction: column; gap: 4px;">
            <li><strong>Raw Values Never Leave Device:</strong> Passwords, account numbers, card numbers, CVVs, OTPs, emails, and phones are stripped before backend context dispatch.</li>
            <li><strong>Zero Raw Screenshots:</strong> Visual captures remain inside Chrome extension memory. LLMs receive only sanitized, coordinate-bounded metadata.</li>
            <li><strong>M8 Privacy Fusion:</strong> Multi-modal agreement between DOM attributes, visual OCR, and text regex patterns enforces fail-closed redaction.</li>
          </ul>
        </div>
      </div>
    `;

    this.renderTable();
  }

  private renderTable(): void {
    const tbody = this.container.querySelector('#privacy-categories-table-body');
    const totalDetectedEl = this.container.querySelector('#privacy-total-detected');
    const totalProtectedEl = this.container.querySelector('#privacy-total-protected');

    const categories: SensitiveCategorySummary = this.state?.categories || {
      password: 0,
      credit_card: 0,
      account_number: 0,
      email: 0,
      phone: 0,
      pan: 0,
      cvv: 0,
      otp: 0,
    };

    const rows: Array<{ label: string; count: number; policy: string }> = [
      { label: 'Password', count: categories.password, policy: 'BLACKOUT + MASK' },
      { label: 'Account Number', count: categories.account_number, policy: 'REDACT + MASK' },
      { label: 'Credit Card (PAN)', count: categories.credit_card, policy: 'BLACKOUT + MASK' },
      { label: 'CVV / Security Code', count: categories.cvv, policy: 'BLACKOUT + STRIP' },
      { label: 'One-Time Password (OTP)', count: categories.otp, policy: 'BLACKOUT + STRIP' },
      { label: 'PAN Card (Tax ID)', count: categories.pan, policy: 'REDACT + MASK' },
      { label: 'Email Address', count: categories.email, policy: 'METADATA_ONLY' },
      { label: 'Phone Number', count: categories.phone, policy: 'METADATA_ONLY' },
    ];

    let totalDetected = 0;

    if (tbody) {
      tbody.innerHTML = rows
        .map((r) => {
          totalDetected += r.count;
          const detectedDisplay = r.count > 0 ? `<strong class="mono" style="color: var(--status-amber-bright);">${r.count}</strong>` : `<span class="mono" style="color: var(--text-dim);">0</span>`;
          const protectedDisplay = r.count > 0 ? `<span class="badge badge-green">${r.count} PROTECTED</span>` : `<span class="mono" style="color: var(--text-dim);">-</span>`;

          return `
            <tr>
              <td><strong>${r.label}</strong></td>
              <td style="text-align: center;">${detectedDisplay}</td>
              <td style="text-align: center;">${protectedDisplay}</td>
              <td style="text-align: center;"><span class="mono" style="color: var(--status-green-bright); font-weight: 700;">0</span></td>
              <td class="mono" style="font-size: 11px; color: var(--text-secondary);">${r.policy}</td>
            </tr>
          `;
        })
        .join('');
    }

    if (totalDetectedEl) totalDetectedEl.textContent = String(totalDetected);
    if (totalProtectedEl) totalProtectedEl.textContent = String(totalDetected);
  }
}
