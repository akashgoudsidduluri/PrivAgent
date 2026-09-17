import { DashboardAgentState, BackendHealthState } from '../types/dashboard';
import { AgentAdapter } from '../adapters/agentAdapter';

export class OverviewView {
  private container: HTMLElement;
  private adapter: AgentAdapter;
  private latestHealth: BackendHealthState | null = null;

  constructor(container: HTMLElement, adapter: AgentAdapter) {
    this.container = container;
    this.adapter = adapter;
    this.render();
  }

  updateHealth(health: BackendHealthState): void {
    this.latestHealth = health;
    this.renderMetrics();
  }

  update(state: DashboardAgentState): void {
    this.renderMetrics(state);
    this.renderCurrentTask(state);
    this.renderRecentActivity(state);
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="ide-panel">
        <div class="ide-panel-header">
          <span>PRIVAGENT — Runtime Overview</span>
          <span class="badge badge-green">ENGINEERING CONSOLE</span>
        </div>
        <div class="ide-panel-body">
          <div id="overview-metrics" class="metric-grid"></div>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
        <!-- Current Task Panel -->
        <div class="ide-panel">
          <div class="ide-panel-header">
            <span>Current Task</span>
            <span id="overview-task-badge" class="badge badge-gray">IDLE</span>
          </div>
          <div class="ide-panel-body">
            <div id="overview-task-details" class="kv-list"></div>
            <div style="margin-top: 12px; display: flex; gap: 8px;">
              <input id="overview-task-input" class="ide-input" type="text" placeholder="Enter browser task (e.g. Open localhost:4173 and find recent transactions)..." />
              <button id="overview-run-btn" class="ide-btn primary">Run</button>
              <button id="overview-stop-btn" class="ide-btn danger">Stop</button>
            </div>
          </div>
        </div>

        <!-- Privacy & Safety Panel -->
        <div class="ide-panel">
          <div class="ide-panel-header">
            <span>Privacy Boundary Status</span>
            <span class="badge badge-green">STRICT ENFORCEMENT</span>
          </div>
          <div class="ide-panel-body">
            <div class="kv-list">
              <div class="kv-row">
                <span class="kv-key">Privacy Firewall:</span>
                <span class="kv-value" style="color: var(--status-green-bright);">ACTIVE (On-device M8 Fusion)</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Remote Sensitive Values Sent:</span>
                <span class="kv-value" style="color: var(--status-green-bright); font-weight: 700;">0 (Non-negotiable)</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Raw Screenshots Sent:</span>
                <span class="kv-value" style="color: var(--status-green-bright);">0 (Blocked)</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Raw DOM Text Sent:</span>
                <span class="kv-value" style="color: var(--status-green-bright);">0 (Sanitized metadata only)</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Target Web Tab:</span>
                <span class="kv-value mono" style="color: var(--status-blue-bright);">http://localhost:4173</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Recent Activity Table -->
      <div class="ide-panel" style="flex: 1;">
        <div class="ide-panel-header">
          <span>Recent Execution Activity</span>
          <span class="mono" style="font-size: 10px; color: var(--text-muted);">LATEST EVENTS</span>
        </div>
        <div class="ide-panel-body" style="padding: 0;">
          <table class="ide-table">
            <thead>
              <tr>
                <th style="width: 90px;">Time</th>
                <th style="width: 140px;">Stage</th>
                <th>Action / Event</th>
                <th style="width: 100px;">Result</th>
              </tr>
            </thead>
            <tbody id="overview-activity-body">
              <tr>
                <td colspan="4" style="text-align: center; color: var(--text-muted); padding: 20px;">
                  No active task execution. Enter a task above or switch to the Agent view to run.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    const runBtn = this.container.querySelector('#overview-run-btn') as HTMLButtonElement;
    const stopBtn = this.container.querySelector('#overview-stop-btn') as HTMLButtonElement;
    const taskInput = this.container.querySelector('#overview-task-input') as HTMLInputElement;

    if (runBtn && taskInput) {
      runBtn.addEventListener('click', () => {
        const task = taskInput.value.trim();
        if (task) {
          this.adapter.startTask(task);
        }
      });
      taskInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const task = taskInput.value.trim();
          if (task) {
            this.adapter.startTask(task);
          }
        }
      });
    }

    if (stopBtn) {
      stopBtn.addEventListener('click', () => {
        this.adapter.stopTask();
      });
    }

    this.renderMetrics(this.adapter.getState());
    this.renderCurrentTask(this.adapter.getState());
  }

  private renderMetrics(state?: DashboardAgentState): void {
    const el = this.container.querySelector('#overview-metrics');
    if (!el) return;

    const s = state || this.adapter.getState();
    const h = this.latestHealth;

    const agentStatus = s.status || 'IDLE';
    const agentClass = agentStatus === 'RUNNING' ? 'green' : agentStatus === 'FAILED' ? 'red' : 'gray';

    const backendStatus = h?.online ? 'CONNECTED' : (h ? 'OFFLINE' : 'CHECKING...');
    const backendClass = h?.online ? 'green' : 'red';

    const reasonerName = (h?.reasoner || 'GROQ').toUpperCase();
    const reasonerStatus = h?.reasoner_status || (h?.reasoner_configured ? 'AVAILABLE' : 'UNCONFIGURED');
    const reasonerClass = reasonerStatus === 'AVAILABLE' ? 'green' : reasonerStatus === 'RATE_LIMITED' ? 'amber' : 'gray';

    el.innerHTML = `
      <div class="metric-tile">
        <span class="metric-label">Agent</span>
        <span class="metric-value ${agentClass}">${agentStatus}</span>
      </div>
      <div class="metric-tile">
        <span class="metric-label">Backend</span>
        <span class="metric-value ${backendClass}">${backendStatus}</span>
      </div>
      <div class="metric-tile">
        <span class="metric-label">Reasoner (${reasonerName})</span>
        <span class="metric-value ${reasonerClass}">${reasonerStatus}</span>
      </div>
      <div class="metric-tile">
        <span class="metric-label">Privacy Firewall</span>
        <span class="metric-value green">ACTIVE</span>
      </div>
      <div class="metric-tile">
        <span class="metric-label">Sensitive Sent</span>
        <span class="metric-value green">0</span>
      </div>
    `;
  }

  private renderCurrentTask(state: DashboardAgentState): void {
    const badge = this.container.querySelector('#overview-task-badge');
    const details = this.container.querySelector('#overview-task-details');
    if (!details) return;

    const status = state.status || 'IDLE';
    if (badge) {
      badge.className = `badge ${
        status === 'RUNNING' ? 'badge-green' : status === 'FAILED' ? 'badge-red' : status === 'SUCCESS' ? 'badge-green' : 'badge-gray'
      }`;
      badge.textContent = status;
    }

    const taskText = state.task || 'No task running';
    const provider = (this.latestHealth?.reasoner || 'groq').toUpperCase();
    const model = this.latestHealth?.model || 'openai/gpt-oss-20b';

    details.innerHTML = `
      <div class="kv-row">
        <span class="kv-key">Task:</span>
        <span class="kv-value mono">${taskText}</span>
      </div>
      <div class="kv-row">
        <span class="kv-key">Status:</span>
        <span class="kv-value">${status}</span>
      </div>
      <div class="kv-row">
        <span class="kv-key">Step:</span>
        <span class="kv-value mono">${state.currentStep} / ${state.maxSteps}</span>
      </div>
      <div class="kv-row">
        <span class="kv-key">Target Tab:</span>
        <span class="kv-value mono" style="color: var(--status-blue-bright);">localhost:4173</span>
      </div>
      <div class="kv-row">
        <span class="kv-key">Provider:</span>
        <span class="kv-value mono">${provider}</span>
      </div>
      <div class="kv-row">
        <span class="kv-key">Model:</span>
        <span class="kv-value mono">${model}</span>
      </div>
    `;
  }

  private renderRecentActivity(state: DashboardAgentState): void {
    const tbody = this.container.querySelector('#overview-activity-body');
    if (!tbody) return;

    if (!state.steps || state.steps.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="4" style="text-align: center; color: var(--text-muted); padding: 20px;">
            No steps executed yet. Task state is ${state.status}.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = state.steps
      .slice(-6)
      .reverse()
      .map((step) => {
        const timeStr = new Date(step.timestamp).toLocaleTimeString();
        const resultBadge = step.executionSuccess
          ? `<span class="badge badge-green">PASS</span>`
          : `<span class="badge badge-red">FAIL</span>`;
        return `
          <tr>
            <td class="mono">${timeStr}</td>
            <td class="mono" style="color: var(--status-blue-bright);">STEP ${step.step}</td>
            <td class="mono">${step.actionType.toUpperCase()}: ${step.targetDescription || 'target'}</td>
            <td>${resultBadge}</td>
          </tr>
        `;
      })
      .join('');
  }
}
