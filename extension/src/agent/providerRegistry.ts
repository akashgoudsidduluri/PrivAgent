/**
 * PrivAgent — Reasoning Provider Registry & Factory (M7 provider space)
 *
 * The single place where reasoning providers are declared, described, and
 * constructed. This is the extension-side seam that makes future model
 * switching a CONFIGURATION change instead of an architecture change.
 *
 *   M6 AgentLoop
 *        │  (depends only on the AgentProvider interface)
 *        ▼
 *   createAgentProvider({ provider, model?, ... })
 *        │
 *        ├─ 'backend'     → BackendAgentProvider   → local FastAPI → Gemma/OpenRouter  (PRODUCTION)
 *        ├─ 'mock'        → MockAgentProvider      → offline/deterministic            (tests, CI)
 *        └─ 'openrouter'  → OpenRouterProvider     → direct vendor call (DEV/TEST ONLY, needs a browser-side key)
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HOW TO ADD A NEW REASONING PROVIDER (no core changes required)
 * ────────────────────────────────────────────────────────────────────────────
 *  1. Add its id to `ProviderType` in ./agentProvider.ts.
 *  2. Implement `AgentProvider` in a new file, e.g.
 *     `extension/src/agent/myVendorProvider.ts`. It MUST:
 *       - accept only an `AgentContextPayload` (call `assertSanitizedContextSafe`
 *         before building a prompt or opening any socket);
 *       - return a `BrowserAction` (validated again downstream by M5/M6);
 *       - throw a typed error on every failure — never a guessed action.
 *  3. Register a descriptor below inside `AGENT_PROVIDERS`.
 *  4. Add a test in `tests/providerRegistry.test.ts` proving M6 behaves
 *     identically through the new provider.
 *
 * Do NOT: add a second agent loop, bypass validateAction/canPerformAction,
 * widen the sanitized context, send raw DOM/OCR/screenshots, or place a vendor
 * API key inside the extension (non-`backend` providers must be opt-in only).
 *
 * Provider-specific telemetry (provider id, model, latency, attempts, failure
 * kind) is already carried by `ReasoningTelemetry`/`ProviderError`, so a new
 * provider becomes comparable in the existing evaluation harness with no
 * further plumbing.
 */

import { AgentProvider, AgentProviderConfig, ProviderType } from './agentProvider';
import { BackendAgentProvider } from './backendAgentProvider';
import { MockAgentProvider } from './mockAgentProvider';
import { DEFAULT_OPENROUTER_MODEL, OpenRouterProvider } from './openRouterProvider';

/** Where the reasoning actually happens, relative to this device. */
export type ProviderKind = 'local_process' | 'remote';

export interface AgentProviderDescriptor {
  id: ProviderType;
  /** Human-readable label for status surfaces (never includes key material). */
  label: string;
  kind: ProviderKind;
  /** True when the provider needs an API key INSIDE the extension. */
  requiresClientApiKey: boolean;
  /**
   * Whether the popup may expose this provider in its selector. Providers that
   * require a client-side API key are excluded by design (M7: the key must
   * stay server-side, so the production path is `backend`).
   */
  selectableInPopup: boolean;
  /** Default model identifier for telemetry (backend decides its own model). */
  defaultModel?: string;
  create: (config: AgentProviderConfig) => AgentProvider;
}

export class ProviderRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderRegistryError';
  }
}

export const AGENT_PROVIDERS: Record<ProviderType, AgentProviderDescriptor> = {
  backend: {
    id: 'backend',
    label: 'Backend → Gemma (OpenRouter)',
    kind: 'local_process',
    requiresClientApiKey: false,
    selectableInPopup: true,
    create: (config) => new BackendAgentProvider({ timeoutMs: config.timeoutMs ?? 55000 }),
  },
  mock: {
    id: 'mock',
    label: 'Mock (offline, deterministic)',
    kind: 'local_process',
    requiresClientApiKey: false,
    selectableInPopup: true,
    create: () => new MockAgentProvider(),
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter (direct — dev/test only)',
    kind: 'remote',
    requiresClientApiKey: true,
    selectableInPopup: false,
    defaultModel: DEFAULT_OPENROUTER_MODEL,
    create: (config) =>
      new OpenRouterProvider({
        apiKey: config.apiKey as string,
        model: config.model,
        baseUrl: config.baseUrl,
        timeoutMs: config.timeoutMs,
      }),
  },
};

export interface CreateAgentProviderOptions {
  /**
   * Explicit opt-in required to build a provider that needs a client-side API
   * key. Only dev/test harnesses may pass `true`; the popup/preview code paths
   * must leave this unset so the OpenRouter key never enters the extension.
   */
  allowClientSideApiKey?: boolean;
}

/**
 * Build the reasoning provider described by `config`. M6 receives the returned
 * object through the `AgentProvider` interface only, so swapping the
 * configuration cannot change loop, validator, policy, or privacy behavior.
 */
export function createAgentProvider(
  config: AgentProviderConfig,
  options: CreateAgentProviderOptions = {}
): AgentProvider {
  const descriptor = AGENT_PROVIDERS[config.provider];
  if (!descriptor) {
    throw new ProviderRegistryError(
      `Unknown reasoning provider '${String(config.provider)}'. ` +
        `Registered providers: ${Object.keys(AGENT_PROVIDERS).join(', ')}.`
    );
  }

  if (descriptor.requiresClientApiKey) {
    if (!options.allowClientSideApiKey) {
      throw new ProviderRegistryError(
        `Provider '${descriptor.id}' requires a client-side API key and is ` +
          'dev/test-only. Use the server-side backend provider so credentials ' +
          'never enter the browser.'
      );
    }
    if (!config.apiKey) {
      throw new ProviderRegistryError(
        `Provider '${descriptor.id}' was explicitly enabled but no apiKey was supplied.`
      );
    }
  }

  return descriptor.create(config);
}

/** Descriptors available for selection (popup) or programmatic enumeration. */
export function listAgentProviders(opts: { selectableOnly?: boolean } = {}): AgentProviderDescriptor[] {
  return Object.values(AGENT_PROVIDERS).filter(
    (d) => !opts.selectableOnly || d.selectableInPopup
  );
}

/** Descriptor lookup by id, or undefined for an unregistered provider. */
export function getProviderDescriptor(id: ProviderType): AgentProviderDescriptor | undefined {
  return AGENT_PROVIDERS[id];
}

/**
 * Provider-agnostic telemetry identity. Safe to surface in the UI/telemetry:
 * it contains NO key material and NO page data.
 */
export function describeProvider(provider: AgentProvider): { provider: string; model?: string } {
  return { provider: provider.name, model: provider.model };
}
