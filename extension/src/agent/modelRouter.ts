import { AgentContextPayload } from '../privacy/types';
import { ModelRole, AgentProvider } from './agentProvider';
import { BrowserAction } from './actionTypes';
import { ProviderError } from './openRouterProvider';
import { ProviderStep } from './providerResponse';

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
    // Bounded escalation tracking. Routed in ONE place so the action path and
    // the step path below can never select different roles for the same cycle.
    const role = this.route(task, context, history);

    // Invoke the provider with the selected role
    return this.backendProvider.requestAction(task, context, history, role);
  }

  /**
   * PHASE 18.7 / A10-F1 — request one STEP, not one action.
   *
   * THE DEFECT THIS FIXES. `AgentProvider.requestStep` is optional, and this
   * class did not implement it. `AgentLoop.requestStepFromProvider` therefore
   * took its fallback branch and called `requestAction`, which reached
   * `BackendAgentProvider.requestAction` — a strict SUBSET of `requestStep` that
   * REFUSES anything that is not an action. Every terminal proposal the model
   * produced (A1's ANSWER / PARTIAL / CANNOT_VERIFY / NEEDS_INFORMATION) was
   * therefore turned into `ProviderError(..., 'SCHEMA_INVALID')` and the task
   * ended as PROVIDER_UNAVAILABLE. The A1 verification path was unreachable in
   * production, and no gate or validator was at fault: the wiring simply never
   * offered the loop a way to receive a proposal.
   *
   * WHAT THIS IS NOT. It is a pass-through, not a privilege. It adds no
   * authority, no verification and no bypass:
   *   - role selection and escalation bookkeeping are unchanged — `route()` is
   *     the same code `requestAction` already used, so the router still decides
   *     the role for every cycle;
   *   - the backend's own `requestStep` still runs the egress firewall, the
   *     payload stripping, `assertSanitizedContextSafe`, the A8 schema and
   *     applicability validation and M5 — the router inspects none of it;
   *   - the returned step is handed back UNMODIFIED, so the loop's existing
   *     stale-observation check and `verifyTerminalProposal` remain the only
   *     things that can accept a proposal. The model proposes; the device
   *     disposes, exactly as before.
   *
   * A backend that cannot express a proposal (mock, OpenRouter) keeps working
   * unchanged: the request is routed as an ACTION step, which is the historical
   * behaviour for a provider with no `requestStep`.
   */
  async requestStep(
    task: string,
    context: AgentContextPayload,
    history: BrowserAction[] = []
  ): Promise<ProviderStep> {
    const role = this.route(task, context, history);

    const requestStep = this.backendProvider.requestStep?.bind(this.backendProvider);
    if (!requestStep) {
      // No step-capable backend: route the historical action request and wrap
      // it. The wrapping is structural only — it introduces no new capability.
      return { kind: 'ACTION', action: await this.backendProvider.requestAction(task, context, history, role) };
    }
    return requestStep(task, context, history, role);
  }

  /**
   * The single routing decision for a cycle. Extracted so the action path and
   * the step path cannot drift into selecting different roles or recording
   * different escalation state for the same observation.
   */
  private route(task: string, context: AgentContextPayload, history: BrowserAction[]): ModelRole {
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
    void decision;

    this.previousRole = role;
    return role;
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
