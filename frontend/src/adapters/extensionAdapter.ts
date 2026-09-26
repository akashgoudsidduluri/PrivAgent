import { AgentAdapter } from './agentAdapter';
import {
  DashboardAgentState,
  BackendHealthState,
  PipelineStage,
  UIAgentStatus,
  StepTelemetry,
  AgentInteractionState,
} from '../types/dashboard';
import { receiptsStore } from '../state/receiptsStore';

/**
 * Map a Phase 14 activity phase onto this dashboard's lifecycle vocabulary.
 *
 * The projection's phases are the authority on what the agent is doing; this
 * mapping only renames them for the status bar and the watchdog message. It
 * NEVER invents a stage the projection did not report — an absent or unknown
 * phase falls back to BROWSER_EXECUTION, the same default the adapter used
 * before Phase 14 existed.
 */
function phaseToPipelineStage(phase?: string): PipelineStage {
  switch (phase) {
    case 'PERCEPTION':
      return 'PERCEPTION';
    case 'PLANNING':
      return 'LLM_REASONING';
    case 'VALIDATION':
      return 'ACTION_VALIDATION';
    case 'EXECUTION':
      return 'BROWSER_EXECUTION';
    case 'VERIFICATION':
      return 'VERIFICATION';
    case 'RECOVERY':
      return 'BROWSER_EXECUTION';
    case 'AWAITING_CONFIRMATION':
      return 'ACTION_VALIDATION';
    case 'TERMINAL':
    case 'IDLE':
      return 'IDLE';
    default:
      return 'BROWSER_EXECUTION';
  }
}

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
      currentUrl: '',
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

  private resetWatchdog(timeoutMs?: number): void {
    this.clearWatchdog();
    const effectiveTimeout = timeoutMs ?? (this.lastLifecycleStage === 'REASONING' ? 60000 : 30000);
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
    }, effectiveTimeout);
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
    // The structured Phase 14 projection is the source of truth for anything
    // user-facing. It is parsed FIRST so the stage tracker and the fallback
    // reason below read from it rather than from the legacy `reason` string,
    // which the agent loop no longer populates.
    const interaction = this.normalizeInteraction(data.interaction);

    console.info('[Adapter] response received', {
      status: data.status,
      currentStep: data.currentStep,
      hasInteraction: Boolean(interaction),
      interactionPhase: interaction?.activity.phase ?? null,
      interactionOutcome: interaction?.outcome ?? null,
    });
    console.info('[AgentTrace] dashboard received TASK_PROGRESS', {
      status: data.status,
      currentStep: data.currentStep,
      hasInteraction: Boolean(interaction),
      interactionPhase: interaction?.activity.phase ?? null,
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
      // The stage is derived from the STRUCTURED projection. Two bugs lived
      // here. First, `currentPipelineStage` was hardcoded to
      // BROWSER_EXECUTION, so the status bar showed "BROWSER_EXECUTION" for an
      // entire run no matter what the agent was actually doing. Second, the
      // watchdog's `lastLifecycleStage` fell back to sniffing the legacy
      // `reason` string for the substring "perception", but `reason` is no
      // longer populated by the agent loop, so that branch could never fire
      // either. Both now read the one field that is actually authoritative.
      stage = data.stage
        ? (data.stage as PipelineStage)
        : phaseToPipelineStage(interaction?.activity.phase);
      this.lastLifecycleStage = stage;
    } else {
      this.lastLifecycleStage = status;
    }

    // A legacy `reason` is only a fallback. Assigning `data.reason`
    // unconditionally overwrote a real failure reason with `undefined` on every
    // progress message, and the receipt written on a FAILED run recorded
    // `error: undefined`. Prefer the structured terminal outcome, which always
    // carries a screened, value-free headline.
    const terminalReason = interaction?.terminal?.headline || interaction?.terminal?.reason || '';
    const resolvedReason = data.reason || terminalReason || undefined;

    const steps: StepTelemetry[] = (data.steps || []).map((s: any, idx: number) => {
      let targetDescription = s.action?.target || s.action?.url;
      if (!targetDescription) {
        if (s.action?.action === 'scroll') {
          targetDescription = `Scroll ${s.action.direction || 'down'} (${s.action.amount || 250}px)`;
        } else if (s.action?.action === 'wait') {
          targetDescription = `Wait ${s.action.durationMs || 500}ms`;
        } else {
          targetDescription = `Step ${idx + 1}`;
        }
      }
      return {
        step: s.step || idx + 1,
        actionType: s.action?.action || 'unknown',
        targetDescription,
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
        semanticContext: s.semanticContext,
      };
    });

    const latestStep = steps.length > 0 ? steps[steps.length - 1] : undefined;

    const rawCandidateUrl =
      data.currentUrl ||
      data.targetUrl ||
      latestStep?.semanticContext?.url ||
      (data.steps && data.steps.length > 0 ? data.steps[data.steps.length - 1].url : undefined);

    const isDashboardHost = (url?: string) => Boolean(url && window?.location?.host && url.includes(window.location.host));

    let currentUrl = this.state.currentUrl;
    if (rawCandidateUrl && !isDashboardHost(rawCandidateUrl)) {
      currentUrl = rawCandidateUrl;
    } else if (isDashboardHost(currentUrl)) {
      currentUrl = '';
    }

    this.state = {
      ...this.state,
      status,
      currentStep: data.currentStep || steps.length,
      currentPipelineStage: stage,
      currentUrl,
      reason: resolvedReason,
      pageType: data.pageType || latestStep?.semanticContext?.pageType,
      candidateEntities: data.candidateEntities || latestStep?.semanticContext?.entities,
      semanticContext: data.semanticContext || latestStep?.semanticContext,
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
      // Phase 14: the interaction projection is built and SCREENED in the
      // service worker, immediately before it crosses the SW → dashboard
      // boundary. The UI consumes it verbatim and re-filters nothing — a
      // frontend filter would be display-time cosmetics, not a privacy
      // boundary. An absent or malformed projection degrades to `undefined`
      // and the view falls back to its previous rendering.
      interaction,
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
        error: resolvedReason,
        steps: [...steps],
      });
    }

    this.notify();
  }

  /**
   * Validate the shape of the Phase 14 interaction projection.
   *
   * This is DEFENSIVE PARSING, not privacy screening: screening already
   * happened in the service worker. Its only job is to keep a malformed
   * payload from reaching the render path.
   */
  private normalizeInteraction(raw: any): AgentInteractionState | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    if (typeof raw.outcome !== 'string' || typeof raw.activity !== 'object' || !raw.activity) {
      return undefined;
    }
    if (typeof raw.activity.phase !== 'string' || typeof raw.activity.summary !== 'string') {
      return undefined;
    }
    const result = raw.result && typeof raw.result === 'object' ? raw.result : { kind: 'NONE', summary: 'No result yet.', count: 0, items: [] };
    return {
      outcome: raw.outcome,
      activity: {
        phase: raw.activity.phase,
        summary: raw.activity.summary,
        step: Number(raw.activity.step) || 0,
        maxSteps: Number(raw.activity.maxSteps) || 0,
        cycle: typeof raw.activity.cycle === 'number' ? raw.activity.cycle : null,
      },
      terminal: raw.terminal && typeof raw.terminal === 'object'
        ? {
            outcome: raw.terminal.outcome,
            reason: raw.terminal.reason,
            headline: String(raw.terminal.headline ?? ''),
          }
        : null,
      result: {
        kind: result.kind ?? 'NONE',
        summary: String(result.summary ?? ''),
        count: Number(result.count) || 0,
        items: Array.isArray(result.items)
          ? result.items.slice(0, 20).map((it: any) => ({
              id: String(it?.id ?? ''),
              title: String(it?.title ?? ''),
              detail: String(it?.detail ?? ''),
            }))
          : [],
      },
      artifacts: Array.isArray(raw.artifacts)
        ? raw.artifacts.slice(0, 20).map((a: any) => ({ kind: a?.kind, label: String(a?.label ?? '') }))
        : [],
      timeline: Array.isArray(raw.timeline)
        ? raw.timeline.slice(0, 40).map((t: any) => ({
            step: Number(t?.step) || 0,
            action: String(t?.action ?? 'unknown'),
            outcome: t?.outcome ?? 'EXECUTED',
          }))
        : [],
      awaitingConfirmation: raw.awaitingConfirmation && typeof raw.awaitingConfirmation === 'object'
        ? {
            action: String(raw.awaitingConfirmation.action ?? ''),
            description: String(raw.awaitingConfirmation.description ?? ''),
            riskLevel: String(raw.awaitingConfirmation.riskLevel ?? 'HIGH'),
          }
        : null,
    } as AgentInteractionState;
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
        currentUrl: '',
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
