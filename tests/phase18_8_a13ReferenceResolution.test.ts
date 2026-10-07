/**
 * PHASE 18.8 / A13 — DETERMINISTIC CONVERSATIONAL REFERENCE RESOLUTION.
 *
 * "the third one" must select the third OBSERVED candidate, "it" must select the
 * revalidated selection, and anything ambiguous must end as a typed
 * clarification rather than a guess. The last test in this file is the important
 * one: an unresolvable reference must make ZERO provider calls and dispatch
 * nothing, so resolution cannot become a second planner or a bypass.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  appendTurn,
  buildIdentity,
  createCandidate,
  createConversationContext,
  eligibleCandidates,
  observeCandidates,
  withSelection,
  type ConversationContext,
  type EntityCandidate,
  type EntityIdentity,
} from '../extension/src/agent/conversationContext';
import { detectReference, resolveReference } from '../extension/src/agent/referenceResolver';
import { parseTaskTargetReference, resolveTargetWebTab } from '../extension/src/background/targetResolver';
import { AgentLoop } from '../extension/src/agent/agentLoop';
import { MockAgentProvider } from '../extension/src/agent/mockAgentProvider';
import type { AgentContextPayload } from '../extension/src/privacy/types';

const NOW = 1_760_000_000_000;
const CATALOG = 'https://shop.example.com/catalog';

function candidate(ordinal: number, title: string, pageGeneration = 2): EntityCandidate {
  const identity = buildIdentity({ entityType: 'PRODUCT', title, url: CATALOG })!;
  return createCandidate({ ordinal, identity, pageGeneration, observedAt: NOW });
}

function listingContext(): ConversationContext {
  const base = createConversationContext({ conversationId: 'conv-a13', now: NOW });
  return appendTurn(base, { intentClass: 'INFORMATION_REQUEST', intentDigest: 'd0', taskLength: 20, now: NOW })
    .context;
}

function withCandidates(): ConversationContext {
  return observeCandidates(
    listingContext(),
    [candidate(1, 'XYZ Wireless Headphones'), candidate(2, 'Cotton Socks 6 Pack'), candidate(3, 'Steel Water Bottle')],
    NOW,
    2
  );
}

function selectionFor(ctx: ConversationContext, identity: EntityIdentity, ordinal: number) {
  return withSelection(ctx, {
    identityKey: identity.identityKey,
    ordinal,
    identity,
    resolvedAt: NOW,
    revalidatedAt: NOW,
    revalidation: 'REVALIDATED',
  }, NOW + 1);
}

describe('A13-1 ordinals', () => {
  it('1.1 "the third one" resolves to the third observed candidate', () => {
    const ref = detectReference('Tell me about the third one.');
    expect(ref?.kind).toBe('ORDINAL');
    expect(ref?.ordinal).toBe(3);
    const result = resolveReference(ref, withCandidates());
    expect(result.outcome).toBe('RESOLVED');
    expect(result.basis).toBe('ORDINAL');
    expect(result.candidate?.ordinal).toBe(3);
    expect(result.identity?.normalizedTitle).toBe('steel water bottle');
  });

  it('1.2 first / second / third / "3rd result" all map to the same list', () => {
    const ctx = withCandidates();
    expect(resolveReference(detectReference('open the first one'), ctx).candidate?.ordinal).toBe(1);
    expect(resolveReference(detectReference('open the second one'), ctx).candidate?.ordinal).toBe(2);
    expect(resolveReference(detectReference('open 3rd result'), ctx).candidate?.ordinal).toBe(3);
  });

  it('1.3 an ordinal beyond the list asks instead of clamping', () => {
    const result = resolveReference(detectReference('tell me about the ninth one'), withCandidates());
    expect(result.outcome).toBe('NEEDS_CLARIFICATION');
    expect(result.clarificationCode).toBe('OUT_OF_RANGE_ORDINAL');
    expect(result.candidate).toBeNull();
  });
});

describe('A13-2 pronouns and descriptors', () => {
  it('2.1 "it" resolves to the revalidated selection, even after navigation', () => {
    const ctx = selectionFor(withCandidates(), candidate(3, 'Steel Water Bottle').identity, 3);
    // The detail page no longer lists the catalog candidates.
    const navigated = observeCandidates(ctx, [], NOW + 10, 9);
    const result = resolveReference(detectReference('Open it.'), navigated);
    expect(result.outcome).toBe('RESOLVED');
    expect(result.basis).toBe('REVALIDATED_SELECTION');
    expect(result.identity?.normalizedTitle).toBe('steel water bottle');
  });

  it('2.2 "this product" resolves when exactly ONE candidate is live', () => {
    const single = observeCandidates(listingContext(), [candidate(1, 'Cotton Socks 6 Pack')], NOW, 2);
    const result = resolveReference(detectReference('tell me about this product'), single);
    expect(result.outcome).toBe('RESOLVED');
    expect(result.basis).toBe('UNIQUE_CANDIDATE');
  });

  it('2.3 "the one we opened" and "the previous result" are references, not prose', () => {
    expect(detectReference('use the one we opened')?.kind).toBe('DESCRIPTOR');
    expect(detectReference('repeat the previous result')?.kind).toBe('DESCRIPTOR');
  });

  it('2.4 a bare "it" inside a long sentence is NOT silently resolved', () => {
    expect(detectReference('get the weather and then tell me about it')).toBeNull();
    expect(detectReference('Open it')?.kind).toBe('PRONOUN');
  });

  it('2.5 an ordinary task is not a reference', () => {
    expect(detectReference('Find the top 5 products under 1000 with good ratings')).toBeNull();
    const result = resolveReference(null, withCandidates());
    expect(result.outcome).toBe('NOT_A_REFERENCE');
  });
});

describe('A13-3 fail-closed paths', () => {
  it('3.1 no candidates at all is NEEDS_INFORMATION, not a guess', () => {
    const result = resolveReference(detectReference('tell me about the third one'), listingContext());
    expect(result.outcome).toBe('NEEDS_INFORMATION');
    expect(result.clarificationCode).toBe('NO_CANDIDATES');
    expect(result.candidate).toBeNull();
  });

  it('3.2 candidates from a page we have left are reported as stale', () => {
    const ctx = withCandidates();
    const navigated = observeCandidates(ctx, [], NOW + 5, 7);
    const result = resolveReference(detectReference('the third one'), navigated);
    expect(result.outcome).toBe('NEEDS_INFORMATION');
    expect(result.clarificationCode).toBe('STALE_CANDIDATES');
  });

  it('3.3 several candidates and nothing selected is NEEDS_CLARIFICATION', () => {
    const result = resolveReference(detectReference('open it'), withCandidates());
    expect(result.outcome).toBe('NEEDS_CLARIFICATION');
    expect(result.clarificationCode).toBe('AMBIGUOUS_REFERENCE');
    expect(result.candidate).toBeNull();
    expect(result.identity).toBeNull();
  });

  it('3.4 a selection that could not be re-established never resolves', () => {
    const third = candidate(3, 'Steel Water Bottle');
    const ctx = selectionFor(withCandidates(), third.identity, 3);
    const broken = withSelection(ctx, {
      identityKey: third.identity.identityKey,
      ordinal: 3,
      identity: third.identity,
      resolvedAt: NOW,
      revalidatedAt: null,
      revalidation: 'NOT_FOUND',
    }, NOW + 20);
    const result = resolveReference(detectReference('open it'), broken);
    expect(result.outcome).toBe('NEEDS_CLARIFICATION');
    expect(result.clarificationCode).toBe('ENTITY_NOT_FOUND_AFTER_NAVIGATION');
  });

  it('3.5 a conflicting identity never resolves to the other candidate', () => {
    const third = candidate(3, 'Steel Water Bottle');
    const ctx = selectionFor(withCandidates(), third.identity, 3);
    const conflicted = withSelection(ctx, {
      identityKey: third.identity.identityKey,
      ordinal: 3,
      identity: third.identity,
      resolvedAt: NOW,
      revalidatedAt: null,
      revalidation: 'UNCONFIRMED',
    }, NOW + 21);
    const result = resolveReference(detectReference('open it'), conflicted);
    expect(result.outcome).toBe('NEEDS_CLARIFICATION');
    expect(result.clarificationCode).toBe('CONFLICTING_IDENTITY');
    expect(result.identity).toBeNull();
  });

  it('3.6 every clarification explains itself without leaking an internal code', () => {
    for (const task of ['open it', 'tell me about the third one', 'the ninth one']) {
      const result = resolveReference(detectReference(task), withCandidates());
      if (result.outcome === 'RESOLVED') continue;
      expect(result.question).toBeTruthy();
      expect(result.question).not.toMatch(/AMBIGUOUS|REVALIDATION|IDENTITY|CANDIDATE|ordinal \d|undefined|null/i);
    }
  });
});

describe('A13-4 the resolver cannot become a second planner', () => {
  /** A sanitized perception plus a world model with three catalog products. */
  function catalogPerception(entities: string[] = ['XYZ Wireless Headphones', 'Cotton Socks 6 Pack', 'Steel Water Bottle']) {
    return async () => {
      const context = {
        url: CATALOG,
        timestamp: NOW,
        viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
        screenshot_dimensions: { width: 1280, height: 800 },
        sanitized_status: 'sanitized_only',
        detections: [],
        total_elements_scanned: 10,
        sensitive_elements_detected: 0,
        ocr_metrics: { regions_scanned: 0, sensitive_detected: 0, latency_ms: 0 },
      } as unknown as AgentContextPayload;
      return {
        context,
        worldModel: {
          id: 'wm-1',
          page: { url: CATALOG, pageGeneration: 2, pageType: 'listing' },
          entities: entities.map((title, i) => ({
            id: `el-${i + 1}`,
            type: 'Product',
            title,
            bbox: [100, 100 + i * 200, 200, 40] as [number, number, number, number],
            associatedElementIds: [],
            attributes: { price: 100 + i * 100 },
            confidence: 0.9,
            pageGeneration: 2,
          })),
          ocrRegions: [],
          visualRegions: [],
          privacyFindings: [],
        },
      } as never;
    };
  }

  it('4.1 an unresolvable reference makes zero provider calls and dispatches nothing', async () => {
    const provider = {
      requestAction: vi.fn(),
      requestStep: vi.fn(),
      reviewAction: vi.fn(async () => ({ safe: true })),
    };
    const executed: unknown[] = [];
    const loop = new AgentLoop(
      provider as never,
      {
        perceivePage: catalogPerception(),
        executeAction: async (action) => {
          executed.push(action);
          return { success: true };
        },
      },
      { maxSteps: 3, maxRetries: 1, delayBetweenStepsMs: 1, conversationContext: listingContext() }
    );
    const state = await loop.runTask('open it');
    expect(state.status).toBe('NEEDS_CLARIFICATION');
    expect(state.clarification?.code).toBe('AMBIGUOUS_REFERENCE');
    expect(provider.requestAction).not.toHaveBeenCalled();
    expect(provider.requestStep).not.toHaveBeenCalled();
    expect(executed).toHaveLength(0);
    expect(state.steps).toHaveLength(0);
    expect(state.conversation?.referenceOutcome).toBe('NEEDS_CLARIFICATION');
    expect(state.conversation?.candidateCount).toBe(3);
  });

  it('4.2 a resolvable reference still runs every gate — the selection is an input, not an authorization', async () => {
    const provider = new MockAgentProvider([
      { action: 'click', target: 'nope-not-grounded', reason: 'invented target' },
    ]);
    const executed: unknown[] = [];
    const loop = new AgentLoop(
      provider as never,
      {
        perceivePage: catalogPerception(),
        executeAction: async (action) => {
          executed.push(action);
          return { success: true };
        },
      },
      { maxSteps: 2, maxRetries: 1, delayBetweenStepsMs: 1, conversationContext: listingContext() }
    );
    const state = await loop.runTask('tell me about the third one');
    expect(state.conversation?.referenceOutcome).toBe('RESOLVED');
    expect(state.conversation?.selectedOrdinal).toBe(3);
    expect(state.conversation?.selectedEntityType).toBe('PRODUCT');
    // Grounding refused the invented target: resolution granted no authority.
    expect(executed).toHaveLength(0);
  });

  // ── Integration: a reference must survive the layers in front of the loop ──
  //
  // Found by REAL CHROME (multiturn run 3): "Open it." was parsed as a
  // destination named "it" and the turn died with DESTINATION_REQUIRED before
  // perception, while every other reference turn worked. Both regressions
  // below are the fixes, asserted at the layer that used to break.

  it('4.3 a conversational object after an open verb is not a destination', () => {
    // Real-browser defect: "Open it." → parseTaskTargetReference → rawTarget
    // "it" → no tab matches → DESTINATION_REQUIRED → FAILED before the loop.
    expect(parseTaskTargetReference('Open it.')).toBeNull();
    expect(parseTaskTargetReference('Open the third one.')).toBeNull();
    expect(parseTaskTargetReference('Show me that product.')).toBeNull();
    expect(parseTaskTargetReference('Get details about it.')).toBeNull();
    // A REAL destination in the same shape still parses — the stop list is
    // about pronouns, not about open-intents.
    expect(parseTaskTargetReference('Open wikipedia')).toMatchObject({ rawTarget: 'wikipedia' });
    expect(parseTaskTargetReference('open https://example.com/x')).toMatchObject({
      rawTarget: 'https://example.com/x',
    });
  });

  // ── PAGE SCOPE — found by REAL CHROME (A14 real-Chrome run) ───────────────
  //
  // "Reply to the order enquiry shown on this page." ended the turn
  // NEEDS_INFORMATION with "I do not have a list of items from this page yet, so
  // I cannot tell which one you mean." — a question with no answer, on a page
  // that lists no items. The locative names WHERE, not WHICH.

  it('5.1 "on this page" is page scope: no candidates, no question, no entity', () => {
    const ref = detectReference('Reply to the order enquiry shown on this page.');
    expect(ref?.kind).toBe('PAGE');
    const result = resolveReference(ref, listingContext());
    expect(result.outcome).toBe('PAGE_SCOPED');
    expect(result.question).toBeNull();
    expect(result.clarificationCode).toBeNull();
    expect(result.candidate).toBeNull();
    expect(result.identity).toBeNull();
    // It needs no conversation at all: the page is already in front of the device.
    expect(resolveReference(detectReference('summarize that page'), null).outcome).toBe('PAGE_SCOPED');
  });

  it('5.2 an ordinal on the same page still outranks the locative', () => {
    const ref = detectReference('open the third one on this page');
    expect(ref?.kind).toBe('ORDINAL');
    const result = resolveReference(ref, withCandidates());
    expect(result.outcome).toBe('RESOLVED');
    expect(result.basis).toBe('ORDINAL');
    expect(result.candidate?.ordinal).toBe(3);
  });

  it('5.3 entity references with nothing observed still fail closed', () => {
    const result = resolveReference(detectReference('tell me about this product'), listingContext());
    expect(result.outcome).toBe('NEEDS_INFORMATION');
    expect(result.clarificationCode).toBe('NO_CANDIDATES');
  });

  it('5.4 a page-scoped turn reaches the reasoner and anchors nothing', async () => {
    const provider = new MockAgentProvider([
      { action: 'click', target: 'nope-not-grounded', reason: 'invented target' },
    ]);
    const reasoner = vi.spyOn(provider as never as { requestAction: () => unknown }, 'requestAction');
    const executed: unknown[] = [];
    const loop = new AgentLoop(
      provider as never,
      {
        // The A14 fixture: a page that lists no product at all.
        perceivePage: catalogPerception([]),
        executeAction: async (action) => {
          executed.push(action);
          return { success: true };
        },
      },
      { maxSteps: 2, maxRetries: 1, delayBetweenStepsMs: 1, conversationContext: listingContext() }
    );
    const state = await loop.runTask('Reply to the order enquiry shown on this page.');
    expect(state.conversation?.referenceOutcome).toBe('PAGE_SCOPED');
    // Not the unanswerable refusal this replaces.
    expect(state.status).not.toBe('NEEDS_INFORMATION');
    expect(state.clarification?.code ?? null).toBeNull();
    // The reasoner was actually consulted: the turn was not refused before it.
    expect(reasoner).toHaveBeenCalled();
    // No entity was selected, so no reference line can be derived from it.
    expect(state.conversation?.selectedIdentityKey).toBeNull();
    // The invented target was still refused by grounding — page scope grants nothing.
    expect(executed).toHaveLength(0);
  });

  it('4.4 "Open it." now resolves to the active web tab instead of failing', () => {
    const tabs = [
      { id: 7, url: CATALOG, active: false },
      { id: 9, url: 'https://shop.example.com/catalog', active: true },
    ];
    const resolution = resolveTargetWebTab(tabs as never, 'Open it.', 'http://localhost:5173');
    expect(resolution.failureCode ?? null).toBeNull();
    expect(resolution.selectedTab?.id).toBe(9);
    expect(resolution.provisioning ?? null).toBeNull();
  });
});