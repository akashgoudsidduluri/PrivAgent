/**
 * PrivAgent — Local Backend Agent Provider (Milestone 5.3 → 7)
 *
 * PRODUCTION REASONING PATH.
 *
 * Connects the extension to the local FastAPI agent reasoning endpoint:
 *   POST http://127.0.0.1:8010/api/v1/agent/action
 *
 * The backend performs the Gemma/OpenRouter request server-side, so the API
 * key NEVER reaches the browser.
 *
 * Security Invariants:
 *  1. Strictly local (127.0.0.1:8010).
 *  2. Pre-flight verification that context has zero raw PII.
 *  3. Safe action-history metadata is forwarded for multi-step reasoning.
 *  4. Output is still treated as untrusted and must pass the local Action Validator.
 *  5. Every failure throws a typed ProviderError — never a guessed action.
 */

import { AgentProvider } from './agentProvider';
import { BrowserAction } from './actionTypes';
import { AgentContextPayload } from '../privacy/types';
import { assertSanitizedContextSafe } from './privacyPolicy';
import { ProviderError, ProviderErrorKind } from './openRouterProvider';

const AGENT_ACTION_ENDPOINT = 'http://127.0.0.1:8010/api/v1/agent/action';

export interface BackendAgentErrorDetail {
  success: false;
  reason: string;
  error_kind?: string;
  retryable?: boolean;
}

export class BackendAgentProvider implements AgentProvider {
  readonly name = 'BackendAgentProvider';

  private timeoutMs: number;

  constructor(opts: { timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 30000;
  }

  async requestAction(
    task: string,
    context: AgentContextPayload,
    history: BrowserAction[] = []
  ): Promise<BrowserAction> {
    // 1. Verify sanitized context safety
    assertSanitizedContextSafe(context);

    // 2. Call local backend with safe history metadata
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await fetch(AGENT_ACTION_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, context, history }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) {
        const { detail, kind, retryable } = await this.parseError(resp);
        throw new ProviderError(`Backend agent endpoint failed: ${detail}`, kind, {
          retryable,
          status: resp.status,
        });
      }

      const data = (await resp.json()) as {
        success: boolean;
        action: BrowserAction;
        reason: string;
      };

      if (!data.success || !data.action) {
        throw new ProviderError(
          `Backend returned unsuccessful action response: ${data.reason || 'unknown'}`,
          'unknown'
        );
      }

      return data.action;
    } catch (err: unknown) {
      clearTimeout(timer);
      if (err instanceof ProviderError) throw err;

      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('abort')) {
        throw new ProviderError(`Backend request timed out after ${this.timeoutMs}ms.`, 'timeout', {
          retryable: true,
        });
      }
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
        throw new ProviderError(
          'Backend unavailable. Start it with: python backend/run.py',
          'network',
          { retryable: true }
        );
      }
      throw new ProviderError(`[BackendAgentProvider] ${msg}`, 'unknown');
    }
  }  private async parseError(resp: Response): Promise<{ detail: string; kind: ProviderErrorKind; retryable: boolean }>
  {
    let detail = `HTTP ${resp.status}`;
    let kind: ProviderErrorKind = 'http_error';
    let retryable = false;
    let structuredKindFound = false;

    try {
      const errJson = (await resp.json()) as { detail?: string | BackendAgentErrorDetail };
      if (typeof errJson?.detail === 'string') {
        detail += `: ${errJson.detail}`;
      } else if (errJson?.detail && typeof errJson.detail === 'object') {
        const d = errJson.detail as BackendAgentErrorDetail;
        if (d.reason) detail += `: ${d.reason}`;
        if (d.error_kind === 'auth') kind = 'auth';
        else if (d.error_kind === 'rate_limit') kind = 'rate_limit';
        else if (d.error_kind === 'timeout' || d.error_kind === 'network') kind = d.error_kind;
        else if (d.error_kind === 'not_configured') kind = 'auth';
        else kind = 'http_error';
        structuredKindFound = true;
        retryable = Boolean(d.retryable);
      }
    } catch {
      // error body not JSON — keep the HTTP status detail
    }

    if (resp.status === 401 || resp.status === 403) {
      kind = 'auth';
    } else if (resp.status === 429) {
      kind = 'rate_limit';
      retryable = true;
    } else if (resp.status >= 500 && !structuredKindFound) {
      // Backend 5xx without a structured body is a transient server-side
      // failure — retryable. A structured error_kind from the body is
      // preferred (e.g. a 503 carrying error_kind=rate_limit stays rate_limit).
      kind = 'http_error';
      retryable = true;
    }

    return { detail, kind, retryable };
  }
}
