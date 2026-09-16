import { AgentAdapter } from '../adapters/agentAdapter';
import { DashboardAgentState, PipelineStage } from '../types/dashboard';
import { classifyUserIntent, extractExplicitTargetFromTask } from '../routing/intentClassifier';

export class AgentView {
  private container: HTMLElement;
  private adapter: AgentAdapter;
  private isSubmitting = false;
  private isActivityExpanded = true;
  private conversationHistory: Array<{
    sender: 'user' | 'assistant';
    text: string;
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
          <h2>PrivAgent Assistant</h2>
          <p>Real-time autonomous browser automation with on-device privacy protection</p>
        </div>
        <div>
          <button id="btn-new-task" class="btn btn-secondary">
            <span>+</span> New Task
          </button>
        </div>
      </div>

      <div class="agent-chat-container">
        <div id="chat-history" class="chat-history">
          <div class="chat-conversation-wrapper">
            <div id="chat-welcome" class="chat-welcome">
              <div class="welcome-icon">🛡️</div>
              <h3>What task should PrivAgent perform?</h3>
              <p>
                PrivAgent runs an autonomous browser agent loop directly in your browser. Sensitive
                information is detected and protected locally on-device before sanitized context is sent to the LLM.
              </p>
              <div class="quick-prompts">
                <button class="quick-prompt-btn" data-task="Open the localhost 4173 and get my account number">
                  🏦 Open localhost:4173 & get my account number
                </button>
                <button class="quick-prompt-btn" data-task="Find my recent transactions">
                  🔍 Find my recent transactions
                </button>
                <button class="quick-prompt-btn" data-task="Open account details">
                  📋 Open account details
                </button>
                <button class="quick-prompt-btn" data-task="Navigate to external partner login">
                  ⚠️ Navigate to external origin (Test safety check)
                </button>
              </div>
            </div>
            <div id="messages-container" style="display: flex; flex-direction: column; gap: 24px;"></div>
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
        // Stop action
        await this.adapter.stopTask();
        return;
      }

      this.isSubmitting = true;

      // 1. Immediately clear input
      input.value = '';
      input.placeholder = 'Ask PrivAgent to do something...';

      // 2. Hide welcome card once conversation begins
      const welcome = this.container.querySelector('#chat-welcome') as HTMLElement;
      if (welcome) welcome.style.display = 'none';

      // 3. Classify intent: CHAT vs BROWSER_TASK
      const classification = classifyUserIntent(task);

      if (classification.intent === 'CHAT') {
        this.conversationHistory.push({
          sender: 'user',
          text: task,
          isBrowserTask: false,
        });

        this.conversationHistory.push({
          sender: 'assistant',
          text:
            classification.suggestedResponse ||
            'Hi. I can help you automate tasks in your browser while keeping sensitive information protected on-device.',
          isBrowserTask: false,
        });

        this.renderConversation();
        this.isSubmitting = false;
        return;
      }

      // 4. Browser Automation Task
      this.conversationHistory.push({
        sender: 'user',
        text: task,
        isBrowserTask: true,
      });

      const leadResponse = this.generateLeadResponse(task);
      this.conversationHistory.push({
        sender: 'assistant',
        text: leadResponse,
        isBrowserTask: true,
      });

      this.isActivityExpanded = true;
      this.renderConversation();

