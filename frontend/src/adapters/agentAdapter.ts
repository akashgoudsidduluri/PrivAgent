import { DashboardAgentState, BackendHealthState } from '../types/dashboard';

export interface AgentAdapter {
  startTask(task: string): Promise<void>;
  stopTask(): Promise<void>;
  confirmAction(allowed: boolean): Promise<void>;
  checkHealth(): Promise<BackendHealthState>;
  getState(): DashboardAgentState;
  onStateChange(callback: (state: DashboardAgentState) => void): () => void;
  isDevMock(): boolean;
  isExtensionConnected?(): boolean;
  checkExtensionConnected?(): Promise<boolean>;
  onExtensionStatusChange?(callback: (connected: boolean) => void): () => void;
  destroy?(): void;
}

