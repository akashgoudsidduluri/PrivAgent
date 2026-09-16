import './styles/theme.css';
import './styles/main.css';

import { DashboardTab, DashboardAgentState } from './types/dashboard';
import { AgentAdapter } from './adapters/agentAdapter';
import { DevMockAgentAdapter } from './adapters/devMockAdapter';
import { ExtensionAgentAdapter } from './adapters/extensionAdapter';

import { AgentView } from './views/agentView';
import { PrivacyCenterView } from './views/privacyCenterView';
import { ReceiptsView } from './views/receiptsView';
import { ActivityView } from './views/activityView';
import { SettingsView } from './views/settingsView';

class App {
  private adapter: AgentAdapter;
  private currentTab: DashboardTab = 'agent';

  private agentView!: AgentView;
  private privacyCenterView!: PrivacyCenterView;
  private receiptsView!: ReceiptsView;
  private activityView!: ActivityView;
  private settingsView!: SettingsView;
  private healthTimer: any = null;

  constructor() {
    // PRIMARY & DEFAULT: Real Extension Adapter (LIVE Mode)
    this.adapter = new ExtensionAgentAdapter();
    this.init();
  }

  private init(): void {
    // Instantiate views
    const vAgent = document.getElementById('view-agent')!;
    const vActivity = document.getElementById('view-activity')!;
    const vPrivacy = document.getElementById('view-privacy')!;
    const vReceipts = document.getElementById('view-receipts')!;
    const vSettings = document.getElementById('view-settings')!;

    this.agentView = new AgentView(vAgent, this.adapter);
    this.activityView = new ActivityView(vActivity);
    this.privacyCenterView = new PrivacyCenterView(vPrivacy);
    this.receiptsView = new ReceiptsView(vReceipts);
    this.settingsView = new SettingsView(vSettings);

    // Setup navigation
    this.setupNavigation();

    // Subscribe to state updates
    this.adapter.onStateChange((state) => this.handleStateChange(state));

    // Extension status listener
    if (this.adapter.onExtensionStatusChange) {
      this.adapter.onExtensionStatusChange((connected) => {
        this.updateModeBadge(connected);
      });
    } else {
      this.updateModeBadge(false);
    }

    // Health check with backoff and click-to-refresh
    this.scheduleHealthCheck(0);
    const backendIndicator = document.getElementById('backend-indicator');
    if (backendIndicator) {
      backendIndicator.style.cursor = 'pointer';
      backendIndicator.title = 'Click to re-check backend status (Run "npm run dev:backend" to start)';
      backendIndicator.addEventListener('click', () => this.scheduleHealthCheck(0));
    }

    // Header privacy badge navigation to Privacy Center
    const headerPill = document.getElementById('header-privacy-pill');
    if (headerPill) {
      headerPill.addEventListener('click', () => {
        this.switchTab('privacy');
      });
    }

    // Initial render
    this.handleStateChange(this.adapter.getState());
  }

  private updateModeBadge(connected: boolean): void {
    const modeBadge = document.getElementById('mode-badge');
    if (!modeBadge) return;

    if (this.adapter.isDevMock()) {
      modeBadge.className = 'mode-badge dev-mock';
      modeBadge.innerHTML = '⚡ DEV MODE (Simulation)';
      modeBadge.title = 'Click to switch to LIVE (Real Extension)';
    } else {
      if (connected) {
        modeBadge.className = 'mode-badge live-connected';
        modeBadge.innerHTML = '<span class="pulse-dot"></span> LIVE';
        modeBadge.title = 'Real Chrome Extension connected. Click to switch to Dev Mode.';
      } else {
        modeBadge.className = 'mode-badge live-disconnected';
        modeBadge.innerHTML = '● Extension Disconnected';
        modeBadge.title = 'Extension not detected. Click to switch to Dev Mode or check chrome://extensions.';
      }
    }
  }

  private setupNavigation(): void {
    const navItems = document.querySelectorAll<HTMLElement>('.nav-item');
    navItems.forEach((item) => {
      item.addEventListener('click', () => {
        const tab = item.getAttribute('data-tab') as DashboardTab;
        if (tab) this.switchTab(tab);
      });
    });

    // Dev mode badge click toggles adapter
    const modeBadge = document.getElementById('mode-badge');
    if (modeBadge) {
      modeBadge.addEventListener('click', () => {
        if (this.adapter.isDevMock()) {
          this.switchAdapter(new ExtensionAgentAdapter());
        } else {
          this.switchAdapter(new DevMockAgentAdapter());
        }
      });
    }
  }

  private switchAdapter(newAdapter: AgentAdapter): void {
    if ((this.adapter as any).destroy) {
      (this.adapter as any).destroy();
    }
    this.adapter = newAdapter;
    this.agentView.setAdapter(this.adapter);

    this.adapter.onStateChange((state) => this.handleStateChange(state));
    if (this.adapter.onExtensionStatusChange) {
      this.adapter.onExtensionStatusChange((connected) => {
        this.updateModeBadge(connected);
      });
    } else {
      this.updateModeBadge(false);
    }
    this.handleStateChange(this.adapter.getState());
  }

  public switchTab(tab: DashboardTab): void {
    this.currentTab = tab;

    // Update nav active states
    document.querySelectorAll('.nav-item').forEach((el) => {
      if (el.getAttribute('data-tab') === tab) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    });

    // Update view container visibility
    document.querySelectorAll('.view-container').forEach((el) => {
      if (el.id === `view-${tab}`) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    });
  }

  private handleStateChange(state: DashboardAgentState): void {
    // Update active views
    this.agentView.update(state);
    this.privacyCenterView.update(state);
    this.activityView.update(state);

    // Update global header privacy badge
    const headerPill = document.getElementById('header-privacy-pill');
    if (headerPill) {
      headerPill.innerHTML = `
        <span class="pulse-dot cyan"></span>
        <span>🔒 On-device privacy · ${state.sensitiveItemsCount} protected</span>
      `;
    }

    // Update sidebar footer
    const footerStat = document.getElementById('footer-sensitive-stat');
    if (footerStat) {
      footerStat.innerHTML = `<span>🔒</span> ${state.sensitiveItemsCount} items protected`;
    }
  }

  private scheduleHealthCheck(delayMs: number): void {
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.healthTimer = setTimeout(async () => {
      await this.updateHealth();
    }, delayMs);
  }

  private async updateHealth(): Promise<void> {
    const health = await this.adapter.checkHealth();
    const dot = document.getElementById('backend-status-dot');
    const label = document.getElementById('backend-status-label');

    if (dot && label) {
      if (health.online) {
        dot.className = 'backend-dot online';
        label.textContent = `Backend: Connected (${health.reasoner.split('/')[1] || health.reasoner})`;
        // If online, poll every 10 seconds
        this.scheduleHealthCheck(10000);
      } else {
        dot.className = 'backend-dot offline';
        label.textContent = 'Backend: Offline (click to retry)';
        // If offline, back off and retry every 30 seconds
        this.scheduleHealthCheck(30000);
      }
    }
  }
}

// Bootstrap with strict singleton guard to prevent duplicate listeners
declare global {
  interface Window {
    __privagent_app_instance?: App;
  }
}

function bootstrap(): void {
  if (window.__privagent_app_instance) return;
  window.__privagent_app_instance = new App();
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  bootstrap();
} else {
  document.addEventListener('DOMContentLoaded', bootstrap);
}
