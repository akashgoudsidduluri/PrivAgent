/**
 * PrivAgent — Modern Top Header Component (Phase 18)
 *
 * Requirements:
 * Minimal top header showing PrivAgent wordmark, and a clear privacy/security
 * indicator such as "● Privacy Protected" reflecting actual application state.
 */

import { DashboardAgentState, BackendHealthState } from '../types/dashboard';

export interface TopHeaderCallbacks {
  onToggleSidebar: () => void;
  onOpenDrawer: (tab: string) => void;
}

export class TopHeader {
  private container: HTMLElement;
  private callbacks: TopHeaderCallbacks;
  private latestState: DashboardAgentState | null = null;
  private latestHealth: BackendHealthState | null = null;
  private isConnected = true;

  constructor(container: HTMLElement, callbacks: TopHeaderCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.render();
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="topbar-left">
        <button id="topbar-sidebar-toggle" class="sidebar-toggle-btn" title="Toggle Sidebar (Ctrl+B)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="3" y1="12" x2="21" y2="12"></line>
            <line x1="3" y1="6" x2="21" y2="6"></line>
            <line x1="3" y1="18" x2="21" y2="18"></line>
          </svg>
        </button>
        <div class="topbar-brand">
          <div class="brand-icon-shield">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
          </div>
          <span>PrivAgent</span>
        </div>
        <span class="topbar-pill-tag">Privacy Browser Agent</span>
      </div>

      <div class="topbar-right">
        <div id="topbar-privacy-pill" class="privacy-indicator-pill">
          <span class="status-dot"></span>
          <span id="topbar-privacy-label">Privacy Protected</span>
        </div>

        <button id="topbar-open-tools" class="topbar-action-btn" title="System & Evaluation Hub">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
          <span>Tools</span>
        </button>
      </div>
    `;

    const toggleBtn = this.container.querySelector('#topbar-sidebar-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => this.callbacks.onToggleSidebar());
    }

    const toolsBtn = this.container.querySelector('#topbar-open-tools');
    if (toolsBtn) {
      toolsBtn.addEventListener('click', () => this.callbacks.onOpenDrawer('evaluation'));
    }
  }

  update(state: DashboardAgentState, isConnected: boolean, health?: BackendHealthState): void {
    this.latestState = state;
    this.isConnected = isConnected;
    if (health) this.latestHealth = health;

    const pill = this.container.querySelector('#topbar-privacy-pill');
    const label = this.container.querySelector('#topbar-privacy-label');
    const dot = pill?.querySelector('.status-dot');

    if (!pill || !label || !dot) return;

    // Truthful state reflection
    if (state.status === 'RUNNING') {
      pill.className = 'privacy-indicator-pill running';
      dot.className = 'status-dot pulse';
      const stage = state.currentPipelineStage ? state.currentPipelineStage.replace('_', ' ') : 'Agent active';
      label.textContent = `Scanning locally · ${stage}`;
    } else if (state.status === 'NEEDS_USER_CONFIRMATION') {
      pill.className = 'privacy-indicator-pill waiting';
      dot.className = 'status-dot pulse';
      label.textContent = 'Waiting for confirmation';
    } else if (state.status === 'SUCCESS') {
      pill.className = 'privacy-indicator-pill';
      dot.className = 'status-dot';
      label.textContent = 'Privacy Protected · Completed';
    } else if (state.status === 'FAILED') {
      pill.className = 'privacy-indicator-pill failed';
      dot.className = 'status-dot';
      label.textContent = 'Task Halted · Zero Leakage';
    } else {
      pill.className = 'privacy-indicator-pill';
      dot.className = 'status-dot';
      label.textContent = this.isConnected ? 'Privacy Protected' : 'Offline';
    }
  }
}