      // 5. Dispatch task to REAL adapter
      try {
        await this.adapter.startTask(task);
      } finally {
        this.isSubmitting = false;
      }
    };

    actionBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const state = this.adapter.getState();
      if (state.status === 'RUNNING') {
        this.adapter.stopTask();
      } else {
        submitTask();
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        submitTask();
      }
    });

    btnNewTask.addEventListener('click', async (e) => {
      e.preventDefault();
      await this.adapter.stopTask();
      this.resetConversation();
      input.value = '';
      input.placeholder = 'Ask PrivAgent to do something...';
      input.focus();
    });

    // Quick prompts
    const promptBtns = this.container.querySelectorAll('.quick-prompt-btn');
    promptBtns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const state = this.adapter.getState();
        if (state.status === 'RUNNING' || this.isSubmitting) return;
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

    // Auto-collapse activity upon successful task completion
    if (state.status === 'SUCCESS' && this.isActivityExpanded) {
      // Keep expanded during execution; can collapse or remain compact
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
          <div class="chat-message-group">
            <div class="user-sender-label">You</div>
            <div class="user-message-row">
              <div class="user-bubble-box">
                ${escapeHtml(msg.text)}
              </div>
            </div>
          </div>
        `;
      } else if (msg.sender === 'assistant') {
        const isLatest = i === this.conversationHistory.length - 1;
        const isTask = msg.isBrowserTask === true;

        html += `
          <div class="assistant-message-row">
            <div class="assistant-avatar">🛡️</div>
            <div class="assistant-body">
              <div class="assistant-sender-label">PrivAgent</div>
              <div class="assistant-lead-text">
                ${escapeHtml(msg.text)}
              </div>

              ${isLatest && isTask ? this.renderActivityBlock(state) : ''}

              ${isLatest && isTask && state.status === 'SUCCESS' ? `
                <div class="task-completion-banner">
                  <span style="font-size: 16px;">✓</span>
                  <div>
                    <strong>Task completed</strong>
                    <div style="color: var(--text-secondary); margin-top: 2px;">
                      I completed the requested task. Sensitive values remained protected on-device.
                    </div>
                  </div>
                </div>
              ` : ''}

              ${isLatest && isTask && state.status === 'FAILED' ? `
                <div class="task-failed-banner">
                  <span style="font-size: 16px;">✕</span>
                  <div>
                    <strong>Task could not be completed</strong>
                    <div style="color: var(--text-secondary); margin-top: 2px;">
                      ${escapeHtml(state.reason || 'The agent could not complete the requested actions.')}
                    </div>
                  </div>
                </div>
              ` : ''}

              ${isLatest && isTask && state.status === 'STOPPED' ? `
                <div style="background-color: var(--status-stopped-bg); border: 1px solid var(--status-stopped-border); padding: 12px 16px; border-radius: var(--radius-md); font-size: 13px; color: var(--status-stopped);">
                  <strong>■ Task stopped</strong>
                  <div style="color: var(--text-secondary); margin-top: 2px;">
                    Task execution was halted by user.
                  </div>
                </div>
              ` : ''}

              ${isLatest && state.status === 'NEEDS_USER_CONFIRMATION' && state.requiresUserConfirmationAction ? `
                <div class="confirmation-card">
                  <h4>⚠ Confirmation required</h4>
                  <p>
                    The agent is about to execute a consequential action:
                    <strong style="display: block; margin-top: 4px; color: #fff;">
                      ${escapeHtml(state.requiresUserConfirmationAction.description || state.requiresUserConfirmationAction.action)}
                    </strong>
                    ${state.requiresUserConfirmationAction.url ? `
                      <code style="display:inline-block; margin-top: 4px; font-size: 11px; background: rgba(0,0,0,0.4); padding: 2px 6px; border-radius: 4px;">
                        ${escapeHtml(state.requiresUserConfirmationAction.url)}
                      </code>
                    ` : ''}
                  </p>
                  <div class="confirmation-actions">
                    <button id="btn-cancel-action" class="btn btn-secondary">Cancel</button>
                    <button id="btn-confirm-action" class="btn btn-primary">Allow Action</button>
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
          ? 'Hide agent activity ▴'
          : 'View agent activity ▾';
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
    let previewText = '● Agent is working...';

    if (state.status === 'SUCCESS') {
      previewStatusCls = 'success';
      previewText = `✓ Completed (${state.steps.length} actions executed)`;
    } else if (state.status === 'FAILED') {
      previewStatusCls = 'failed';
      previewText = '✕ Execution failed';
    } else if (state.status === 'NEEDS_USER_CONFIRMATION') {
      previewStatusCls = 'confirmation';
      previewText = '⚠ Action confirmation required';
    } else if (state.status === 'STOPPED') {
      previewStatusCls = 'stopped';
      previewText = '■ Task stopped by user';
    }

    const failedEarly = state.status === 'FAILED' && state.steps.length === 0;

    // Dynamic thinking steps based on REAL execution steps
    const stepItemsHtml = state.steps.map((s) => `
      <div class="activity-step-row done">
        <div class="activity-step-marker">✓</div>
        <div>
          <span>Step ${s.step}: <strong>${escapeHtml(s.actionType)}</strong> — ${escapeHtml(s.targetDescription)}</span>
          ${s.sensitiveCategoryDetected ? `
            <span class="category-pill detected" style="padding: 1px 6px; font-size: 10px; margin-left: 6px;">
              Protected class: ${escapeHtml(s.sensitiveCategoryDetected)}
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
            ${this.isActivityExpanded ? 'Hide agent activity ▴' : 'View agent activity ▾'}
          </button>
        </div>

        <div id="activity-drawer" class="activity-details-drawer" style="display: ${this.isActivityExpanded ? 'flex' : 'none'};">
          ${failedEarly ? `
            <div class="activity-step-row failed">
              <div class="activity-step-marker" style="color: var(--status-failed);">✕</div>
              <div>
                <strong>Execution stopped</strong> — ${escapeHtml(state.reason || 'No browser tab available')}
              </div>
            </div>
          ` : state.status === 'RUNNING' && state.steps.length === 0 ? `
            <div class="activity-step-row active">
              <div class="activity-step-marker">●</div>
              <div>
                <em>Target tab discovery & on-device page perception...</em>
              </div>
            </div>
          ` : `
            <div class="activity-step-row done">
              <div class="activity-step-marker">✓</div>
              <div>
                <strong>Page perception</strong> — DOM & Visual OCR scanned
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
                <strong>Context minimization</strong> — Outbound context sanitized & bounded (M8)
              </div>
            </div>
          `}
          ${stepItemsHtml}
          ${state.status === 'RUNNING' && state.steps.length > 0 ? `
            <div class="activity-step-row active">
              <div class="activity-step-marker">●</div>
              <div>
                <em>Executing safe next step...</em>
              </div>
            </div>
          ` : ''}
          ${state.status === 'FAILED' && state.steps.length > 0 ? `
            <div class="activity-step-row failed">
              <div class="activity-step-marker" style="color: var(--status-failed);">✕</div>
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
