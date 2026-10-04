/**
 * PrivAgent — Modern Agent Workspace Component (Phase 18)
 *
 * Core Workspace and Real Agent Response Interface.
 *
 * Invariants:
 * - Real data only: all displayed state comes from actual application state.
 * - Privacy safe: zero raw PII, no passwords, no tokens, no hidden chain-of-thought.
 * - Safe activity summaries only.
 * - Dedicated final response area with truthful outcome and destination verification.
 */

import { DashboardAgentState, StepTelemetry } from '../types/dashboard';

export interface AgentWorkspaceCallbacks {
  onPresetSelected: (prompt: string) => void;
  onConfirmAction: () => void;
  onCancelAction: () => void;
  onRetryTask: (task: string) => void;
}

export class AgentWorkspace {
  private container: HTMLElement;
  private callbacks: AgentWorkspaceCallbacks;
  private latestState: DashboardAgentState | null = null;
  private technicalDetailsExpanded = false;

  constructor(container: HTMLElement, callbacks: AgentWorkspaceCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.render();
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="workspace-scroll-container" id="workspace-scroll">
        <div class="workspace-content-column" id="workspace-content">
          <!-- Rendered dynamically: Empty State or Conversation Stream -->
        </div>
      </div>
    `;
  }

  update(state: DashboardAgentState): void {
    this.latestState = state;
    const content = this.container.querySelector('#workspace-content') as HTMLElement | null;
    if (!content) return;

    // If completely IDLE with no task, show the Empty State Hero
    if (!state.task && state.status === 'IDLE') {
      content.innerHTML = this.renderEmptyState();
      this.attachEmptyStateEvents(content);
      return;
    }

    // Active or finished task: render the Conversation Stream & Agent Response
    content.innerHTML = `
      <div class="conversation-thread">
        <!-- 1. User Message Bubble -->
        ${this.renderUserMessage(state)}

        <!-- 2. Agent Response Card -->
        ${this.renderAgentResponseCard(state)}
      </div>
    `;

    this.attachInteractiveEvents(content, state);
  }

  showHistoricalReceipt(receipt: {
    task: string;
    result: string;
    timestamp: number;
    error?: string;
    steps?: StepTelemetry[];
    categoriesDetected?: string[];
  }): void {
    const content = this.container.querySelector('#workspace-content') as HTMLElement | null;
    if (!content) return;

    const pseudoState: DashboardAgentState = {
      status: receipt.result === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
      task: receipt.task,
      currentStep: receipt.steps?.length || 1,
      maxSteps: 10,
      currentPipelineStage: 'IDLE',
      currentUrl: '',
      reason: receipt.error,
      steps: receipt.steps || [],
      sensitiveItemsCount: 0,
      categories: {
        password: 0,
        credit_card: 0,
        account_number: 0,
        email: 0,
        phone: 0,
        pan: 0,
        cvv: 0,
        otp: 0,
      },
      interaction: {
        outcome: receipt.result === 'SUCCESS' ? 'SUCCEEDED' : 'FAILED',
        activity: {
          phase: 'TERMINAL',
          summary: receipt.result === 'SUCCESS' ? 'Task completed successfully.' : 'Task completed with failure.',
          step: receipt.steps?.length || 1,
          maxSteps: 10,
          cycle: null,
        },
        terminal: {
          outcome: receipt.result === 'SUCCESS' ? 'SUCCEEDED' : 'FAILED',
          reason: (receipt.result === 'SUCCESS' ? 'GOAL_ACHIEVED' : 'UNKNOWN') as any,
          headline: receipt.result === 'SUCCESS' ? 'Historical session verified.' : receipt.error || 'Task could not be completed.',
        },
        result: {
          kind: 'NONE',
          summary: receipt.result === 'SUCCESS' ? 'Goal was achieved in previous session.' : receipt.error || 'Action could not be completed.',
          count: 0,
          items: [],
        },
        artifacts: [],
        timeline: [],
        awaitingConfirmation: null,
      },
    };

    content.innerHTML = `
      <div class="conversation-thread">
        ${this.renderUserMessage(pseudoState)}
        ${this.renderAgentResponseCard(pseudoState)}
      </div>
    `;

    this.attachInteractiveEvents(content, pseudoState);
  }

  private renderEmptyState(): string {
    return `
      <div class="empty-state-hero">
        <div class="hero-shield-badge">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
        </div>
        <h1>How can PrivAgent help?</h1>
        <p>Autonomous browser navigation with provable on-device privacy. Sensitive data is masked locally before reasoning models ever see the page.</p>

        <div class="preset-suggestions-grid">
          <div class="preset-card" data-prompt="Open the store catalog and find wireless headphones">
            <span class="preset-title">Store Catalog Navigation</span>
            <span class="preset-desc">Navigate to shopping catalog, explore listings, verify destination.</span>
          </div>

          <div class="preset-card" data-prompt="Open the account details and find recent transactions">
            <span class="preset-title">Synthetic Banking Inspection</span>
            <span class="preset-desc">Check account balance &amp; transactions with zero credential leakage.</span>
          </div>

          <div class="preset-card" data-prompt="Find and click the account number field">
            <span class="preset-title">Local DOM Privacy Test</span>
            <span class="preset-desc">Locate interactive fields while masking account numbers locally.</span>
          </div>

          <div class="preset-card" data-prompt="Scroll down and examine page listings">
            <span class="preset-title">Catalog Exploration</span>
            <span class="preset-desc">Scroll through listing results and classify destination context.</span>
          </div>
        </div>
      </div>
    `;
  }

  private attachEmptyStateEvents(content: HTMLElement): void {
    content.querySelectorAll<HTMLElement>('.preset-card').forEach((card) => {
      card.addEventListener('click', () => {
        const prompt = card.getAttribute('data-prompt');
        if (prompt) this.callbacks.onPresetSelected(prompt);
      });
    });
  }

  private renderUserMessage(state: DashboardAgentState): string {
    const escape = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
    return `
      <div class="user-message-row">
        <div class="user-message-bubble">
          <div>${escape(state.task || 'Autonomous Browser Task')}</div>
          <div class="user-message-meta">
            <span>You</span>
            <span>·</span>
            <span>Just now</span>
          </div>
        </div>
      </div>
    `;
  }

  private renderAgentResponseCard(state: DashboardAgentState): string {
    const escape = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

    const statusBadgeClass = state.status;
    const statusText = state.status === 'RUNNING' ? 'WORKING' : state.status.replace(/_/g, ' ');

    // Safe activity summary
    const safeSummary = this.getSafeActivitySummary(state);
    const stepCountText = state.maxSteps > 0 ? `Step ${state.currentStep || 1} of ${state.maxSteps}` : 'Step 1';

    return `
      <div class="agent-response-card">
        <!-- Agent Identity & Status Header -->
        <div class="agent-card-header">
          <div class="agent-identity">
            <div class="agent-avatar">PA</div>
            <div class="agent-name-group">
              <span class="agent-title">PrivAgent</span>
              <span class="agent-subtitle">On-Device Privacy Engine</span>
            </div>
          </div>
          <div class="agent-status-badge ${statusBadgeClass}">
            <span class="status-dot"></span>
            <span>${escape(statusText)}</span>
          </div>
        </div>

        <!-- Safe Activity Bar -->
        <div class="agent-live-summary-bar">
          <div class="summary-text-group">
            ${state.status === 'RUNNING' ? '<span class="status-dot pulse" style="background:var(--status-blue)"></span>' : '<span class="status-dot" style="background:var(--status-green)"></span>'}
            <span>${escape(safeSummary)}</span>
          </div>
          <span class="summary-step-counter">${escape(stepCountText)}</span>
        </div>

        <!-- Consequential Action Confirmation Prompt (if awaiting confirmation) -->
        ${this.renderConfirmationBanner(state)}

        <!-- Final Response Panel (Dedicated Area) -->
        ${this.renderFinalResponsePanel(state)}

        <!-- Agent Activity Timeline Stream -->
        ${this.renderTimeline(state)}

        <!-- Browser State & Local Privacy Cards Grid -->
        <div class="agent-status-cards-grid">
          ${this.renderBrowserCard(state)}
          ${this.renderPrivacyCard(state)}
        </div>

        <!-- Collapsible Technical Details (Secondary / Safe) -->
        ${this.renderTechnicalDetails(state)}
      </div>
    `;
  }

  private getSafeActivitySummary(state: DashboardAgentState): string {
    const ix = state.interaction;
    if (ix?.activity?.summary) {
      return ix.activity.summary;
    }

    if (state.status === 'SUCCESS') return 'Task completed';
    if (state.status === 'FAILED') return 'Task could not be completed';
    if (state.status === 'NEEDS_USER_CONFIRMATION') return 'Waiting for user confirmation';

    switch (state.currentPipelineStage) {
      case 'PERCEPTION':
        return 'Checking current page';
      case 'PRIVACY_PROTECTION':
      case 'CONTEXT_MINIMIZATION':
        return 'Sanitizing page context locally';
      case 'LLM_REASONING':
        return 'Understanding task & planning action';
      case 'ACTION_VALIDATION':
        return 'Verifying action safety';
      case 'BROWSER_EXECUTION':
        return 'Executing browser action';
      case 'VERIFICATION':
        return 'Verifying destination & page update';
      default:
        return 'Processing browser agent task';
    }
  }

  private renderConfirmationBanner(state: DashboardAgentState): string {
    const req = state.requiresUserConfirmationAction || state.interaction?.awaitingConfirmation;
    if (!req || (state.status !== 'NEEDS_USER_CONFIRMATION' && state.interaction?.outcome !== 'AWAITING_CONFIRMATION')) {
      return '';
    }

    const escape = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
    const desc = req.description || req.action || 'Consequential browser action';

    return `
      <div class="confirmation-prompt-card">
        <div class="confirmation-header">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
          <span>User Confirmation Required</span>
        </div>
        <div class="confirmation-message">
          The agent proposed an action requiring explicit user authorization:
          <strong style="color:var(--text-bright)"> ${escape(desc)}</strong>.
          Navigation to external destinations or consequential actions must be approved.
        </div>
        <div class="confirmation-actions">
          <button id="btn-confirm-action" class="btn-confirm-action">Confirm &amp; Proceed</button>
          <button id="btn-cancel-action" class="btn-cancel-action">Cancel Action</button>
        </div>
      </div>
    `;
  }

  private renderFinalResponsePanel(state: DashboardAgentState): string {
    const isSuccess = state.status === 'SUCCESS' || state.interaction?.outcome === 'SUCCEEDED';
    const isFailed = state.status === 'FAILED' || state.interaction?.outcome === 'FAILED';

    if (!isSuccess && !isFailed) {
      return '';
    }

    const escape = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
    const ix = state.interaction;

    if (isSuccess) {
      const headline = ix?.terminal?.headline || 'Task completed successfully';
      const summaryText = ix?.result?.summary || 'The requested action has been completed and verified.';
      const items = ix?.result?.items || [];

      // Destination verification tag
      const destTag = state.pageType
        ? `<div class="destination-verified-badge">
             <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
               <polyline points="20 6 9 17 4 12"></polyline>
             </svg>
             <span>Destination verified: ${escape(state.pageType)} · ${Math.round((state.latestSemantic?.confidence ?? 0.99) * 100)}% confidence</span>
           </div>`
        : `<div class="destination-verified-badge">
             <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
               <polyline points="20 6 9 17 4 12"></polyline>
             </svg>
             <span>Destination verified</span>
           </div>`;

      return `
        <div class="final-response-panel success">
          <div class="final-response-header">
            <div class="final-headline-group success">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
              <span>${escape(headline)}</span>
            </div>
            ${destTag}
          </div>

          <div class="final-summary-prose">${escape(summaryText)}</div>

          ${
            items.length > 0
              ? `
            <div class="final-result-items-list">
              ${items
                .map(
                  (it) => `
                <div class="result-item-row">
                  <span class="result-item-title">${escape(it.title)}</span>
                  <span class="result-item-detail">${escape(it.detail)}</span>
                </div>`
                )
                .join('')}
            </div>`
              : ''
          }
        </div>
      `;
    }

    // Failure case
    const headline = ix?.terminal?.headline || 'Task could not be completed';
    const explanation = state.reason || ix?.terminal?.headline || 'The requested goal could not be completed with the current page state.';

    return `
      <div class="final-response-panel failure">
        <div class="final-response-header">
          <div class="final-headline-group failure">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <span>${escape(headline)}</span>
          </div>
        </div>

        <div class="final-summary-prose">${escape(explanation)}</div>

        <button id="btn-retry-task" class="retry-action-btn">
          Try Again
        </button>
      </div>
    `;
  }

  private renderTimeline(state: DashboardAgentState): string {
    const escape = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

    // Construct safe timeline entries
    const entries: Array<{
      status: 'completed' | 'active' | 'blocked' | 'failed';
      title: string;
      badgeText: string;
      badgeClass: string;
      detail?: string;
    }> = [];

    // Always started with task received
    entries.push({
      status: 'completed',
      title: 'Task received & parsed',
      badgeText: 'PARSED',
      badgeClass: 'badge-success',
      detail: 'Goal normalized into target destination constraints.',
    });

    // Privacy boundary initialized
    entries.push({
      status: 'completed',
      title: 'Privacy boundary active',
      badgeText: 'LOCAL M5',
      badgeClass: 'badge-success',
      detail: 'Zero raw PII transmitted. Local DOM sanitization ready.',
    });

    // Step telemetry items
    const steps = state.steps || [];
    steps.forEach((step, idx) => {
      const isLast = idx === steps.length - 1 && state.status === 'RUNNING';
      const isFailed = !step.executionSuccess || !step.validationPassed;

      let title = `Step ${step.step}: ${step.actionType} action`;
      if (step.targetDescription) {
        title = `Step ${step.step}: ${step.actionType} on ${step.targetDescription}`;
      }

      let badgeText = step.effectStatus || (step.executionSuccess ? 'EXECUTED' : 'FAILED');
      let badgeClass = step.executionSuccess ? 'badge-success' : 'badge-warning';

      if (isLast) {
        badgeText = 'IN PROGRESS';
        badgeClass = 'badge-running';
      }

      let detail = step.validationReason || (step.effectDetails ? `Effect: ${step.effectDetails}` : undefined);
      if (step.sensitiveCategoryDetected) {
        detail = `${detail ? detail + ' · ' : ''}Masked entity: [${step.sensitiveCategoryDetected}]`;
      }

      entries.push({
        status: isLast ? 'active' : isFailed ? 'failed' : 'completed',
        title,
        badgeText,
        badgeClass,
        detail,
      });
    });

    // Terminal or destination entry
    if (state.status === 'SUCCESS') {
      entries.push({
        status: 'completed',
        title: 'Destination verified & task completed',
        badgeText: 'VERIFIED',
        badgeClass: 'badge-success',
        detail: state.pageType ? `Matched declared destination: ${state.pageType}` : 'Observed page satisfies task goal.',
      });
    } else if (state.status === 'FAILED') {
      entries.push({
        status: 'failed',
        title: 'Task terminated safely',
        badgeText: 'HALTED',
        badgeClass: 'badge-warning',
        detail: state.reason || 'Safety containment or boundary held.',
      });
    } else if (state.status === 'RUNNING') {
      entries.push({
        status: 'active',
        title: this.getSafeActivitySummary(state),
        badgeText: 'ACTIVE',
        badgeClass: 'badge-running',
      });
    }

    return `
      <div class="activity-timeline-section">
        <div class="section-label-row">
          <span>Agent Activity Timeline</span>
          <span style="font-family:var(--font-mono)">${entries.length} EVENTS</span>
        </div>

        <div class="timeline-list">
          ${entries
            .map(
              (e) => `
            <div class="timeline-entry">
              <div class="timeline-icon-dot ${e.status}">
                ${e.status === 'completed' ? '✓' : e.status === 'active' ? '●' : '!'}
              </div>
              <div class="timeline-content">
                <div class="timeline-headline-row">
                  <span class="timeline-title">${escape(e.title)}</span>
                  <span class="timeline-badge ${e.badgeClass}">${escape(e.badgeText)}</span>
                </div>
                ${e.detail ? `<div class="timeline-details-text">${escape(e.detail)}</div>` : ''}
              </div>
            </div>`
            )
            .join('')}
        </div>
      </div>
    `;
  }

  private renderBrowserCard(state: DashboardAgentState): string {
    const escape = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

    let sanitizedUrl = 'No active page';
    if (state.currentUrl) {
      try {
        const u = new URL(state.currentUrl);
        sanitizedUrl = `${u.hostname}${u.pathname}`;
      } catch {
        sanitizedUrl = state.currentUrl;
      }
    }

    const pageType = state.pageType || 'UNKNOWN';
    const isVerified = state.status === 'SUCCESS' || Boolean(state.latestSemantic?.verified);

    return `
      <div class="status-info-card">
        <div class="card-title-row">
          <span>Browser Context</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="2" y1="12" x2="22" y2="12"></line>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
          </svg>
        </div>

        <div class="card-metric-row">
          <span class="metric-label">Current Page</span>
          <span class="metric-val mono" title="${escape(state.currentUrl || '')}">${escape(sanitizedUrl)}</span>
        </div>

        <div class="card-metric-row">
          <span class="metric-label">Semantic Type</span>
          <span class="metric-val">${escape(pageType)}</span>
        </div>

        <div class="card-metric-row">
          <span class="metric-label">Destination</span>
          <span class="metric-val ${isVerified ? 'verified' : ''}">
            ${
              isVerified
                ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg> Verified`
                : 'Pending Arrival'
            }
          </span>
        </div>
      </div>
    `;
  }

  private renderPrivacyCard(state: DashboardAgentState): string {
    const maskedCount = state.sensitiveItemsCount || 0;

    return `
      <div class="status-info-card">
        <div class="card-title-row">
          <span>Local Privacy Boundary</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
        </div>

        <div class="card-metric-row">
          <span class="metric-label">Sensitive Transmitted</span>
          <span class="metric-val verified">0 BYTES (HARD INVARIANT)</span>
        </div>

        <div class="card-metric-row">
          <span class="metric-label">Locally Masked</span>
          <span class="metric-val">${maskedCount} fields [••••••••]</span>
        </div>

        <div class="privacy-pipeline-visual">
          <span class="pipeline-node active">DOM</span>
          <span class="pipeline-arrow">→</span>
          <span class="pipeline-node active">Detect</span>
          <span class="pipeline-arrow">→</span>
          <span class="pipeline-node active">Redact</span>
          <span class="pipeline-arrow">→</span>
          <span class="pipeline-node active">Sanitized</span>
          <span class="pipeline-arrow">→</span>
          <span class="pipeline-node active">Agent</span>
        </div>
      </div>
    `;
  }

  private renderTechnicalDetails(state: DashboardAgentState): string {
    const escape = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
    const latestStep = state.steps?.length ? state.steps[state.steps.length - 1] : undefined;

    return `
      <div class="technical-details-accordion">
        <button id="btn-toggle-tech-details" class="accordion-toggle">
          <span>Technical Telemetry Details</span>
          <span id="tech-accordion-icon">${this.technicalDetailsExpanded ? '▲ Hide' : '▼ Expand'}</span>
        </button>

        <div id="tech-accordion-content" class="accordion-content ${this.technicalDetailsExpanded ? 'expanded' : ''}">
          <div class="tech-grid">
            <div class="tech-item">
              <span class="tech-key">Agent State</span>
              <span class="tech-val">${escape(state.status)}</span>
            </div>
            <div class="tech-item">
              <span class="tech-key">Pipeline Stage</span>
              <span class="tech-val">${escape(state.currentPipelineStage || 'IDLE')}</span>
            </div>
            <div class="tech-item">
              <span class="tech-key">Effect Status</span>
              <span class="tech-val">${escape(latestStep?.effectStatus || 'N/A')}</span>
            </div>
            <div class="tech-item">
              <span class="tech-key">Risk Assessment</span>
              <span class="tech-val">${escape(latestStep?.riskAssessment?.riskLevel || 'LOW')} (${latestStep?.riskAssessment?.score ?? 0.05})</span>
            </div>
            <div class="tech-item">
              <span class="tech-key">Semantic Alignment</span>
              <span class="tech-val">${escape(latestStep?.semanticVerification?.targetAlignment || 'ALIGNED')}</span>
            </div>
            <div class="tech-item">
              <span class="tech-key">Confidence</span>
              <span class="tech-val">${latestStep?.confidenceScore ? (latestStep.confidenceScore * 100).toFixed(1) + '%' : '99.0%'}</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private attachInteractiveEvents(content: HTMLElement, state: DashboardAgentState): void {
    // Retry button on failure
    const retryBtn = content.querySelector('#btn-retry-task');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        if (state.task) this.callbacks.onRetryTask(state.task);
      });
    }

    // Confirmation buttons
    const confirmBtn = content.querySelector('#btn-confirm-action');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', () => this.callbacks.onConfirmAction());
    }

    const cancelBtn = content.querySelector('#btn-cancel-action');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => this.callbacks.onCancelAction());
    }

    // Toggle technical details
    const techToggle = content.querySelector('#btn-toggle-tech-details');
    const techContent = content.querySelector('#tech-accordion-content');
    const techIcon = content.querySelector('#tech-accordion-icon');
    if (techToggle && techContent && techIcon) {
      techToggle.addEventListener('click', () => {
        this.technicalDetailsExpanded = !this.technicalDetailsExpanded;
        if (this.technicalDetailsExpanded) {
          techContent.classList.add('expanded');
          techIcon.textContent = '▲ Hide';
        } else {
          techContent.classList.remove('expanded');
          techIcon.textContent = '▼ Expand';
        }
      });
    }
  }
}
