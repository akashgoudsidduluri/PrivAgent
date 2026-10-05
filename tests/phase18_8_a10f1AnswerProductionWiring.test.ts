/**
 * PHASE 18.8 / A10-F1 — the A1 ANSWER path is reachable through the PRODUCTION
 * provider wiring.
 *
 * THE DEFECT, observed in real Chrome (A10 S17)
 *   `serviceWorker.ts` builds the production provider as
 *   `new ModelRouter(createAgentProvider({ provider: 'backend' }))`. `ModelRouter`
 *   implemented `requestAction` and `reviewAction` but NOT the optional
 *   `requestStep`. `AgentLoop.requestStepFromProvider` therefore took its
 *   documented fallback branch and called `requestAction`, which reached
 *   `BackendAgentProvider.requestAction` — a strict SUBSET that throws
 *   `SCHEMA_INVALID` on anything that is not an action. Every terminal proposal
 *   became a provider failure and the task ended `PROVIDER_UNAVAILABLE`.
 *
 *   The A1 verification code was correct, fully tested, and unreachable. That is
 *   why an information task had never produced a user-facing answer.
 *
 * WHAT IS ASSERTED HERE
 *   These are WIRING tests, and they are deliberately written against the
 *   production class rather than against `verifyTerminalProposal` in isolation
 *   (which `phase18_7_a1a9TerminalStates.test.ts` already covers exhaustively).
 *   Each one fails on the pre-fix tree:
 *
 *     1. `ModelRouter.requestStep` exists and reaches the backend.
 *     2. A valid ANSWER with resolvable evidence is accepted FOR VERIFICATION —
 *        and is still not SUCCESS.
 *     3. A citation the model invented is discarded, never counted as support.
 *     4. Stale evidence cannot back a reported answer.
 *     5. An ANSWER with no verified evidence is not falsely successful.
 *     6. ACTION proposals keep flowing through the unchanged action path.
 *     7. A8 still refuses malformed responses on this route.
 *     8. The router grants NO authority: role selection and escalation
 *        bookkeeping are unchanged, and a backend without `requestStep` still
 *        works.
 */
import { describe, it, expect, vi } from 'vitest';

import { ModelRouter } from '../extension/src/agent/modelRouter';
import { BackendAgentProvider } from '../extension/src/agent/backendAgentProvider';
import { AgentLoop } from '../extension/src/agent/agentLoop';
import { EvidenceLedger } from '../extension/src/evidence/evidenceLedger';
import { validateProviderStep } from '../extension/src/agent/providerResponse';
import type { AgentProvider, ModelRole } from '../extension/src/agent/agentProvider';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import type { BrowserAction } from '../extension/src/agent/actionTypes';
import type { IntentDecision } from '../extension/src/agent/intentBoundary';
import type { SemanticFact, SemanticObservation } from '../extension/src/semanticObservation/types';

const PAGE_URL = 'https://en.wikipedia.org/wiki/Charminar';
const TASK = 'tell me about charminar';

function informationRequest(): IntentDecision {
  return {
    intent: 'INFORMATION_REQUEST',
    confidence: 'DETERMINISTIC',
    requiresDestination: false,
    requiresEvidence: true,
    admitsBrowserAutomation: true,
    refusal: null,
  } as unknown as IntentDecision;
}

function context(): AgentContextPayload {
  return {
    timestamp: Date.now(),
    url: PAGE_URL,
    detections: [],
    viewport: { width: 1265, height: 757, scroll_x: 0, scroll_y: 0 },
    screenshot: null,
    total_elements_scanned: 0,
    sensitive_elements_detected: 0,
    sanitized_status: 'sanitized_only' as const,
    pageState: { url: PAGE_URL, domElementCount: 0 },
  } as unknown as AgentContextPayload;
}

function ledgerWith(claims: readonly string[]): EvidenceLedger {
  const ledger = new EvidenceLedger();
  ledger.advance(1, PAGE_URL);
  for (const claim of claims) {
    const record = ledger.record({
      claim,
      key: 'charminar',
      sourceUrl: PAGE_URL,
      pageGeneration: 1,
      evidenceType: 'SEMANTIC_FACT',
      confidence: 0.9,
    });
    if (record) ledger.verify(record.id);
  }
  return ledger;
}

