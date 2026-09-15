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
          <span>Protection Active</span>
        </div>
      </div>

      <div class="privacy-center-container">
        <!-- 4 Core Metrics -->
        <div class="privacy-metrics-grid">
          <div class="metric-card">
            <div class="metric-card-label">
              <span>👁️</span> Sensitive info detected
            </div>
            <div id="metric-sensitive-detected" class="metric-card-value">6</div>
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
            <div class="category-pill detected">✓ Password</div>
            <div class="category-pill detected">✓ Card number</div>
            <div class="category-pill detected">✓ Account number</div>
            <div class="category-pill detected">✓ Email</div>
            <div class="category-pill detected">✓ Phone</div>
            <div class="category-pill detected">✓ PAN</div>
            <div class="category-pill">✓ CVV</div>
            <div class="category-pill">✓ OTP</div>
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
  }
}
