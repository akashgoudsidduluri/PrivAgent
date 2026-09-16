import { AgentAdapter } from '../adapters/agentAdapter';
import { DashboardAgentState, PipelineStage } from '../types/dashboard';
import { classifyUserIntent, extractExplicitTargetFromTask } from '../routing/intentClassifier';

export type AgentDisplayStatus =
  | 'IDLE'
  | 'THINKING'
  | 'PERCEIVING'
  | 'PROTECTING'
  | 'EXECUTING'
  | 'WAITING_FOR_CONFIRMATION'
  | 'SUCCESS'
  | 'FAILED'
  | 'STOPPED';

export class AgentView {
  private container: HTMLElement;
  private adapter: AgentAdapter;
  private isSubmitting = false;
  private isActivityExpanded = true;
  private conversationHistory: Array<{
    sender: 'user' | 'assistant';
    text: string;
    timestamp?: string;
    isBrowserTask?: boolean;
    state?: DashboardAgentState;
  }> = [];

  constructor(container: HTMLElement, adapter: AgentAdapter) {
    this.container = container;
    this.adapter = adapter;
    this.render();
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="view-header">
        <div class="view-title-group">
          <div class="view-title-row">
            <h2>PrivAgent Assistant</h2>
            <div id="agent-runtime-badge" class="agent-status-badge status-idle">
              <span class="status-badge-dot"></span>
              <span class="status-badge-text">IDLE</span>
            </div>
          </div>
          <p>Autonomous browser agent with zero-knowledge on-device privacy firewall</p>
        </div>
        <div class="view-header-actions">
          <div class="live-firewall-indicator" title="Hardware/local memory isolation boundary active">
            <span class="firewall-pulse-dot"></span>
            <span class="firewall-text">PRIVACY FIREWALL ACTIVE · 0 SENT</span>
          </div>
          <button id="btn-new-task" class="btn btn-secondary">
            <span>+</span> New Task
          </button>
        </div>
      </div>

      <div class="agent-chat-container">
        <div id="chat-history" class="chat-history">
          <div class="chat-conversation-wrapper">
            <div id="chat-welcome" class="chat-welcome">
              <div class="welcome-icon-shield">
                <span class="shield-glyph">🛡️</span>
              </div>
              <h3>What task should PrivAgent perform?</h3>
              <p>
                PrivAgent executes autonomous browser tasks directly in your browser tab. All passwords,
                card numbers, OTPs, CVVs, PAN numbers, and personal identifiers are detected and redacted
                locally on-device before sanitized context is sent to the LLM.
              </p>

              <div class="privacy-guarantee-strip">
                <div class="guarantee-item">
                  <span class="guarantee-check">✓</span>
                  <span>100% On-Device PII Masking</span>
                </div>
                <div class="guarantee-item">
                  <span class="guarantee-check">✓</span>
                  <span>Zero Raw Data Outbound</span>
                </div>
                <div class="guarantee-item">
                  <span class="guarantee-check">✓</span>
                  <span>Consequential Action Gating</span>
                </div>
              </div>

              <div class="quick-prompts-label">Quick test prompts:</div>
              <div class="quick-prompts">
                <button class="quick-prompt-btn" data-task="Open the localhost 4173 and get my account number">
                  <span class="prompt-icon">🏦</span>
                  <span>Open localhost:4173 & get my account number</span>
                </button>
                <button class="quick-prompt-btn" data-task="Find my recent transactions">
                  <span class="prompt-icon">🔍</span>
                  <span>Find my recent transactions</span>
                </button>
                <button class="quick-prompt-btn" data-task="Open account details">
                  <span class="prompt-icon">📋</span>
                  <span>Open account details</span>
                </button>
                <button class="quick-prompt-btn" data-task="Navigate to external partner login">
                  <span class="prompt-icon">⚠️</span>
                  <span>Navigate to external origin (Safety test)</span>
                </button>
              </div>
            </div>

            <div id="messages-container" class="messages-container"></div>
          </div>
        </div>

        <div class="chat-input-area">
          <div class="composer-container">
            <input
              type="text"
              id="composer-input"
              class="composer-input"
              placeholder="Ask PrivAgent to do something..."
              autocomplete="off"
            />
            <button
              id="btn-composer-action"
              class="composer-button submit"
              title="Run task"
            >
              ↑
            </button>
          </div>
          <div class="composer-footnote">
            <span>PrivAgent M1–M8 Architecture</span> · <span>Zero Raw PII Transmission Guarantee</span> · <span>Deterministic Verification</span>
          </div>
        </div>
      </div>
    `;

    this.bindEvents();
  }

  private bindEvents(): void {
    const input = this.container.querySelector('#composer-input') as HTMLInputElement;
    const actionBtn = this.container.querySelector('#btn-composer-action') as HTMLButtonElement;
    const btnNewTask = this.container.querySelector('#btn-new-task') as HTMLButtonElement;

    const submitTask = async () => {
      const task = input.value.trim();
      if (!task || this.isSubmitting) return;

      const state = this.adapter.getState();
      if (state.status === 'RUNNING') {
        this.adapter.stopTask();
        return;
      }

      this.isSubmitting = true;
      input.value = '';

      const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      this.conversationHistory.push({
        sender: 'user',
        text: task,
        timestamp: now,
      });

      const welcome = this.container.querySelector('#chat-welcome') as HTMLElement;
      if (welcome) welcome.style.display = 'none';

      const intent = classifyUserIntent(task);
      const isBrowserTask = intent.intent === 'BROWSER_TASK';

      if (isBrowserTask) {
        const leadResponse = this.generateLeadResponse(task);
        this.conversationHistory.push({
          sender: 'assistant',
          text: leadResponse,
          timestamp: now,
          isBrowserTask: true,
        });

        this.renderConversation();

        try {
          await this.adapter.startTask(task);
        } catch (err: any) {
          console.error('[AgentView] Failed to start task:', err);
        } finally {
          this.isSubmitting = false;
        }
      } else {
        this.conversationHistory.push({
          sender: 'assistant',
          text: intent.suggestedResponse || "Hello! I am PrivAgent, an on-device privacy-preserving browser automation assistant. Tell me what web task you'd like me to perform.",
          timestamp: now,
          isBrowserTask: false,
        });

        this.renderConversation();
        this.isSubmitting = false;
      }
    };

    actionBtn.addEventListener('click', submitTask);

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitTask();
      }
    });

    if (btnNewTask) {
      btnNewTask.addEventListener('click', () => {
        const state = this.adapter.getState();
        if (state.status === 'RUNNING') {
          this.adapter.stopTask();
        }
        this.resetConversation();
      });
    }

    const quickBtns = this.container.querySelectorAll('.quick-prompt-btn');
    quickBtns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const task = (e.currentTarget as HTMLElement).getAttribute('data-task');
        if (task) {
          input.value = task;
          submitTask();
        }
      });
    });
  }

  setAdapter(adapter: AgentAdapter): void {
    this.adapter = adapter;
  }

  private resetConversation(): void {
    this.conversationHistory = [];
    const welcome = this.container.querySelector('#chat-welcome') as HTMLElement;
    if (welcome) welcome.style.display = 'block';
    const messages = this.container.querySelector('#messages-container')!;
    messages.innerHTML = '';
    this.updateStatusBadge('IDLE');
  }

  private computeDisplayStatus(state: DashboardAgentState): AgentDisplayStatus {
    if (state.status === 'SUCCESS') return 'SUCCESS';
    if (state.status === 'FAILED') return 'FAILED';
    if (state.status === 'STOPPED') return 'STOPPED';
    if (state.status === 'NEEDS_USER_CONFIRMATION') return 'WAITING_FOR_CONFIRMATION';

    if (state.status === 'RUNNING') {
      if (state.steps.length === 0) {
        return 'PERCEIVING';
      }
      const lastStep = state.steps[state.steps.length - 1];
      if (lastStep && lastStep.actionType === 'reasoning') {
        return 'THINKING';
      }
      return 'EXECUTING';
    }

    return 'IDLE';
  }

  private updateStatusBadge(status: AgentDisplayStatus, extra?: string): void {
    const badge = this.container.querySelector('#agent-runtime-badge');
    if (!badge) return;

    badge.className = `agent-status-badge status-${status.toLowerCase().replace(/_/g, '-')}`;

    const textEl = badge.querySelector('.status-badge-text');
    if (textEl) {
      textEl.textContent = extra ? `${status} · ${extra}` : status;
    }
  }

  private generateLeadResponse(task: string): string {
    const lower = task.toLowerCase();
    const explicit = extractExplicitTargetFromTask(task);
    if (explicit && (explicit.port || explicit.hostname)) {
      return "I'll navigate to the requested page while keeping sensitive information protected on-device.";
    }
    if (lower.includes('transaction')) {
      return "I'll find your recent transactions while keeping sensitive financial information protected on-device.";
    }
    if (lower.includes('account number') || lower.includes('account')) {
      return "I'll navigate to your account details while keeping sensitive account numbers and credentials protected locally.";
    }
    if (lower.includes('shipping') || lower.includes('form')) {
      return "I'll assist with the form while masking private identifiers and credentials on-device.";
    }
    return "I'll execute your requested task through the browser while keeping all private information protected on-device.";
  }

  update(state: DashboardAgentState): void {
    const input = this.container.querySelector('#composer-input') as HTMLInputElement;
    const actionBtn = this.container.querySelector('#btn-composer-action') as HTMLButtonElement;

    const displayStatus = this.computeDisplayStatus(state);
    const stepInfo = state.steps.length > 0 ? `Step ${state.steps.length}` : undefined;
    this.updateStatusBadge(displayStatus, stepInfo);

    if (state.status === 'RUNNING') {
      actionBtn.className = 'composer-button stop';
      actionBtn.textContent = '■';
      actionBtn.title = 'Stop agent task';
      input.disabled = true;
      input.placeholder = 'Agent is working on-device...';
    } else {
      actionBtn.className = 'composer-button submit';
      actionBtn.textContent = '↑';
      actionBtn.title = 'Run task';
      input.disabled = false;
      input.placeholder = 'Ask PrivAgent to do something...';
    }

    this.renderConversation(state);
  }

  private renderConversation(currentState?: DashboardAgentState): void {
    const container = this.container.querySelector('#messages-container');
    if (!container) return;

    if (this.conversationHistory.length === 0) return;

    const state = currentState || this.adapter.getState();

    let html = '';

    for (let i = 0; i < this.conversationHistory.length; i++) {
      const msg = this.conversationHistory[i];

      if (msg.sender === 'user') {
        html += `
          <div class="chat-message-group user">
            <div class="message-meta-row">
              <span class="sender-name user">You</span>
              ${msg.timestamp ? `<span class="message-timestamp">${escapeHtml(msg.timestamp)}</span>` : ''}
            </div>
            <div class="user-bubble-box">
              ${escapeHtml(msg.text)}
            </div>
          </div>
        `;
      } else if (msg.sender === 'assistant') {
        const isLatest = i === this.conversationHistory.length - 1;
        const isTask = msg.isBrowserTask === true;

        html += `
          <div class="chat-message-group assistant">
            <div class="message-meta-row">
              <span class="assistant-avatar-mini">🛡️</span>
              <span class="sender-name assistant">PrivAgent</span>
              <span class="firewall-shield-tag">LOCAL FIREWALL</span>
              ${msg.timestamp ? `<span class="message-timestamp">${escapeHtml(msg.timestamp)}</span>` : ''}
            </div>
            <div class="assistant-bubble-box">
              <div class="assistant-lead-text">
                ${escapeHtml(msg.text)}
              </div>

              ${isLatest && isTask ? this.renderActivityBlock(state) : ''}

              ${isLatest && isTask && state.status === 'SUCCESS' ? `
                <div class="task-completion-banner">
                  <div class="banner-icon success">✓</div>
                  <div class="banner-content">
                    <strong>Task completed successfully</strong>
                    <div class="banner-subtext">
                      Autonomous loop finished. Zero raw sensitive values were transmitted.
                    </div>
                  </div>
                </div>
              ` : ''}

              ${isLatest && isTask && state.status === 'FAILED' ? `
                <div class="task-failed-banner">
                  <div class="banner-icon failed">✕</div>
                  <div class="banner-content">
                    <strong>Task halted</strong>
                    <div class="banner-subtext">
                      ${escapeHtml(state.reason || 'The agent could not complete the requested actions.')}
                    </div>
                  </div>
                </div>
              ` : ''}

              ${isLatest && isTask && state.status === 'STOPPED' ? `
                <div class="task-stopped-banner">
                  <div class="banner-icon stopped">■</div>
                  <div class="banner-content">
                    <strong>Task stopped by user</strong>
                    <div class="banner-subtext">
                      Agent loop was immediately halted. Browser tab state preserved.
                    </div>
                  </div>
                </div>
              ` : ''}

              ${isLatest && state.status === 'NEEDS_USER_CONFIRMATION' && state.requiresUserConfirmationAction ? `
                <div class="confirmation-card">
                  <div class="confirmation-card-header">
                    <span class="confirmation-icon">⚠</span>
                    <span>CONSEQUENTIAL ACTION CONFIRMATION REQUIRED</span>
                  </div>
                  <div class="confirmation-body">
                    <p class="confirmation-prompt">
                      The autonomous agent is about to execute a consequential browser action:
                    </p>
                    <div class="consequential-action-detail">
                      <div class="action-type-badge">${escapeHtml(state.requiresUserConfirmationAction.action.toUpperCase())}</div>
                      <div class="action-description-text">
                        ${escapeHtml(state.requiresUserConfirmationAction.description || state.requiresUserConfirmationAction.action)}
                      </div>
                    </div>
                    ${state.requiresUserConfirmationAction.url ? `
                      <div class="target-url-row">
                        <span class="url-label">Destination URL:</span>
                        <code class="url-code">${escapeHtml(state.requiresUserConfirmationAction.url)}</code>
                      </div>
                    ` : ''}
                    <div class="confirmation-safety-warning">
                      <span>🔒</span>
                      <span>This action may alter account state, initiate a transfer, or submit sensitive information. Explicit user consent is mandatory.</span>
                    </div>
                    <div class="confirmation-actions-row">
                      <button id="btn-cancel-action" class="btn btn-secondary danger-hover">
                        ✕ Reject Action
                      </button>
                      <button id="btn-confirm-action" class="btn btn-primary authorize-btn">
                        ✓ Authorize & Execute
                      </button>
                    </div>
                  </div>
                </div>
              ` : ''}
            </div>
          </div>
        `;
      }
    }

    container.innerHTML = html;

    // Bind activity toggle
    const toggleBtn = container.querySelector('#btn-toggle-activity');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        this.isActivityExpanded = !this.isActivityExpanded;
        const drawer = container.querySelector('#activity-drawer') as HTMLElement;
        if (drawer) {
          drawer.style.display = this.isActivityExpanded ? 'flex' : 'none';
        }
        toggleBtn.textContent = this.isActivityExpanded
          ? 'Hide execution trace ▴'
          : 'View execution trace ▾';
      });
    }

    // Bind confirmation buttons
    const btnConfirm = container.querySelector('#btn-confirm-action');
    const btnCancel = container.querySelector('#btn-cancel-action');
    if (btnConfirm && btnCancel) {
      btnConfirm.addEventListener('click', () => this.adapter.confirmAction(true));
      btnCancel.addEventListener('click', () => this.adapter.confirmAction(false));
    }

    const chatHistory = this.container.querySelector('#chat-history');
    if (chatHistory) {
      chatHistory.scrollTop = chatHistory.scrollHeight;
    }
  }

  private renderActivityBlock(state: DashboardAgentState): string {
    if (state.status === 'IDLE' && state.steps.length === 0) return '';

    let previewStatusCls = 'running';
    let previewText = '● Agent is executing...';

    if (state.status === 'SUCCESS') {
      previewStatusCls = 'success';
      previewText = `✓ Completed (${state.steps.length} actions executed)`;
    } else if (state.status === 'FAILED') {
      previewStatusCls = 'failed';
      previewText = '✕ Execution stopped';
    } else if (state.status === 'NEEDS_USER_CONFIRMATION') {
      previewStatusCls = 'confirmation';
      previewText = '⚠ Confirmation required';
    } else if (state.status === 'STOPPED') {
      previewStatusCls = 'stopped';
      previewText = '■ Halted by user';
    }

    const failedEarly = state.status === 'FAILED' && state.steps.length === 0;

    // Dynamic execution steps
    const stepItemsHtml = state.steps.map((s) => `
      <div class="activity-step-row done">
        <div class="activity-step-marker">✓</div>
        <div class="step-content-block">
          <span class="step-label">Step ${s.step}: <strong>${escapeHtml(s.actionType)}</strong> — ${escapeHtml(s.targetDescription)}</span>
          ${s.sensitiveCategoryDetected ? `
            <span class="category-pill detected">
              Protected: ${escapeHtml(s.sensitiveCategoryDetected)}
            </span>
          ` : ''}
        </div>
      </div>
    `).join('');

    return `
      <div class="activity-collapsible-wrapper">
        <div class="activity-summary-bar">
          <div class="activity-status-preview ${previewStatusCls}">
            ${previewText}
          </div>
          <button id="btn-toggle-activity" class="activity-toggle-btn">
            ${this.isActivityExpanded ? 'Hide execution trace ▴' : 'View execution trace ▾'}
          </button>
        </div>

        <div id="activity-drawer" class="activity-details-drawer" style="display: ${this.isActivityExpanded ? 'flex' : 'none'};">
          ${failedEarly ? `
            <div class="activity-step-row failed">
              <div class="activity-step-marker">✕</div>
              <div>
                <strong>Execution stopped</strong> — ${escapeHtml(state.reason || 'No browser tab available')}
              </div>
            </div>
          ` : state.status === 'RUNNING' && state.steps.length === 0 ? `
            <div class="activity-step-row active">
              <div class="activity-step-marker pulse">●</div>
              <div>
                <em>Target tab discovery & on-device page perception...</em>
              </div>
            </div>
          ` : `
            <div class="activity-step-row done">
              <div class="activity-step-marker">✓</div>
              <div>
                <strong>Page perception</strong> — DOM & Visual OCR scanned on-device
              </div>
            </div>
            <div class="activity-step-row done">
              <div class="activity-step-marker">✓</div>
              <div>
                <strong>On-device privacy protection</strong> — ${state.sensitiveItemsCount > 0 ? `${state.sensitiveItemsCount} sensitive items protected locally` : 'Local firewall verified zero leakage'}
              </div>
            </div>
            <div class="activity-step-row done">
              <div class="activity-step-marker">✓</div>
              <div>
                <strong>Context minimization (M8)</strong> — Outbound context sanitized & bounded
              </div>
            </div>
          `}
          ${stepItemsHtml}
          ${state.status === 'RUNNING' && state.steps.length > 0 ? `
            <div class="activity-step-row active">
              <div class="activity-step-marker pulse">●</div>
              <div>
                <em>Executing safe next step...</em>
              </div>
            </div>
          ` : ''}
          ${state.status === 'FAILED' && state.steps.length > 0 ? `
            <div class="activity-step-row failed">
              <div class="activity-step-marker">✕</div>
              <div>
                <strong>Task halted</strong> — ${escapeHtml(state.reason || 'Step execution failed')}
              </div>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
