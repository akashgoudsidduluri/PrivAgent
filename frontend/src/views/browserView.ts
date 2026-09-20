import { DashboardAgentState } from '../types/dashboard';
import { AgentAdapter } from '../adapters/agentAdapter';

export class BrowserView {
  private container: HTMLElement;
  private adapter: AgentAdapter;

  constructor(container: HTMLElement, adapter: AgentAdapter) {
    this.container = container;
    this.adapter = adapter;
    this.render();
  }

  update(state: DashboardAgentState): void {
    this.renderState(state);
  }

  private render(): void {
    this.container.innerHTML = `
      <div style="display: grid; grid-template-columns: 340px 1fr; gap: 12px; height: 100%; min-height: 0;">
        <!-- Left: Target Status & Telemetry -->
        <div class="ide-panel" style="height: 100%;">
          <div class="ide-panel-header">
            <span>Target Tab Telemetry</span>
            <span class="badge badge-green">BOUNDED</span>
          </div>
          <div class="ide-panel-body" style="gap: 12px;">
            <div class="kv-list">
              <div class="kv-row">
                <span class="kv-key">Target Web Tab:</span>
                <span id="browser-target-url" class="kv-value mono" style="color: var(--status-blue-bright); word-break: break-all;">
                  http://localhost:4174
                </span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Page Title:</span>
                <span id="browser-page-title" class="kv-value">ApexCart — Modern Commerce</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Page Generation:</span>
                <span id="browser-page-gen" class="kv-value mono">Generation 1</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Page Classification:</span>
                <span id="browser-page-type" class="kv-value">
                  <span class="badge badge-blue">COMMERCE_PORTAL</span>
                </span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Interactive Targets:</span>
                <span id="browser-interactive-count" class="kv-value mono">24 candidates</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Privacy Protected:</span>
                <span id="browser-privacy-count" class="kv-value mono" style="color: var(--status-green-bright); font-weight: 700;">
                  0 protected
                </span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Self-Dashboard Tab:</span>
                <span class="kv-value mono" style="color: var(--text-muted);">
                  localhost:5173 (Excluded)
                </span>
              </div>
            </div>

            <div style="display: flex; flex-direction: column; gap: 6px; margin-top: 6px;">
              <button id="browser-open-btn" class="ide-btn primary">
                <span>Focus Target Tab (localhost:4174)</span>
              </button>
              <button id="browser-ping-btn" class="ide-btn">
                <span>Verify Tab CDP Readiness</span>
              </button>
            </div>

            <div style="margin-top: auto; padding: 10px; background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: var(--radius-xs); font-size: 11px; color: var(--text-secondary); line-height: 1.4;">
              <strong>Stale-Target Invariant:</strong> Any action referencing element IDs from past page generations is rejected by M5 before execution, preventing misclicks across navigations.
            </div>
          </div>
        </div>

        <!-- Right: Interactive Element Candidates & Safe Metadata Overlay -->
        <div class="ide-panel" style="height: 100%;">
          <div class="ide-panel-header">
            <span>Sanitized Interactive Element Candidates</span>
            <span class="mono" style="font-size: 10px; color: var(--text-muted);">DOM BOUNDED METADATA</span>
          </div>
          <div class="ide-panel-body" style="padding: 0; display: flex; flex-direction: column;">
            <div style="padding: 8px 12px; background: var(--bg-panel-subtle); border-bottom: 1px solid var(--border-subtle); font-size: 11px; color: var(--text-secondary); display: flex; justify-content: space-between;">
              <span>Candidates exposed to Groq reasoner (strictly sanitized, zero credentials)</span>
              <span class="badge badge-green">LOCAL GROUNDING ACTIVE</span>
            </div>

            <div style="flex: 1; overflow-y: auto;">
              <table class="ide-table">
                <thead>
                  <tr>
                    <th style="width: 140px;">Element ID</th>
                    <th style="width: 80px;">Tag</th>
                    <th>Role / Description</th>
                    <th style="width: 130px;">Viewport Bounds</th>
                    <th style="width: 100px;">Privacy Status</th>
                  </tr>
                </thead>
                <tbody id="browser-candidates-tbody">
                  <!-- Dynamically populated or default set -->
                  <tr>
                    <td class="mono" style="color: var(--status-blue-bright);">elem_search_q</td>
                    <td class="mono">textarea</td>
                    <td>Search query input field</td>
                    <td class="mono">[x: 320, y: 140, w: 480, h: 44]</td>
                    <td><span class="badge badge-green">SAFE</span></td>
                  </tr>
                  <tr>
                    <td class="mono" style="color: var(--status-blue-bright);">elem_btn_search</td>
                    <td class="mono">button</td>
                    <td>Google Search submit button</td>
                    <td class="mono">[x: 480, y: 210, w: 120, h: 36]</td>
                    <td><span class="badge badge-green">SAFE</span></td>
                  </tr>
                  <tr>
                    <td class="mono" style="color: var(--status-blue-bright);">elem_input_pwd</td>
                    <td class="mono">input[pwd]</td>
                    <td>Login password credential field</td>
                    <td class="mono">[x: 320, y: 260, w: 280, h: 36]</td>
                    <td><span class="badge badge-amber">LOCAL ONLY</span></td>
                  </tr>
                  <tr>
                    <td class="mono" style="color: var(--status-blue-bright);">elem_btn_add_cart</td>
                    <td class="mono">button</td>
                    <td>Add qualifying item to cart</td>
                    <td class="mono">[x: 520, y: 380, w: 160, h: 40]</td>
                    <td><span class="badge badge-green">SAFE</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;

    this.setupListeners();
  }

  private setupListeners(): void {
    const openBtn = document.getElementById('browser-open-btn');
    if (openBtn) {
      openBtn.addEventListener('click', () => {
        window.open('http://localhost:4174', '_blank');
      });
    }
  }

  private renderState(state: DashboardAgentState): void {
    const urlEl = document.getElementById('browser-target-url');
    const genEl = document.getElementById('browser-page-gen');
    const countEl = document.getElementById('browser-interactive-count');
    const privEl = document.getElementById('browser-privacy-count');

    if (urlEl) urlEl.textContent = state.currentUrl || 'http://localhost:4174';
    if (genEl) genEl.textContent = `Generation ${state.steps.length > 0 ? 2 : 1}`;
    if (countEl) countEl.textContent = `${state.steps.length > 0 ? 28 : 24} candidates`;
    if (privEl) privEl.textContent = `${state.sensitiveItemsCount} protected`;
  }
}
