/**
 * PrivAgent — Modern AI Agent Interface Controller (Phase 18)
 *
 * Implements the ChatGPT-style AI agent interface:
 * - Persistent left sidebar with session history & privacy status
 * - Minimal top header with live privacy state
 * - Central conversation workspace with real agent response panel
 * - Agent activity timeline stream with safe summaries
 * - Browser state & destination verification display
 * - Local privacy visualizer card (zero raw PII)
 * - Modern bottom task composer wired directly to AgentAdapter
 * - Secondary drawer for deep benchmarks and architecture views
 */

import './styles/theme.css';
import './styles/main.css';

import { DashboardAgentState, BackendHealthState } from './types/dashboard';
import { AgentAdapter } from './adapters/agentAdapter';
import { ExtensionAgentAdapter } from './adapters/extensionAdapter';
import { receiptsStore } from './state/receiptsStore';

import { TopHeader } from './components/topHeader';
import { Sidebar } from './components/sidebar';
import { AgentWorkspace } from './components/agentWorkspace';
import { TaskComposer } from './components/taskComposer';
import { SecondaryDrawer } from './components/secondaryDrawer';

class App {
  private adapter: AgentAdapter;

  private topHeader!: TopHeader;
  private sidebar!: Sidebar;
  private workspace!: AgentWorkspace;
  private composer!: TaskComposer;
  private secondaryDrawer!: SecondaryDrawer;

  private healthTimer: ReturnType<typeof setTimeout> | null = null;
  private latestHealth: BackendHealthState | null = null;
  private isConnected = false;

  constructor() {
    this.adapter = new ExtensionAgentAdapter();
    if (typeof window !== 'undefined') {
      (window as any).__app = this;
      (window as any).__adapter = this.adapter;
    }
    this.init();
  }

  private init(): void {
    const topbarEl = document.getElementById('app-topbar')!;
    const sidebarEl = document.getElementById('app-sidebar')!;
    const workspaceEl = document.getElementById('app-workspace')!;
    const composerEl = document.getElementById('app-composer')!;
    const drawerEl = document.getElementById('app-secondary-drawer')!;

    // 1. Instantiate Secondary Drawer first so callbacks can open it
    this.secondaryDrawer = new SecondaryDrawer(drawerEl, this.adapter);

    // 2. Instantiate Top Header
    this.topHeader = new TopHeader(topbarEl, {
      onToggleSidebar: () => this.toggleSidebar(),
      onOpenDrawer: (tab) => this.secondaryDrawer.open(tab),
    });

    // 3. Instantiate Sidebar
    this.sidebar = new Sidebar(sidebarEl, {
      onNewTask: () => this.handleNewTask(),
      onSelectHistoricalTask: (id) => this.handleSelectHistoricalTask(id),
      onOpenDrawer: (tab) => this.secondaryDrawer.open(tab),
    });

    // 4. Instantiate Agent Workspace
    this.workspace = new AgentWorkspace(workspaceEl, {
      onPresetSelected: (prompt) => {
        this.composer.setTaskPrompt(prompt);
      },
      onConfirmAction: () => {
        if (this.adapter.confirmAction) {
          this.adapter.confirmAction(true);
        }
      },
      onCancelAction: () => {
        if (this.adapter.confirmAction) {
          this.adapter.confirmAction(false);
        } else {
          this.adapter.stopTask();
        }
      },
      onRetryTask: (task) => {
        this.composer.setTaskPrompt(task);
        this.adapter.startTask(task);
      },
    });

    // 5. Instantiate Task Composer
    this.composer = new TaskComposer(composerEl, {
      onSubmitTask: (task) => {
        this.adapter.startTask(task);
      },
      onStopTask: () => {
        this.adapter.stopTask();
      },
    });

    // 6. Setup Global Keyboard Shortcuts
    this.setupKeyboardShortcuts();

    // 7. Subscribe to Adapter State Updates
    this.adapter.onStateChange((state) => this.handleStateChange(state));

    // 8. Extension connection updates
    if (this.adapter.onExtensionStatusChange) {
      this.adapter.onExtensionStatusChange((connected) => {
        this.isConnected = connected;
        this.topHeader.update(this.adapter.getState(), this.isConnected, this.latestHealth ?? undefined);
      });
    }

    // 9. Initial health check
    this.scheduleHealthCheck(0);

    // 10. Initial state render
    this.handleStateChange(this.adapter.getState());
  }

  private toggleSidebar(): void {
    const sidebarEl = document.getElementById('app-sidebar');
    if (!sidebarEl) return;
    sidebarEl.classList.toggle('collapsed');
    localStorage.setItem('privagent_sidebar_collapsed', sidebarEl.classList.contains('collapsed').toString());
  }

  private handleNewTask(): void {
    // Reset workspace to clean empty state ready for composer
    this.composer.setTaskPrompt('');
    const state = this.adapter.getState();
    if (state.status === 'RUNNING') {
      this.adapter.stopTask();
    }
    // Show empty state hero
    const emptyState: DashboardAgentState = {
      ...this.adapter.getState(),
      task: '',
      status: 'IDLE',
      steps: [],
      currentStep: 0,
      interaction: undefined,
      // DYNAMIC TASK-AWARE UI — a fresh workspace carries no provenance and
      // no supersession from the previous message.
      answerSource: undefined,
      supersededPreviousTask: undefined,
      currentPipelineStage: 'IDLE',
    };
    this.workspace.clearHistory();
    this.workspace.update(emptyState);
    this.sidebar.update(emptyState);
    this.topHeader.update(emptyState, this.isConnected, this.latestHealth ?? undefined);
    this.composer.update(emptyState);
  }

  private handleSelectHistoricalTask(receiptId: string): void {
    const receipt = receiptsStore.getById(receiptId);
    if (!receipt) return;
    this.workspace.showHistoricalReceipt(receipt);
  }

  private setupKeyboardShortcuts(): void {
    window.addEventListener('keydown', (e) => {
      // Ctrl+B: Toggle Sidebar
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        this.toggleSidebar();
      }
      // Alt+N: New Task
      if (e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        this.handleNewTask();
      }
    });

    // Restore persisted sidebar state
    if (localStorage.getItem('privagent_sidebar_collapsed') === 'true') {
      const sidebarEl = document.getElementById('app-sidebar');
      if (sidebarEl) sidebarEl.classList.add('collapsed');
    }
  }

  private handleStateChange(state: DashboardAgentState): void {
    // Forward to all components
    this.topHeader.update(state, this.isConnected, this.latestHealth ?? undefined);
    this.sidebar.update(state);
    this.workspace.update(state);
    this.composer.update(state);
    this.secondaryDrawer.update(state);
  }

  private scheduleHealthCheck(delayMs: number): void {
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.healthTimer = setTimeout(() => this.checkBackendHealth(), delayMs);
  }

  private async checkBackendHealth(): Promise<void> {
    try {
      const health = await this.adapter.checkHealth();
      this.latestHealth = health;
      this.topHeader.update(this.adapter.getState(), this.isConnected, this.latestHealth);
    } catch {
      // offline
    }
  }
}

// Bootstrap application on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new App());
} else {
  new App();
}
