/**
 * PrivAgent — Local Backend Agent Provider (Milestone 5.3)
 *
 * Connects the extension to the local FastAPI agent reasoning endpoint:
 *   POST http://127.0.0.1:8010/api/v1/agent/action
 *
 * Security Invariants:
 *  1. Strictly local (127.0.0.1:8010).
 *  2. Pre-flight verification that context has zero raw PII.
 *  3. Output is still treated as untrusted and must pass the local Action Validator.
 */

import { AgentProvider } from './agentProvider';
import { BrowserAction } from './actionTypes';
import { AgentContextPayload } from '../privacy/types';
import { assertSanitizedContextSafe } from './privacyPolicy';

const AGENT_ACTION_ENDPOINT = 'http://127.0.0.1:8010/api/v1/agent/action';

export class BackendAgentProvider implements AgentProvider {
  readonly name = 'BackendAgentProvider';

  async requestAction(task: string, context: AgentContextPayload): Promise<BrowserAction> {
    // 1. Verify sanitized context safety
    assertSanitizedContextSafe(context);

    // 2. Call local backend
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);

    try {
      const resp = await fetch(AGENT_ACTION_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, context }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) {
        let errDetail = `HTTP ${resp.status}`;
        try {
          const errJson = await resp.json() as { detail?: string };
          if (errJson.detail) errDetail += `: ${errJson.detail}`;
        } catch {
          // ignore
        }
        throw new Error(`Backend agent endpoint failed: ${errDetail}`);
      }

      const data = await resp.json() as {
        success: boolean;
        action: BrowserAction;
        reason: string;
      };

      if (!data.success || !data.action) {
        throw new Error(`Backend returned unsuccessful action response: ${data.reason || 'unknown'}`);
      }

      return data.action;
    } catch (err: unknown) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[BackendAgentProvider] ${msg}`);
    }
  }
}
