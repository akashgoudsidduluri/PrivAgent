export class SettingsView {
  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="view-header">
        <div class="view-title-group">
          <h2>System Settings</h2>
          <p>Agent reasoning configuration, safety policy enforcement, and privacy parameters</p>
        </div>
      </div>

      <div class="settings-container">
        <!-- Agent Section -->
        <div class="settings-section">
          <h3 class="settings-section-title">Agent Configuration</h3>
          <p class="settings-section-desc">
            Controls the LLM reasoning provider and autonomous execution bounds for M6.
          </p>

          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-label">Reasoning Provider</div>
              <div class="setting-hint">Server-side FastAPI reasoning bridge</div>
            </div>
            <div class="setting-control">
              <select id="setting-provider">
                <option value="backend-gemma" selected>Backend Gemma (OpenRouter)</option>
                <option value="mock">Deterministic Mock Reasoner</option>
              </select>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-label">Model Target</div>
              <div class="setting-hint">Target OpenRouter model path</div>
            </div>
            <div class="setting-control">
              <input type="text" value="google/gemma-2-9b-it:free" readonly style="color: var(--text-muted); width: 220px;" />
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-label">Maximum Steps</div>
              <div class="setting-hint">Endless-loop bound for M6 task runner</div>
            </div>
            <div class="setting-control">
              <select id="setting-max-steps">
                <option value="5">5 steps</option>
                <option value="10" selected>10 steps (default)</option>
                <option value="15">15 steps</option>
                <option value="20">20 steps</option>
              </select>
            </div>
          </div>
        </div>

        <!-- Privacy Section -->
        <div class="settings-section">
          <h3 class="settings-section-title">Privacy Engine (Architectural Invariants)</h3>
          <p class="settings-section-desc">
            Hardened on-device security policies. These parameters are enforced at the engine level.
          </p>

          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-label">Privacy Protection Status</div>
              <div class="setting-hint">Local perception firewall and PII minimization</div>
            </div>
            <div class="setting-control">
              <span class="setting-badge-fixed">✓ Enforced On-Device</span>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-label">Local-Only Sensitive Data Processing</div>
              <div class="setting-hint">Passwords, cards, and OTPs never leave extension memory</div>
            </div>
            <div class="setting-control">
              <span class="setting-badge-fixed">✓ Active</span>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-label">Visual Redaction Mode</div>
              <div class="setting-hint">Visual masking style applied to screenshot canvas</div>
            </div>
            <div class="setting-control">
              <select id="setting-redaction-mode">
                <option value="blackout" selected>Blackout Mask</option>
                <option value="blur">Blur (Sigma 10)</option>
                <option value="mask">[REDACTED] Overlay</option>
              </select>
            </div>
          </div>
        </div>

        <!-- Security Section -->
        <div class="settings-section">
          <h3 class="settings-section-title">Security & Safety Policies</h3>
          <p class="settings-section-desc">
            Enforces explicit user confirmation before consequential actions.
          </p>

          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-label">External Navigation Confirmation</div>
              <div class="setting-hint">Requires user authorization when agent navigates to a new origin</div>
            </div>
            <div class="setting-control">
              <span class="setting-badge-fixed">✓ Always Required</span>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-label">Consequential Action Safeguard</div>
              <div class="setting-hint">Submitting financial forms or changing credentials pauses M6</div>
            </div>
            <div class="setting-control">
              <span class="setting-badge-fixed">✓ Protected</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}
