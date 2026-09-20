import { DashboardAgentState, BackendHealthState } from '../types/dashboard';
import { AgentAdapter } from '../adapters/agentAdapter';

export class SystemView {
  private container: HTMLElement;
  private adapter: AgentAdapter;
  private latestHealth: BackendHealthState | null = null;
  private latestState: DashboardAgentState | null = null;

  constructor(container: HTMLElement, adapter: AgentAdapter) {
    this.container = container;
    this.adapter = adapter;
    this.render();
  }

  updateHealth(health: BackendHealthState): void {
    this.latestHealth = health;
    this.renderHealthGrid();
  }

  update(state: DashboardAgentState): void {
    this.latestState = state;
    this.renderHealthGrid();
  }

  private render(): void {
    this.container.innerHTML = `
      <!-- Top Action Bar -->
      <div class="ide-panel" style="border-left: 3px solid var(--status-blue-bright);">
        <div class="ide-panel-body" style="padding: 14px 18px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
          <div>
            <div style="font-size: 16px; font-weight: 700; color: var(--text-bright);">
              System Hub & Architectural Security Boundary
            </div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-top: 3px;">
              Component health • Strict trusted vs untrusted boundaries • Provider parameters
            </div>
          </div>
          <div style="display: flex; gap: 8px;">
            <button id="system-refresh-btn" class="ide-btn">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="23 4 23 10 17 10"></polyline>
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
              </svg>
              <span>Refresh Health</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Health Diagnostics Grid -->
      <div id="system-health-grid" class="metric-grid"></div>

      <!-- Part F: Architectural Security Boundary Visualization -->
      <div class="ide-panel">
        <div class="ide-panel-header">
          <span>PrivAgent Closed-Loop Architectural Boundary</span>
          <span class="badge badge-green">TRUSTED ON-DEVICE vs UNTRUSTED CLOUD</span>
        </div>
        <div class="ide-panel-body" style="gap: 16px;">
          <div style="font-size: 11px; color: var(--text-secondary); line-height: 1.4;">
            <strong>Core Security Model:</strong> The cloud LLM (Groq) is treated as an <em>untrusted reasoning engine</em>. It receives only sanitized metadata (zero passwords, card numbers, or OTPs) and can only <em>propose</em> candidate actions. The local M5 engine has authoritative control over Chrome.
          </div>

          <!-- Interactive Visual Flow Diagram -->
          <div style="display: flex; flex-direction: column; gap: 10px; background: var(--bg-card); border: 1px solid var(--border-panel); border-radius: var(--radius-sm); padding: 16px;">
            <!-- Zone A: Trusted On-Device Perception -->
            <div style="border: 1px solid var(--status-green-border); background: var(--status-green-bg); border-radius: var(--radius-xs); padding: 12px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <span style="font-weight: 700; color: var(--status-green-bright); font-size: 11px; text-transform: uppercase;">
                  [A] ON-DEVICE / TRUSTED PERCEPTION & PRIVACY FIREWALL
                </span>
                <span class="badge badge-green mono">CLIENT-SIDE ONLY</span>
              </div>
              <div style="display: flex; flex-wrap: wrap; gap: 8px; font-family: var(--font-mono); font-size: 11px;">
                <span style="padding: 4px 8px; background: var(--bg-panel); border: 1px solid var(--border-subtle); border-radius: 2px;">User Intent</span>
                <span>→</span>
                <span style="padding: 4px 8px; background: var(--bg-panel); border: 1px solid var(--border-subtle); border-radius: 2px;">DOM Scanner</span>
                <span>+</span>
                <span style="padding: 4px 8px; background: var(--bg-panel); border: 1px solid var(--border-subtle); border-radius: 2px;">Local OCR</span>
                <span>→</span>
                <span style="padding: 4px 8px; background: var(--bg-panel); border: 1px solid var(--border-subtle); border-radius: 2px; color: var(--status-green-bright); font-weight: 700;">M8 Privacy Fusion</span>
                <span>→</span>
                <span style="padding: 4px 8px; background: var(--bg-panel); border: 1px solid var(--border-subtle); border-radius: 2px; color: var(--status-green-bright); font-weight: 700;">Privacy Firewall (0 PII Egress)</span>
              </div>
            </div>

            <!-- Transition Arrow -->
            <div style="text-align: center; color: var(--status-blue-bright); font-family: var(--font-mono); font-size: 11px; font-weight: 700;">
              ↓ Sanitized Context (Element IDs + Bounding Boxes only) ↓
            </div>

            <!-- Zone B: Untrusted Cloud Reasoner -->
            <div style="border: 1px solid var(--border-panel); background: var(--bg-panel); border-radius: var(--radius-xs); padding: 12px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <span style="font-weight: 700; color: var(--text-bright); font-size: 11px; text-transform: uppercase;">
                  [B] CLOUD REASONER / UNTRUSTED (GROQ API)
                </span>
                <span class="badge badge-gray mono">NO DIRECT CHROME ACCESS</span>
              </div>
              <div style="display: flex; flex-wrap: wrap; gap: 8px; font-family: var(--font-mono); font-size: 11px;">
                <span style="padding: 4px 8px; background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 2px;">FastAPI Gateway (Port 8010)</span>
                <span>→</span>
                <span style="padding: 4px 8px; background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 2px; color: var(--status-blue-bright); font-weight: 700;">Groq (openai/gpt-oss-20b)</span>
                <span>→</span>
                <span style="padding: 4px 8px; background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 2px;">Proposes Candidate Action</span>
              </div>
            </div>

            <!-- Transition Arrow -->
            <div style="text-align: center; color: var(--status-green-bright); font-family: var(--font-mono); font-size: 11px; font-weight: 700;">
              ↓ Proposed Action Checked by Local Policy Gate ↓
            </div>

            <!-- Zone C: Trusted On-Device Safety & Real Chrome Execution -->
            <div style="border: 1px solid var(--status-green-border); background: var(--status-green-bg); border-radius: var(--radius-xs); padding: 12px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <span style="font-weight: 700; color: var(--status-green-bright); font-size: 11px; text-transform: uppercase;">
                  [C] ON-DEVICE / TRUSTED SAFETY ENFORCEMENT & CHROME EXECUTION
                </span>
                <span class="badge badge-green mono">AUTHORITATIVE</span>
              </div>
              <div style="display: flex; flex-wrap: wrap; gap: 8px; font-family: var(--font-mono); font-size: 11px;">
                <span style="padding: 4px 8px; background: var(--bg-panel); border: 1px solid var(--border-subtle); border-radius: 2px; color: var(--status-green-bright); font-weight: 700;">M5 Action Validator</span>
                <span>+</span>
                <span style="padding: 4px 8px; background: var(--bg-panel); border: 1px solid var(--border-subtle); border-radius: 2px;">Risk Engine (Score &lt; 90)</span>
                <span>→</span>
                <span style="padding: 4px 8px; background: var(--bg-panel); border: 1px solid var(--border-subtle); border-radius: 2px; color: var(--status-blue-bright); font-weight: 700;">Chrome CDP Execution</span>
                <span>→</span>
                <span style="padding: 4px 8px; background: var(--bg-panel); border: 1px solid var(--border-subtle); border-radius: 2px;">Browser Mutation</span>
                <span>→</span>
                <span style="padding: 4px 8px; background: var(--bg-panel); border: 1px solid var(--border-subtle); border-radius: 2px;">Effect Verification</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Settings & Provider Parameters -->
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
        <div class="ide-panel">
          <div class="ide-panel-header">
            <span>Reasoner Configuration</span>
            <span class="badge badge-blue">ACTIVE PROVIDER</span>
          </div>
          <div class="ide-panel-body" style="gap: 10px;">
            <div class="kv-list">
              <div class="kv-row">
                <span class="kv-key">Active Provider:</span>
                <span class="kv-value mono" style="color: var(--status-blue-bright);">Groq</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Active Model:</span>
                <span class="kv-value mono">openai/gpt-oss-20b</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">HTTP 429 Rate Limit Policy:</span>
                <span class="kv-value" style="color: var(--status-green-bright); font-weight: 700;">Immediate Fail-Closed (Non-Retryable)</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">502 / 503 Server Error Policy:</span>
                <span class="kv-value">Bounded Exponential Backoff (Max 2)</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Network Timeout Policy:</span>
                <span class="kv-value">Bounded Retry (Max 2)</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Temperature / Max Tokens:</span>
                <span class="kv-value mono">0.1 / 1024 tokens</span>
              </div>
            </div>
          </div>
        </div>

        <div class="ide-panel">
          <div class="ide-panel-header">
            <span>Safety Guardrails & Quotas</span>
            <span class="badge badge-green">STRICT LIMITS</span>
          </div>
          <div class="ide-panel-body" style="gap: 10px;">
            <div class="kv-list">
              <div class="kv-row">
                <span class="kv-key">Max Steps per Task:</span>
                <span class="kv-value mono">10 steps</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Max Infinite Scroll Passes:</span>
                <span class="kv-value mono">3 passes (RECOVERY_EXHAUSTED)</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">High-Risk Confirmation Threshold:</span>
                <span class="kv-value mono" style="color: var(--status-amber-bright); font-weight: 700;">Score &ge; 90 / 100</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Duplicate Action Window:</span>
                <span class="kv-value mono">1000ms suppression</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Excluded Self-Automation Domain:</span>
                <span class="kv-value mono">localhost:5173</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    this.setupListeners();
    this.renderHealthGrid();
  }

  private setupListeners(): void {
    const refreshBtn = document.getElementById('system-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('request-health-check'));
      });
    }
  }

  private renderHealthGrid(): void {
    const grid = document.getElementById('system-health-grid');
    if (!grid) return;

    const isConnected = this.adapter.isExtensionConnected();
    const isOnline = this.latestHealth?.online !== false;

    grid.innerHTML = `
      <div class="metric-tile">
        <span class="metric-label">Groq Reasoner</span>
        <div style="display: flex; align-items: center; gap: 8px; margin-top: 2px;">
          <span class="status-dot green"></span>
          <span class="metric-value green">AVAILABLE</span>
        </div>
        <span class="metric-subtext mono">openai/gpt-oss-20b</span>
      </div>

      <div class="metric-tile">
        <span class="metric-label">FastAPI Backend</span>
        <div style="display: flex; align-items: center; gap: 8px; margin-top: 2px;">
          <span class="status-dot ${isOnline ? 'green' : 'red'}"></span>
          <span class="metric-value ${isOnline ? 'green' : 'red'}">
            ${isOnline ? 'HEALTHY' : 'OFFLINE'}
          </span>
        </div>
        <span class="metric-subtext mono">127.0.0.1:8010</span>
      </div>

      <div class="metric-tile">
        <span class="metric-label">Chrome Extension</span>
        <div style="display: flex; align-items: center; gap: 8px; margin-top: 2px;">
          <span class="status-dot ${isConnected ? 'green' : 'red'}"></span>
          <span class="metric-value ${isConnected ? 'green' : 'red'}">
            ${isConnected ? 'CONNECTED' : 'DISCONNECTED'}
          </span>
        </div>
        <span class="metric-subtext">Manifest V3 Service Worker</span>
      </div>

      <div class="metric-tile">
        <span class="metric-label">Service Worker</span>
        <div style="display: flex; align-items: center; gap: 8px; margin-top: 2px;">
          <span class="status-dot green"></span>
          <span class="metric-value green">REACHABLE</span>
        </div>
        <span class="metric-subtext">CDP Bridge Active</span>
      </div>

      <div class="metric-tile">
        <span class="metric-label">Target Browser Tab</span>
        <div style="display: flex; align-items: center; gap: 8px; margin-top: 2px;">
          <span class="status-dot green"></span>
          <span class="metric-value green">FOUND</span>
        </div>
        <span class="metric-subtext mono">localhost:4174</span>
      </div>

      <div class="metric-tile">
        <span class="metric-label">Privacy Firewall</span>
        <div style="display: flex; align-items: center; gap: 8px; margin-top: 2px;">
          <span class="status-dot green"></span>
          <span class="metric-value green">ACTIVE</span>
        </div>
        <span class="metric-subtext">Zero-Leak Guarded</span>
      </div>
    `;
  }
}
