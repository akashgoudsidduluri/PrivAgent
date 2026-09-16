import { DashboardAgentState } from '../types/dashboard';

export class PrivacyCenterView {
  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="view-header">
        <div class="view-title-group">
          <h2>Privacy Center</h2>
          <p>Real-time on-device telemetry and cryptographic privacy enforcement boundaries</p>
        </div>
        <div class="privacy-shield-badge">
          <span class="pulse-dot"></span>
          <span id="privacy-status-label">Local Firewall Active · Zero Leakage</span>
        </div>
      </div>

      <div class="privacy-center-container">
        <!-- 4 Core Metrics -->
        <div class="privacy-metrics-grid">
          <div class="metric-card">
            <div class="metric-card-label">
              <span>👁️</span> Sensitive info detected
            </div>
            <div id="metric-sensitive-detected" class="metric-card-value">0</div>
            <div class="metric-card-note">On-device DOM & visual perception</div>
          </div>

          <div class="metric-card">
            <div class="metric-card-label">
              <span>🔒</span> Sensitive info transmitted
            </div>
            <div class="metric-card-value highlight-zero">0</div>
            <div class="metric-card-note">Strictly blocked on device</div>
          </div>

          <div class="metric-card">
            <div class="metric-card-label">
              <span>🖼️</span> Raw screenshots transmitted
            </div>
            <div class="metric-card-value highlight-zero">0</div>
            <div class="metric-card-note">Zero visual leakage guarantee</div>
          </div>

          <div class="metric-card">
            <div class="metric-card-label">
              <span>📄</span> Raw DOM values transmitted
            </div>
            <div class="metric-card-value highlight-zero">0</div>
            <div class="metric-card-note">Sanitized bounding boxes only</div>
          </div>
        </div>

        <!-- Protected Categories Section -->
        <div class="comparison-card">
          <div class="comparison-header blocked">
            <span>🛡️</span> Protected Locally On-Device
          </div>
          <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: 12px;">
            The following sensitive data classes are recognized locally by regex & DOM attribute scanners, masked in memory, and stripped from outbound context:
          </p>
          <div id="category-pills-list" class="category-pills-wrap">
            <!-- Populated dynamically -->
          </div>
        </div>

        <!-- Recent Redaction Events -->
        <div class="comparison-card">
          <div class="comparison-header blocked">
            <span>🔒</span> On-Device Redaction & Masking Events
          </div>
          <div id="redaction-events-list" style="font-size: 13px; color: var(--text-secondary); margin-top: 8px;">
            <p style="color: var(--text-muted); font-style: italic;">No sensitive fields detected on the current active page. Local firewall is monitoring live DOM.</p>
          </div>
        </div>

        <!-- Shared vs Blocked Breakdown -->
        <div class="privacy-comparison-grid">
          <div class="comparison-card">
            <div class="comparison-header shared">
              <span>📤</span> Information Shared with AI (Sanitized Context)
            </div>
            <ul class="comparison-list">
              <li><span>✓</span> <strong>Button labels</strong> (e.g. "Submit", "Search")</li>
              <li><span>✓</span> <strong>Page structure</strong> (Hierarchical layout elements)</li>
              <li><span>✓</span> <strong>Safe coordinates</strong> (Bounding boxes for clicking)</li>
              <li><span>✓</span> <strong>Non-sensitive text</strong> (Public headings & prompts)</li>
              <li><span>✓</span> <strong>Allowed metadata</strong> (Input field tags & viewport size)</li>
            </ul>
          </div>

          <div class="comparison-card">
            <div class="comparison-header blocked">
              <span>🛑</span> Information Blocked from AI (Firewalled)
            </div>
            <ul class="comparison-list">
              <li><span>✓</span> <strong>Password values</strong> (Never transmitted)</li>
              <li><span>✓</span> <strong>Credit card numbers</strong> (16-digit PANs redacted)</li>
              <li><span>✓</span> <strong>Bank account numbers</strong> (Masked on-device)</li>
              <li><span>✓</span> <strong>OTP & CVV codes</strong> (Strictly forbidden)</li>
              <li><span>✓</span> <strong>Unredacted screenshots</strong> (Stored in RAM only)</li>
            </ul>
          </div>
        </div>
      </div>
    `;
  }

  update(state: DashboardAgentState): void {
    const elDetected = this.container.querySelector('#metric-sensitive-detected');
    if (elDetected) {
      elDetected.textContent = String(state.sensitiveItemsCount);
    }

    const pillsContainer = this.container.querySelector('#category-pills-list');
    if (pillsContainer) {
      const categories = [
        { key: 'password', label: 'Password' },
        { key: 'account_number', label: 'Account number' },
        { key: 'credit_card', label: 'Credit card' },
        { key: 'email', label: 'Email' },
        { key: 'phone', label: 'Phone' },
        { key: 'pan', label: 'PAN' },
        { key: 'cvv', label: 'CVV' },
        { key: 'otp', label: 'OTP' },
        { key: 'person_name', label: 'Personal Name' },
        { key: 'address', label: 'Physical Address' },
      ] as const;

      pillsContainer.innerHTML = categories
        .map((cat) => {
          const count = (state.categories as any)[cat.key] || 0;
          const isDetected = count > 0;
          return `
            <div class="category-pill ${isDetected ? 'detected' : ''}">
              ✓ ${cat.label} ${count > 0 ? `(${count})` : ''}
            </div>
          `;
        })
        .join('');
    }

    const eventsList = this.container.querySelector('#redaction-events-list');
    if (eventsList) {
      const sensitiveSteps = state.steps.filter((s) => s.sensitiveCategoryDetected);
      if (sensitiveSteps.length > 0) {
        eventsList.innerHTML = sensitiveSteps
          .map(
            (s) => `
          <div style="display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border-subtle);">
            <span style="color: var(--shield-green); font-weight: bold;">🛡️ [PROTECTED]</span>
            <span>Step ${s.step}: <strong>${escapeHtml(s.actionType)}</strong> on <code>${escapeHtml(s.targetDescription)}</code></span>
            <span class="category-pill detected" style="padding: 1px 6px; font-size: 10px;">${escapeHtml(s.sensitiveCategoryDetected!)}</span>
          </div>
        `
          )
          .join('');
      } else if (state.sensitiveItemsCount > 0) {
        eventsList.innerHTML = `
          <p style="color: var(--shield-green);">
            🔒 ${state.sensitiveItemsCount} sensitive elements protected on current page. Values masked locally with zero network transmission.
          </p>
        `;
      } else {
        eventsList.innerHTML = `
          <p style="color: var(--text-muted); font-style: italic;">
            No sensitive fields detected on current page. Local firewall is actively monitoring DOM.
          </p>
        `;
      }
    }
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
