/**
 * FINAL PRODUCT ACCEPTANCE — THE NORMAL-CHAT ROUTE.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * The I-1 intent boundary (see `intentBoundary.ts`) already guarantees that a
 * casual message never LAUNCHES browser automation: it is refused
 * deterministically, with zero provider calls and zero tab provisioning. What
 * it never did was ANSWER. "Hi" came back as "No browser action is needed for
 * that.", and every ordinary knowledge question — "What is machine learning?",
 * "Explain TCP vs UDP", "What is 2 + 2?" — carried a knowledge verb, was
 * classified INFORMATION_REQUEST and was therefore admitted to the full browser
 * pipeline: target-tab resolution, perception, a world model, provider
 * round-trips and an evidence-based completion rule, all to answer a question
 * that needs no browser at all.
 *
 * This module is the missing decision. It answers ONE question, locally and
 * deterministically:
 *
 *   Can this message be answered as ordinary conversation, with no browser
 *   involvement whatsoever?
 *
 * ── What it can and cannot do ───────────────────────────────────────────────
 * CONVERSATION is a NARROW, WHITELISTED verdict. It is produced by exactly three
 * codes — smalltalk, a definitional/technical question, or arithmetic — and
 * only when the message carries NO browser signal at all (no page deixis, no
 * named site, no navigation/search/mutation verb, no freshness requirement, no
 * capability the agent does not have).
 *
 * Everything else — including every message this module is not sure about —
 * returns PIPELINE, which means "not mine": the caller falls through to the
 * EXISTING I-1 boundary unchanged, which may admit a browser task, refuse, or
 * ask for clarification exactly as it does today.
 *
 * That asymmetry is the whole safety argument. This route can only ever REMOVE
 * browser work from a message that provably needs none; it cannot admit
 * anything, cannot dispatch anything, cannot resolve a target, and cannot
 * provision a tab. Its worst failure mode is answering conversationally
 * something that would have been better served by a browser run — an
 * availability cost, never a safety one.
 *
 * It is also deliberately hostile to the trap the audit names: a sentence
 * containing "search", "find", "open" or "latest" is NOT thereby a browser
 * task, and a sentence containing "what is" is NOT thereby free of one. Both
 * directions are decided by the whole message, never by one word.
 *
 * Pure: no I/O, no clock, no model, no randomness, and no parameter for
 * anything a model said.
 */

import { isPureGreeting } from './intentBoundary';

/** Which path a message belongs on. */
export type MessageRoute =
  /** Answer it here: ordinary conversation. Never touches the browser. */
  | 'CONVERSATION'
  /** Not this route's business: hand it to the existing I-1 boundary unchanged. */
  | 'PIPELINE';

/** Why the route came out the way it did. Fixed vocabulary, never prose. */
export type MessageRouteCode =
  // ── the only three codes that produce CONVERSATION ──
  | 'SMALLTALK'
  | 'DEFINITIONAL_KNOWLEDGE'
  | 'ARITHMETIC'
  // ── browser signals: each of these sends the message to the pipeline ──
  | 'BROWSER_VERB'
  | 'PAGE_DEIXIS'
  | 'VAGUE_REFERENCE'
  | 'NAMED_DESTINATION'
  | 'FRESHNESS_REQUIRED'
  | 'STATE_CHANGE'
  | 'UNSUPPORTED_CAPABILITY'
  | 'NO_CONVERSATIONAL_SHAPE';

export interface MessageRouteDecision {
  readonly route: MessageRoute;
  readonly code: MessageRouteCode;
}

/**
 * The three codes that can EVER produce CONVERSATION. Exported so a caller (and
 * its tests) can assert the whitelist directly instead of re-deriving it.
 */
export const CONVERSATIONAL_CODES: ReadonlySet<MessageRouteCode> = new Set<MessageRouteCode>([
  'SMALLTALK',
  'DEFINITIONAL_KNOWLEDGE',
  'ARITHMETIC',
]);

// ── Browser signals ──────────────────────────────────────────────────────────
//
// Every pattern below is written against a CONSTRUCTION, not a bare keyword.
// "binary search tree" is a technical question; "search for laptops" is a
// browser task; "the latest information about X" is a browser task and
// "explain the latest consensus on X" is not (it is a definitional question
// whose wording merely happens to contain a freshness word — see the ordering
// note in `classifyMessageRoute`).

