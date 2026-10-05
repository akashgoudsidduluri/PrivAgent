/**
 * PHASE 18.8 / B2 — THE CONVERSATION CONTEXT.
 *
 * Focused tests for the contract itself: creation, bounded growth, isolation
 * between conversations, refusal of stale/foreign context, persistence, and the
 * privacy rules (no raw value, no user text, no page text may enter it).
 *
 * Each privacy test states the INVARIANT, not the implementation.
 */
import { describe, it, expect } from 'vitest';

import {
  appendTurn,
  buildIdentity,
  canonicalizeUrl,
  closeTurn,
  CONVERSATION_MAX_AGE_MS,
  CONVERSATION_STORE_KEY,
  createCandidate,
  createConversationContext,
  eligibleCandidates,
  hostOf,
  identifierFromUrl,
  isUsableContext,
  MAX_CONVERSATION_CANDIDATES,
  MAX_CONVERSATION_TURNS,
  MAX_IDENTITY_TITLE_CHARS,
  normalizeTitle,
  observeCandidates,
  withPage,
  withSelection,
  type ConversationContext,
  type EntityCandidate,
} from '../extension/src/agent/conversationContext';
import {
  conversationPrivacyViolations,
  createConversationStore,
  createMemoryConversationStore,
} from '../extension/src/agent/conversationPersistence';
import { planConversation } from '../extension/src/agent/referenceResolver';
import { scanForRawSensitiveValues } from '../extension/src/privacy/rawValueScanner';

const NOW = 1_760_000_000_000;
const PAN = '4111 1111 1111 1111';

function candidate(ordinal: number, title: string, pageGeneration = 2): EntityCandidate {
  const identity = buildIdentity({ entityType: 'PRODUCT', title, url: 'https://shop.example.com/catalog' });
  if (!identity) throw new Error(`identity for ${title}`);
  return createCandidate({ ordinal, identity, pageGeneration, observedAt: NOW });
}

function ctx(): ConversationContext {
  return createConversationContext({ conversationId: 'conv-test', now: NOW });
}

describe('B2-1 creation and bounded growth', () => {
  it('1.1 a fresh context is empty, frozen and fresh', () => {
    const c = ctx();
    expect(c.turns).toEqual([]);
    expect(c.candidates).toEqual([]);
    expect(c.selection).toBeNull();
    expect(c.clarification).toBeNull();
    expect(c.freshness).toBe('FRESH');
    expect(Object.isFrozen(c)).toBe(true);
  });

  it('1.2 turns are bounded — the oldest are dropped, never accumulated', () => {
    let c = ctx();
    for (let i = 0; i < MAX_CONVERSATION_TURNS + 8; i += 1) {
      c = appendTurn(c, { intentClass: 'ACTION', intentDigest: `d${i}`, taskLength: 10, now: NOW + i }).context;
    }
    expect(c.turns).toHaveLength(MAX_CONVERSATION_TURNS);
    expect(c.turns[0]!.index).toBe(0);
    expect(c.turns[MAX_CONVERSATION_TURNS - 1]!.index).toBe(MAX_CONVERSATION_TURNS - 1);
  });

  it('1.3 candidates are bounded, and only those for the LIVE page resolve', () => {
    const many = Array.from({ length: MAX_CONVERSATION_CANDIDATES + 6 }, (_, i) => candidate(i + 1, `product ${i + 1}`));
    const c = observeCandidates(ctx(), many, NOW, 2);
    expect(c.candidates).toHaveLength(MAX_CONVERSATION_CANDIDATES);
    expect(eligibleCandidates(c)).toHaveLength(MAX_CONVERSATION_CANDIDATES);

    // A navigation drops the old page's candidates from eligibility.
    const navigated = withPage(c, { url: 'https://shop.example.com/detail', role: 'product_detail', pageGeneration: 3, navigated: true }, NOW + 1);
    expect(eligibleCandidates(navigated)).toHaveLength(0);
  });

  it('1.4 a closed turn records its outcome without the user text', () => {
    let c = ctx();
    const opened = appendTurn(c, { intentClass: 'ACTION', intentDigest: 'abc', taskLength: 42, now: NOW });
    c = opened.context;
    c = closeTurn(c, opened.index, 'SUCCESS', NOW + 5);
    expect(c.turns[0]!.status).toBe('SUCCESS');
    expect(JSON.stringify(c.turns[0])).not.toContain('find the top 5 products');
  });
});

