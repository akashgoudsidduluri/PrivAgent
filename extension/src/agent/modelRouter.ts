import { AgentContextPayload } from '../privacy/types';
import { ModelRole, AgentProvider } from './agentProvider';
import { BrowserAction } from './actionTypes';
import { ProviderError } from './openRouterProvider';

export interface RouterInput {
  taskComplexity: 'simple' | 'complex';
  pageComplexity: 'low' | 'high';
  pageType: string;
  candidateCount: number;
  ambiguity: boolean;
  visualRequirement: boolean;
  longHorizonRequirement: boolean;
  recoveryCount: number;
  previousFailures: number;
  actionRisk: 'low' | 'high';
  injectionRisk: boolean;
  semanticConfidence: number;
  perceptionConfidence: number;
  latencyBudget: number;
}

export interface RoutingDecision {
  taskId: string;
  selectedRole: ModelRole;
  modelIdMetadata?: string;
  routingReason: string;
  routingFeatures: RouterInput;
  escalationCount: number;
  previousRole?: ModelRole;
  policyVersion: string;
  timestamp: number;
}

export class ModelRouter implements AgentProvider {
  readonly name = 'ModelRouter';
  public currentEscalation = 0;
  public previousRole?: ModelRole;
  private maxEscalations = 2;

  constructor(private backendProvider: AgentProvider) {}

  async requestAction(
    task: string,
    context: AgentContextPayload,
    history: BrowserAction[] = []
  ): Promise<BrowserAction> {
    // Bounded escalation tracking
    const routerInput = this.deriveRouterInput(task, context, history);
    const role = this.determineRole(routerInput);
    
    const decision: RoutingDecision = {
      taskId: 'task_' + context.timestamp,
      selectedRole: role,
      routingReason: 'Deterministic policy evaluation',
      routingFeatures: routerInput,
      escalationCount: this.currentEscalation,
      previousRole: this.previousRole,
      policyVersion: '1.0',
      timestamp: Date.now()
    };
    
    this.previousRole = role;
    
    // Invoke the provider with the selected role
    return this.backendProvider.requestAction(task, context, history, role);
  }

  async reviewAction(action: BrowserAction, task: string, context: AgentContextPayload): Promise<{ safe: boolean; reason: string }> {
    if (this.backendProvider.reviewAction) {
      return this.backendProvider.reviewAction(action, task, context);
    }
    return { safe: true, reason: 'No safety review provider available' };
  }

  private deriveRouterInput(task: string, context: AgentContextPayload, history: BrowserAction[]): RouterInput {
    const candidateCount = context.detections.length;
    const pageComplexity = candidateCount > 50 ? 'high' : 'low';
    const taskComplexity = (task.length > 50 || task.split(' ').length > 10) ? 'complex' : 'simple';
    
    return {
      taskComplexity,
      pageComplexity,
      pageType: context.page_type || 'general',
      candidateCount,
      ambiguity: false,
      visualRequirement: context.screenshot_dimensions !== undefined,
      longHorizonRequirement: history.length > 5,
      recoveryCount: 0,
      previousFailures: this.currentEscalation,
      actionRisk: 'low',
      injectionRisk: false,
      semanticConfidence: 0.9,
      perceptionConfidence: 0.9,
      latencyBudget: 5000
    };
  }

  private determineRole(input: RouterInput): ModelRole {
    if (this.currentEscalation === 2 || input.visualRequirement) {
      return 'VISION';
    }
    
    if (this.currentEscalation === 1 || input.taskComplexity === 'complex' || input.pageComplexity === 'high' || input.longHorizonRequirement || input.recoveryCount > 0) {
      return 'STRONG';
    }
    
    return 'FAST';
  }
  
  public registerFailure() {
    if (this.currentEscalation < this.maxEscalations) {
      this.currentEscalation++;
    }
  }
  
  public resetEscalation() {
    this.currentEscalation = 0;
    this.previousRole = undefined;
  }
}
