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

import { AgentProvider, ModelRole } from './agentProvider';
import { BrowserAction } from './actionTypes';
import { AgentContextPayload } from '../privacy/types';
import { assertSanitizedContextSafe } from './privacyPolicy';
import { ProviderError, ProviderErrorKind } from './openRouterProvider';
import {
  parseRetryAfter,
  readBoundedJsonBody,
  validateProviderEnvelope,
  validateProviderStep,
  type ProviderStep,
  type ProviderTelemetryEvent,
} from './providerResponse';
import { validateEgressPayload } from '../security/egressFirewall';

const DEFAULT_AGENT_API_BASE = 'http://127.0.0.1:8010';

export interface BackendAgentErrorDetail {
  success: false;
  reason: string;
  error_kind?: string;
  retryable?: boolean;
}

export class BackendAgentProvider implements AgentProvider {
  readonly name = 'BackendAgentProvider';

  private timeoutMs: number;

  /**
   * PHASE 17.5. The resolved local backend endpoints.
   *
   * The DEFAULT is unchanged (`http://127.0.0.1:8010`) — production behaviour is
   * identical. The base is now overridable so a harness or an operator running
   * the backend on a different port talks to the backend that is ACTUALLY
   * listening, instead of silently issuing requests to a port nobody owns.
   *
   * This is the direct cause of the 17.4 real-reasoner `NOT_PROVEN`: the provider
   * hardcoded 8010 while the harness started its backend on 8061, so every
   * request went to a foreign/absent process and the model was never invoked.
   *
   * SECURITY: the override cannot escape the local boundary. The egress firewall
   * still allowlists only `http://127.0.0.1` and `http://localhost`, so a remote
   * base here is BLOCKED fail-closed at the single outbound enforcement point —
   * the API key and the sanitized context can never be sent off-device.
   */
  private readonly actionEndpoint: string;
  private readonly reviewEndpoint: string;

  /**
   * PHASE 17.5. Structured, CONTENT-FREE telemetry. A ring buffer, not a log
   * sink: it carries identifiers, categories, counts and statuses only.
   */
  private readonly telemetry: ProviderTelemetryEvent[] = [];
  private static readonly TELEMETRY_RING = 50;
  /** Monotonic per-provider request counter; the requestId stem. */
  private requestCounter = 0;

  constructor(opts: { timeoutMs?: number; baseUrl?: string } = {}) {
    // 35s: backend NVIDIA timeout is 30s; giving backend 5s extra ensures the
    // backend's structured 503 arrives before the frontend AbortController fires.
    this.timeoutMs = opts.timeoutMs ?? 55000;
    const base = (opts.baseUrl ?? DEFAULT_AGENT_API_BASE).replace(/\/+$/, '');
    this.actionEndpoint = `${base}/api/v1/agent/action`;
    this.reviewEndpoint = `${base}/api/v1/agent/review`;
  }

  async requestAction(
    task: string,
    context: AgentContextPayload,
    history: BrowserAction[] = [],
    role?: ModelRole,
    cycle = 0,
    attempt = 1
  ): Promise<BrowserAction> {
    // PHASE 18.7 / A1. One request, two possible outcomes. `requestAction` is
    // now a strict SUBSET of `requestStep`: it accepts an action and refuses
    // anything else. The egress firewall, the payload stripping and every
    // telemetry call live in `requestStep` exactly once, so the action path
    // cannot drift from the terminal path.
    const step = await this.requestStep(task, context, history, role, cycle, attempt);
    if (step.kind !== 'ACTION') {
      throw new ProviderError(
        'Provider returned a terminal proposal where an action was required.',
        'missing_action',
        { category: 'SCHEMA_INVALID' }
      );
    }
    return step.action;
  }