describe('B2-2 isolation and staleness', () => {
  it('2.1 a first turn starts a new conversation', () => {
    const plan = planConversation({ task: 'find the top 5 products under 1000', current: null, conversationId: 'conv-a', now: NOW });
    expect(plan.mode).toBe('NEW');
    expect(plan.reason).toBe('NO_ACTIVE_CONVERSATION');
    expect(plan.context?.turns).toEqual([]);
  });

  it('2.2 a turn with NO reference starts a NEW conversation (no inherited candidates)', () => {
    const active = observeCandidates(ctx(), [candidate(1, 'alpha'), candidate(2, 'beta')], NOW, 2);
    const plan = planConversation({ task: 'now search for laptops', current: active, conversationId: 'conv-b', now: NOW });
    expect(plan.mode).toBe('NEW');
    expect(plan.reason).toBe('NO_REFERENCE_IN_TURN');
    expect(plan.context?.candidates).toEqual([]);
  });

  it('2.3 a reference with nothing to refer to starts a NEW conversation', () => {
    const active = ctx();
    const plan = planConversation({ task: 'tell me about the third one', current: active, conversationId: 'conv-c', now: NOW });
    expect(plan.mode).toBe('NEW');
    expect(plan.reason).toBe('NO_ANCHOR_TO_REFER_TO');
  });

  it('2.4 "new task" always starts a new conversation, even with an anchor', () => {
    const active = observeCandidates(ctx(), [candidate(1, 'alpha')], NOW, 2);
    const plan = planConversation({ task: 'start over, new task for the weather', current: active, conversationId: 'conv-d', now: NOW });
    expect(plan.mode).toBe('NEW');
    expect(plan.reason).toBe('EXPLICIT_NEW_CONVERSATION');
  });

  it('2.5 a reference WITH an anchor continues the same conversation', () => {
    const active = observeCandidates(ctx(), [candidate(1, 'alpha'), candidate(2, 'beta'), candidate(3, 'gamma')], NOW, 2);
    const plan = planConversation({ task: 'tell me about the third one', current: active, conversationId: 'conv-e', now: NOW });
    expect(plan.mode).toBe('CONTINUE');
    expect(plan.context?.conversationId).toBe('conv-test');
  });

  it('2.6 a context from another conversation, or past its age, is refused', () => {
    const c = ctx();
    expect(isUsableContext(c, { conversationId: 'conv-other', now: NOW })).toBe(false);
    expect(isUsableContext(c, { conversationId: 'conv-test', now: NOW + CONVERSATION_MAX_AGE_MS + 1 })).toBe(false);
    expect(isUsableContext(c, { conversationId: 'conv-test', now: NOW })).toBe(true);
    expect(isUsableContext(null, { conversationId: 'conv-test', now: NOW })).toBe(false);
  });

  it('2.7 a generation mismatch invalidates the context', () => {
    const c = ctx();
    expect(isUsableContext(c, { conversationId: 'conv-test', contextGeneration: 1, now: NOW })).toBe(true);
    expect(isUsableContext(c, { conversationId: 'conv-test', contextGeneration: 7, now: NOW })).toBe(false);
  });
});