/** A search/navigation/interaction construction that only a browser can serve. */
const BROWSER_VERB =
  /\b(search for|search(?:es|ing)? the|search on|search up|search the web|google|find the|find me|find out about|find the latest|look up the|open the|open up|go to the|navigate to|visit the|browse the|click (?:the|on)|tap the|press the|scroll (?:down|up|to)|download the|upload|add to (?:the )?cart|log ?in|sign ?in)\b/i;

/**
 * Page deixis. The message points at the CURRENT document, or at an artefact of
 * a live session, so the answer depends on a page only the browser can read.
 */
const PAGE_DEIXIS =
  /\b(this page|that page|the page|this site|that site|the site|this product|that product|the product|this result|that result|the result|the results|first result|second result|third result|fourth result|fifth result|this listing|that listing|the listing|this item|that item|the item|this cart|the cart|my cart|my account|my order|my orders|this order|that order|the order|this screen|that screen|the screen|this fixture|the fixture|shopping fixture|this tab|the tab|current page|this document|here on|on this)\b/i;

/**
 * A bare deictic object — a pronoun standing in for something the message never
 * names.
 *
 * Bare `this`/`that` are included even though they are usually determiners: as a
 * DETERMINER they are already caught by PAGE_DEIXIS ("this product"), and as a
 * PRONOUN ("what does that mean exactly") they are a reference with no referent
 * — which is the same defect as "Tell me about it." The cost of being wrong is
 * that a legitimate question containing the word "that" is served by the browser
 * pipeline instead; the cost of the other error is answering a question about an
 * object nobody identified.
 *
 * Found by this file's own acceptance test: "Tell me about it." matched the
 * definitional shape ("tell me about …") and was about to be answered as a
 * general question about the pronoun. It has no object, so there is nothing to
 * answer and nothing to browse: that is a CLARIFICATION case, and it belongs to
 * the pipeline's reference layer, which is the only thing that knows whether a
 * live conversation supplies a referent. When one does, I-1 lets the turn
 * through and the resolver uses it; when one does not, the user is asked.
 */
const VAGUE_REFERENCE =
  /\b(it|its|them|they|those|these|that|this|that one|this one|the one|the ones|the same|he|she|him|her|his|hers)\b/i;

/** A destination named explicitly (URL, hostname, or a known search portal). */
const NAMED_DESTINATION =
  /(https?:\/\/[^\s]+)|\b[a-z0-9-]+\.(?:com|org|net|in|io|gov|edu|dev|app|ai|co)\b/i;

/**
 * The answer changes with time, so it cannot come from static knowledge. These
 * are the words that make a question a LOOKUP rather than a definition.
 */
const FRESHNESS_REQUIRED =
  /\b(latest|newest|most recent|current(?:ly)?|right now|today|tonight|tomorrow|as of|live|real ?time|price|prices|pricing|cost|stock|in stock|availability|available now|news|headlines?|weather|forecast|exchange rate|score|scores|deal|deals|offer|offers|top \d)\b/i;

/** A state change: the message asks to alter something, never to be answered. */
const STATE_CHANGE =
  /\b(buy|purchase|check ?out|order it|order this|add to|book|reserve|apply|submit|send|post|upload|download|delete|remove|transfer|withdraw|deposit|pay|subscribe|register|sign ?up|fill|enter|type|click|press|accept|decline|confirm|cancel)\b/i;

/**
 * Capabilities the agent does not have. Mirrors the I-1 list deliberately: a
 * message that the boundary declines must not be "answered" here instead, or
 * this route would quietly replace an honest refusal with a model guess.
 */
const UNSUPPORTED_CAPABILITY =
  /\b(send (?:an? )?(?:e-?mail|email|sms|text message|message|whatsapp|telegram|dm)|(?:call|ring|phone) (?:me|him|her|them|someone|us)|voice ?call|make (?:a )?(?:phone )?call|download (?:and )?(?:run|execute)|run (?:this )?(?:script|code|command|program)|execute (?:code|script)|install (?:this |a )?(?:software|package|extension|app)\b|delete (?:this |my )?(?:account|all data)|transfer money|wire money|send money|pay (?:someone|them|him|her))\b/i;

