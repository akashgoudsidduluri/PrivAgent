/**
 * PrivAgent — Agent Provider Abstraction (Milestone 5.3 → M7 provider space)
 *
 * Defines the ONE contract every reasoning backend must satisfy (Mock,
 * OpenRouter/OpenRouter-compatible, local Backend→Gemma, and any future model).
 * Ensures that all providers receive strictly sanitized M4 context and return
 * structured BrowserAction objects.
 *
 * ── Architecture invariant (do not break) ───────────────────────────────────
 *
 *   M6 AgentLoop  →  AgentProvider  →  { Gemma | Provider B | Mock | ... }
 *
 * There is exactly ONE orchestration loop (M6 `AgentLoop`). It is provider
 * agnostic: it knows only this interface, never a model name, endpoint, or
 * vendor SDK. Adding a reasoning model must NEVER add a second loop, a second
 * validator, or another execution path — only a new provider implementation.
 *
 * ── Security invariant (do not break) ───────────────────────────────────────
 *
 * Providers only ever receive an `AgentContextPayload` whose
 * `sanitized_status === 'sanitized_only'` (i.e. IDs, types, confidence,
 * geometry, counts — no raw DOM text, OCR text, screenshots, base64, or
 * sensitive values). Every provider re-asserts this locally via
 * `assertSanitizedContextSafe` before it formats a prompt or opens a socket.
 *
 * To add a new provider, see `providerRegistry.ts`.
 */

import { AgentContextPayload } from '../privacy/types';
import { BrowserAction } from './actionTypes';

export interface AgentProvider {
  /** Stable display identifier, e.g. 'BackendAgentProvider'. */
  readonly name: string;
  /**
   * Optional provider-specific model identifier used for telemetry/comparison
   * (e.g. 'google/gemma-4-31b-it:free'). Purely informational — M6 and the
   * validators never branch on it.
   */
  readonly model?: string;
  requestAction(
    task: string,
    context: AgentContextPayload,
    history?: BrowserAction[]
  ): Promise<BrowserAction>;
}

/**
 * Registered provider ids. Adding a provider means adding its id to this union
 * AND registering a descriptor in `providerRegistry.ts` — nothing else in the
 * agent architecture changes.
 */
export type ProviderType = 'mock' | 'openrouter' | 'backend';

export interface AgentProviderConfig {
  provider: ProviderType;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}
