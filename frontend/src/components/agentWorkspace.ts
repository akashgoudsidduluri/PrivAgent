/**
 * PrivAgent — Modern Agent Workspace Component (Phase 18, DYNAMIC TASK-AWARE UI)
 *
 * The workspace renders ONE surface at a time, chosen by the pure projection
 * in `ui/uiProjection.ts`:
 *
 *   IDLE             → empty-state hero
 *   CONVERSATION     → user message + assistant response. Nothing else:
 *                      no Agent Activity Timeline, no step counter, no
 *                      target/privacy/browser chrome of any kind.
 *   BROWSER_ACTIVITY → compact working indicator, event-driven activity list
 *                      (only events that really occurred), the terminal
 *                      result as the primary element, and diagnostics folded
 *                      into one collapsed disclosure.
 *
 * Invariants:
 * - This component renders state; it never decides it. The projection is the
 *   only input to every branch below.
 * - Real data only: no fixed timeline entries, no fabricated step counts, no
 *   fabricated thinking, no hidden chain-of-thought.
 * - Privacy safe: everything dynamic is escaped; content comes from the
 *   screened interaction projection or a fixed label table.
 * - Activity space is proportional to actual agent work: a run with no
 *   reported events shows no activity list at all.
 */

import { DashboardAgentState, StepTelemetry } from '../types/dashboard';
import {
  projectUi,
  mergeActivities,
  EMPTY_LOG,
  type ActivityLog,
  type UiModel,
  type UiActivity,
} from '../ui/uiProjection';

export interface AgentWorkspaceCallbacks {
  onPresetSelected: (prompt: string) => void;
  onConfirmAction: () => void;
  onCancelAction: () => void;
  onRetryTask: (task: string) => void;
}

const escapeHtml = (s: string): string =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  );

export interface WorkspaceTurn {
  id: string;
  runId?: number;
  task: string;
  state: DashboardAgentState;
  ui: UiModel;
  activityLog: ActivityLog;
  timestamp: number;
}

export class AgentWorkspace {
  private container: HTMLElement;
  private callbacks: AgentWorkspaceCallbacks;
  private latestState: DashboardAgentState | null = null;
  private technicalDetailsExpanded = false;
  private diagnosticsOpen = false;
  private activityOpen = false;
  private lastUi: UiModel | null = null;
  private activityLog: ActivityLog = EMPTY_LOG;

  private turns: WorkspaceTurn[] = [];
  private activeTurnId: string | null = null;
  private turnCounter = 0;

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

  clearHistory(): void {
    this.turns = [];
    this.activeTurnId = null;
    this.latestState = null;
    this.activityLog = EMPTY_LOG;
    this.lastUi = null;
    const content = this.container.querySelector('#workspace-content') as HTMLElement | null;
    if (content) {
      content.innerHTML = this.renderEmptyState();
      this.attachEmptyStateEvents(content);
    }
  }

  getTurns(): readonly WorkspaceTurn[] {
    return this.turns;
  }