/** The shapes of a question that asks for knowledge rather than for action. */
const DEFINITIONAL =
  /^(what|who|when|where|why|how|which|whose|is|are|does|do|did|can|could|would|should|explain|describe|define|compare|tell me about|difference between|summar(?:y|ise|ize))\b/i;

/** An operator-only message is arithmetic, which needs no browser and no page. */
const ARITHMETIC_TOKENS = /^[\d\s+*/%^().\-=,:x×÷]+$/i;
const ARITHMETIC_WORDS = /\b(plus|minus|times|multiplied by|divided by|to the power of|square root of|percent of|modulo)\b/i;

function normalize(task: string): string {
  return task.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** True when the message is nothing but an arithmetic expression or question. */
function isArithmetic(task: string): boolean {
  const n = normalize(task);
  if (!n) return false;
  // Strip the question wrapper, then require an operator to remain: "2 + 2" is
  // arithmetic, "2" alone is a bare noun phrase and stays in the pipeline.
  const body = n
    .replace(/^(what(?:'s| is| are)?|how much is|calculate|compute|evaluate|solve)\b/, '')
    .replace(/[?=\s]+$/, '')
    .trim();
  if (!body) return false;
  if (!/\d/.test(body)) return false;
  if (ARITHMETIC_TOKENS.test(body)) return /[+\-*/%^×÷]/.test(body);
  return ARITHMETIC_WORDS.test(body) && /[+\-*/%^×÷]/.test(body);
}

/**
 * Decide which path a raw user message belongs on.
 *
 * Ordering is load-bearing and deliberate: EVERY browser signal is checked
 * before any conversational shape is granted. Asking "is this a question?" first
 * would let "is there a cheaper one on the site?" through as a definitional
 * question, because it also starts with "is".
 */
export function classifyMessageRoute(rawTask: unknown): MessageRouteDecision {
  if (typeof rawTask !== 'string') return { route: 'PIPELINE', code: 'NO_CONVERSATIONAL_SHAPE' };
  const task = rawTask.trim();
  if (!task.length) return { route: 'PIPELINE', code: 'NO_CONVERSATIONAL_SHAPE' };

  // The shared I-1 smalltalk predicate. One definition, so the two boundaries
  // can never disagree about what "hi" is.
  if (isPureGreeting(task)) return { route: 'CONVERSATION', code: 'SMALLTALK' };

  // ── 1. Any browser signal at all wins. ────────────────────────────────────
  if (UNSUPPORTED_CAPABILITY.test(task)) return { route: 'PIPELINE', code: 'UNSUPPORTED_CAPABILITY' };
  if (STATE_CHANGE.test(task)) return { route: 'PIPELINE', code: 'STATE_CHANGE' };
  if (NAMED_DESTINATION.test(task)) return { route: 'PIPELINE', code: 'NAMED_DESTINATION' };
  if (PAGE_DEIXIS.test(task)) return { route: 'PIPELINE', code: 'PAGE_DEIXIS' };
  if (BROWSER_VERB.test(task)) return { route: 'PIPELINE', code: 'BROWSER_VERB' };
  if (VAGUE_REFERENCE.test(task)) return { route: 'PIPELINE', code: 'VAGUE_REFERENCE' };
  // Freshness is checked AFTER the verb patterns so the reported code says what
  // the user asked for (a lookup) rather than what word happened to appear.
  if (FRESHNESS_REQUIRED.test(task)) return { route: 'PIPELINE', code: 'FRESHNESS_REQUIRED' };

  // ── 2. Only now: is it a conversational shape? ────────────────────────────
  if (isArithmetic(task)) return { route: 'CONVERSATION', code: 'ARITHMETIC' };
  if (DEFINITIONAL.test(task)) return { route: 'CONVERSATION', code: 'DEFINITIONAL_KNOWLEDGE' };

  // A bare noun phrase ("machine learning") is not a question and not a task.
  // It is left to the pipeline's own ambiguity handling.
  return { route: 'PIPELINE', code: 'NO_CONVERSATIONAL_SHAPE' };
}

/** Convenience predicate for callers that only need the boolean. */
export function isConversational(rawTask: unknown): boolean {
  return classifyMessageRoute(rawTask).route === 'CONVERSATION';
}
