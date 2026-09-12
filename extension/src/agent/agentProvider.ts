/**
 * PrivAgent — Agent Provider Abstraction (Milestone 5.3)
 *
 * Defines the contract for reasoning providers (Mock, OpenRouter, Backend).
 * Ensures that all providers receive strictly sanitized M4 context and return
 * structured BrowserAction objects.
 */

import { AgentContextPayload } from '../privacy/types';
import { BrowserAction } from './actionTypes';

export interface AgentProvider {
  readonly name: string;
  requestAction(
    task: string,
    context: AgentContextPayload,
    history?: BrowserAction[]
  ): Promise<BrowserAction>;
}

export type ProviderType = 'mock' | 'openrouter' | 'backend';

export interface AgentProviderConfig {
  provider: ProviderType;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}