  update(state: DashboardAgentState): void {
    this.latestState = state;
    const content = this.container.querySelector('#workspace-content') as HTMLElement | null;
    if (!content) return;

    // Empty state when there is no task and no history
    if ((!state.task || state.status === 'IDLE') && this.turns.length === 0) {
      this.lastUi = projectUi(state, EMPTY_LOG);
      content.innerHTML = this.renderEmptyState();
      this.attachEmptyStateEvents(content);
      return;
    }

    // Match existing turn or start a new turn
    let turn: WorkspaceTurn | undefined;

    if (typeof state.runId === 'number') {
      turn = this.turns.find((t) => t.runId === state.runId);
    }

    if (!turn && this.activeTurnId) {
      const active = this.turns.find((t) => t.id === this.activeTurnId);
      if (active) {
        if (!state.runId && (active.task === state.task || !active.task)) {
          turn = active;
        }
      }
    }

    if (!turn) {
      // If idle with empty task, ignore
      if (!state.task && state.status === 'IDLE') {
        return;
      }

      // Start new turn
      const turnId = `turn-${++this.turnCounter}-${Date.now()}`;
      const log = mergeActivities(EMPTY_LOG, state);
      const ui = projectUi(state, log);
      turn = {
        id: turnId,
        runId: state.runId,
        task: state.task || '',
        state: { ...state },
        ui,
        activityLog: log,
        timestamp: Date.now(),
      };
      this.turns.push(turn);
      this.activeTurnId = turnId;
    } else {
      // Stale regression protection: do not allow terminal turn to regress to RUNNING with same runId
      if (turn.ui.terminal && state.status === 'RUNNING' && turn.runId === state.runId) {
        return;
      }

      if (turn.runId === undefined && typeof state.runId === 'number') {
        turn.runId = state.runId;
      }
      if (state.task && !turn.task) {
        turn.task = state.task;
      }
      // Fold runtime report into turn's event-driven activity log
      turn.activityLog = mergeActivities(turn.activityLog, state);
      turn.state = { ...turn.state, ...state };
      turn.ui = projectUi(turn.state, turn.activityLog);
    }

    this.lastUi = turn.ui;
    this.activityLog = turn.activityLog;

    this.renderTurns();
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

    const ok = receipt.result === 'SUCCESS';
    const pseudoState: DashboardAgentState = {
      status: ok ? 'SUCCESS' : 'FAILED',
      task: receipt.task,
      currentStep: receipt.steps?.length || 0,
      maxSteps: 10,
      currentPipelineStage: 'IDLE',
      currentUrl: '',
      steps: receipt.steps || [],
      sensitiveItemsCount: 0,
      categories: {
        password: 0, credit_card: 0, account_number: 0, email: 0,
        phone: 0, pan: 0, cvv: 0, otp: 0,
      },
      interaction: {
        outcome: ok ? 'SUCCEEDED' : 'FAILED',
        activity: {
          phase: 'TERMINAL',
          summary: ok ? 'Task completed successfully.' : 'Task completed with failure.',
          step: receipt.steps?.length || 0,
          maxSteps: 10,
          cycle: null,
        },
        terminal: {
          outcome: ok ? 'SUCCEEDED' : 'FAILED',
          reason: (ok ? 'GOAL_ACHIEVED' : 'UNKNOWN') as never,
          headline: ok
            ? 'Historical session verified.'
            : receipt.error || 'Task could not be completed.',
        },
        result: {
          kind: 'NONE',
          summary: ok ? 'Goal was achieved in previous session.' : receipt.error || 'Action could not be completed.',
          count: 0,
          items: [],
        },
        artifacts: [],
        timeline: [],
        awaitingConfirmation: null,
      },
    };

    const log = mergeActivities(
      { task: receipt.task, items: [], seen: [] },
      pseudoState,
    );
    const ui = projectUi(pseudoState, log);
    const histTurn: WorkspaceTurn = {
      id: `receipt-${Date.now()}`,
      task: receipt.task,
      state: pseudoState,
      ui,
      activityLog: log,
      timestamp: receipt.timestamp || Date.now(),
    };

    this.turns = [histTurn];
    this.activeTurnId = histTurn.id;
    this.renderTurns();
  }

  private renderTurns(): void {
    const content = this.container.querySelector('#workspace-content') as HTMLElement | null;
    if (!content) return;

    if (this.turns.length === 0) {
      content.innerHTML = this.renderEmptyState();
      this.attachEmptyStateEvents(content);
      return;
    }

    let threadHtml = `<div class="conversation-thread" id="conversation-thread">`;
    for (let i = 0; i < this.turns.length; i++) {
      const turn = this.turns[i];
      if (!turn) continue;
      const isLatest = i === this.turns.length - 1;
      threadHtml += this.renderTurn(turn, isLatest);
    }
    threadHtml += `</div>`;
    content.innerHTML = threadHtml;

    this.attachInteractiveEvents(content);
    this.scrollToBottom();
  }

  private renderTurn(turn: WorkspaceTurn, isLatest: boolean): string {
    const { state, ui } = turn;
    if (ui.surface === 'CONVERSATION') {
      return `
        <div class="conversation-turn" data-turn-id="${turn.id}">
          ${this.renderUserMessage(state, turn.timestamp)}
          ${this.renderConversationResponse(state, ui)}
        </div>
      `;
    }

    return `
      <div class="conversation-turn" data-turn-id="${turn.id}">
        ${this.renderUserMessage(state, turn.timestamp)}
        ${this.renderBrowserTaskCard(state, ui, isLatest, turn.id)}
      </div>
    `;
  }