function firstId(ledger: EvidenceLedger): string {
  const record = ledger.citable()[0];
  if (!record) throw new Error('expected at least one citable evidence record');
  return record.id;
}

/**
 * A genuine OBSERVED semantic observation — exactly what the service worker
 * hands to `EvidenceLedger.ingestObservation` in production.
 */
function semanticObservation(facts: readonly Partial<SemanticFact>[] = [{}]): SemanticObservation {
  return {
    state: 'OBSERVED',
    provenance: {
      tabId: 7,
      documentUrl: PAGE_URL,
      pageGeneration: 1,
      observedAt: 1_700_000_000_000,
      source: 'WORLD_MODEL_TEXT_REGIONS',
    },
    facts: facts.map((over, i) => ({
      id: `fact-${i}`,
      key: 'charminar',
      label: 'Charminar',
      displayText: 'The Charminar was built in 1591.',
      displayValue: null,
      valueKind: 'text',
      source: 'DOM_TEXT_REGION',
      selector: `r${i}`,
      bbox: [0, 0, 10, 10],
      confidence: 0.9,
      pageGeneration: 1,
      ...over,
    })) as SemanticFact[],
    droppedSensitiveCount: 0,
    quarantinedInjectionCount: 0,
    regionsConsidered: 1,
    latencyMs: 1,
  } as SemanticObservation;
}

/** A backend that answers with one step, and records the role it was given. */
function backendReturning(step: unknown, seen: ModelRole[] = []): AgentProvider {
  return {
    name: 'RecordingBackend',
    requestAction: vi.fn(async () => {
      throw new Error('requestAction must not be used when requestStep exists');
    }),
    requestStep: vi.fn(async (_t, _c, _h, role) => {
      if (role) seen.push(role);
      return step as never;
    }),
  } as unknown as AgentProvider;
}

const SCROLL: BrowserAction = { action: 'scroll', direction: 'down', amount: 400 };

describe('A10-F1 — the production wiring accepts a step', () => {
  it('ModelRouter exposes requestStep at all (the exact S17 defect)', () => {
    // The pre-fix class had no `requestStep`, so the loop could never receive
    // anything but an action. This is the one-line form of the finding.
    expect(typeof ModelRouter.prototype.requestStep).toBe('function');
  });

  it('a TERMINAL_PROPOSAL survives the router and reaches the caller', async () => {
    const proposal = {
      kind: 'ANSWER',
      reason: 'The page states it.',
      answer: 'Charminar was built in 1591.',
      cited_evidence: [],
    };
    const backend = backendReturning({ kind: 'TERMINAL_PROPOSAL', proposal });
    const router = new ModelRouter(backend);

    const step = await router.requestStep(TASK, context(), []);

    expect(step.kind).toBe('TERMINAL_PROPOSAL');
    // Unmodified: the router inspects nothing and invents nothing.
    expect((step as { proposal: unknown }).proposal).toEqual(proposal);
  });

  it('an ACTION step still reaches the caller through the router', async () => {
    const backend = backendReturning({ kind: 'ACTION', action: SCROLL });
    const router = new ModelRouter(backend);
    const step = await router.requestStep(TASK, context(), []);
    expect(step.kind).toBe('ACTION');
    expect((step as { action: BrowserAction }).action).toEqual(SCROLL);
  });

  it('a backend WITHOUT requestStep still works (mock/OpenRouter unchanged)', async () => {
    const requestAction = vi.fn(async () => SCROLL);
    const router = new ModelRouter({
      name: 'ActionOnlyBackend',
      requestAction,
    } as unknown as AgentProvider);

    const step = await router.requestStep(TASK, context(), []);

    expect(step.kind).toBe('ACTION');
    expect(requestAction).toHaveBeenCalledTimes(1);
  });

  it('the router selects and records a role on the step path too', async () => {
    const seen: ModelRole[] = [];
    const router = new ModelRouter(backendReturning({ kind: 'ACTION', action: SCROLL }, seen));
    await router.requestStep(TASK, context(), []);
    // Role selection is the router's whole job; routing the step path through a
    // different (or absent) policy would make the two paths inconsistent.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe('FAST');
    expect(router.previousRole).toBe('FAST');
  });

  it('escalation bookkeeping is shared by both paths', async () => {
    // A backend that answers BOTH paths — the real BackendAgentProvider does,
    // since its `requestAction` is a strict subset of its `requestStep`.
    const roles: ModelRole[] = [];
    const router = new ModelRouter({
      name: 'BothPathsBackend',
      requestAction: vi.fn(async (_t, _c, _h, role) => {
        if (role) roles.push(role);
        return SCROLL;
      }),
      requestStep: vi.fn(async (_t, _c, _h, role) => {
        if (role) roles.push(role);
        return { kind: 'ACTION' as const, action: SCROLL };
      }),
    } as unknown as AgentProvider);

    await router.requestAction(TASK, context(), []);
    router.registerFailure();
    await router.requestStep(TASK, context(), []);

    // One escalation registered on the action path is visible to the step path,
    // and both paths routed through the same policy.
    expect(router.currentEscalation).toBe(1);
    expect(roles).toHaveLength(2);
  });
});