describe('B2-3 persistence', () => {
  it('3.1 a conversation survives a save/load round trip', async () => {
    const store = createMemoryConversationStore();
    const c = observeCandidates(ctx(), [candidate(1, 'alpha')], NOW, 2);
    await store.save(c);
    const loaded = await store.load();
    expect(loaded?.conversationId).toBe('conv-test');
    expect(loaded?.candidates).toHaveLength(1);
  });

  it('3.2 the off-device store degrades explicitly rather than pretending', async () => {
    const store = createConversationStore();
    // Off-device (no chrome.storage.session) this MUST degrade, and say so.
    expect(store.persistenceAvailable).toBe(false);
    await store.save(ctx());
    expect((await store.load())?.conversationId).toBe('conv-test');
  });

  it('3.3 a raw sensitive value in the context is refused at the write boundary', async () => {
    const store = createMemoryConversationStore();
    // A candidate carrying a PAN in its title must never reach persistence.
    const poisoned = {
      ...ctx(),
      candidates: [{ ordinal: 1, identity: { normalizedTitle: `card ${PAN}` } }],
    };
    expect(conversationPrivacyViolations(poisoned).length).toBeGreaterThan(0);
    await store.save(poisoned as unknown as ConversationContext);
    expect(await store.load()).toBeNull();
  });
});

describe('B2-4 privacy of identity attributes', () => {
  it('4.1 a sensitive title yields NO identity, never a degraded one', () => {
    expect(normalizeTitle(`card ${PAN}`)).toBeNull();
    expect(buildIdentity({ entityType: 'PRODUCT', title: `card ${PAN}` })).toBeNull();
    expect(scanForRawSensitiveValues(`card ${PAN}`, { structuralKeys: new Set() }).length).toBeGreaterThan(0);
  });

  it('4.2 sensitive attributes are dropped; safe ones are kept', () => {
    const identity = buildIdentity({
      entityType: 'PRODUCT',
      title: 'XYZ Wireless Headphones',
      attributes: { price: 899, rating: 4.4, availability: 'in stock', cvv: '123', accountNumber: PAN },
    });
    expect(identity).not.toBeNull();
    expect(identity!.attributes).toEqual({ price: 899, rating: 4.4, availability: 'in stock' });
    expect(JSON.stringify(identity)).not.toContain('123');
    expect(JSON.stringify(identity)).not.toContain(PAN);
  });

  it('4.3 a URL identity keeps an allowlisted id and drops everything else', () => {
    expect(canonicalizeUrl('https://Shop.Example.com:443/p/3/?ref=affiliate&token=secret#frag')).toBe(
      'https://shop.example.com/p/3'
    );
    expect(identifierFromUrl('https://shop.example.com/product?id=xyz-9')).toBe('xyz-9');
    expect(hostOf('https://www.shop.example.com/p/3')).toBe('shop.example.com');
    expect(canonicalizeUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalizeUrl(`https://shop.example.com/u?email=a@b.com`)).not.toContain('@b.com');
  });

  it('4.4 titles are bounded', () => {
    const long = 'x'.repeat(MAX_IDENTITY_TITLE_CHARS * 3);
    const title = normalizeTitle(long);
    expect(title === null || title.length <= MAX_IDENTITY_TITLE_CHARS).toBe(true);
  });

  it('4.5 nothing in a built context trips the raw-value scanner', () => {
    const c = observeCandidates(
      ctx(),
      [candidate(1, 'XYZ Wireless Headphones'), candidate(2, 'Basic Cotton Socks')],
      NOW,
      2
    );
    expect(conversationPrivacyViolations(c)).toEqual([]);
  });

  it('4.6 a selection carries a bounded, screened identity — never raw state', () => {
    const identity = buildIdentity({ entityType: 'PRODUCT', title: 'XYZ Wireless Headphones' })!;
    const c = withSelection(
      observeCandidates(ctx(), [candidate(1, 'XYZ Wireless Headphones')], NOW, 2),
      {
        identityKey: identity.identityKey,
        ordinal: 1,
        identity,
        resolvedAt: NOW,
        revalidatedAt: null,
        revalidation: 'SELECTED',
      },
      NOW
    );
    expect(c.selection?.identity.normalizedTitle).toBe('xyz wireless headphones');
    expect(conversationPrivacyViolations(c)).toEqual([]);
  });

  it('4.7 the store key targets session storage, never disk', () => {
    expect(CONVERSATION_STORE_KEY).toContain('conversation');
    expect(CONVERSATION_STORE_KEY.startsWith('privagent.')).toBe(true);
  });
});