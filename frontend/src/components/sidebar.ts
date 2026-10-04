/**
 * PrivAgent — Modern Persistent Sidebar Component (Phase 18)
 *
 * Requirements:
 * - PrivAgent logo/wordmark
 * - New Task button
 * - Recent tasks/session history (from real receiptsStore data, no fabricated tasks)
 * - Current task indicator
 * - Privacy status
 * - Settings
 * - Compact, clean, icons where appropriate, not visually overloaded.
 */

import { DashboardAgentState } from '../types/dashboard';
import { receiptsStore } from '../state/receiptsStore';

export interface SidebarCallbacks {
  onNewTask: () => void;
  onSelectHistoricalTask: (receiptId: string) => void;
  onOpenDrawer: (tab: string) => void;
}

export class Sidebar {
  private container: HTMLElement;
  private callbacks: SidebarCallbacks;
  private latestState: DashboardAgentState | null = null;
  private unsubscribeReceipts: (() => void) | null = null;

  constructor(container: HTMLElement, callbacks: SidebarCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.render();
    this.setupListeners();
  }

  destroy(): void {
    if (this.unsubscribeReceipts) {
      this.unsubscribeReceipts();
      this.unsubscribeReceipts = null;
    }
  }

  private setupListeners(): void {
    this.unsubscribeReceipts = receiptsStore.subscribe(() => {
      this.renderRecentTasks();
    });
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="sidebar-header">
        <button id="sidebar-btn-new-task" class="btn-new-task" title="Start a fresh task (Alt+N)">
          <span style="display:flex;align-items:center;gap:8px">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            <span>New Task</span>
          </span>
          <span class="shortcut-hint">Alt+N</span>
        </button>
      </div>

      <div class="sidebar-scroll-area">
        <div id="sidebar-current-task-group" style="display:none;flex-direction:column;gap:4px">
          <div class="sidebar-section-title">Current Task</div>
          <div id="sidebar-current-task-item" class="task-history-item active">
            <span class="task-history-title" id="sidebar-current-task-title">—</span>
            <span class="task-history-meta">
              <span class="status-dot" style="background:var(--status-blue)"></span>
              <span id="sidebar-current-task-status">RUNNING</span>
            </span>
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:6px">
          <div class="sidebar-section-title">Recent Tasks</div>
          <div id="sidebar-recent-list" class="recent-tasks-list">
            <!-- Populated from receiptsStore -->
          </div>
        </div>
      </div>

      <div class="sidebar-footer">
        <div class="sidebar-privacy-card">
          <div class="shield-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
          </div>
          <div class="privacy-text">
            <span class="privacy-title">Local Privacy Boundary</span>
            <span class="privacy-sub" id="sidebar-sensitive-metric">0 bytes transmitted</span>
          </div>
        </div>

        <div class="sidebar-tools-row">
          <button id="sidebar-btn-privacy" class="sidebar-tool-btn" title="View Privacy Receipts">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            <span>Privacy Hub</span>
          </button>
          <button id="sidebar-btn-evaluation" class="sidebar-tool-btn" title="View SIH Benchmark & Evaluation">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 20V10"></path>
              <path d="M12 20V4"></path>
              <path d="M6 20v-6"></path>
            </svg>
            <span>Evaluation</span>
          </button>
          <button id="sidebar-btn-architecture" class="sidebar-tool-btn" title="System Architecture">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
            <span>Arch</span>
          </button>
        </div>
      </div>
    `;

    const newBtn = this.container.querySelector('#sidebar-btn-new-task');
    if (newBtn) {
      newBtn.addEventListener('click', () => this.callbacks.onNewTask());
    }

    const privBtn = this.container.querySelector('#sidebar-btn-privacy');
    if (privBtn) {
      privBtn.addEventListener('click', () => this.callbacks.onOpenDrawer('privacy'));
    }

    const evalBtn = this.container.querySelector('#sidebar-btn-evaluation');
    if (evalBtn) {
      evalBtn.addEventListener('click', () => this.callbacks.onOpenDrawer('evaluation'));
    }

    const archBtn = this.container.querySelector('#sidebar-btn-architecture');
    if (archBtn) {
      archBtn.addEventListener('click', () => this.callbacks.onOpenDrawer('system'));
    }

    this.renderRecentTasks();
  }

  private renderRecentTasks(): void {
    const listEl = this.container.querySelector('#sidebar-recent-list');
    if (!listEl) return;

    const receipts = receiptsStore.getAll();
    if (receipts.length === 0) {
      listEl.innerHTML = `<div class="task-empty-history">No recent sessions yet. Run a task to build session history.</div>`;
      return;
    }

    const escape = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

    const formatRelativeTime = (timestamp: number) => {
      const diffSec = Math.floor((Date.now() - timestamp) / 1000);
      if (diffSec < 60) return 'Just now';
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) return `${diffMin}m ago`;
      const diffHr = Math.floor(diffMin / 60);
      if (diffHr < 24) return `${diffHr}h ago`;
      return `${Math.floor(diffHr / 24)}d ago`;
    };

    listEl.innerHTML = receipts.slice(0, 15).map((r) => {
      const dotColor = r.result === 'SUCCESS' ? 'var(--status-green)' : r.result === 'FAILED' ? 'var(--status-red)' : 'var(--text-muted)';
      return `
        <div class="task-history-item" data-id="${escape(r.id)}" title="${escape(r.task)}">
          <span class="task-history-title">${escape(r.task || 'Untitled Task')}</span>
          <span class="task-history-meta">
            <span class="status-dot" style="background:${dotColor}"></span>
            <span>${r.result} · ${formatRelativeTime(r.timestamp)}</span>
          </span>
        </div>
      `;
    }).join('');

    listEl.querySelectorAll<HTMLElement>('.task-history-item').forEach((item) => {
      item.addEventListener('click', () => {
        const id = item.getAttribute('data-id');
        if (id) this.callbacks.onSelectHistoricalTask(id);
      });
    });
  }

  update(state: DashboardAgentState): void {
    this.latestState = state;

    const currentGroup = this.container.querySelector('#sidebar-current-task-group') as HTMLElement | null;
    const currentTitle = this.container.querySelector('#sidebar-current-task-title');
    const currentStatus = this.container.querySelector('#sidebar-current-task-status');

    if (state.task && state.status !== 'IDLE') {
      if (currentGroup) currentGroup.style.display = 'flex';
      if (currentTitle) currentTitle.textContent = state.task;
      if (currentStatus) currentStatus.textContent = state.status;
    } else {
      if (currentGroup) currentGroup.style.display = 'none';
    }

    const sensitiveMetric = this.container.querySelector('#sidebar-sensitive-metric');
    if (sensitiveMetric) {
      if (state.sensitiveItemsCount > 0) {
        sensitiveMetric.textContent = `${state.sensitiveItemsCount} elements masked (0 transmitted)`;
      } else {
        sensitiveMetric.textContent = '0 bytes transmitted (zero-leak)';
      }
    }
  }
}
