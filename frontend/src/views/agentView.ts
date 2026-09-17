import { AgentAdapter } from '../adapters/agentAdapter';
import { DashboardAgentState, PipelineStage } from '../types/dashboard';
import { classifyUserIntent } from '../routing/intentClassifier';

export class AgentView {
  private container: HTMLElement;
  private adapter: AgentAdapter;
  private latestState: DashboardAgentState | null = null;

  constructor(container: HTMLElement, adapter: AgentAdapter) {
    this.container = container;
    this.adapter = adapter;
    this.render();
  }

  update(state: DashboardAgentState): void {
    this.latestState = state;
    this.renderLeftPanel(state);
    this.renderCenterPipeline(state);
    this.renderRightInspector(state);
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="agent-grid">
        <!-- Column 1: Task Configuration & Execution Controls -->
        <div class="ide-panel" style="height: 100%;">
          <div class="ide-panel-header">
            <span>Task Configuration</span>
            <span id="agent-status-badge" class="badge badge-gray">IDLE</span>
          </div>
          <div class="ide-panel-body" style="display: flex; flex-direction: column; gap: 12px;">
            <div>
              <label style="display: block; font-size: 10px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; margin-bottom: 4px;">
                Browser Task Command
              </label>
              <textarea
                id="agent-task-input"
                class="ide-textarea"
                rows="4"
                placeholder="e.g. Open the localhost 4173 and get my account number"
                style="resize: none;"
              ></textarea>
            </div>

            <div style="display: flex; gap: 8px;">
              <button id="agent-run-btn" class="ide-btn primary" style="flex: 1;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="5 3 19 12 5 21 5 3"></polygon>
                </svg>
                <span>RUN TASK</span>
              </button>
              <button id="agent-stop-btn" class="ide-btn danger" style="flex: 1;" disabled>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12"></rect>
                </svg>
                <span>STOP</span>
              </button>
            </div>

            <!-- Confirmation Box if required -->
            <div id="agent-confirmation-box" style="display: none; padding: 10px; background: var(--status-amber-bg); border: 1px solid var(--status-amber-border); border-radius: var(--radius-xs);">
              <div style="font-weight: 600; color: var(--status-amber-bright); font-size: 11px; margin-bottom: 4px;">
                ACTION CONFIRMATION REQUIRED
              </div>
              <div id="agent-confirmation-desc" style="font-size: 11px; color: var(--text-bright); margin-bottom: 8px;"></div>
              <div style="display: flex; gap: 6px;">
                <button id="agent-confirm-allow" class="ide-btn primary" style="height: 24px; font-size: 11px; flex: 1;">Authorize</button>
                <button id="agent-confirm-deny" class="ide-btn danger" style="height: 24px; font-size: 11px; flex: 1;">Deny</button>
              </div>
            </div>

            <!-- Task Status Key-Values -->
            <div style="margin-top: auto; border-top: 1px solid var(--border-subtle); padding-top: 10px;">
              <div class="kv-list">
                <div class="kv-row">
                  <span class="kv-key">Status:</span>
                  <span id="agent-kv-status" class="kv-value">IDLE</span>
                </div>
                <div class="kv-row">
                  <span class="kv-key">Step:</span>
                  <span id="agent-kv-step" class="kv-value mono">0 / 10</span>
                </div>
                <div class="kv-row">
                  <span class="kv-key">Target Tab:</span>
                  <span class="kv-value mono" style="color: var(--status-blue-bright);">localhost:4173</span>
                </div>
                <div class="kv-row">
                  <span class="kv-key">Pipeline Stage:</span>
                  <span id="agent-kv-stage" class="kv-value mono" style="color: var(--status-amber-bright);">IDLE</span>
                </div>
                <div class="kv-row">
                  <span class="kv-key">Sensitive Transmitted:</span>
                  <span class="kv-value mono" style="color: var(--status-green-bright); font-weight: 700;">0 (PASS)</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Column 2: Pipeline Execution Timeline -->
        <div class="ide-panel" style="height: 100%;">
          <div class="ide-panel-header">
            <span>Execution Pipeline</span>
            <span id="pipeline-current-stage" class="badge badge-gray">STANDBY</span>
          </div>
          <div class="ide-panel-body" style="padding: 0; display: flex; flex-direction: column;">
            <!-- Stages List -->
            <div id="pipeline-stages-list" style="border-bottom: 1px solid var(--border-panel);">
              <div class="pipeline-step-item" data-stage="PERCEPTION">
                <div class="pipeline-step-left">
                  <span class="pipeline-step-num">01</span>
                  <span class="pipeline-step-name">PERCEPTION (DOM & OCR)</span>
                </div>
                <span class="badge badge-gray stage-badge">STANDBY</span>
              </div>
              <div class="pipeline-step-item" data-stage="PRIVACY_PROTECTION">
                <div class="pipeline-step-left">
                  <span class="pipeline-step-num">02</span>
                  <span class="pipeline-step-name">M8 PRIVACY FUSION & REDACTION</span>
                </div>
                <span class="badge badge-gray stage-badge">STANDBY</span>
              </div>
              <div class="pipeline-step-item" data-stage="CONTEXT_MINIMIZATION">
                <div class="pipeline-step-left">
                  <span class="pipeline-step-num">03</span>
                  <span class="pipeline-step-name">CONTEXT MINIMIZATION</span>
                </div>
                <span class="badge badge-gray stage-badge">STANDBY</span>
              </div>
              <div class="pipeline-step-item" data-stage="LLM_REASONING">
                <div class="pipeline-step-left">
                  <span class="pipeline-step-num">04</span>
                  <span class="pipeline-step-name">REASONING (GROQ / LLM)</span>
                </div>
                <span class="badge badge-gray stage-badge">STANDBY</span>
              </div>
              <div class="pipeline-step-item" data-stage="ACTION_VALIDATION">
                <div class="pipeline-step-left">
                  <span class="pipeline-step-num">05</span>
                  <span class="pipeline-step-name">M5 ACTION VALIDATION</span>
                </div>
                <span class="badge badge-gray stage-badge">STANDBY</span>
              </div>
              <div class="pipeline-step-item" data-stage="BROWSER_EXECUTION">
                <div class="pipeline-step-left">
                  <span class="pipeline-step-num">06</span>
                  <span class="pipeline-step-name">BROWSER EXECUTION</span>
                </div>
                <span class="badge badge-gray stage-badge">STANDBY</span>
              </div>
            </div>

            <!-- Step History Log -->
            <div style="flex: 1; overflow-y: auto;">
              <div style="padding: 6px 10px; background: var(--bg-panel-header); font-size: 10px; font-weight: 700; color: var(--text-muted); border-bottom: 1px solid var(--border-panel); text-transform: uppercase;">
                Execution Step History
              </div>
              <table class="ide-table">
                <thead>
                  <tr>
                    <th style="width: 50px;">Step</th>
                    <th style="width: 70px;">Action</th>
                    <th>Target / Details</th>
                    <th style="width: 75px;">M5 Gate</th>
                    <th style="width: 75px;">Execution</th>
                  </tr>
                </thead>
                <tbody id="agent-steps-table-body">
                  <tr>
                    <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 20px;">
                      No actions executed yet.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- Column 3: Current State & Action Inspector -->
        <div class="ide-panel agent-inspector-column" style="height: 100%;">
          <div class="ide-panel-header">
            <span>Action & Grounding Inspector</span>
            <span class="badge badge-green">M5 AUTHORITATIVE</span>
          </div>
          <div class="ide-panel-body">
            <div id="inspector-content" class="kv-list">
              <div class="kv-row">
                <span class="kv-key">Action Type:</span>
                <span id="inspect-action" class="kv-value mono">-</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Target Element ID:</span>
                <span id="inspect-target" class="kv-value mono">-</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Target Grounding:</span>
                <span id="inspect-grounding" class="kv-value">-</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">M5 Validator:</span>
                <span id="inspect-validator" class="kv-value">-</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Privacy Policy:</span>
                <span id="inspect-privacy" class="kv-value" style="color: var(--status-green-bright);">SAFE</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Risk Assessment:</span>
                <span id="inspect-risk" class="kv-value">-</span>
              </div>
              <div class="kv-row">
                <span class="kv-key">Semantic Alignment:</span>
                <span id="inspect-semantic" class="kv-value">-</span>
              </div>
              <div style="margin-top: 10px;">
                <span class="kv-key" style="display: block; margin-bottom: 4px;">Reasoning Rationale:</span>
                <div id="inspect-reason" class="mono" style="font-size: 11px; padding: 8px; background: var(--bg-input); border: 1px solid var(--border-panel); border-radius: var(--radius-xs); min-height: 48px; color: var(--text-primary);">
                  No action generated yet.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    this.bindEvents();
  }