describe('A10-F1 — the proposal is still verified, never obeyed', () => {
  /**
   * Drives a REAL AgentLoop whose provider is the production
   * `ModelRouter → BackendAgentProvider` pair, with `fetch` stubbed to return
   * exactly what the backend would return. This is the S17 scenario in a
   * deterministic form: a scroll, then a terminal ANSWER proposal.
   */
  async function runLoopWithProposal(
    proposal: unknown,
    ledger: EvidenceLedger,
    options: Record<string, unknown> = {}
  ): Promise<{ state: Awaited<ReturnType<AgentLoop['runTask']>>; executeAction: ReturnType<typeof vi.fn> }> {
    const responses: unknown[] = [
      { success: true, action: { action: 'scroll', direction: 'down', amount: 400 } },
      { success: true, proposal },
    ];
    let call = 0;

    const originalFetch = globalThis.fetch;
    // The loop's Security Critic calls `/review` for every dispatched action, so
    // the stub answers it with a SAFE verdict. Returning an action payload there
    // would be a malformed review response, which A8 refuses — correctly.
    globalThis.fetch = (async (input: unknown) => {
      const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? '');
      const body = url.includes('/review')
        ? { safe: true, reason: 'ok' }
        : responses[Math.min(call, responses.length - 1)];
      if (!url.includes('/review')) call += 1;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const executeAction = vi.fn(async () => ({ success: true, message: 'ok' }));

    try {
      // The EXACT production composition from serviceWorker.ts:1432.
      const router = new ModelRouter(new BackendAgentProvider({ timeoutMs: 50 }));
      const loop = new AgentLoop(
        router,
        {
          getEffectSnapshot: async () => null,
          perceivePage: async () => context(),
          executeAction,
        } as never,
        {
          delayBetweenStepsMs: 1,
          maxSteps: 4,
          evidenceLedger: ledger,
          intentDecision: informationRequest(),
          ...options,
        } as never
      );
      const state = await loop.runTask(TASK);
      return { state, executeAction };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  it('a valid ANSWER with resolvable evidence is accepted for reporting', async () => {
    const ledger = ledgerWith(['The Charminar was built in 1591.']);
    const { state } = await runLoopWithProposal(
      {
        kind: 'ANSWER',
        reason: 'The page states this.',
        answer: 'Charminar was built in 1591.',
        cited_evidence: [firstId(ledger)],
      },
      ledger
    );

    expect(state.status).toBe('ANSWER');
    // The model may propose ANSWER; only the GoalVerifier may report SUCCESS,
    // and it did not run on this path.
    expect(state.status).not.toBe('SUCCESS');
    expect(state.answer).toContain('1591');
  });

  it('the accepted answer is composed from LOCAL evidence, not model prose', async () => {
    const ledger = ledgerWith(['The Charminar was built in 1591.']);
    const { state } = await runLoopWithProposal(
      {
        kind: 'ANSWER',
        reason: 'The page states this.',
        // The model's text is deliberately wrong on a detail.
        answer: 'The Charminar was built in 1234 and towers 400 feet tall.',
        cited_evidence: [firstId(ledger)],
      },
      ledger
    );

    expect(state.status).toBe('ANSWER');
    // The reported answer is rebuilt from the verified ledger claim. Anything
    // the model invented is absent — that is the device disposing.
    expect(state.answer).not.toContain('1234');
  });

  it('a citation the model invented is discarded, and cannot support an ANSWER', async () => {
    const ledger = ledgerWith(['The Charminar was built in 1591.']);
    const { state } = await runLoopWithProposal(
      {
        kind: 'ANSWER',
        reason: 'The page states this.',
        answer: 'Charminar was built in 1591.',
        cited_evidence: ['ev-does-not-exist-0000'],
      },
      ledger
    );

    // The invented id resolves to nothing, so the ANSWER cannot stand as an
    // answer about the subject. It is not SUCCESS either.
    expect(state.status).not.toBe('SUCCESS');
    expect(state.status === 'ANSWER').toBe(false);
  });

  it('an ANSWER with NO verified evidence is not falsely successful', async () => {
    const empty = new EvidenceLedger();
    empty.advance(1, PAGE_URL);
    const { state } = await runLoopWithProposal(
      {
        kind: 'ANSWER',
        reason: 'The page states this.',
        answer: 'Charminar was built in 1591.',
        cited_evidence: [],
      },
      empty
    );

    expect(state.status).not.toBe('SUCCESS');
    expect(state.status).toBe('NEEDS_INFORMATION');
  });

  it('stale evidence cannot back a reported answer', async () => {
    const ledger = ledgerWith(['The Charminar was built in 1591.']);
    // A page transition marks every CURRENT record stale, which is what the
    // verifier reads as "this claim no longer describes the live page".
    ledger.advance(2, PAGE_URL);

    const { state } = await runLoopWithProposal(
      {
        kind: 'ANSWER',
        reason: 'The page states this.',
        answer: 'Charminar was built in 1591.',
        cited_evidence: [ledger.citable()[0]?.id ?? 'none'],
      },
      ledger
    );

    expect(state.status).not.toBe('ANSWER');
    expect(state.status).not.toBe('SUCCESS');
  });

  it('the action path still executes before a proposal terminates the task', async () => {
    const ledger = ledgerWith(['The Charminar was built in 1591.']);
    const { state, executeAction } = await runLoopWithProposal(
      {
        kind: 'ANSWER',
        reason: 'The page states this.',
        answer: 'Charminar was built in 1591.',
        cited_evidence: [firstId(ledger)],
      },
      ledger
    );

    // One scroll was dispatched through the normal gated pipeline before the
    // proposal arrived. The proposal did not short-circuit action handling.
    expect(executeAction).toHaveBeenCalledTimes(1);
    expect(state.status).toBe('ANSWER');
  });

  it('END TO END: evidence verified by the PRODUCTION ingestion path backs a reported answer', async () => {
    // Nothing in this test calls `ledger.verify()`. The only reason the record
    // is VERIFIED is the production ingestion path itself — which is what makes
    // step 5 of the A10-F1 proof ("valid evidence is accepted -> a user-facing
    // result becomes available") reachable at all. Pre-wiring this ends
    // NEEDS_INFORMATION with zero supported records.
    const ledger = new EvidenceLedger();
    ledger.ingestObservation(semanticObservation(), PAGE_URL);
    const record = ledger.citable().find((r) => r.verificationStatus === 'VERIFIED');
    expect(record, 'ingestion must promote the observed fact').toBeTruthy();

    const { state } = await runLoopWithProposal(
      {
        kind: 'ANSWER',
        reason: 'The page states this.',
        answer: 'Charminar was built in 1591.',
        cited_evidence: [record!.id],
      },
      ledger
    );

    expect(state.status).toBe('ANSWER');
    expect(state.status).not.toBe('SUCCESS');
    expect(state.answer).toContain('1591');
  });
});

describe('A10-F1 — the device PRODUCES the verification the ANSWER contract requires', () => {
  it('ingesting a genuinely OBSERVED fact promotes it to VERIFIED (the missing production caller)', () => {
    const ledger = new EvidenceLedger();
    ledger.ingestObservation(semanticObservation(), PAGE_URL);
    const verified = ledger.citable().filter((r) => r.verificationStatus === 'VERIFIED');
    expect(verified).toHaveLength(1);
    expect(verified[0]?.freshness).toBe('CURRENT');
    // Local-only and provenance-derived: nothing model-shaped was involved.
    expect(verified[0]?.privacyStatus).toBe('SANITIZED');
  });

  it('a raw record() write is NOT promoted — verification is not a default', () => {
    const ledger = new EvidenceLedger();
    ledger.advance(1, PAGE_URL);
    const rec = ledger.record({
      claim: 'The Charminar was built in 1591.',
      key: 'charminar',
      sourceUrl: PAGE_URL,
      pageGeneration: 1,
      evidenceType: 'SEMANTIC_FACT',
      confidence: 0.9,
    });
    expect(rec?.verificationStatus).toBe('UNVERIFIED');
    expect(ledger.citable().filter((r) => r.verificationStatus === 'VERIFIED')).toHaveLength(0);
  });

  it('an unobservable observation still contributes nothing (the A2 gate is untouched)', () => {
    const ledger = new EvidenceLedger();
    for (const state of ['UNAVAILABLE', 'STALE', 'NOT_APPLICABLE'] as const) {
      expect(ledger.ingestObservation({ ...semanticObservation(), state }, PAGE_URL)).toBe(0);
    }
    expect(ledger.size).toBe(0);
  });

  it('a conflict between live facts is never promoted, in either order', () => {
    const ledger = new EvidenceLedger();
    ledger.ingestObservation(
      semanticObservation([
        { key: 'charminar', displayText: 'The Charminar was built in 1591.' },
        { key: 'charminar', displayText: 'The Charminar was built in 1687.' },
      ]),
      PAGE_URL
    );
    const records = ledger.snapshot().records;
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.verificationStatus === 'CONFLICTED')).toBe(true);
    expect(ledger.citable()).toHaveLength(0);
  });

  it('a generation advance invalidates promoted evidence (A5 non-regression)', () => {
    const ledger = new EvidenceLedger();
    ledger.ingestObservation(semanticObservation(), PAGE_URL);
    expect(ledger.citable().filter((r) => r.verificationStatus === 'VERIFIED')).toHaveLength(1);

    ledger.advance(2, PAGE_URL);

    expect(ledger.citable()).toHaveLength(0);
    expect(ledger.snapshot().records.every((r) => r.verificationStatus === 'INVALIDATED')).toBe(true);
  });
});

describe('A10-F1 — A8 is unchanged on this route', () => {
  it('a malformed 200 is still refused by validateProviderStep', () => {
    // The router hands the backend's step through untouched, so the backend's
    // own A8 validation is the only thing between a bad response and the loop.
    expect(() =>
      validateProviderStep({ success: true, action: { action: 'scroll', direction: 'sideways', amount: 1 } })
    ).toThrow();
    expect(() => validateProviderStep({ success: true, action: { action: 'scroll' } })).toThrow();
    expect(() => validateProviderStep({ success: true })).toThrow();
  });

  it('the router does not launder a malformed response into a valid one', async () => {
    // If the router tried to repair or coerce a bad step, this would pass.
    const backend = backendReturning({
      kind: 'ACTION',
      action: { action: 'scroll', direction: 'sideways', amount: 1 },
    });
    const router = new ModelRouter(backend);
    const step = await router.requestStep(TASK, context(), []);
    // Still exactly what the backend said — no repair, no coercion.
    expect((step as { action: { direction: string } }).action.direction).toBe('sideways');
  });
});