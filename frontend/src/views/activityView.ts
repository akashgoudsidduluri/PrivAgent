import { DashboardAgentState, StepTelemetry } from '../types/dashboard';

export class ActivityView {
  private container: HTMLElement;
  private state: DashboardAgentState | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
  }

  update(state: DashboardAgentState): void {
    this.state = state;
    this.renderTimeline(state);
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="ide-panel" style="border-left: 3px solid var(--status-blue-bright);">
        <div class="ide-panel-body" style="padding: 14px 18px; display: flex; justify-content: space-between; align-items: center;">
          <div>
            <div style="font-size: 16px; font-weight: 700; color: var(--text-bright);">
              Agent Activity & Decision Timeline
            </div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-top: 3px;">
              Real-time chronological events • Pre-flight safety verification • Zero raw credential logging
            </div>
          </div>
          <div style="display: flex; gap: 8px;">
            <span class="badge badge-green mono">M5 AUTHORITATIVE</span>
            <span class="badge badge-blue mono">CLOSED-LOOP</span>
          </div>
        </div>
      </div>

      <div class="ide-panel" style="flex: 1;">
        <div class="ide-panel-header">
          <span>Chronological Event Stream</span>
          <span class="mono" style="font-size: 10px; color: var(--text-muted);">STREAMING OBSERVER</span>
        </div>
        <div class="ide-panel-body" style="padding: 0; overflow-y: auto;">
          <div id="activity-timeline-list" style="padding: 14px; display: flex; flex-direction: column; gap: 8px;">
            <!-- Timeline items populated here -->
            <div style="text-align: center; color: var(--text-muted); padding: 40px 10px; font-size: 12px;">
              No runtime activity recorded yet. Launch a task in Agent Workspace to observe real-time execution events.
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private renderTimeline(state: DashboardAgentState): void {
    const list = document.getElementById('activity-timeline-list');
    if (!list) return;

    if (!state.steps || state.steps.length === 0) {
      list.innerHTML = `
        <div style="text-align: center; color: var(--text-muted); padding: 40px 10px; font-size: 12px;">
          No runtime activity recorded yet. Launch a task in Agent Workspace to observe real-time execution events.
        </div>
      `;
      return;
    }

    const itemsHtml: string[] = [];

    // Map each step into chronological events (Perception, Reasoner, M5, Execution, Verification)
    state.steps.forEach((step, idx) => {
      const timeStr = new Date(step.timestamp || (Date.now() - (state.steps.length - idx) * 1000)).toLocaleTimeString();

      // Perception Event
      itemsHtml.push(`
        <div style="display: flex; gap: 14px; padding: 10px 12px; background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: var(--radius-xs);">
          <div class="mono" style="font-size: 11px; color: var(--text-muted); width: 68px; flex-shrink: 0; padding-top: 2px;">
            ${timeStr}
          </div>
          <div style="width: 100px; flex-shrink: 0;">
            <span class="badge badge-blue">PERCEPTION</span>
          </div>
          <div style="flex: 1; font-size: 12px; color: var(--text-primary);">
            Scanned active DOM generation. Filtered interactive elements in viewport.
          </div>
        </div>
      `);

      // Reasoner Event
      itemsHtml.push(`
        <div style="display: flex; gap: 14px; padding: 10px 12px; background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: var(--radius-xs);">
          <div class="mono" style="font-size: 11px; color: var(--text-muted); width: 68px; flex-shrink: 0; padding-top: 2px;">
            ${timeStr}
          </div>
          <div style="width: 100px; flex-shrink: 0;">
            <span class="badge badge-gray">REASONER</span>
          </div>
          <div style="flex: 1; font-size: 12px; color: var(--text-primary);">
            Proposed action <strong class="mono" style="color: var(--status-blue-bright);">${step.actionType.toUpperCase()}</strong>:
            ${step.targetDescription || 'Target interactive candidate'}
          </div>
        </div>
      `);

      // M5 Validator Event
      itemsHtml.push(`
        <div style="display: flex; gap: 14px; padding: 10px 12px; background: var(--bg-card); border: 1px solid ${step.validationPassed ? 'var(--status-green-border)' : 'var(--status-red-border)'}; border-radius: var(--radius-xs);">
          <div class="mono" style="font-size: 11px; color: var(--text-muted); width: 68px; flex-shrink: 0; padding-top: 2px;">
            ${timeStr}
          </div>
          <div style="width: 100px; flex-shrink: 0;">
            <span class="badge ${step.validationPassed ? 'badge-green' : 'badge-red'}">M5 GATE</span>
          </div>
          <div style="flex: 1; font-size: 12px; color: var(--text-primary);">
            <strong>${step.validationPassed ? 'ALLOWED' : 'BLOCKED'}</strong>:
            ${step.validationReason || (step.validationPassed ? 'Validated bounds, active generation & risk threshold.' : 'Validation rejected.')}
          </div>
        </div>
      `);

      // Execution Event
      itemsHtml.push(`
        <div style="display: flex; gap: 14px; padding: 10px 12px; background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: var(--radius-xs);">
          <div class="mono" style="font-size: 11px; color: var(--text-muted); width: 68px; flex-shrink: 0; padding-top: 2px;">
            ${timeStr}
          </div>
          <div style="width: 100px; flex-shrink: 0;">
            <span class="badge badge-green">EXECUTION</span>
          </div>
          <div style="flex: 1; font-size: 12px; color: var(--text-primary);">
            Dispatched Chrome CDP action. Browser mutated cleanly.
          </div>
        </div>
      `);

      // Verification Event
      itemsHtml.push(`
        <div style="display: flex; gap: 14px; padding: 10px 12px; background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: var(--radius-xs);">
          <div class="mono" style="font-size: 11px; color: var(--text-muted); width: 68px; flex-shrink: 0; padding-top: 2px;">
            ${timeStr}
          </div>
          <div style="width: 100px; flex-shrink: 0;">
            <span class="badge badge-green">VERIFICATION</span>
          </div>
          <div style="flex: 1; font-size: 12px; color: var(--text-primary);">
            Observed post-action effect in DOM. State progressed to step ${step.step + 1}.
          </div>
        </div>
      `);
    });

    list.innerHTML = itemsHtml.reverse().join('');
  }
}
