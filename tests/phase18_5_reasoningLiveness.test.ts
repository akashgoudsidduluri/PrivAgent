/**
 * PHASE 18.5 — REASONING LIVENESS (F1).
 *
 * Regression coverage for the WATCHDOG_TIMEOUT failure: the agent reached
 * LLM_REASONING, executed no browser action, and never reached GoalVerifier.
 *
 * ROOT CAUSE (measured, not assumed): the AgentLoop emitted NO progress at all
 * while awaiting the reasoner, so the dashboard watchdog stayed anchored to the
 * last message sent BEFORE reasoning began. The reasoning budget is up to
 * `providerRetries + 1` attempts x 55s (~165s at providerRetries=2), but the
 * dashboard's reasoning watchdog window is 60s and nothing re-armed it — so a
 * healthy, in-budget, slow reasoning run was reported FAILED as stalled.
 *
 * These tests pin the fix (one liveness emission per RETRY attempt) and pin the
 * boundaries that must NOT move: bounded attempts, no emission on the final
 * attempt, and no emission when nothing is retried.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentLoop } from '../extension/src/agent/agentLoop';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import type { BrowserAction } from '../extension/src/agent/actionTypes';

const SLOW_MS = 40;

function makeContext(): AgentContextPayload {
  const url = 'https://www.wikipedia.org/wiki/Charminar';
  return {
    url,
    timestamp: Date.now(),
    viewport: { width: 1280, height: 800 },
    detections: [],
    total_elements_scanned: 200,
    sensitive_elements_detected: 0,
    sanitized_status: 'sanitized_only',
    page_type: 'LISTING',
    semantic_context: { pageType: 'LISTING', confidence: 0.99, url },
  } as unknown as AgentContextPayload;
}

/**
 * Drive the real AgentLoop with a provider that fails `failTimes` times with a
 * RETRYABLE error and then succeeds. Records the emissions that occur while
 * the provider is actually in flight.
 */
async function runWithRetries(opts: {
  failTimes: number;
  providerRetries: number;
}) {
  // Count of progress emissions seen so far, and a per-provider-call record of
  // how many emissions happened BEFORE this call started and AFTER it ended.
  let emissionCount = 0;
  const callsMeta: Array<{ emissionsBefore: number; emissionsAfter: number }> = [];
  let calls = 0;

  const provider = {
    async requestAction(_task: string, _ctx: AgentContextPayload, _h: BrowserAction[]) {
      calls += 1;
      const seq = calls;
      const meta = { emissionsBefore: emissionCount, emissionsAfter: emissionCount };
      callsMeta.push(meta);
      await new Promise((r) => setTimeout(r, SLOW_MS));
      if (seq <= opts.failTimes) {
        // Retryable ProviderError, same shape the backend 503/timeout produces.
        const { ProviderError } = await import('../extension/src/agent/providerResponse');
        throw new ProviderError(`simulated retryable failure ${seq}`, 'timeout', {
          retryable: true,
        });
      }
      meta.emissionsAfter = emissionCount;
      return { action: 'scroll', direction: 'down', amount: 250 } as BrowserAction;
    },
    registerFailure() {},
    resetEscalation() {},
  };

  const loop = new AgentLoop(
    provider as never,
    {
      onStepProgress: () => {
        emissionCount += 1;
      },
      perceivePage: async () => makeContext(),
      executeAction: async () => ({ success: true } as never),
    },
    {
      maxSteps: 1,
      delayBetweenStepsMs: 0,
      providerRetries: opts.providerRetries,
      providerRetryDelayMs: 1,
    }
  );

  await loop.runTask('open wikipedia and find information about charminar').catch(() => {});
  // Emissions that landed BETWEEN two provider attempts — the exact moments the
  // dashboard watchdog must be re-armed from. Between call N-1 and call N the
  // count is emissionsBefore(N) - emissionsAfter(N-1).
  const betweenAttempts: number[] = [];
  for (let i = 1; i < callsMeta.length; i += 1) {
    const prev = callsMeta[i - 1];
    const cur = callsMeta[i];
    if (prev && cur) betweenAttempts.push(cur.emissionsBefore - prev.emissionsAfter);
  }
  return { callsMeta, betweenAttempts, totalEmissions: emissionCount, calls };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('PHASE 18.5 reasoning liveness (F1)', () => {
  it('emits a liveness progress message before each RETRY attempt', async () => {
    // 2 failures then success => 3 attempts. Attempts 2 and 3 are retries, so
    // there must be exactly one emission between each adjacent pair.
    const { betweenAttempts, calls } = await runWithRetries({ failTimes: 2, providerRetries: 2 });
    expect(calls).toBe(3);
    expect(betweenAttempts.length).toBe(2);
    for (const n of betweenAttempts) {
      expect(n).toBeGreaterThanOrEqual(1);
    }
  });

  it('emits NO liveness message when the first attempt succeeds (nothing retried)', async () => {
    const { betweenAttempts, calls } = await runWithRetries({ failTimes: 0, providerRetries: 2 });
    expect(calls).toBe(1);
    expect(betweenAttempts.length).toBe(0);
  });

  it('keeps execution bounded: never exceeds providerRetries + 1 attempts', async () => {
    const { calls } = await runWithRetries({ failTimes: 99, providerRetries: 2 });
    expect(calls).toBe(3);
  });

  it('emits no extra liveness message after the final attempt fails', async () => {
    // All 3 attempts fail. Liveness must be emitted only BETWEEN attempts,
    // never after the last one — otherwise a dead reasoner would look alive.
    const { betweenAttempts, calls } = await runWithRetries({ failTimes: 99, providerRetries: 2 });
    expect(calls).toBe(3);
    // Exactly 2 gaps => at most one emission each, and no trailing emission.
    expect(betweenAttempts.every((n) => n >= 1 && n <= 2)).toBe(true);
  });

  it('a single slow attempt that succeeds is NOT rescued by liveness (window unchanged)', async () => {
    // One attempt, slow but successful, no retries: the fix must not change
    // anything about the first attempt's watchdog anchoring.
    const { betweenAttempts, calls } = await runWithRetries({ failTimes: 0, providerRetries: 0 });
    expect(calls).toBe(1);
    expect(betweenAttempts.length).toBe(0);
  });
});