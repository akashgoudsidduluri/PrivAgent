import { AgentAdapter } from './agentAdapter';
import {
  DashboardAgentState,
  BackendHealthState,
  PipelineStage,
  UIAgentStatus,
  StepTelemetry,
} from '../types/dashboard';
import { receiptsStore } from '../state/receiptsStore';

export class ExtensionAgentAdapter implements AgentAdapter {
  private state: DashboardAgentState;
  private listeners: Array<(state: DashboardAgentState) => void> = [];
  private taskStartTime = 0;
  private extensionConnected = false;
  private pingListeners: Array<(connected: boolean) => void> = [];

  private isStartingTask = false;
  private messageBridgeHandler: ((event: MessageEvent) => void) | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.state = {
      status: 'IDLE',
      task: '',
      currentStep: 0,
      maxSteps: 10,
      currentPipelineStage: 'IDLE',
      currentUrl: window.location.href,
      steps: [],
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
    };

    this.setupMessageBridge();
    // Initial ping with slight delay so the page and content script settle
    setTimeout(() => this.checkExtensionConnected(), 200);
    // Periodic re-check every 15s so status recovers if extension loads late
    this.pingInterval = setInterval(() => this.checkExtensionConnected(), 15000);
  }

  destroy(): void {
    this.clearWatchdog();
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.messageBridgeHandler) {
      window.removeEventListener('message', this.messageBridgeHandler);
      this.messageBridgeHandler = null;
    }
    this.listeners = [];
    this.pingListeners = [];
  }

  private lastLifecycleStage = 'IDLE';

  private resetWatchdog(timeoutMs = 30000): void {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      if (this.state.status === 'RUNNING') {
        const stage = this.lastLifecycleStage || 'UNKNOWN';
        console.warn(`[AgentTrace] dashboard task watchdog timed out (WATCHDOG_TIMEOUT). Last stage: ${stage}`);
        this.state = {
          ...this.state,
          status: 'FAILED',
          reason: `Task execution timed out (WATCHDOG_TIMEOUT). Last stage: ${stage}.`,
          currentPipelineStage: 'IDLE',
        };
        this.notify();
      }
    }, timeoutMs);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  isDevMock(): boolean {
    return false;
  }

  isExtensionConnected(): boolean {
    return this.extensionConnected;
  }

  async checkExtensionConnected(): Promise<boolean> {
    return new Promise((resolve) => {
      let resolved = false;
      const pingId = `adapter-${Date.now()}`;
      console.info('[Adapter][PING] PING_SENT', { pingId, origin: window.location.origin });

      const handler = (event: MessageEvent) => {
        if (
          event.data &&
          event.data.source === 'privagent-extension' &&
          event.data.type === 'PONG_EXTENSION'
        ) {
          if (resolved) return; // guard against duplicate PONG replies
          resolved = true;
          const isConnected = Boolean(event.data.connected !== false && !event.data.error);
          this.extensionConnected = isConnected;

          const details = event.data.details || {};
          const extStatus = details.extension || (isConnected ? 'CONNECTED' : 'DISCONNECTED');
          const swStatus = details.serviceWorker || (isConnected ? 'REACHABLE' : 'UNREACHABLE');
          const tabStatus = details.targetTab || 'NOT_FOUND';
          const csStatus = details.contentScript || 'NOT_INJECTED';

          console.info('[Adapter][PING] PONG_EXTENSION_RECEIVED', {
            pingId: event.data.pingId || pingId,
            connected: isConnected,
            extension: extStatus,
            serviceWorker: swStatus,
            targetTab: tabStatus,
            contentScript: csStatus,
          });
          console.info('[Adapter][PING] ADAPTER_RESOLVED', { pingId, connected: isConnected });
          console.info(`Extension: ${extStatus}`);
          console.info(`Service Worker: ${swStatus}`);
          console.info(`Target Tab: ${tabStatus}`);
          console.info(`Content Script: ${csStatus}`);

          window.removeEventListener('message', handler);
          this.notifyExtensionStatus(isConnected);
          resolve(isConnected);
        }
      };

      window.addEventListener('message', handler);

      window.postMessage(
        {
          source: 'privagent-dashboard',
          type: 'PING_EXTENSION',
          pingId,
          targetUrl: 'http://localhost:4173',
        },
        '*'
      );

      // 3000ms is now sufficient:
      // - SW now responds immediately (no ensureTargetTabReady in PING path)
      // - Worst case is: CS receives ping (5ms) + SW wakeup retry (600ms) +
      //   chrome.tabs.query (~50ms) + PONG back (~10ms) = ~665ms total.
      // - 3000ms gives 4x headroom for slow machines / SW cold-start.
      setTimeout(() => {
        if (!resolved) {
          window.removeEventListener('message', handler);
          console.warn('[Adapter][PING] PING_TIMEOUT', {
            pingId,
            afterMs: 3000,
            lastKnownConnected: this.extensionConnected,
          });
          // Keep last known connected state instead of immediately flipping to false.
          // This prevents transient timeouts from showing DISCONNECTED when extension
          // is merely slow to respond on a specific ping cycle.
          if (!this.extensionConnected) {
            console.info('Extension: DISCONNECTED (ping timeout after 3s)');
            console.info('Service Worker: UNREACHABLE');
            console.info('Target Tab: NOT_FOUND');
            console.info('Content Script: NOT_INJECTED');
            this.notifyExtensionStatus(false);
          } else {
            console.info('[Adapter][PING] timeout — keeping last connected state');
          }
          resolve(this.extensionConnected);
        }
      }, 3000);
    });
  }

  onExtensionStatusChange(callback: (connected: boolean) => void): () => void {
    this.pingListeners.push(callback);
    callback(this.extensionConnected);
    return () => {
      this.pingListeners = this.pingListeners.filter((l) => l !== callback);
    };
  }

  private notifyExtensionStatus(connected: boolean): void {
    this.pingListeners.forEach((cb) => cb(connected));
  }

  private setupMessageBridge(): void {
    this.messageBridgeHandler = (event: MessageEvent) => {
      if (!event.data || event.data.source !== 'privagent-extension') return;

      const { type, payload } = event.data;

      if (type === 'PONG_EXTENSION') {
        const isConnected = Boolean(event.data.connected !== false && !event.data.error);
        this.extensionConnected = isConnected;
        this.notifyExtensionStatus(isConnected);
      } else if (type === 'TASK_PROGRESS' && payload) {
        this.handleExtensionProgress(payload);
      } else if (type === 'PRIVACY_SCAN_UPDATE' && payload) {
        this.handlePrivacyUpdate(payload);
      }
    };
    window.addEventListener('message', this.messageBridgeHandler);
  }

  private handleExtensionProgress(data: any): void {
    console.info('[Adapter] response received', {
      status: data.status,
      currentStep: data.currentStep,
      reason: data.reason,
    });
    console.info('[AgentTrace] dashboard received TASK_PROGRESS', {
      status: data.status,
      currentStep: data.currentStep,
      reason: data.reason,
    });

    let status: UIAgentStatus = 'RUNNING';
    if (data.status === 'SUCCESS') status = 'SUCCESS';
    else if (data.status === 'FAILED') status = 'FAILED';
    else if (data.status === 'STOPPED') status = 'STOPPED';
    else if (data.status === 'NEEDS_USER_CONFIRMATION') status = 'NEEDS_USER_CONFIRMATION';

    if (status === 'SUCCESS' || status === 'FAILED' || status === 'STOPPED') {
      this.clearWatchdog();
    } else if (status === 'RUNNING') {
      this.resetWatchdog();
    }

    let stage: PipelineStage = 'IDLE';
    if (status === 'RUNNING') {
      stage = 'BROWSER_EXECUTION';
      if (data.stage) {
        this.lastLifecycleStage = data.stage;
      } else if (data.reason && String(data.reason).toLowerCase().includes('perception')) {
        this.lastLifecycleStage = 'PERCEPTION';
      } else {
        this.lastLifecycleStage = 'BROWSER_EXECUTION';
      }
    } else {
      this.lastLifecycleStage = status;
    }

    const steps: StepTelemetry[] = (data.steps || []).map((s: any, idx: number) => ({
      step: s.step || idx + 1,
      actionType: s.action?.action || 'unknown',
      targetDescription: s.action?.target || s.action?.url || `Step ${idx + 1}`,
      validationPassed: s.validationAllowed ?? true,
      validationReason: s.validationReason,
      executionSuccess: s.executionSuccess ?? true,
      executionError: s.executionError,
      sensitiveCategoryDetected: s.targetType,
      timestamp: s.timestamp || Date.now(),
      riskAssessment: s.riskAssessment,
      semanticVerification: s.semanticVerification,
      confidenceScore: s.confidenceEvaluation?.confidenceScore,
      selfHealingRecovered: s.selfHealing?.recovered,
    }));

    const latestStep = steps.length > 0 ? steps[steps.length - 1] : undefined;

    this.state = {
      ...this.state,
      status,
      currentStep: data.currentStep || steps.length,
      currentPipelineStage: stage,
      reason: data.reason,
      requiresUserConfirmationAction: data.requiresUserConfirmationAction
        ? {
            action: data.requiresUserConfirmationAction.action,
            description:
              data.requiresUserConfirmationAction.target ||
              data.requiresUserConfirmationAction.url ||
              'Consequential browser action',
            target: data.requiresUserConfirmationAction.target,
            url: data.requiresUserConfirmationAction.url,
            riskLevel: latestStep?.riskAssessment?.riskLevel || 'HIGH',
            riskScore: latestStep?.riskAssessment?.score || 0.85,
          }
        : undefined,
      steps,
      plan: data.plan,
      latestRisk: latestStep?.riskAssessment,
      latestSemantic: latestStep?.semanticVerification,
      decisionTraceSummary: data.decisionTraceSummary,
    };

    if (status === 'SUCCESS' || status === 'FAILED' || status === 'STOPPED') {
      const latency = Date.now() - this.taskStartTime;
      receiptsStore.addReceipt({
        id: `rcpt-${Date.now()}`,
        task: this.state.task,
        timestamp: Date.now(),
        result: status,
        sensitiveDetectedCount: this.state.sensitiveItemsCount,
        sensitiveTransmittedCount: 0,
        rawScreenshotsTransmitted: 0,
        rawDomTransmitted: 0,
        categoriesDetected: Object.keys(this.state.categories).filter(
          (k) => (this.state.categories as any)[k] > 0
        ),
        sanitizedContextShared: ['Button labels', 'Safe coordinates', 'Non-sensitive text'],
        llmRequestsCount: steps.length,
        browserActionsCount: steps.length,
        latencyMs: latency,
        error: data.reason,
        steps: [...steps],
      });
    }

    this.notify();
  }

  private handlePrivacyUpdate(report: any): void {
    if (!report) return;
    this.state.sensitiveItemsCount = report.sensitiveElementsDetected || 0;
    if (report.categories) {
      this.state.categories = {
        password: report.categories.password || 0,
        credit_card: report.categories.credit_card || 0,
        account_number: report.categories.account_number || 0,
        email: report.categories.email || 0,
        phone: report.categories.phone || 0,
        pan: report.categories.pan || 0,
        cvv: report.categories.cvv || 0,
        otp: report.categories.otp || 0,
      };
    }
    this.notify();
  }

  getState(): DashboardAgentState {
    return { ...this.state, steps: [...this.state.steps] };
  }

  onStateChange(callback: (state: DashboardAgentState) => void): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== callback);
    };
  }

  private notify(): void {
    const s = this.getState();
    this.listeners.forEach((cb) => cb(s));
  }

  async checkHealth(): Promise<BackendHealthState> {
    try {
      const resp = await fetch('http://127.0.0.1:8010/api/v1/health', {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) {
        const data = await resp.json();
        return {
          online: true,
          service: 'PrivAgent Agent Safety API (M7)',
          backend_status: data.backend_status || 'CONNECTED',
          reasoner: data.reasoner || 'groq',
          reasoner_status: data.reasoner_status || 'AVAILABLE',
          reasoner_configured: data.reasoner_configured ?? false,
          model: data.model || 'openai/gpt-oss-20b',
          fallback_reasoner: data.fallback_reasoner || 'openrouter',
          fallback_configured: data.fallback_configured ?? false,
          privacy_firewall: data.privacy_firewall || 'ACTIVE',
          sensitive_data_sent: data.sensitive_data_sent || 0,
        };
      }
    } catch {
      // offline
    }

    return {
      online: false,
      service: 'PrivAgent Backend (Offline)',
      backend_status: 'OFFLINE',
      reasoner: 'groq',
      reasoner_status: 'ERROR',
      reasoner_configured: false,
      privacy_firewall: 'ACTIVE',
      sensitive_data_sent: 0,
    };
  }


  async startTask(task: string): Promise<void> {
    console.info('[Adapter] START_TASK received', { taskLength: task.length });
    console.info('[AgentTrace] dashboard START_TASK received', { taskLength: task.length });

    // Genuine concurrent-task protection: reject if a task is actively being
    // dispatched (isStartingTask) OR if the agent loop is running AND the
    // watchdog is still ticking (meaning we have a live task in the SW).
    // If the watchdog has already fired (watchdogTimer===null) and state is
    // still RUNNING, the TASK_PROGRESS relay from the SW was dropped — allow
    // a fresh start by resetting the stale RUNNING state.
    const isLikelyStaleRunning =
      this.state.status === 'RUNNING' &&
      !this.isStartingTask &&
      this.watchdogTimer === null;

    if (isLikelyStaleRunning) {
      console.warn('[AgentTrace] stale RUNNING state detected (watchdog fired, relay lost) — resetting for fresh task');
      this.state = { ...this.state, status: 'FAILED', reason: 'Previous task relay was lost; starting fresh.' };
      this.notify();
    }

    if (this.state.status === 'RUNNING' || this.isStartingTask) {
      console.warn('[AgentTrace] dashboard startTask rejected: task already running or starting (genuine concurrent guard)');
      return;
    }

    this.isStartingTask = true;
    this.lastLifecycleStage = 'TARGET_RESOLUTION';
    try {
      this.taskStartTime = Date.now();

      // Check extension connectivity
      const connected = await this.checkExtensionConnected();
      if (!connected) {
        this.state = {
          ...this.state,
          task,
          status: 'FAILED',
          currentStep: 0,
          steps: [],
          reason:
            'PrivAgent Chrome Extension is not connected. Please load the extension in chrome://extensions or switch to Dev Mode to simulate UI interactions.',
          currentPipelineStage: 'IDLE',
        };
        this.notify();
        return;
      }

      this.state = {
        ...this.state,
        task,
        status: 'RUNNING',
        currentStep: 0,
        steps: [],
        reason: undefined,
        requiresUserConfirmationAction: undefined,
        currentPipelineStage: 'PERCEPTION',
      };
      this.notify();

      console.info('[AgentTrace] dashboard START_TASK posted to window', { taskLength: task.length });
      this.resetWatchdog(30000);

      window.postMessage(
        {
          source: 'privagent-dashboard',
          type: 'START_TASK',
          task,
        },
        '*'
      );
    } finally {
      this.isStartingTask = false;
    }
  }

  async stopTask(): Promise<void> {
    this.clearWatchdog();
    window.postMessage(
      {
        source: 'privagent-dashboard',
        type: 'STOP_TASK',
      },
      '*'
    );
    this.state.status = 'STOPPED';
    this.state.reason = 'Task stopped by user.';
    this.notify();
  }

  async confirmAction(allowed: boolean): Promise<void> {
    window.postMessage(
      {
        source: 'privagent-dashboard',
        type: 'CONFIRM_ACTION',
        allowed,
      },
      '*'
    );
  }
}