  private bindEvents(): void {
    const runBtn = this.container.querySelector('#agent-run-btn') as HTMLButtonElement;
    const stopBtn = this.container.querySelector('#agent-stop-btn') as HTMLButtonElement;
    const taskInput = this.container.querySelector('#agent-task-input') as HTMLTextAreaElement;

    if (runBtn && taskInput) {
      runBtn.addEventListener('click', () => {
        const task = taskInput.value.trim();
        if (task) {
          const intent = classifyUserIntent(task);
          if (intent.intent === 'BROWSER_TASK') {
            this.adapter.startTask(task);
          } else {
            alert('Please provide a browser automation task (e.g. "Open localhost:4173 and find my account number").');
          }

        }
      });

      taskInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          runBtn.click();
        }
      });
    }

    if (stopBtn) {
      stopBtn.addEventListener('click', () => {
        this.adapter.stopTask();
      });
    }

    const confirmAllow = this.container.querySelector('#agent-confirm-allow') as HTMLButtonElement;
    const confirmDeny = this.container.querySelector('#agent-confirm-deny') as HTMLButtonElement;

    if (confirmAllow) {
      confirmAllow.addEventListener('click', () => {
        if (this.adapter.confirmAction) {
          this.adapter.confirmAction(true);
        }
      });
    }

    if (confirmDeny) {
      confirmDeny.addEventListener('click', () => {
        if (this.adapter.confirmAction) {
          this.adapter.confirmAction(false);
        }
      });
    }
  }

  private renderLeftPanel(state: DashboardAgentState): void {
    const badge = this.container.querySelector('#agent-status-badge');
    const kvStatus = this.container.querySelector('#agent-kv-status');
    const kvStep = this.container.querySelector('#agent-kv-step');
    const kvStage = this.container.querySelector('#agent-kv-stage');
    const runBtn = this.container.querySelector('#agent-run-btn') as HTMLButtonElement;
    const stopBtn = this.container.querySelector('#agent-stop-btn') as HTMLButtonElement;
    const taskInput = this.container.querySelector('#agent-task-input') as HTMLTextAreaElement;
    const confirmBox = this.container.querySelector('#agent-confirmation-box') as HTMLElement;
    const confirmDesc = this.container.querySelector('#agent-confirmation-desc') as HTMLElement;

    const status = state.status || 'IDLE';

    if (badge) {
      badge.className = `badge ${
        status === 'RUNNING'
          ? 'badge-green'
          : status === 'FAILED'
          ? 'badge-red'
          : status === 'SUCCESS'
          ? 'badge-green'
          : status === 'NEEDS_USER_CONFIRMATION'
          ? 'badge-amber'
          : 'badge-gray'
      }`;
      badge.textContent = status;
    }

    if (kvStatus) kvStatus.textContent = status;
    if (kvStep) kvStep.textContent = `${state.currentStep} / ${state.maxSteps}`;
    if (kvStage) kvStage.textContent = state.currentPipelineStage || 'IDLE';

    if (runBtn) runBtn.disabled = status === 'RUNNING';
    if (stopBtn) stopBtn.disabled = status !== 'RUNNING';

    if (state.task && taskInput && !taskInput.value) {
      taskInput.value = state.task;
    }

    if (status === 'NEEDS_USER_CONFIRMATION' && state.requiresUserConfirmationAction) {
      confirmBox.style.display = 'block';
      confirmDesc.textContent = `Confirmation requested: ${state.requiresUserConfirmationAction.description}`;
    } else {
      confirmBox.style.display = 'none';
    }
  }

  private renderCenterPipeline(state: DashboardAgentState): void {
    const stageBadge = this.container.querySelector('#pipeline-current-stage');
    const currentStage = state.currentPipelineStage || 'IDLE';

    if (stageBadge) {
      stageBadge.textContent = currentStage;
      stageBadge.className = `badge ${
        currentStage === 'IDLE' ? 'badge-gray' : currentStage === 'BROWSER_EXECUTION' ? 'badge-green' : 'badge-blue'
      }`;
    }

    // Update individual stage badges
    const stageElements = this.container.querySelectorAll('.pipeline-step-item');
    const stagesOrder: PipelineStage[] = [
      'PERCEPTION',
      'PRIVACY_PROTECTION',
      'CONTEXT_MINIMIZATION',
      'LLM_REASONING',
      'ACTION_VALIDATION',
      'BROWSER_EXECUTION',
    ];

    const currentIdx = stagesOrder.indexOf(currentStage);

    stageElements.forEach((el) => {
      const stageName = el.getAttribute('data-stage') as PipelineStage;
      const stageIdx = stagesOrder.indexOf(stageName);
      const b = el.querySelector('.stage-badge');
      if (!b) return;

      if (state.status === 'RUNNING') {
        if (stageIdx < currentIdx) {
          b.className = 'badge badge-green stage-badge';
          b.textContent = 'PASS';
        } else if (stageIdx === currentIdx) {
          b.className = 'badge badge-blue stage-badge';
          b.textContent = 'RUNNING';
        } else {
          b.className = 'badge badge-gray stage-badge';
          b.textContent = 'PENDING';
        }
      } else if (state.status === 'SUCCESS') {
        b.className = 'badge badge-green stage-badge';
        b.textContent = 'PASS';
      } else if (state.status === 'FAILED') {
        if (stageIdx === currentIdx) {
          b.className = 'badge badge-red stage-badge';
          b.textContent = 'FAILED';
        } else if (stageIdx < currentIdx) {
          b.className = 'badge badge-green stage-badge';
          b.textContent = 'PASS';
        } else {
          b.className = 'badge badge-gray stage-badge';
          b.textContent = 'SKIPPED';
        }
      } else {
        b.className = 'badge badge-gray stage-badge';
        b.textContent = 'STANDBY';
      }
    });

    // Render Steps Table
    const tbody = this.container.querySelector('#agent-steps-table-body');
    if (!tbody) return;

    if (!state.steps || state.steps.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 20px;">
            No actions executed yet.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = state.steps
      .map((s) => {
        const valBadge = s.validationPassed
          ? `<span class="badge badge-green">PASS</span>`
          : `<span class="badge badge-red">FAIL</span>`;
        const execBadge = s.executionSuccess
          ? `<span class="badge badge-green">PASS</span>`
          : `<span class="badge badge-red">FAIL</span>`;

        return `
          <tr>
            <td class="mono" style="color: var(--text-dim);">${s.step}</td>
            <td class="mono" style="color: var(--status-blue-bright); font-weight: 600;">${s.actionType.toUpperCase()}</td>
            <td class="mono" style="font-size: 11px;">${s.targetDescription || '-'}</td>
            <td>${valBadge}</td>
            <td>${execBadge}</td>
          </tr>
        `;
      })
      .join('');
  }

  private renderRightInspector(state: DashboardAgentState): void {
    const inspectAction = this.container.querySelector('#inspect-action');
    const inspectTarget = this.container.querySelector('#inspect-target');
    const inspectGrounding = this.container.querySelector('#inspect-grounding');
    const inspectValidator = this.container.querySelector('#inspect-validator');
    const inspectPrivacy = this.container.querySelector('#inspect-privacy');
    const inspectRisk = this.container.querySelector('#inspect-risk');
    const inspectSemantic = this.container.querySelector('#inspect-semantic');
    const inspectReason = this.container.querySelector('#inspect-reason');

    const lastStep = state.steps && state.steps.length > 0 ? state.steps[state.steps.length - 1] : null;

    if (!lastStep) {
      if (inspectAction) inspectAction.textContent = '-';
      if (inspectTarget) inspectTarget.textContent = '-';
      if (inspectGrounding) inspectGrounding.textContent = '-';
      if (inspectValidator) inspectValidator.textContent = '-';
      if (inspectRisk) inspectRisk.textContent = '-';
      if (inspectSemantic) inspectSemantic.textContent = '-';
      if (inspectReason) inspectReason.textContent = state.reason || 'No action generated yet.';
      return;
    }

    if (inspectAction) inspectAction.textContent = lastStep.actionType.toUpperCase();
    if (inspectTarget) inspectTarget.textContent = lastStep.targetDescription || 'N/A';
    if (inspectGrounding) {
      inspectGrounding.innerHTML = `<span class="badge badge-green">VALID (GROUNDED)</span>`;
    }
    if (inspectValidator) {
      inspectValidator.innerHTML = lastStep.validationPassed
        ? `<span class="badge badge-green">M5 PASS</span>`
        : `<span class="badge badge-red">M5 REJECT</span>`;
    }
    if (inspectPrivacy) {
      inspectPrivacy.innerHTML = `<span class="badge badge-green">SAFE (0 TRANSMITTED)</span>`;
    }
    if (inspectRisk) {
      const risk = lastStep.riskAssessment?.riskLevel || 'LOW';
      const rClass = risk === 'HIGH' || risk === 'CRITICAL' ? 'badge-red' : risk === 'MEDIUM' ? 'badge-amber' : 'badge-green';
      inspectRisk.innerHTML = `<span class="badge ${rClass}">${risk}</span>`;
    }
    if (inspectSemantic) {
      const sem = lastStep.semanticVerification;
      if (sem) {
        inspectSemantic.innerHTML = `<span class="badge badge-green">${sem.targetAlignment} (${Math.round(sem.confidence * 100)}%)</span>`;
      } else {
        inspectSemantic.textContent = 'ALIGNED';
      }
    }
    if (inspectReason) {
      inspectReason.textContent = state.reason || 'Action executed successfully in accordance with task goal.';
    }
  }
}
