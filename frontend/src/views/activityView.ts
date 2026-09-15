import { DashboardAgentState } from '../types/dashboard';
import { receiptsStore } from '../state/receiptsStore';

export class ActivityView {
  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="view-header">
        <div class="view-title-group">
          <h2>Agent Activity</h2>
          <p>Real-time execution log and historical browser agent operations trail</p>
        </div>
      </div>

      <div class="activity-container">
        <!-- Current Task Execution Card -->
        <div id="current-task-activity-section" style="margin-bottom: 24px;">
          <h3 style="font-size: 15px; font-weight: 600; color: var(--text-primary); margin-bottom: 12px; display: flex; align-items: center; gap: 8px;">
            <span class="pulse-dot"></span> Active Task Operations
          </h3>
          <div id="current-task-trail" class="activity-trail">
            <div style="color: var(--text-muted); font-size: 13px; padding: 12px 0;">
              No active task currently running. Start a task from the Agent tab.
            </div>
          </div>
        </div>

        <!-- Previous Completed Tasks -->
        <div>
          <h3 style="font-size: 15px; font-weight: 600; color: var(--text-primary); margin-bottom: 12px;">
            Historical Task Executions
          </h3>
          <div id="previous-task-list" class="activity-trail"></div>
        </div>
      </div>
    `;

    this.renderHistorical();
  }

  update(state: DashboardAgentState): void {
    const currentSection = this.container.querySelector('#current-task-trail');
    if (!currentSection) return;

    if (state.status === 'RUNNING' || (state.steps.length > 0 && state.status !== 'IDLE')) {
      currentSection.innerHTML = `
        <div class="activity-item success">
          <div class="activity-dot">●</div>
          <div class="activity-card">
            <div class="activity-top">
              <span class="activity-action-name">${escapeHtml(state.task)}</span>
              <span class="activity-time">${state.status}</span>
            </div>
            <div class="activity-detail">
              ${state.steps
                .map(
                  (s) => `
                <div style="margin-top: 6px; display: flex; align-items: center; gap: 8px;">
                  <span style="color: ${s.executionSuccess ? 'var(--shield-green)' : 'var(--danger-red)'}; font-size: 11px;">
                    ${s.executionSuccess ? '✓' : '✗'}
                  </span>
                  <span>Step ${s.step}: <strong>${escapeHtml(s.actionType)}</strong> on ${escapeHtml(s.targetDescription)}</span>
                  ${
                    s.sensitiveCategoryDetected
                      ? `<span class="category-pill detected" style="padding: 1px 6px; font-size: 10px;">Protected: ${escapeHtml(s.sensitiveCategoryDetected)}</span>`
                      : ''
                  }
                </div>
              `
                )
                .join('')}
            </div>
          </div>
        </div>
      `;
    } else {
      currentSection.innerHTML = `
        <div style="color: var(--text-muted); font-size: 13px; padding: 8px 0;">
          No task currently active. Enter a prompt in the Agent tab to begin.
        </div>
      `;
    }

    this.renderHistorical();
  }

  private renderHistorical(): void {
    const prevSection = this.container.querySelector('#previous-task-list');
    if (!prevSection) return;

    const receipts = receiptsStore.getAll();
    if (receipts.length === 0) {
      prevSection.innerHTML = `
        <div style="color: var(--text-muted); font-size: 13px; padding: 12px 0;">
          No completed historical operations recorded.
        </div>
      `;
      return;
    }

    prevSection.innerHTML = receipts
      .map(
        (r) => `
      <div class="activity-item ${r.result === 'SUCCESS' ? 'success' : 'blocked'}">
        <div class="activity-dot">${r.result === 'SUCCESS' ? '✓' : '⚠'}</div>
        <div class="activity-card">
          <div class="activity-top">
            <span class="activity-action-name">${escapeHtml(r.task)}</span>
            <span class="activity-time">${new Date(r.timestamp).toLocaleTimeString()}</span>
          </div>
          <div class="activity-detail">
            ${r.steps
              .map(
                (s) => `
              <div style="margin-top: 4px; font-size: 12px; display: flex; align-items: center; gap: 6px;">
                <span style="color: ${s.executionSuccess ? 'var(--shield-green)' : 'var(--danger-red)'};">
                  ${s.executionSuccess ? '✓' : '✗'}
                </span>
                <span>${escapeHtml(s.actionType)} — ${escapeHtml(s.targetDescription)}</span>
              </div>
            `
              )
              .join('')}
          </div>
        </div>
      </div>
    `
      )
      .join('');
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
