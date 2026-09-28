/**
 * PrivAgent — PHASE 17.8 BENCHMARK: the egress wire measurement.
 *
 * THE REGRESSION BEING MEASURED
 * ────────────────────────────
 * Phase 17.6 finding F-08: the production Service Worker attaches an
 * `ocr_observation` whenever a visual capture runs, and the provider forwarded
 * it verbatim. The backend's `AgentContextPayload` is a frozen Pydantic model
 * with `extra="forbid"`, so every request was rejected with HTTP 422 and the
 * loop failed closed at step 1. The fail-closed behaviour was correct; the bug
 * was that a local-only field was being sent at all.
 *
 * WHY THIS IS MEASURED ON THE WIRE, NOT ON THE DESTRUCTURING
 * ──────────────────────────────────────────────────────────
 * A test that asserted on the source line doing the stripping would pass even
 * if the line were removed, and would fail if the line were refactored. The
 * thing that matters is what the provider ACTUALLY puts in the request body, so
 * this module intercepts `fetch`, lets the real `BackendAgentProvider` build
 * its own payload, and inspects the serialized bytes.
 *
 * The response is deliberately irrelevant: the body is captured before the
 * response is parsed, and a 500 is returned so the provider throws. The
 * measurement does not depend on the provider succeeding.
 */

import { BackendAgentProvider } from '../../extension/src/agent/backendAgentProvider';
import type { AgentContextPayload } from '../../extension/src/privacy/types';

export interface EgressMeasurement {
  /** The exact bytes the provider would put on the wire. */
  body: string;
  captured: boolean;
  /** Local-only fields that must never appear in the wire payload. */
  present: string[];
}

const LOCAL_ONLY_FIELDS = ['ocr_observation', 'viewportObservable', 'viewportSource'] as const;

/**
 * Runs the real provider against an intercepted `fetch` and reports what
 * crossed the boundary.
 *
 * `fetch` is replaced for the duration of the call and restored in a `finally`,
 * so a throw inside the provider cannot leave the stub installed for another
 * test in the same process.
 */
export async function measureEgress(context: AgentContextPayload): Promise<EgressMeasurement> {
  const original = globalThis.fetch;
  let body = '';
  let captured = false;

  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    if (init && typeof init.body === 'string') {
      body = init.body;
      captured = true;
    }
    // A refusal. The provider will throw; the measurement does not care.
    return new Response('{"detail":"benchmark"}', { status: 500 }) as unknown as never;
  }) as typeof globalThis.fetch;

  try {
    const provider = new BackendAgentProvider();
    await provider.requestAction('benchmark task', context, []);
  } catch {
    // Expected: the stubbed backend refused. The body was already captured.
  } finally {
    globalThis.fetch = original;
  }

  const present = LOCAL_ONLY_FIELDS.filter((f) => body.includes(`"${f}"`));
  return { body, captured, present };
}