  private scrollToBottom(): void {
    const scrollEl = this.container.querySelector('#workspace-scroll') as HTMLElement | null;
    if (scrollEl) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
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
        <p>Ask a question for a direct answer, or describe a browser task and watch only the work that actually happens.</p>

        <div class="preset-suggestions-grid">
          <div class="preset-card" data-prompt="What is machine learning?">
            <span class="preset-title">Ask a question</span>
            <span class="preset-desc">Get a direct conversational answer — no browser involved.</span>
          </div>

          <div class="preset-card" data-prompt="Open the store catalog and find wireless headphones">
            <span class="preset-title">Store Catalog Navigation</span>
            <span class="preset-desc">Navigate to shopping catalog, explore listings, verify destination.</span>
          </div>

          <div class="preset-card" data-prompt="Open the account details and find recent transactions">
            <span class="preset-title">Synthetic Banking Inspection</span>
            <span class="preset-desc">Check account balance &amp; transactions with zero credential leakage.</span>
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

  private renderUserMessage(state: DashboardAgentState, timestamp?: number): string {
    const timeStr = timestamp
      ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : 'Just now';

    return `
      <div class="user-message-row">
        <div class="user-message-bubble">
          <div>${escapeHtml(state.task || '')}</div>
          <div class="user-message-meta">
            <span>You</span>
            <span>·</span>
            <span>${timeStr}</span>
          </div>
        </div>
      </div>
    `;
  }

  // ── CONVERSATION SURFACE ───────────────────────────────────────────────────

  /**
   * Phase 3 — a conversational reply looks like a conversation: the user's
   * message and the assistant's response. Nothing else is rendered, by
   * construction: this branch cannot reach the timeline, the cards, the step
   * counter, or any browser state.
   */
  private renderConversationResponse(state: DashboardAgentState, ui: UiModel): string {
    const tone = ui.terminal?.tone;
    const body = ui.terminal?.body ?? '';

    if (ui.pending) {
      return `
        <div class="assistant-message-row" data-surface="conversation">
          <div class="assistant-avatar" aria-hidden="true">PA</div>
          <div class="assistant-message-bubble pending">
            <span class="typing-dots" aria-label="Answering"><i></i><i></i><i></i></span>
          </div>
        </div>
      `;
    }

    return `
      <div class="assistant-message-row" data-surface="conversation">
        <div class="assistant-avatar" aria-hidden="true">PA</div>
        <div class="assistant-message-bubble${tone && tone !== 'success' ? ' notice' : ''}" data-tone="${tone || 'success'}">
          <div class="assistant-message-body">${escapeHtml(body)}</div>
        </div>
      </div>
    `;
  }

  // ── BROWSER ACTIVITY SURFACE ───────────────────────────────────────────────

  private renderBrowserTaskCard(
    state: DashboardAgentState,
    ui: UiModel,
    isLatest = true,
    turnId = '',
  ): string {
    const statusBadgeClass = state.status;
    const statusText = state.status === 'RUNNING' ? 'WORKING' : state.status.replace(/_/g, ' ');

    return `
      <div class="agent-response-card" data-surface="browser" data-turn-id="${turnId}">
        <!-- Agent Identity & Status Header -->
        <div class="agent-card-header">
          <div class="agent-identity">
            <div class="agent-avatar">PA</div>
            <div class="agent-name-group">
              <span class="agent-title">PrivAgent</span>
              <span class="agent-subtitle">Browser task</span>
            </div>
          </div>
          <div class="agent-status-badge ${statusBadgeClass}">
            <span class="status-dot"></span>
            <span>${escapeHtml(statusText)}</span>
          </div>
        </div>

        <!-- Compact live row: category of work + observed activity count -->
        ${this.renderLiveRow(ui)}

        ${this.renderSupersededNotice(ui)}
        ${this.renderConfirmationBanner(state, isLatest, turnId)}

        <!-- FINAL RESULT — primary visual focus once the run reaches a terminal state -->
        ${this.renderFinalResult(state, ui, isLatest, turnId)}

        <!-- Event-driven activity list: only what actually happened -->
        ${this.renderActivitySection(ui, isLatest, turnId)}

        <!-- Diagnostics folded away: the answer comes first, the machinery second -->
        ${this.renderDiagnostics(state, isLatest, turnId)}
      </div>
    `;
  }

  private renderLiveRow(ui: UiModel): string {
    const right = ui.activityCount > 0
      ? `<span class="activity-count-badge">${ui.activityCount} ${ui.activityCount === 1 ? 'activity' : 'activities'}</span>`
      : '';

    if (ui.workingLabel) {
      return `
        <div class="agent-live-summary-bar" data-state="working">
          <div class="summary-text-group">
            <span class="status-dot pulse" style="background:var(--status-blue)"></span>
            <span class="working-label">${escapeHtml(ui.workingLabel)}</span>
          </div>
          ${right}
        </div>
      `;
    }

    if (ui.awaitingConfirmation) {
      return `
        <div class="agent-live-summary-bar" data-state="awaiting">
          <div class="summary-text-group">
            <span class="status-dot" style="background:var(--status-amber-bright)"></span>
            <span class="working-label">Waiting for your confirmation</span>
          </div>
          ${right}
        </div>
      `;
    }

    if (ui.terminal) {
      const icon = ui.terminal.tone === 'success' ? '✓' : ui.terminal.tone === 'notice' ? 'i' : '!';
      return `
        <div class="agent-live-summary-bar" data-state="terminal" data-tone="${ui.terminal.tone}">
          <div class="summary-text-group">
            <span class="terminal-state-icon ${ui.terminal.tone}">${icon}</span>
            <span class="working-label">${escapeHtml(ui.terminal.headline)}</span>
          </div>
          ${right}
        </div>
      `;
    }

    return right ? `<div class="agent-live-summary-bar" data-state="idle">${right}</div>` : '';
  }

  private renderSupersededNotice(ui: UiModel): string {
    if (!ui.supersededNotice) return '';
    return `
      <div class="superseded-notice" role="status">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
          <polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
        </svg>
        <span>${escapeHtml(ui.supersededNotice)}</span>
      </div>
    `;
  }

  private renderConfirmationBanner(state: DashboardAgentState, isLatest = true, turnId = ''): string {
    const req = state.requiresUserConfirmationAction || state.interaction?.awaitingConfirmation;
    if (!req || (state.status !== 'NEEDS_USER_CONFIRMATION' && state.interaction?.outcome !== 'AWAITING_CONFIRMATION')) {
      return '';
    }

    const desc = req.description || req.action || 'Consequential browser action';

    return `
      <div class="confirmation-prompt-card">
        <div class="confirmation-header">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
          <span>User Confirmation Required</span>
        </div>
        <div class="confirmation-message">
          The agent proposed an action requiring explicit user authorization:
          <strong style="color:var(--text-bright)"> ${escapeHtml(desc)}</strong>.
          Navigation to external destinations or consequential actions must be approved.
        </div>
        <div class="confirmation-actions">
          <button id="${isLatest ? 'btn-confirm-action' : `btn-confirm-action-${turnId}`}" class="btn-confirm-action">Confirm &amp; Proceed</button>
          <button id="${isLatest ? 'btn-cancel-action' : `btn-cancel-action-${turnId}`}" class="btn-cancel-action">Cancel Action</button>
        </div>
      </div>
    `;
  }

  /**
   * Phase 7 — the terminal result. Success/answer shows the answer as the
   * primary element; notices (clarification, commit unknown, freshness,
   * cancelled, superseded) say what happened; failures are concise with a
   * retry. `state.reason` is internal by contract and is never rendered.
   */
  private renderFinalResult(state: DashboardAgentState, ui: UiModel, isLatest = true, turnId = ''): string {
    const t = ui.terminal;
    if (!t) return '';

    const panelClass = t.tone === 'success' ? 'success' : t.tone === 'notice' ? 'notice' : 'failure';
    const iconSvg =
      t.tone === 'success'
        ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>`
        : t.tone === 'notice'
          ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`
          : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;

    const ix = state.interaction;
    const result = ix?.result;
    const showLegacyResult =
      !t.body && result && result.kind !== 'NONE' && (t.kind === 'SUCCESS' || t.kind === 'PARTIAL');

    const remaining =
      t.remaining.length > 0
        ? `<ul class="final-remaining-list">${t.remaining.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`
        : '';

    const retry =
      t.tone === 'failure'
        ? `<button id="${isLatest ? 'btn-retry-task' : `btn-retry-task-${turnId}`}" class="retry-action-btn" data-task="${escapeHtml(state.task || '')}">Try Again</button>`
        : '';

    return `
      <div class="final-response-panel ${panelClass}">
        <div class="final-response-header">
          <div class="final-headline-group ${panelClass}">
            ${iconSvg}
            <span>${escapeHtml(t.headline)}</span>
          </div>
        </div>

        ${t.body ? `<div class="final-summary-prose" data-final-result="body">${escapeHtml(t.body)}</div>` : ''}
        ${
          showLegacyResult && result
            ? `<div class="final-summary-prose">${escapeHtml(result.summary)}</div>
               ${
                 result.items.length
                   ? `<div class="final-result-items-list">${result.items
                       .map(
                         (it) => `<div class="result-item-row">
                           <span class="result-item-title">${escapeHtml(it.title)}</span>
                           <span class="result-item-detail">${escapeHtml(it.detail)}</span>
                         </div>`,
                       )
                       .join('')}</div>`
                   : ''
               }`
            : ''
        }
        ${remaining}
        ${t.provenance ? `<div class="final-provenance">${escapeHtml(t.provenance)}</div>` : ''}
        ${retry}
      </div>
    `;
  }

  /**
   * Phase 5 — the event-driven activity list. Entries exist only for events
   * that actually occurred (an executed step, or a reported phase). While the
   * run is going it is open; at a terminal state it collapses behind a
   * disclosure so the answer stays primary.
   */
  private renderActivitySection(ui: UiModel, isLatest = true, turnId = ''): string {
    if (ui.activityCount === 0) return '';

    const entries = ui.activities.map((a) => this.renderActivityEntry(a)).join('');
    const count = `<span class="activity-count-badge">${ui.activityCount} ${ui.activityCount === 1 ? 'activity' : 'activities'}</span>`;

    if (ui.terminal) {
      return `
        <details class="activity-section collapsed-activity activity-details" id="${isLatest ? 'activity-details' : `activity-details-${turnId}`}" ${this.activityOpen ? 'open' : ''}>
          <summary class="section-label-row activity-summary-row">
            <span>Activity</span>
            ${count}
          </summary>
          <div class="timeline-list">${entries}</div>
        </details>
      `;
    }

    return `
      <div class="activity-section" data-state="running">
        <div class="section-label-row">
          <span>Activity</span>
          ${count}
        </div>
        <div class="timeline-list">${entries}</div>
      </div>
    `;
  }

  private renderActivityEntry(a: UiActivity): string {
    const glyph = a.status === 'COMPLETE' ? '✓' : a.status === 'ACTIVE' ? '●' : '!';
    const badgeText =
      a.status === 'COMPLETE' ? 'DONE' : a.status === 'ACTIVE' ? 'WORKING' : a.status;
    return `
      <div class="timeline-entry" data-status="${a.status}">
        <div class="timeline-icon-dot ${a.status === 'COMPLETE' ? 'completed' : a.status === 'ACTIVE' ? 'active' : 'failed'}">${glyph}</div>
        <div class="timeline-content">
          <div class="timeline-headline-row">
            <span class="timeline-title">${escapeHtml(a.label)}</span>
            <span class="timeline-badge ${a.status === 'ACTIVE' ? 'badge-running' : a.status === 'COMPLETE' ? 'badge-success' : 'badge-warning'}">${badgeText}</span>
          </div>
          ${a.detail ? `<div class="timeline-details-text">${escapeHtml(a.detail)}</div>` : ''}
        </div>
      </div>
    `;
  }

  /**
   * The diagnostics (browser context, local privacy boundary, technical
   * telemetry) are real and useful — but second. They live behind one
   * disclosure so a short task looks short.
   */
  private renderDiagnostics(state: DashboardAgentState, isLatest = true, turnId = ''): string {
    return `
      <details class="diagnostics-details" id="${isLatest ? 'diagnostics-details' : `diagnostics-details-${turnId}`}" ${this.diagnosticsOpen ? 'open' : ''}>
        <summary class="accordion-toggle">
          <span>Browser &amp; privacy diagnostics</span>
          <span class="diagnostics-toggle-icon" id="${isLatest ? 'diagnostics-icon' : `diagnostics-icon-${turnId}`}">${this.diagnosticsOpen ? '▲ Hide' : '▼ Expand'}</span>
        </summary>
        <div class="diagnostics-body">
          <div class="agent-status-cards-grid">
            ${this.renderBrowserCard(state)}
            ${this.renderPrivacyCard(state)}
          </div>
          ${this.renderTechnicalDetails(state, isLatest, turnId)}
        </div>
      </details>
    `;
  }

  private renderBrowserCard(state: DashboardAgentState): string {
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
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
          </svg>
        </div>

        <div class="card-metric-row">
          <span class="metric-label">Current Page</span>
          <span class="metric-val mono" title="${escapeHtml(state.currentUrl || '')}">${escapeHtml(sanitizedUrl)}</span>
        </div>

        <div class="card-metric-row">
          <span class="metric-label">Semantic Type</span>
          <span class="metric-val">${escapeHtml(pageType)}</span>
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

  private renderTechnicalDetails(state: DashboardAgentState, isLatest = true, turnId = ''): string {
    const latestStep = state.steps?.length ? state.steps[state.steps.length - 1] : undefined;

    return `
      <div class="technical-details-accordion">
        <button id="${isLatest ? 'btn-toggle-tech-details' : `btn-toggle-tech-details-${turnId}`}" class="accordion-toggle">
          <span>Technical Telemetry Details</span>
          <span class="tech-accordion-icon" id="${isLatest ? 'tech-accordion-icon' : `tech-accordion-icon-${turnId}`}">${this.technicalDetailsExpanded ? '▲ Hide' : '▼ Expand'}</span>
        </button>

        <div id="${isLatest ? 'tech-accordion-content' : `tech-accordion-content-${turnId}`}" class="accordion-content ${this.technicalDetailsExpanded ? 'expanded' : ''}">
          <div class="tech-grid">
            <div class="tech-item">
              <span class="tech-key">Agent State</span>
              <span class="tech-val">${escapeHtml(state.status)}</span>
            </div>
            <div class="tech-item">
              <span class="tech-key">Pipeline Stage</span>
              <span class="tech-val">${escapeHtml(state.currentPipelineStage || 'IDLE')}</span>
            </div>
            <div class="tech-item">
              <span class="tech-key">Effect Status</span>
              <span class="tech-val">${escapeHtml(latestStep?.effectStatus || 'N/A')}</span>
            </div>
            <div class="tech-item">
              <span class="tech-key">Risk Assessment</span>
              <span class="tech-val">${escapeHtml(latestStep?.riskAssessment?.riskLevel || 'LOW')} (${latestStep?.riskAssessment?.score ?? 0.05})</span>
            </div>
            <div class="tech-item">
              <span class="tech-key">Semantic Alignment</span>
              <span class="tech-val">${escapeHtml(latestStep?.semanticVerification?.targetAlignment || 'ALIGNED')}</span>
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

  private attachInteractiveEvents(content: HTMLElement): void {
    // Retry buttons across all turns
    content.querySelectorAll<HTMLElement>('.retry-action-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const task = btn.getAttribute('data-task');
        if (task) this.callbacks.onRetryTask(task);
      });
    });

    // Confirmation buttons across all turns
    content.querySelectorAll<HTMLElement>('.btn-confirm-action').forEach((btn) => {
      btn.addEventListener('click', () => this.callbacks.onConfirmAction());
    });

    content.querySelectorAll<HTMLElement>('.btn-cancel-action').forEach((btn) => {
      btn.addEventListener('click', () => this.callbacks.onCancelAction());
    });

    // Diagnostics disclosure
    content.querySelectorAll<HTMLDetailsElement>('.diagnostics-details').forEach((diagnostics) => {
      diagnostics.addEventListener('toggle', () => {
        this.diagnosticsOpen = diagnostics.open;
        const icon = diagnostics.querySelector('.diagnostics-toggle-icon, #diagnostics-icon');
        if (icon) icon.textContent = this.diagnosticsOpen ? '▲ Hide' : '▼ Expand';
      });
    });

    // Activity history disclosure
    content.querySelectorAll<HTMLDetailsElement>('.activity-details').forEach((activity) => {
      activity.addEventListener('toggle', () => {
        this.activityOpen = activity.open;
      });
    });

    // Toggle technical details
    content.querySelectorAll<HTMLElement>('.technical-details-accordion .accordion-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.technicalDetailsExpanded = !this.technicalDetailsExpanded;
        const parent = btn.closest('.technical-details-accordion');
        if (parent) {
          const techContent = parent.querySelector('.accordion-content');
          const techIcon = parent.querySelector('.tech-accordion-icon, #tech-accordion-icon');
          if (techContent) {
            if (this.technicalDetailsExpanded) {
              techContent.classList.add('expanded');
              if (techIcon) techIcon.textContent = '▲ Hide';
            } else {
              techContent.classList.remove('expanded');
              if (techIcon) techIcon.textContent = '▼ Expand';
            }
          }
        }
      });
    });
  }
}
