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
    this.renderDetails(state);
  }

  private render(): void {
    this.container.innerHTML = `
      <div style="display: grid; grid-template-columns: 360px 1fr; gap: 12px; height: 100%;">
        <!-- Left: Target Status & Controls -->
        <div class="ide-panel">
          <div class="ide-panel-header">
            <span>Browser Target Controller</span>
            <span class="badge badge-green">BOUNDED</span>
          </div>
          <div class="ide-panel-body" style="display: flex; flex-direction: column; gap: 12px;">
            <div class="kv-list">
              <div class="kv-row">
                <span class="kv-key">Target Web Tab:</span>
                <span class="kv-value mono" style="color: var(--status-blue-bright);">http://localhost:4173</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Dashboard Tab (Self):</span>
                <span class="kv-value mono" style="color: var(--text-muted);">http://localhost:5173 (Excluded)</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Tab Status:</span>
                <span id="browser-tab-status" class="kv-value">
                  <span class="badge badge-green">CONNECTED</span>
                </span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Content Script:</span>
                <span class="kv-value">
                  <span class="badge badge-green">REACHABLE</span>
                </span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Last Perception:</span>
                <span id="browser-last-perception" class="kv-value mono">-</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Scanned Elements:</span>
                <span id="browser-elements-count" class="kv-value mono">34 elements</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Sensitive Findings:</span>
                <span id="browser-sensitive-count" class="kv-value mono" style="color: var(--status-amber-bright);">0 protected</span>
              </div>
            </div>

            <div style="display: flex; flex-direction: column; gap: 6px; margin-top: 10px;">
              <button id="browser-open-target-btn" class="ide-btn primary">Open Target (localhost:4173)</button>
              <button id="browser-refresh-btn" class="ide-btn">Re-check Target Readiness</button>
              <button id="browser-reconnect-btn" class="ide-btn">Ping Extension Service Worker</button>
            </div>

            <div style="margin-top: auto; padding: 10px; background: var(--bg-row-alt); border: 1px solid var(--border-panel); border-radius: var(--radius-xs); font-size: 11px; color: var(--text-secondary);">
              <strong>Target Safety Invariant:</strong> PrivAgent strictly resolves synthetic banking target (<code>localhost:4173</code>) and prevents self-automation of dashboard (<code>localhost:5173</code>).
            </div>
          </div>
        </div>

        <!-- Right: Bounded DOM Inspection & Perception Metadata -->
        <div class="ide-panel">
          <div class="ide-panel-header">
            <span>Target Context & DOM Perception Inspection</span>
            <span class="mono" style="font-size: 10px; color: var(--text-muted);">SANITIZED ONLY</span>
          </div>
          <div class="ide-panel-body" style="padding: 0; display: flex; flex-direction: column;">
            <div style="padding: 8px 12px; background: var(--bg-panel-header); border-bottom: 1px solid var(--border-panel); display: flex; justify-content: space-between; align-items: center; font-size: 11px;">
              <span>Active Target: <strong class="mono" style="color: var(--status-blue-bright);">http://localhost:4173/</strong></span>
              <span class="badge badge-green">0 RAW PII EXPOSED</span>
            </div>

            <div style="flex: 1; overflow-y: auto; padding: 10px;">
              <div style="margin-bottom: 12px; font-size: 11px; color: var(--text-secondary);">
                Structural DOM elements detected during perception (coordinates and allowlisted metadata only):
              </div>
              <table class="ide-table">
                <thead>
                  <tr>
                    <th>Element ID</th>
                    <th>Type / Tag</th>
                    <th>Bounding Box</th>
                    <th>Sanitized Selector</th>
                    <th>Privacy Protection</th>
                  </tr>
                </thead>
                <tbody id="browser-dom-table-body">
                  <tr>
                    <td class="mono">elem_acc_details</td>
                    <td class="mono">button</td>
                    <td class="mono">x: 100, y: 220, w: 140, h: 36</td>
                    <td class="mono">#btn-details</td>
                    <td><span class="badge badge-green">SAFE METADATA</span></td>
                  </tr>
                  <tr>
                    <td class="mono">elem_acc_num</td>
                    <td class="mono">account_number</td>
                    <td class="mono">x: 100, y: 340, w: 200, h: 30</td>
                    <td class="mono">#account-number</td>
                    <td><span class="badge badge-amber">REDACTED LOCALLY</span></td>
                  </tr>
                  <tr>
                    <td class="mono">elem_transactions</td>
                    <td class="mono">button</td>
                    <td class="mono">x: 100, y: 400, w: 160, h: 36</td>
                    <td class="mono">#btn-transactions</td>
                    <td><span class="badge badge-green">SAFE METADATA</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;

    const openBtn = this.container.querySelector('#browser-open-target-btn') as HTMLButtonElement;
    if (openBtn) {
      openBtn.addEventListener('click', () => {
        window.open('http://localhost:4173', '_blank');
      });
    }

    const refreshBtn = this.container.querySelector('#browser-refresh-btn') as HTMLButtonElement;
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        window.postMessage({ source: 'privagent-dashboard', type: 'PING_EXTENSION' }, '*');
      });
    }

    const reconnectBtn = this.container.querySelector('#browser-reconnect-btn') as HTMLButtonElement;
    if (reconnectBtn) {
      reconnectBtn.addEventListener('click', () => {
        window.postMessage({ source: 'privagent-dashboard', type: 'PING_EXTENSION' }, '*');
      });
    }

    this.renderDetails(this.adapter.getState());
  }

  private renderDetails(state: DashboardAgentState): void {
    const lastPerception = this.container.querySelector('#browser-last-perception');
    const sensitiveCount = this.container.querySelector('#browser-sensitive-count');

    if (lastPerception) {
      lastPerception.textContent = new Date().toLocaleTimeString();
    }
    if (sensitiveCount) {
      sensitiveCount.textContent = `${state.sensitiveItemsCount || 0} protected`;
    }
  }
}
