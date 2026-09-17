import { DashboardAgentState, StepTelemetry } from '../types/dashboard';

export interface ActivityLogEntry {
  time: string;
  source: string;
  stage: string;
  event: string;
  status: 'PASS' | 'PROTECTED' | 'FAIL' | 'RUNNING' | 'INFO';
}

export class ActivityView {
  private container: HTMLElement;
  private logs: ActivityLogEntry[] = [];
  private filterText = '';

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
  }

  update(state: DashboardAgentState): void {
    this.syncFromState(state);
    this.renderTable();
  }

  private syncFromState(state: DashboardAgentState): void {
    if (!state.steps || state.steps.length === 0) return;

    // Build log entries from steps
    const newLogs: ActivityLogEntry[] = [];
    state.steps.forEach((step: StepTelemetry) => {
      const time = new Date(step.timestamp).toLocaleTimeString();

      if (step.sensitiveCategoryDetected) {
        newLogs.push({
          time,
          source: 'Privacy',
          stage: 'M8',
          event: `${step.sensitiveCategoryDetected} detected and masked locally`,
          status: 'PROTECTED',
        });
      }

      newLogs.push({
        time,
        source: 'Reasoner',
        stage: 'Groq',
        event: `Structured action produced: ${step.actionType.toUpperCase()}`,
        status: 'PASS',
      });

      newLogs.push({
        time,
        source: 'Validator',
        stage: 'M5',
        event: `${step.actionType.toUpperCase()} target validated against M4 context`,
        status: step.validationPassed ? 'PASS' : 'FAIL',
      });

      newLogs.push({
        time,
        source: 'Executor',
        stage: 'M6',
        event: `Browser action executed (${step.actionType})`,
        status: step.executionSuccess ? 'PASS' : 'FAIL',
      });
    });

    this.logs = newLogs;
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="ide-panel" style="height: 100%;">
        <div class="ide-panel-header">
          <span>Technical Activity Log Viewer</span>
          <div class="ide-panel-header-actions">
            <input
              id="activity-search-input"
              class="ide-input"
              type="text"
              placeholder="Filter events (e.g. M5, Groq, Privacy)..."
              style="width: 220px; height: 22px; font-size: 11px;"
            />
            <button id="activity-clear-btn" class="ide-btn" style="height: 22px; font-size: 11px;">Clear</button>
          </div>
        </div>
        <div class="ide-panel-body" style="padding: 0; display: flex; flex-direction: column;">
          <table class="ide-table">
            <thead>
              <tr>
                <th style="width: 100px;">Time</th>
                <th style="width: 110px;">Source</th>
                <th style="width: 80px;">Stage</th>
                <th>Event Description</th>
                <th style="width: 110px;">Status</th>
              </tr>
            </thead>
            <tbody id="activity-table-body">
              <tr>
                <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 24px;">
                  No activity events recorded yet. Run a task to view execution logs.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    const searchInput = this.container.querySelector('#activity-search-input') as HTMLInputElement;
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        this.filterText = searchInput.value.toLowerCase().trim();
        this.renderTable();
      });
    }

    const clearBtn = this.container.querySelector('#activity-clear-btn') as HTMLButtonElement;
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        this.logs = [];
        this.renderTable();
      });
    }
  }

  private renderTable(): void {
    const tbody = this.container.querySelector('#activity-table-body');
    if (!tbody) return;

    const filtered = this.filterText
      ? this.logs.filter(
          (l) =>
            l.event.toLowerCase().includes(this.filterText) ||
            l.source.toLowerCase().includes(this.filterText) ||
            l.stage.toLowerCase().includes(this.filterText)
        )
      : this.logs;

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 24px;">
            ${this.logs.length === 0 ? 'No activity events recorded yet.' : 'No events match the active filter.'}
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = filtered
      .slice(-100)
      .reverse()
      .map((entry) => {
        const badgeClass =
          entry.status === 'PASS'
            ? 'badge-green'
            : entry.status === 'PROTECTED'
            ? 'badge-green'
            : entry.status === 'RUNNING'
            ? 'badge-blue'
            : entry.status === 'FAIL'
            ? 'badge-red'
            : 'badge-gray';

        return `
          <tr>
            <td class="mono" style="color: var(--text-dim);">${entry.time}</td>
            <td class="mono" style="color: var(--status-blue-bright); font-weight: 500;">${entry.source}</td>
            <td class="mono">${entry.stage}</td>
            <td class="mono">${entry.event}</td>
            <td><span class="badge ${badgeClass}">${entry.status}</span></td>
          </tr>
        `;
      })
      .join('');
  }
}
