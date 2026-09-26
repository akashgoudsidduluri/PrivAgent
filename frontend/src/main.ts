import './styles/theme.css';
import './styles/main.css';

import { DashboardTab, DashboardAgentState, BackendHealthState } from './types/dashboard';
import { AgentAdapter } from './adapters/agentAdapter';
import { DevMockAgentAdapter } from './adapters/devMockAdapter';
import { ExtensionAgentAdapter } from './adapters/extensionAdapter';

import { OverviewView } from './views/overviewView';
import { AgentView } from './views/agentView';
import { BrowserView } from './views/browserView';
import { PrivacyCenterView } from './views/privacyCenterView';
import { EvaluationView } from './views/evaluationView';
import { EvidenceView } from './views/evidenceView';
import { ActivityView } from './views/activityView';
import { SystemView } from './views/systemView';

class App {
  private adapter: AgentAdapter;
  private currentTab: DashboardTab = 'overview';

  private overviewView!: OverviewView;
  private agentView!: AgentView;
  private browserView!: BrowserView;
  private privacyCenterView!: PrivacyCenterView;
  private evaluationView!: EvaluationView;
  private evidenceView!: EvidenceView;
  private activityView!: ActivityView;
  private systemView!: SystemView;

  private healthTimer: ReturnType<typeof setTimeout> | null = null;
  private latestHealth: BackendHealthState | null = null;

  constructor() {
    // Primary adapter is LIVE Chrome Extension
    this.adapter = new ExtensionAgentAdapter();
    this.init();
  }

  private init(): void {
    // Instantiate all 8 primary views
    this.overviewView = new OverviewView(document.getElementById('view-overview')!, this.adapter);
    this.agentView = new AgentView(document.getElementById('view-agent')!, this.adapter);
    this.browserView = new BrowserView(document.getElementById('view-browser')!, this.adapter);
    this.privacyCenterView = new PrivacyCenterView(document.getElementById('view-privacy')!);
    this.evaluationView = new EvaluationView(document.getElementById('view-evaluation')!);
    this.evidenceView = new EvidenceView(document.getElementById('view-evidence')!);
    this.activityView = new ActivityView(document.getElementById('view-activity')!);
    this.systemView = new SystemView(document.getElementById('view-system')!, this.adapter);

    // Setup sidebar collapse
    this.setupSidebar();

    // Setup navigation
    this.setupNavigation();

    // Setup topbar quick buttons
    this.setupTopbarControls();

    // Subscribe to state updates
    this.adapter.onStateChange((state) => this.handleStateChange(state));

    // Extension status updates
    if (this.adapter.onExtensionStatusChange) {
      this.adapter.onExtensionStatusChange((connected) => {
        this.updateExtensionStatus(connected);
      });
    }

    // Health checks
    this.scheduleHealthCheck(0);
    window.addEventListener('request-health-check', () => this.scheduleHealthCheck(0));

    // Initial state render
    this.handleStateChange(this.adapter.getState());
  }