  async requestStep(
    task: string,
    context: AgentContextPayload,
    history: BrowserAction[] = [],
    role?: ModelRole,
    cycle = 0,
    attempt = 1
  ): Promise<ProviderStep> {
    // 1. Verify sanitized context safety
    assertSanitizedContextSafe(context);
    //
    // PHASE 17.1 (C6): the local viewport-observability flags are stripped
    // here, at the single egress boundary. The backend schema is
    // extra="forbid" and these are local facts about whether a reading was
    // obtained — the model has no use for them and the device gains nothing by
    // transmitting them. The wire schema is byte-identical to before.
    //
    // PHASE 17.6 (F-08). `ocr_observation` is stripped for the same reason, and
    // its absence was a HARD BLOCKER rather than a nicety.
    //
    // The production Service Worker attaches an `OCRObservation` whenever a
    // visual capture runs. It was forwarded verbatim, and the backend's frozen
    // `AgentContextPayload` is `extra="forbid"`, so the request was rejected
    // with HTTP 422 and the loop failed closed at step 1. Every real-reasoner
    // run through the actual product path was therefore impossible; this is
    // why no real-reasoner multi-step completion had ever been observed. The
    // fail-closed behaviour was CORRECT — the bug was that a local-only field
    // was being sent at all.
    //
    // The field is pure LOCAL provenance: observation state, the document URL
    // and page generation at capture time, the capture timestamp, bitmap and
    // viewport geometry, and scale factors. It carries no pixels and no OCR
    // text, so this is not a PII incident — but it is exactly the class of
    // device-local fact Phase 17.1 (C6) established should not cross the
    // boundary, and stripping it is strictly privacy-TIGHTENING: less leaves
    // the device than before. Nothing in the reasoner depends on it.
    //
    // Post-17.9. `semanticObservation` is stripped for the same reason, and it
    // is the same class of fact: the tab id, document URL, page generation and
    // timestamp that let goal verification decide whether a sanitized display
    // fact still describes the live page. It carries provenance, not content —
    // the sanitized facts the reasoner may use travel inside `semantic_context`,
    // which is unaffected. Stripping is strictly privacy-TIGHTENING: less leaves
    // the device than before, and the wire schema is byte-identical.
    const {
      viewportObservable: _vo,
      viewportSource: _vs,
      ocr_observation: _ocrObs,
      semanticObservation: _semObs,
      ...egressContext
    } = context;

    // 2. Call local backend with safe history metadata
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    //
    // PHASE 17.5 (F7). Telemetry is recorded on EVERY exit path — success,
    // refusal and failure alike. It carries no prompt, page text, PII, OCR text
    // or credential; only identifiers, categories, counts and statuses.
    //
    const startedAt = Date.now();
    const base = {
      provider: this.name,
      cycle,
      attempt,
      fallbackUsed: false,
      retryable: false,
      retried: attempt > 1,
      retryAfterMs: null as number | null,
    };
    try {
      // Map history entries to safe metadata only (excluding raw text/values)
      const safeHistory = history.map((act) => ({
        action: act.action,
        ...('target' in act && act.target ? { target: act.target } : {}),
        ...('direction' in act && act.direction ? { direction: act.direction } : {}),
        ...('amount' in act && act.amount !== undefined ? { amount: act.amount } : {}),
        ...('url' in act && act.url ? { url: act.url } : {}),
        ...('reason' in act && act.reason ? { reason: act.reason } : {}),
        ...('key' in act && act.key ? { key: act.key } : {}),
        ...(act.effect ? { effect: act.effect } : {}),
        ...(act.scrollDelta !== undefined ? { scrollDelta: act.scrollDelta } : {}),
      }));
      const payload = { task, context: egressContext, history: safeHistory, model_role: role };
      const egressDecision = validateEgressPayload(payload, this.actionEndpoint);
      if (egressDecision.directive === 'BLOCK') {
        throw new ProviderError(`Egress Firewall Blocked Request: ${egressDecision.reason}`, 'unknown');
      }

      const resp = await fetch(this.actionEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) {
        const retryAfterMs = parseRetryAfter(resp.headers?.get?.('retry-after'));
        const { detail, kind, retryable } = await this.parseError(resp, retryAfterMs);
        throw new ProviderError(`Backend agent endpoint failed: ${detail}`, kind, {
          retryable,
          status: resp.status,
          retryAfterMs,
        });
      }

      //
      // PHASE 17.5 (F5, F1). BOUNDED body read, then STRICT validation.
      //
      // The backend is local and trusted to be *well-intentioned*, but its
      // response is still untrusted INPUT: a misconfigured or replaced backend
      // must not be able to hand the agent an arbitrary object. Previously this
      // returned `data.action` verbatim, with no schema check and no size bound.
      //
      // M5 still runs afterwards and remains the authority. This only means a
      // malformed response is refused HERE, at the boundary, instead of
      // travelling through the loop to be caught later.
      const validated = validateProviderStep(await readBoundedJsonBody(resp));
      this.recordTelemetry({
        ...base,
        category: 'OK',
        httpStatus: resp.status,
        retryable: false,
        validation: 'PASS',
        actionType: validated.kind === 'ACTION' ? validated.action.action : null,
        terminalOutcome: validated.kind === 'ACTION' ? 'CONTINUE' : 'TERMINAL_PROPOSAL',
        latencyMs: Date.now() - startedAt,
      });
      return validated;
    } catch (err: unknown) {
      clearTimeout(timer);
      //
      // PHASE 17.5 (F7). Failure telemetry, recorded BEFORE any re-throw so no
      // exit path escapes it. Only the CATEGORY, status and counters are
      // recorded — never the message content — so a provider cannot smuggle
      // content into telemetry.
      //
      const isProviderError = err instanceof ProviderError;
      this.recordTelemetry({
        ...base,
        category: isProviderError ? err.category : 'UNKNOWN_PROVIDER_FAILURE',
        httpStatus: isProviderError ? err.status ?? null : null,
        retryable: isProviderError ? err.retryable : false,
        retryAfterMs: isProviderError ? err.retryAfterMs ?? null : null,
        validation: isProviderError && err.category === 'STALE_RESPONSE' ? 'REFUSED' : 'NOT_RUN',
        actionType: null,
        terminalOutcome: 'FAILED',
        latencyMs: Date.now() - startedAt,
      });
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
  }

  /**
   * PHASE 17.5 (F7). Read the structured provider telemetry ring.
   * Content-free by construction: see `ProviderTelemetryEvent`.
   */
  getTelemetry(): readonly ProviderTelemetryEvent[] {
    return [...this.telemetry];
  }

  /** PHASE 17.5. Record one telemetry event, bounded by a ring buffer. */
  recordTelemetry(event: ProviderTelemetryEvent): void {
    this.requestCounter += 1;
    this.telemetry.push({ ...event, requestId: `req-${this.requestCounter}` });
    if (this.telemetry.length > BackendAgentProvider.TELEMETRY_RING) this.telemetry.shift();
  }

  async reviewAction(action: BrowserAction, task: string, context: AgentContextPayload): Promise<{ safe: boolean; reason: string }> {
    assertSanitizedContextSafe(context);
    // PHASE 17.1 (C6): same local-only strip as the action path.
    const { viewportObservable: _vo2, viewportSource: _vs2, ...egressContext } = context;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const payload = { action, task, context: egressContext, model_role: 'SAFETY' };
      const egressDecision = validateEgressPayload(payload, this.reviewEndpoint);
      if (egressDecision.directive === 'BLOCK') {
        throw new ProviderError(`Egress Firewall Blocked Review: ${egressDecision.reason}`, 'unknown');
      }
      const resp = await fetch(this.reviewEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const { detail, kind, retryable } = await this.parseError(resp);
        throw new ProviderError(`Backend review endpoint failed: ${detail}`, kind, {
          retryable,
          status: resp.status,
          retryAfterMs: parseRetryAfter(resp.headers?.get?.('retry-after')),
        });
      }
      const parsed = await readBoundedJsonBody(resp);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new ProviderError('Backend review response is not an object.', 'invalid_json', {
          category: 'INVALID_JSON',
        });
      }
      const data = parsed as { safe?: unknown; reason?: unknown };
      if (typeof data.safe !== 'boolean' || typeof data.reason !== 'string') {
        // The safety verdict is AUTHORITATIVE. A malformed verdict must never be
        // coerced into `safe: true`.
        throw new ProviderError('Backend review response is schema-invalid.', 'invalid_json', {
          category: 'SCHEMA_INVALID',
        });
      }
      return { safe: data.safe, reason: data.reason };
    } catch (err: unknown) {
      clearTimeout(timer);
      if (err instanceof ProviderError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('abort')) throw new ProviderError(`Backend review timed out after ${this.timeoutMs}ms.`, 'timeout', { retryable: true });
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) throw new ProviderError('Backend unavailable.', 'network', { retryable: true });
      throw new ProviderError(`[BackendAgentProvider] ${msg}`, 'unknown');
    }
  }  private async parseError(resp: Response, retryAfterMs?: number): Promise<{ detail: string; kind: ProviderErrorKind; retryable: boolean }>
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
        // PHASE 18.5 / I-3. The backend now reports a model contract
        // violation (502) under its own `model_contract` kind. It used to
        // arrive as a bare 503 whose body carried no recognised kind, and fell
        // through to `http_error` — i.e. exactly the same classification a
        // genuine provider outage received. Preserving the distinct kind is
        // what keeps "the model answered with something unusable" separable
        // from "the provider could not answer", which is the whole point of
        // the change.
        else if (d.error_kind === 'model_contract') kind = 'model_contract';
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
      // M7 hotfix, narrowed in Step 10.6 (G7): a rate limit is still never
      // retried on a guess. Whether it is retryable is decided by the SINGLE
      // rule below, which requires the provider's own published Retry-After.
      retryable = false;
    } else if (resp.status >= 500 && !structuredKindFound) {
      // Backend 5xx without a structured body is a transient server-side
      // failure — retryable. A structured error_kind from the body is
      // preferred (e.g. a 503 carrying error_kind=rate_limit stays rate_limit).
      kind = 'http_error';
      retryable = true;
    }

    // M7 hotfix, retained and STRENGTHENED — defense in depth: the extension
    // NEVER trusts a remote `retryable` flag for rate limiting. Even if the
    // backend reports error_kind=rate_limit with retryable=true, that flag alone
    // is IGNORED. The value assigned here is derived ONLY from the local,
    // already-clamped parse of the provider's own Retry-After header — never
    // from the remote body.
    //
    // POST-17.10 Step 10.6 (G7). A rate limit that arrives WITH a valid
    // Retry-After is TRANSIENT by the provider's own account: it published the
    // exact interval at which it will serve the next request. Honouring that
    // interval is RESPECTING the limit, not bypassing it — the alternative is
    // either failing closed on a request the provider has said will succeed,
    // or hammering the pool with unspaced retries.
    //
    // The bounds are unchanged and all live upstream in the loop: retries are
    // capped by `providerRetries`, the delay is clamped by `parseRetryAfter`
    // here and again by `Math.min(hint, 30_000)` in `AgentLoop`, and a rate
    // limit with NO valid Retry-After stays exactly as before — non-retryable,
    // zero retries, fail closed.
    if (kind === 'rate_limit') {
      retryable = typeof retryAfterMs === 'number';
    }

    return { detail, kind, retryable };
  }
}
