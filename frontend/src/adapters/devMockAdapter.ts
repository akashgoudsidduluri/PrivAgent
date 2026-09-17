import { AgentAdapter } from './agentAdapter';
import {
  DashboardAgentState,
  BackendHealthState,
  PipelineStage,
  UIAgentStatus,
  StepTelemetry,
} from '../types/dashboard';
import { receiptsStore } from '../state/receiptsStore';

export class DevMockAgentAdapter implements AgentAdapter {
  private state: DashboardAgentState;
  private listeners: Array<(state: DashboardAgentState) => void> = [];
  private currentTimer: any = null;
  private isAborted = false;
  private startTime = 0;

  constructor() {
    this.state = {
      status: 'IDLE',
      task: '',
      currentStep: 0,
      maxSteps: 10,
      currentPipelineStage: 'IDLE',
      currentUrl: 'http://localhost:4173/bank',
      steps: [],
      sensitiveItemsCount: 6,
      categories: {
        password: 1,
        credit_card: 1,
        account_number: 1,
        email: 1,
        phone: 1,
        pan: 1,
        cvv: 0,
        otp: 0,
      },
    };
  }

  isDevMock(): boolean {
    return true;
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
        signal: AbortSignal.timeout(1500),
      });
      if (resp.ok) {
        const data = await resp.json();
        return {
          online: true,
          service: 'PrivAgent Agent Safety API (M7)',
          backend_status: data.backend_status || 'CONNECTED',
          reasoner: data.reasoner || 'groq',
          reasoner_status: data.reasoner_status || 'AVAILABLE',
          reasoner_configured: data.reasoner_configured ?? true,
          model: data.model || 'openai/gpt-oss-20b',
          fallback_reasoner: data.fallback_reasoner || 'openrouter',
          fallback_configured: data.fallback_configured ?? false,
          privacy_firewall: data.privacy_firewall || 'ACTIVE',
          sensitive_data_sent: data.sensitive_data_sent || 0,
        };
      }
    } catch {
      // Backend offline
    }

    return {
      online: false,
      service: 'PrivAgent Backend (Offline)',
      backend_status: 'OFFLINE',
      reasoner: 'mock',
      reasoner_status: 'AVAILABLE',
      reasoner_configured: false,
      privacy_firewall: 'ACTIVE',
      sensitive_data_sent: 0,
    };
  }


  async startTask(task: string): Promise<void> {
    if (!task.trim()) return;

    this.isAborted = false;
    this.startTime = Date.now();
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

    // Check if task triggers consequential confirmation
    const lower = task.toLowerCase();
    if (lower.includes('external') || lower.includes('outside domain')) {
      await this.delay(600);
      if (this.isAborted) return;
      this.state.currentPipelineStage = 'LLM_REASONING';
      this.notify();

      await this.delay(500);
      if (this.isAborted) return;
      this.state.status = 'NEEDS_USER_CONFIRMATION';
      this.state.reason = 'Action requires user confirmation: Navigating across domains.';
      this.state.requiresUserConfirmationAction = {
        action: 'navigate',
        description: 'Navigate to external authentication provider',
        url: 'https://auth-partner.external.com/verify',
      };
      this.notify();
      return;
    }

    this.runMockLoop();
  }

  private async runMockLoop(): Promise<void> {
    const mockSteps: Array<{
      action: string;
      target: string;
      category?: string;
      delay: number;
    }> = [
      { action: 'click', target: 'Account Overview Button', delay: 700 },
      { action: 'scroll', target: 'Scroll down 250px', delay: 600 },
      { action: 'click', target: 'Recent Transactions Tab', category: 'account_number', delay: 800 },
    ];

    for (let i = 0; i < mockSteps.length; i++) {
      if (this.isAborted) return;
      const s = mockSteps[i];
      this.state.currentStep = i + 1;

      // 1. Perception
      this.state.currentPipelineStage = 'PERCEPTION';
      this.notify();
      await this.delay(250);
      if (this.isAborted) return;

      // 2. Privacy Protection
      this.state.currentPipelineStage = 'PRIVACY_PROTECTION';
      this.notify();
      await this.delay(200);
      if (this.isAborted) return;

      // 3. Context Minimization
      this.state.currentPipelineStage = 'CONTEXT_MINIMIZATION';
      this.notify();
      await this.delay(180);
      if (this.isAborted) return;

      // 4. LLM Reasoning
      this.state.currentPipelineStage = 'LLM_REASONING';
      this.notify();
      await this.delay(350);
      if (this.isAborted) return;

      // 5. Action Validation
      this.state.currentPipelineStage = 'ACTION_VALIDATION';
      this.notify();
      await this.delay(150);
      if (this.isAborted) return;

      // 6. Browser Execution
      this.state.currentPipelineStage = 'BROWSER_EXECUTION';
      const stepRecord: StepTelemetry = {
        step: i + 1,
        actionType: s.action,
        targetDescription: s.target,
        validationPassed: true,
        executionSuccess: true,
        sensitiveCategoryDetected: s.category,
        timestamp: Date.now(),
      };
      this.state.steps.push(stepRecord);
      this.notify();

      await this.delay(s.delay);
      if (this.isAborted) return;
    }

    // Finished successfully
    this.finishTask('SUCCESS', 'Task goal successfully achieved.');
  }

  private finishTask(status: 'SUCCESS' | 'FAILED' | 'STOPPED', reason?: string): void {
    this.state.status = status;
    this.state.currentPipelineStage = 'IDLE';
    this.state.reason = reason;
    this.notify();

    // Create and record auditable privacy receipt
    const totalLatency = Date.now() - this.startTime;
    receiptsStore.addReceipt({
      id: `rcpt-${Date.now()}`,
      task: this.state.task,
      timestamp: Date.now(),
      result: status,
      sensitiveDetectedCount: this.state.sensitiveItemsCount,
      sensitiveTransmittedCount: 0,
      rawScreenshotsTransmitted: 0,
      rawDomTransmitted: 0,
      categoriesDetected: ['password', 'card_number', 'account_number', 'email', 'phone', 'pan'],
      sanitizedContextShared: [
        'Button labels',
        'Page structure',
        'Safe coordinates',
        'Non-sensitive text',
        'Allowed metadata',
      ],
      llmRequestsCount: this.state.steps.length,
      browserActionsCount: this.state.steps.length,
      latencyMs: totalLatency,
      error: status === 'FAILED' ? reason : undefined,
      steps: [...this.state.steps],
    });
  }

  async stopTask(): Promise<void> {
    this.isAborted = true;
    if (this.currentTimer) clearTimeout(this.currentTimer);
    if (this.state.status === 'RUNNING' || this.state.status === 'NEEDS_USER_CONFIRMATION') {
      this.finishTask('STOPPED', 'Task stopped by user.');
    }
  }

  async confirmAction(allowed: boolean): Promise<void> {
    if (this.state.status !== 'NEEDS_USER_CONFIRMATION') return;

    if (allowed) {
      this.state.status = 'RUNNING';
      this.state.requiresUserConfirmationAction = undefined;
      this.notify();

      // Proceed with confirmed execution
      await this.delay(500);
      this.state.steps.push({
        step: this.state.currentStep + 1,
        actionType: 'navigate',
        targetDescription: 'https://auth-partner.external.com/verify (Confirmed by user)',
        validationPassed: true,
        executionSuccess: true,
        timestamp: Date.now(),
      });
      this.notify();
      await this.delay(600);
      this.finishTask('SUCCESS', 'External action confirmed and completed.');
    } else {
      this.finishTask('STOPPED', 'Action cancelled by user.');
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.currentTimer = setTimeout(resolve, ms);
    });
  }
}