  private setupSidebar(): void {
    const sidebar = document.getElementById('app-sidebar');
    const toggleBtn = document.getElementById('sidebar-toggle-btn');
    if (!sidebar || !toggleBtn) return;

    // Restore persisted sidebar state
    const isCollapsed = localStorage.getItem('privagent_sidebar_collapsed') === 'true';
    if (isCollapsed) {
      sidebar.classList.add('collapsed');
    }

    const toggle = () => {
      sidebar.classList.toggle('collapsed');
      localStorage.setItem('privagent_sidebar_collapsed', sidebar.classList.contains('collapsed').toString());
    };

    toggleBtn.addEventListener('click', toggle);

    // Keyboard shortcut Ctrl+B
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggle();
      }
    });
  }

  private setupNavigation(): void {
    const navItems = document.querySelectorAll<HTMLElement>('.nav-item');
    navItems.forEach((item) => {
      item.addEventListener('click', () => {
        const tab = item.getAttribute('data-tab') as DashboardTab;
        if (tab) this.switchTab(tab);
      });
    });

    const statusExtensionPill = document.getElementById('status-extension-pill');
    if (statusExtensionPill) {
      statusExtensionPill.addEventListener('click', () => {
        if (this.adapter.isDevMock()) {
          this.switchAdapter(new ExtensionAgentAdapter());
        } else {
          this.switchAdapter(new DevMockAgentAdapter());
        }
      });
    }
  }

  private setupTopbarControls(): void {
    const runBtn = document.getElementById('topbar-run-btn');
    const stopBtn = document.getElementById('topbar-stop-btn');
    const settingsBtn = document.getElementById('topbar-settings-btn');

    if (runBtn) {
      runBtn.addEventListener('click', () => {
        this.switchTab('agent');
        const input = document.getElementById('agent-task-input') as HTMLTextAreaElement;
        if (input) input.focus();
      });
    }

    if (stopBtn) {
      stopBtn.addEventListener('click', () => {
        this.adapter.stopTask();
      });
    }

    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => {
        this.switchTab('system');
      });
    }
  }

  private switchTab(tab: DashboardTab): void {
    this.currentTab = tab;

    // Update nav items
    document.querySelectorAll<HTMLElement>('.nav-item').forEach((item) => {
      if (item.getAttribute('data-tab') === tab) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    // Update view containers
    document.querySelectorAll<HTMLElement>('.view-container').forEach((vc) => {
      if (vc.id === `view-${tab}`) {
        vc.classList.add('active');
      } else {
        vc.classList.remove('active');
      }
    });
  }

  private switchAdapter(newAdapter: AgentAdapter): void {
    if (this.adapter.destroy) {
      this.adapter.destroy();
    }
    this.adapter = newAdapter;

    this.overviewView = new OverviewView(document.getElementById('view-overview')!, this.adapter);
    this.agentView = new AgentView(document.getElementById('view-agent')!, this.adapter);
    this.browserView = new BrowserView(document.getElementById('view-browser')!, this.adapter);
    this.systemView = new SystemView(document.getElementById('view-system')!, this.adapter);

    this.adapter.onStateChange((state) => this.handleStateChange(state));
    if (this.adapter.onExtensionStatusChange) {
      this.adapter.onExtensionStatusChange((connected) => {
        this.updateExtensionStatus(connected);
      });
    }

    this.updateExtensionStatus(this.adapter.isDevMock() ? false : this.adapter.isExtensionConnected?.() ?? true);
    this.handleStateChange(this.adapter.getState());
  }

  private handleStateChange(state: DashboardAgentState): void {
    // Propagate to all active views
    this.overviewView.update(state);
    this.agentView.update(state);
    this.browserView.update(state);
    this.privacyCenterView.update(state);
    this.evaluationView.update(state);
    this.evidenceView.update(state);
    this.activityView.update(state);
    this.systemView.update(state);

    // Update Bottom Status Bar
    const statusbarStage = document.getElementById('statusbar-stage');
    if (statusbarStage) {
      statusbarStage.textContent = state.currentPipelineStage || 'IDLE';
    }

    const statusbarTarget = document.getElementById('statusbar-target');
    if (statusbarTarget) {
      statusbarTarget.textContent = state.currentUrl || 'No Target';
    }

    // Topbar Stop Button state
    const topbarStopBtn = document.getElementById('topbar-stop-btn') as HTMLButtonElement;
    if (topbarStopBtn) {
      topbarStopBtn.disabled = state.status !== 'RUNNING';
    }
  }

  private updateExtensionStatus(connected: boolean): void {
    const dot = document.getElementById('status-extension-dot');
    const label = document.getElementById('status-extension-label');
    if (!dot || !label) return;

    if (this.adapter.isDevMock()) {
      dot.className = 'status-dot amber';
      label.textContent = 'DEV MOCK (Simulation)';
    } else if (connected) {
      dot.className = 'status-dot green';
      label.textContent = 'Extension CONNECTED';
    } else {
      dot.className = 'status-dot red';
      label.textContent = 'Extension DISCONNECTED';
    }
  }

  private scheduleHealthCheck(delayMs: number): void {
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.healthTimer = setTimeout(() => this.checkBackendHealth(), delayMs);
  }

  private async checkBackendHealth(): Promise<void> {
    try {
      const resp = await fetch('http://127.0.0.1:8010/api/v1/health');
      if (resp.ok) {
        const data = await resp.json();
        this.latestHealth = {
          online: true,
          service: data.service,
          backend_status: data.backend_status || 'CONNECTED',
          reasoner: data.reasoner || 'groq',
          reasoner_status: data.reasoner_status || 'AVAILABLE',
          reasoner_configured: Boolean(data.reasoner_configured),
          model: data.model || 'openai/gpt-oss-20b',
          fallback_reasoner: data.fallback_reasoner || 'openrouter',
          fallback_configured: Boolean(data.fallback_configured),
          privacy_firewall: data.privacy_firewall || 'ACTIVE',
          sensitive_data_sent: data.sensitive_data_sent || 0,
        };
      } else {
        this.latestHealth = {
          online: false,
          service: 'PrivAgent Safety API',
          backend_status: 'OFFLINE',
          reasoner: 'groq',
          reasoner_status: 'ERROR',
          reasoner_configured: false,
          privacy_firewall: 'ACTIVE',
          sensitive_data_sent: 0,
        };
      }
    } catch {
      this.latestHealth = {
        online: false,
        service: 'PrivAgent Safety API',
        backend_status: 'OFFLINE',
        reasoner: 'groq',
        reasoner_status: 'UNREACHABLE',
        reasoner_configured: false,
        privacy_firewall: 'ACTIVE',
        sensitive_data_sent: 0,
      };
    }

    this.updateTopbarHealthIndicators(this.latestHealth);
    this.overviewView.updateHealth(this.latestHealth);
    this.systemView.updateHealth(this.latestHealth);

    // Poll health periodically
    this.scheduleHealthCheck(5000);
  }

  private updateTopbarHealthIndicators(h: BackendHealthState): void {
    const bDot = document.getElementById('top-backend-dot');
    const bVal = document.getElementById('top-backend-val');
    const rDot = document.getElementById('top-reasoner-dot');
    const rVal = document.getElementById('top-reasoner-val');
    const tDot = document.getElementById('top-target-dot');
    const tVal = document.getElementById('top-target-val');

    if (bDot && bVal) {
      if (h.online) {
        bDot.className = 'status-dot green';
        bVal.textContent = 'Connected';
      } else {
        bDot.className = 'status-dot red';
        bVal.textContent = 'Offline';
      }
    }

    if (rDot && rVal) {
      const reasonerName = h.reasoner ? h.reasoner.toUpperCase() : 'GROQ';
      if (h.reasoner_status === 'AVAILABLE') {
        rDot.className = 'status-dot green';
        rVal.textContent = `${reasonerName} (Ready)`;
      } else if (h.reasoner_status === 'RATE_LIMITED') {
        rDot.className = 'status-dot amber';
        rVal.textContent = `${reasonerName} (429)`;
      } else {
        rDot.className = 'status-dot gray';
        rVal.textContent = `${reasonerName} (${h.reasoner_status})`;
      }
    }

    if (tDot && tVal) {
      tDot.className = 'status-dot green';
      tVal.textContent = 'localhost:4174';
    }
  }
}

// Instantiate on load
window.addEventListener('DOMContentLoaded', () => {
  new App();
});
