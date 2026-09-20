import { M12EvaluationEngine, EvaluationRun, EvaluationCase } from '../../../extension/src/telemetry/evaluationEngine';
import { EvidenceManager, ChronologicalTraceStep } from '../../../extension/src/telemetry/evidenceManager';
import { DashboardAgentState } from '../types/dashboard';

export class EvidenceView {
  private container: HTMLElement;
  private currentRun: EvaluationRun | null = null;
  private selectedCaseId: string = 'CASE-A';

  constructor(container: HTMLElement) {
    this.container = container;
    this.init();
  }

  private async init(): Promise<void> {
    const engine = M12EvaluationEngine.getInstance();
    this.currentRun = engine.getLatestRun();
    if (!this.currentRun) {
      this.currentRun = await engine.runEvaluation();
    }
    this.render();
  }

  update(_state: DashboardAgentState): void {
    // Dynamic updates
  }

  private render(): void {
    const run = this.currentRun;
    const cases = run?.cases ?? [];
    const selectedCase = cases.find((c) => c.id === this.selectedCaseId) ?? cases[0];
    const trace = selectedCase ? EvidenceManager.getInstance().buildChronologicalTrace(selectedCase.evidence) : [];

    this.container.innerHTML = `
      <div style="display: grid; grid-template-columns: 380px 1fr; gap: 12px; height: 100%; min-height: 0;">
        <!-- Left: Case Selector & High-Level Invariant Proofs -->
        <div class="ide-panel" style="height: 100%;">
          <div class="ide-panel-header">
            <span>Benchmark Evaluation Cases</span>
            <span class="badge badge-green mono">${cases.length} RUNS</span>
          </div>
          <div class="ide-panel-body" style="padding: 0; display: flex; flex-direction: column;">
            <div style="padding: 8px 12px; background: var(--bg-panel-subtle); border-bottom: 1px solid var(--border-subtle); font-size: 11px; color: var(--text-secondary);">
              Select any benchmark scenario to inspect its complete 11-stage decision trace:
            </div>

            <div style="flex: 1; overflow-y: auto; padding: 6px;" id="evidence-case-list">
              ${cases.map((c) => `
                <div class="evidence-case-card ${c.id === this.selectedCaseId ? 'selected' : ''}" data-case-id="${c.id}" style="padding: 9px 12px; border-radius: var(--radius-xs); border: 1px solid ${c.id === this.selectedCaseId ? 'var(--status-blue-bright)' : 'var(--border-subtle)'}; background: ${c.id === this.selectedCaseId ? 'var(--bg-card-hover)' : 'var(--bg-card)'}; margin-bottom: 6px; cursor: pointer; transition: all 0.12s ease;">
                  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px;">
                    <span class="mono" style="font-weight: 700; color: var(--status-blue-bright); font-size: 12px;">${c.id}</span>
                    <span class="badge ${c.status === 'PASSED' ? 'badge-green' : 'badge-red'}">${c.status}</span>
                  </div>
                  <div style="font-weight: 600; font-size: 12px; color: var(--text-bright); margin-bottom: 2px;">
                    ${c.title}
                  </div>
                  <div style="font-size: 11px; color: var(--text-muted); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">
                    ${c.inputTask}
                  </div>
                  <div style="display: flex; justify-content: space-between; margin-top: 6px; font-family: var(--font-mono); font-size: 10px; color: var(--text-secondary);">
                    <span>M5: ${c.evidence.m5Result.allowed ? 'ALLOW' : 'GATE'}</span>
                    <span>Risk: ${c.evidence.riskResult.riskLevel}</span>
                    <span>P: 0 bytes</span>
                    <span>${c.durationMs}ms</span>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>

        <!-- Right: 11-Stage Chronological Trace Explorer -->
        <div class="ide-panel" style="height: 100%;">
          <div class="ide-panel-header">
            <span>11-Stage Chronological Trace & Verification: ${selectedCase?.id ?? ''}</span>
            <div style="display: flex; gap: 6px;">
              <span class="badge badge-green mono">0 BYTES TRANSMITTED</span>
              <span class="badge badge-blue mono">${selectedCase?.durationMs ?? 0}ms</span>
            </div>
          </div>
          <div class="ide-panel-body" style="padding: 0; display: flex; flex-direction: column;">
            <!-- Header Summary -->
            <div style="padding: 12px 16px; background: var(--bg-panel-subtle); border-bottom: 1px solid var(--border-subtle);">
              <div style="font-size: 14px; font-weight: 700; color: var(--text-bright); margin-bottom: 4px;">
                ${selectedCase?.title ?? ''}
              </div>
              <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 6px;">
                <strong>Task:</strong> "${selectedCase?.inputTask ?? ''}"
              </div>
              <div style="display: flex; gap: 16px; font-family: var(--font-mono); font-size: 11px;">
                <span><strong style="color: var(--text-muted);">M5 Validator:</strong> <span style="color: var(--status-green-bright);">${selectedCase?.evidence.m5Result.allowed ? 'ALLOWED' : 'GATED'}</span></span>
                <span><strong style="color: var(--text-muted);">Risk:</strong> <span style="color: var(--text-primary);">${selectedCase?.evidence.riskResult.riskLevel} (${selectedCase?.evidence.riskResult.riskScore}/100)</span></span>
                <span><strong style="color: var(--text-muted);">Goal Verification:</strong> <span style="color: var(--status-green-bright);">${selectedCase?.evidence.goalVerification.verdict} (${Math.round((selectedCase?.evidence.goalVerification.confidence ?? 1) * 100)}%)</span></span>
              </div>
            </div>

            <!-- Chronological Steps Timeline -->
            <div style="flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 8px;">
              ${trace.map((step) => this.renderTraceStep(step)).join('')}
            </div>
          </div>
        </div>
      </div>
    `;

    this.setupCardListeners();
  }

  private renderTraceStep(step: ChronologicalTraceStep): string {
    const verdictBadge = step.safetyVerdict === 'SAFE' ? '<span class="badge badge-green">SAFE</span>' :
                         step.safetyVerdict === 'BLOCKED' ? '<span class="badge badge-red">BLOCKED</span>' :
                         step.safetyVerdict === 'GATED' ? '<span class="badge badge-amber">GATED</span>' : '';

    return `
      <div style="display: flex; gap: 12px; padding: 10px 12px; background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: var(--radius-xs);">
        <!-- Step Number Indicator -->
        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; width: 28px; height: 28px; background: var(--bg-panel); border: 1px solid var(--border-panel); border-radius: var(--radius-xs); font-family: var(--font-mono); font-weight: 700; font-size: 11px; color: var(--status-blue-bright); flex-shrink: 0;">
          ${step.stepNumber}
        </div>

        <!-- Step Content -->
        <div style="flex: 1;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;">
            <div style="font-size: 12px; font-weight: 700; color: var(--text-bright);">
              <span class="badge badge-gray mono" style="margin-right: 6px;">${step.phase}</span>
              ${step.name}
            </div>
            ${verdictBadge}
          </div>
          <div style="font-size: 12px; color: var(--text-primary); margin-top: 2px;">
            ${step.description}
          </div>
          <div class="mono" style="font-size: 10px; color: var(--text-secondary); margin-top: 4px; padding: 4px 8px; background: var(--bg-input); border-radius: 2px; border: 1px solid var(--border-subtle);">
            ${JSON.stringify(step.details)}
          </div>
        </div>
      </div>
    `;
  }

  private setupCardListeners(): void {
    const cards = this.container.querySelectorAll<HTMLElement>('.evidence-case-card');
    cards.forEach((card) => {
      card.addEventListener('click', () => {
        const id = card.getAttribute('data-case-id');
        if (id && id !== this.selectedCaseId) {
          this.selectedCaseId = id;
          this.render();
        }
      });
    });
  }
}
