export class SettingsView {
  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="ide-panel" style="max-width: 800px;">
        <div class="ide-panel-header">
          <span>System & Engine Settings</span>
          <span class="badge badge-green">INVARIANTS LOCKED</span>
        </div>
        <div class="ide-panel-body" style="display: flex; flex-direction: column; gap: 16px;">
          <!-- Reasoner Settings -->
          <div>
            <h4 style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); margin-bottom: 8px;">Reasoner Configuration</h4>
            <div class="kv-list">
              <div class="kv-row">
                <span class="kv-key">Primary Reasoner:</span>
                <span class="kv-value mono">groq</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Groq Model:</span>
                <span class="kv-value mono">openai/gpt-oss-20b</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Fallback Reasoner:</span>
                <span class="kv-value mono">openrouter (on transient error)</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Structured Output Schema:</span>
                <span class="kv-value mono">strict json_schema (BrowserActionModel)</span>
              </div>
            </div>
          </div>

          <!-- Agent Loop Settings -->
          <div style="border-top: 1px solid var(--border-subtle); padding-top: 12px;">
            <h4 style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); margin-bottom: 8px;">Agent Loop Limits</h4>
            <div class="kv-list">
              <div class="kv-row">
                <span class="kv-key">Max Steps per Task:</span>
                <span class="kv-value mono">10 steps</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Max Consecutive Retries:</span>
                <span class="kv-value mono">2 retries</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Risk-Aware Human Confirmation:</span>
                <span class="kv-value" style="color: var(--status-green-bright);">ENABLED (HIGH / CRITICAL ACTIONS)</span>
              </div>
            </div>
          </div>

          <!-- Privacy Invariants (Locked) -->
          <div style="border-top: 1px solid var(--border-subtle); padding-top: 12px;">
            <h4 style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); margin-bottom: 8px;">Mandatory Security Invariants (Locked)</h4>
            <div class="kv-list">
              <div class="kv-row">
                <span class="kv-key">Privacy Firewall:</span>
                <span class="kv-value" style="color: var(--status-green-bright);">LOCKED ACTIVE (Cannot be disabled)</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Raw Value Firewall:</span>
                <span class="kv-value" style="color: var(--status-green-bright);">LOCKED ACTIVE (Pass-closed rejection)</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Target Tab Boundary:</span>
                <span class="kv-value mono" style="color: var(--status-blue-bright);">Strict localhost:4173 resolution</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}
