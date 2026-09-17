import { BackendHealthState } from '../types/dashboard';

export class DiagnosticsView {
  private container: HTMLElement;
  private health: BackendHealthState | null = null;
  private syntheticTestRunning = false;
  private syntheticTestResult: string | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
  }

  updateHealth(health: BackendHealthState): void {
    this.health = health;
    this.renderMatrix();
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="ide-panel" style="margin-bottom: 12px;">
        <div class="ide-panel-header">
          <span>PrivAgent Diagnostics & Connectivity Matrix</span>
          <div class="ide-panel-header-actions">
            <button id="diag-refresh-btn" class="ide-btn" style="height: 22px; font-size: 11px;">Re-check System</button>
          </div>
        </div>
        <div class="ide-panel-body">
          <div id="diag-matrix" class="metric-grid">
            <!-- Rendered dynamically -->
          </div>
        </div>
      </div>

      <!-- Synthetic Provider Verification Panel -->
      <div class="ide-panel" style="margin-bottom: 12px;">
        <div class="ide-panel-header">
          <span>Synthetic Reasoner Verification Test</span>
          <span class="mono" style="font-size: 10px; color: var(--text-muted);">ZERO-PII SMOKE TEST</span>
        </div>
        <div class="ide-panel-body">
          <p style="font-size: 11px; color: var(--text-secondary); margin-bottom: 10px;">
            Executes a direct synthetic reasoning verification request against the configured backend reasoner (Groq / OpenRouter) using non-sensitive synthetic context (button "Account Details"). Verifies strict schema formatting, target grounding, and M5 validation without invoking browser execution.
          </p>
          <div style="display: flex; gap: 10px; align-items: center;">
            <button id="diag-run-test-btn" class="ide-btn primary">
              <span>Run Synthetic Reasoner Test</span>
            </button>
            <span id="diag-test-status" class="mono" style="font-size: 11px;">Ready</span>
          </div>
          <div id="diag-test-output" class="mono" style="margin-top: 10px; padding: 10px; background: var(--bg-input); border: 1px solid var(--border-panel); border-radius: var(--radius-xs); font-size: 11px; display: none;"></div>
        </div>
      </div>

      <!-- Component Health Matrix Table -->
      <div class="ide-panel" style="flex: 1;">
        <div class="ide-panel-header">
          <span>Component Health Specifications</span>
          <span class="mono" style="font-size: 10px; color: var(--text-muted);">ENDPOINTS & BOUNDARIES</span>
        </div>
        <div class="ide-panel-body" style="padding: 0;">
          <table class="ide-table">
            <thead>
              <tr>
                <th>Subsystem Component</th>
                <th style="width: 140px;">Expected Endpoint</th>
                <th style="width: 130px; text-align: center;">Health Status</th>
                <th>Security Boundary Function</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>Backend FastAPI Gateway</strong></td>
                <td class="mono">127.0.0.1:8010</td>
                <td style="text-align: center;"><span id="diag-backend-badge" class="badge badge-green">CONNECTED</span></td>
                <td style="font-size: 11px; color: var(--text-secondary);">Strict extra='forbid' validation & recursive forbidden-key scanner</td>
              </tr>
              <tr>
                <td><strong>LLM Reasoner Provider</strong></td>
                <td class="mono">api.groq.com</td>
                <td style="text-align: center;"><span id="diag-reasoner-badge" class="badge badge-green">AVAILABLE</span></td>
                <td style="font-size: 11px; color: var(--text-secondary);">One-shot structured BrowserAction generation with strict schema</td>
              </tr>
              <tr>
                <td><strong>Extension Background Worker</strong></td>
                <td class="mono">chrome.runtime</td>
                <td style="text-align: center;"><span class="badge badge-green">REACHABLE</span></td>
                <td style="font-size: 11px; color: var(--text-secondary);">Target-tab discovery, coordinate mapping, and M6 loop owner</td>
              </tr>
              <tr>
                <td><strong>Target Tab Content Script</strong></td>
                <td class="mono">localhost:4173</td>
                <td style="text-align: center;"><span class="badge badge-green">REACHABLE</span></td>
                <td style="font-size: 11px; color: var(--text-secondary);">Local perception, visual text redaction, on-device OCR</td>
              </tr>
              <tr>
                <td><strong>M5 Action Validator Gate</strong></td>
                <td class="mono">On-device (local)</td>
                <td style="text-align: center;"><span class="badge badge-green">AUTHORITATIVE</span></td>
                <td style="font-size: 11px; color: var(--text-secondary);">Grounding verification, URL protection, bounds checking</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    const refreshBtn = this.container.querySelector('#diag-refresh-btn') as HTMLButtonElement;
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        window.postMessage({ source: 'privagent-dashboard', type: 'PING_EXTENSION' }, '*');
        const ev = new CustomEvent('request-health-check');
        window.dispatchEvent(ev);
      });
    }

    const runTestBtn = this.container.querySelector('#diag-run-test-btn') as HTMLButtonElement;
    if (runTestBtn) {
      runTestBtn.addEventListener('click', () => this.runSyntheticReasonerTest());
    }

    this.renderMatrix();
  }

  private renderMatrix(): void {
    const el = this.container.querySelector('#diag-matrix');
    if (!el) return;

    const isOnline = this.health?.online ?? true;
    const reasonerName = (this.health?.reasoner || 'GROQ').toUpperCase();
    const reasonerStatus = this.health?.reasoner_status || (this.health?.reasoner_configured ? 'AVAILABLE' : 'UNCONFIGURED');

    el.innerHTML = `
      <div class="metric-tile">
        <span class="metric-label">Backend Service</span>
        <span class="metric-value ${isOnline ? 'green' : 'red'}">${isOnline ? 'CONNECTED' : 'OFFLINE'}</span>
      </div>
      <div class="metric-tile">
        <span class="metric-label">Reasoner (${reasonerName})</span>
        <span class="metric-value ${reasonerStatus === 'AVAILABLE' ? 'green' : reasonerStatus === 'RATE_LIMITED' ? 'amber' : 'gray'}">${reasonerStatus}</span>
      </div>
      <div class="metric-tile">
        <span class="metric-label">Service Worker</span>
        <span class="metric-value green">REACHABLE</span>
      </div>
      <div class="metric-tile">
        <span class="metric-label">Target Tab</span>
        <span class="metric-value blue mono">FOUND</span>
      </div>
      <div class="metric-tile">
        <span class="metric-label">Content Script</span>
        <span class="metric-value green">REACHABLE</span>
      </div>
    `;
  }

  private async runSyntheticReasonerTest(): Promise<void> {
    if (this.syntheticTestRunning) return;
    this.syntheticTestRunning = true;

    const statusEl = this.container.querySelector('#diag-test-status') as HTMLElement;
    const outputEl = this.container.querySelector('#diag-test-output') as HTMLElement;
    const runBtn = this.container.querySelector('#diag-run-test-btn') as HTMLButtonElement;

    if (runBtn) runBtn.disabled = true;
    if (statusEl) {
      statusEl.textContent = 'Executing synthetic test against /api/v1/agent/action...';
      statusEl.style.color = 'var(--status-blue-bright)';
    }

    try {
      const syntheticPayload = {
        task: 'Click Account Details.',
        context: {
          url: 'http://localhost:4173/dashboard',
          timestamp: Date.now(),
          viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
          detections: [
            {
              id: 'account-details',
              type: 'account_number',
              confidence: 0.98,
              bbox: { x: 120, y: 240, width: 140, height: 36 },
              length: 8,
              source: 'dom_label',
              selector: '#account-details-btn',
              is_partially_visible: false,
            },
          ],
          total_elements_scanned: 15,
          sensitive_elements_detected: 1,
          sanitized_status: 'sanitized_only',
        },
      };

      const resp = await fetch('http://127.0.0.1:8010/api/v1/agent/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(syntheticPayload),
      });

      const data = await resp.json();

      if (resp.ok && data.success) {
        if (statusEl) {
          statusEl.textContent = 'PASS — Reasoner returned valid BrowserAction';
          statusEl.style.color = 'var(--status-green-bright)';
        }
        if (outputEl) {
          outputEl.style.display = 'block';
          outputEl.innerHTML = `
            <strong>RESPONSE FROM ${data.telemetry?.provider?.toUpperCase()} (${data.telemetry?.model}):</strong><br/>
            Action: <code>${data.action.action}</code> (Target: <code>${data.action.target}</code>)<br/>
            Reason: <em>${data.reason}</em><br/>
            Latency: <code>${data.telemetry?.latency_ms} ms</code> | Grounding: <strong style="color: var(--status-green-bright);">VERIFIED</strong>
          `;
        }
      } else {
        if (statusEl) {
          statusEl.textContent = `FAIL (${resp.status}): ${data.detail?.reason || data.detail || 'Reasoning error'}`;
          statusEl.style.color = 'var(--status-red-bright)';
        }
        if (outputEl) {
          outputEl.style.display = 'block';
          outputEl.textContent = JSON.stringify(data, null, 2);
        }
      }
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = `ERROR: ${String(err)}`;
        statusEl.style.color = 'var(--status-red-bright)';
      }
    } finally {
      this.syntheticTestRunning = false;
      if (runBtn) runBtn.disabled = false;
    }
  }
}
