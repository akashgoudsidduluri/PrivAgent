/**
 * PrivAgent — Secondary Drawer / Modal Component (Phase 18)
 *
 * Hosts secondary developer / benchmark / audit views (Privacy Receipts,
 * SIH Evaluation, System Architecture) without cluttering the primary
 * AI agent workspace.
 */

import { DashboardAgentState } from '../types/dashboard';
import { AgentAdapter } from '../adapters/agentAdapter';
import { PrivacyCenterView } from '../views/privacyCenterView';
import { EvaluationView } from '../views/evaluationView';
import { SystemView } from '../views/systemView';

export class SecondaryDrawer {
  private overlay: HTMLElement;
  private adapter: AgentAdapter;
  private activeTab = 'evaluation';

  private privacyView!: PrivacyCenterView;
  private evaluationView!: EvaluationView;
  private systemView!: SystemView;

  constructor(overlay: HTMLElement, adapter: AgentAdapter) {
    this.overlay = overlay;
    this.adapter = adapter;
    this.render();
  }

  private render(): void {
    this.overlay.innerHTML = `
      <div class="drawer-modal-card">
        <div class="drawer-modal-header">
          <div class="drawer-nav-tabs">
            <button class="drawer-tab-btn" data-tab="privacy">Privacy Firewall &amp; Receipts</button>
            <button class="drawer-tab-btn active" data-tab="evaluation">SIH Evaluation Matrix</button>
            <button class="drawer-tab-btn" data-tab="system">System Architecture</button>
          </div>
          <button id="drawer-btn-close" class="drawer-close-btn" title="Close (Esc)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div class="drawer-modal-body">
          <div id="drawer-content-privacy" style="display:none"></div>
          <div id="drawer-content-evaluation"></div>
          <div id="drawer-content-system" style="display:none"></div>
        </div>
      </div>
    `;

    // Instantiate auxiliary views into the drawer containers
    this.privacyView = new PrivacyCenterView(this.overlay.querySelector('#drawer-content-privacy')!);
    this.evaluationView = new EvaluationView(this.overlay.querySelector('#drawer-content-evaluation')!);
    this.systemView = new SystemView(this.overlay.querySelector('#drawer-content-system')!, this.adapter);

    // Close button
    const closeBtn = this.overlay.querySelector('#drawer-btn-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.close());
    }

    // Backdrop click
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    // Escape key
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.overlay.classList.contains('active')) {
        this.close();
      }
    });

    // Tab buttons
    this.overlay.querySelectorAll<HTMLElement>('.drawer-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        if (tab) this.switchTab(tab);
      });
    });
  }

  open(tab = 'evaluation'): void {
    this.switchTab(tab);
    this.overlay.classList.add('active');
  }

  close(): void {
    this.overlay.classList.remove('active');
  }

  switchTab(tab: string): void {
    this.activeTab = tab;

    this.overlay.querySelectorAll<HTMLElement>('.drawer-tab-btn').forEach((btn) => {
      if (btn.getAttribute('data-tab') === tab) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    const privEl = this.overlay.querySelector('#drawer-content-privacy') as HTMLElement | null;
    const evalEl = this.overlay.querySelector('#drawer-content-evaluation') as HTMLElement | null;
    const sysEl = this.overlay.querySelector('#drawer-content-system') as HTMLElement | null;

    if (privEl) privEl.style.display = tab === 'privacy' ? 'block' : 'none';
    if (evalEl) evalEl.style.display = tab === 'evaluation' ? 'block' : 'none';
    if (sysEl) sysEl.style.display = tab === 'system' ? 'block' : 'none';
  }

  update(state: DashboardAgentState): void {
    this.privacyView.update(state);
    this.evaluationView.update(state);
    this.systemView.update(state);
  }
}
