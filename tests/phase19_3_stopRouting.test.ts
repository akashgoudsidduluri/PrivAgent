/**
 * PHASE 19.3 — "STOP." + A QUESTION: ROUTING AND CANCELLATION AUTHORITY.
 *
 * Real-browser finding (A12 interrupt scenario): the interrupt message
 * "Stop. What is TCP?" stopped the running task correctly, but the QUESTION was
 * then handled by the browser pipeline (an evidence request against the page in
 * front of us) instead of as a normal conversation, because the definitional
 * shape patterns are anchored at the start of the message.
 *
 * The fix ignores a LEADING CANCELLATION PREFIX for the shape test ONLY.
 * Everything that makes a message a browser task is still evaluated against the
 * FULL text first, so nothing can hide behind "Stop.", and a message whose
 * remainder is not a recognised conversational shape still falls through to the
 * pipeline unchanged.
 *
 * The prefix is also a predicate the service worker uses to keep cancellation
 * authoritative: an answer to "Stop. ..." must not leave the old run working.
 */

import { describe, it, expect } from 'vitest';

import {
  classifyMessageRoute,
  hasLeadingCancellation,
  stripLeadingCancellation,
  CONVERSATIONAL_CODES,
  type MessageRouteCode,
} from '../extension/src/agent/conversationRoute';

const routeOf = (task: string) => classifyMessageRoute(task);

describe('19.3-A the reported matrix', () => {
  it('A. "Stop. What is TCP?" is a CONVERSATION (was: browser pipeline)', () => {
    expect(routeOf('Stop. What is TCP?')).toEqual({
      route: 'CONVERSATION',
      code: 'DEFINITIONAL_KNOWLEDGE',
    });
  });

  it('B. "Stop. Explain BFS." is a CONVERSATION', () => {
    expect(routeOf('Stop. Explain BFS.')).toEqual({
      route: 'CONVERSATION',
      code: 'DEFINITIONAL_KNOWLEDGE',
    });
  });

  it('C. "Stop. Open Wikipedia." stays in the PIPELINE', () => {
    // Not a conversational shape even after the prefix is ignored: it is a
    // bare imperative, which the router deliberately never answers from model
    // knowledge.
    expect(routeOf('Stop. Open Wikipedia.').route).toBe('PIPELINE');
  });

  it('D. "Stop. Search for cats." stays in the PIPELINE as a BROWSER_VERB', () => {
    expect(routeOf('Stop. Search for cats.')).toEqual({ route: 'PIPELINE', code: 'BROWSER_VERB' });
  });

  it('E. "What is TCP?" is a CONVERSATION (unchanged)', () => {
    expect(routeOf('What is TCP?')).toEqual({
      route: 'CONVERSATION',
      code: 'DEFINITIONAL_KNOWLEDGE',
    });
  });

  it('F. "Explain BFS." is a CONVERSATION (unchanged)', () => {
    expect(routeOf('Explain BFS.')).toEqual({
      route: 'CONVERSATION',
      code: 'DEFINITIONAL_KNOWLEDGE',
    });
  });

  it('G. a browser task with no Stop still enters the PIPELINE', () => {
    expect(routeOf('Open Wikipedia.').route).toBe('PIPELINE');
    expect(routeOf('Search for laptops.').route).toBe('PIPELINE');
    expect(routeOf('Open the first product and tell me its price.').route).toBe('PIPELINE');
  });
});

describe('19.3-B no browser signal can hide behind the prefix', () => {
  //
  // The SECURITY-RELEVANT claim is the route: every one of these must stay in
  // the pipeline, so no browser-signal turn can be answered from static
  // knowledge just because it began with "Stop.".
  //
  // The exact code only says WHICH signal fired, and several of these match more
  // than one pattern (page deixis is checked before the browser verbs, for
  // instance). The codes pinned below are the ones verified to be stable; the
  // rest assert the route alone rather than encoding pattern precedence that the
  // router is free to reorder.
  const stillPipeline: Array<[string, MessageRouteCode | null]> = [
    ['Stop. Search for cats.', 'BROWSER_VERB'],
    ['Stop. Go to the cart.', null],
    ['Stop. Buy it now.', 'STATE_CHANGE'],
    ['Stop. Cancel my subscription.', 'STATE_CHANGE'],
    ['Stop. Send money to Bob.', 'UNSUPPORTED_CAPABILITY'],
    ['Stop. What is the price of the first result?', null],
    ['Stop. What is the latest news on this page?', null],
    ['Stop. What is on wikipedia.org?', 'NAMED_DESTINATION'],
    ['Stop. What does that mean?', 'VAGUE_REFERENCE'],
    ['Stop. Show me the third one.', null],
  ];

  it.each(stillPipeline)('%s → PIPELINE / %s', (task, code) => {
    const decided = routeOf(task);
    expect(decided.route).toBe('PIPELINE');
    if (code) expect(decided.code).toBe(code);
    // Whatever the code, it can never be one of the conversational ones.
    expect(CONVERSATIONAL_CODES.has(decided.code)).toBe(false);
  });

  it('a bare "Stop." is never answered as knowledge', () => {
    expect(routeOf('Stop.').route).toBe('PIPELINE');
    expect(routeOf('Stop.').code).toBe('NO_CONVERSATIONAL_SHAPE');
    expect(routeOf('stop').route).toBe('PIPELINE');
  });

  it('arithmetic after a Stop still answers (no browser work needed)', () => {
    expect(routeOf('Stop. 2 + 2').route).toBe('CONVERSATION');
  });

  it('only the three conversational codes can ever produce CONVERSATION', () => {
    const tasks = [
      'Stop. What is TCP?',
      'Stop. Explain BFS.',
      'Stop. Search for cats.',
      'hi',
      '2 + 2',
      'Open Wikipedia.',
    ];
    for (const t of tasks) {
      const d = routeOf(t);
      if (d.route === 'CONVERSATION') expect(CONVERSATIONAL_CODES.has(d.code)).toBe(true);
      else expect(CONVERSATIONAL_CODES.has(d.code)).toBe(false);
    }
  });
});

describe('19.3-C the cancellation predicate the service worker uses', () => {
  it('recognises the prefix, and only as a leading whole word', () => {
    expect(hasLeadingCancellation('Stop. What is TCP?')).toBe(true);
    expect(hasLeadingCancellation('stop')).toBe(true);
    expect(hasLeadingCancellation('Halt — explain BFS.')).toBe(true);
    expect(hasLeadingCancellation('  Stop, what is TCP?')).toBe(true);
    // No false positives: these are not cancellations.
    expect(hasLeadingCancellation('What is TCP?')).toBe(false);
    expect(hasLeadingCancellation('Stopwatch internals')).toBe(false);
    expect(hasLeadingCancellation('Explain how stop words work.')).toBe(false);
    expect(hasLeadingCancellation(12345)).toBe(false);
  });

  it('strips only the prefix, leaving the question intact', () => {
    expect(stripLeadingCancellation('Stop. What is TCP?')).toBe('What is TCP?');
    expect(stripLeadingCancellation('What is TCP?')).toBe('What is TCP?');
  });
});
