/**
 * PHASE 18.7 / I-1 — THE INTENT BOUNDARY.
 *
 * THE DEFECT THIS EXISTS TO FIX
 * ----------------------------
 * `serviceWorker.ts` accepted any string from the dashboard and handed it
 * straight to `AgentLoop.runTask()`, which immediately ran `parseUserGoal` and
 * `decomposeTask` and then started provider calls and target-tab provisioning.
 * There was no gate of any kind between the raw user string and browser
 * automation.
 *
 * The visible symptom was that typing "hi" into the composer launched a full
 * autonomous browser session: a provider round-trip, a target tab resolved or
 * provisioned, a world model built, and a terminal `FAILED`. Casual
 * conversation was being answered with browser automation.
 *
 * WHERE THE BOUNDARY GOES AND WHY
 * ------------------------------
 * In the service worker, BEFORE target resolution. That placement is load
 * bearing for one of the acceptance criteria: target-tab provisioning happens
 * in `resolveTargetWebTab` / `provisionTargetTab`, which run ahead of
 * `runTask`. A gate placed inside the loop would therefore still have opened a
 * tab for "hi". It is also placed before the active-task-ownership block, so a
 * casual message does not supersede and halt a task that is genuinely running.
 *
 * DETERMINISTIC, NOT LEARNED
 * --------------------------
 * This is a pure function of the task string. It never calls a model. That is a
 * deliberate security property, not a simplification: if intent were inferred
 * by the reasoner then a malformed or hostile provider response could change
 * whether automation is admitted at all, and an admission gate that a model can
 * influence is not a gate.
 *
 * It is also the reason intent is IMMUTABLE for a run. The decision is computed
 * once, at admission, and no later code path — including every model response —
 * can write it back.
 *
 * FAIL-CLOSED
 * -----------
 * Anything this module cannot classify with confidence becomes `AMBIGUOUS` and
 * is NOT admitted. It never guesses a destination or an action. Guessing here
 * would be strictly worse than the pre-I-1 behaviour, because a guessed
 * intent would flow into a guessed plan.
 *
 * BACKWARD COMPATIBILITY
 * ----------------------
 * `goalParser.actionIntent` ('shopping' | 'search' | 'banking' | 'login' |
 * 'navigation' | 'general') is deliberately left untouched. It continues to
 * shape decomposition. It was never an admission gate and is not repurposed as
 * one here; intent is a separate, earlier, strictly-deterministic decision.
 */

/** What kind of task this is. */
export type TaskIntent =
  | 'INFORMATION_REQUEST'
  | 'NAVIGATION_REQUEST'
  | 'ACTION_REQUEST'
  | 'MIXED_TASK'
  | 'GREETING_CASUAL'
  | 'AMBIGUOUS'
  | 'UNSUPPORTED';

export type IntentConfidence = 'DETERMINISTIC' | 'HEURISTIC';

/** Why admission was refused. A fixed code — never free text, never user data. */
export type IntentRefusalCode =
  | 'GREETING_NO_AUTOMATION'
  | 'AMBIGUOUS_NO_GUESS'
  | 'UNSUPPORTED_CAPABILITY';

export interface IntentDecision {
  readonly intent: TaskIntent;
  readonly confidence: IntentConfidence;
  /** Whether this task implies navigating somewhere. Drives destination declaration. */
  readonly requiresDestination: boolean;
  /**
   * Whether completion must be justified by verified evidence rather than by
   * UI action state. This is the single switch that later selects the
   * information completion rule (A5); without it an information task has no
   * evidence-based success path.
   */
  readonly requiresEvidence: boolean;
  /** False means: do not resolve a target tab, do not call a provider. */
  readonly admitsBrowserAutomation: boolean;
  readonly refusal?: IntentRefusalCode;
}

/** Words that constitute smalltalk on their own. */
const GREETING_WORDS = new Set([
  'hi', 'hii', 'hey', 'hello', 'helo', 'yo', 'sup', 'hiya',
  'thanks', 'thank', 'thx', 'ty', 'cheers',
  'bye', 'goodbye', 'cya', 'later',
  'ok', 'okay', 'k', 'kk', 'sure', 'cool', 'nice', 'great', 'awesome',
  'good', 'morning', 'evening', 'night', 'afternoon',
  'howdy', 'greetings', 'please', 'sorry', 'yes', 'no', 'yep', 'nope',
  'lol', 'haha', 'welcome',
  // Filler that appears in real greetings ("hello there", "hi everyone").
  // These carry no instruction, so allowing them here does not let a real
  // command through: every token must still be smalltalk.
  'there', 'you', 'your', 'u', 'all', 'everyone', 'folks', 'team', 'friend',
  'mate', 'buddy', 'again', 'noted', 'right', 'sounds',
]);

/**
 * A knowledge-seeking verb. Distinct from the broader INFORMATION_PREDICATE:
 * "find X on Wikipedia" asks for knowledge but uses no question word, so the
 * predicate alone would miss it and the task would be refused as ambiguous.
 */
const KNOWLEDGE_VERB =
  /\b(find|finds|search|searche[ds]?|searching|look up|research|read about|learn about|show me|give me|tell me)\b/i;

import { isKnownSearchPortalAlias } from '../planning/searchCapability';

/** Pure smalltalk that has no actionable content at all. */
const GREETING_PHRASES: RegExp[] = [
  /^(hi|hey|hello|helo|hiya|howdy|greetings|yo|sup)\b[\s!,.?]*$/i,
  /^(how are you|how're you|how r u|whats up|what's up|how u doing)\b[\s!,.?]*$/i,
  /^(thanks|thank you|thankyou|thx|ty|cheers|much appreciated)\b[\s!,.?]*$/i,
  /^(bye|goodbye|see you|see ya|later|cya|good ?night)\b[\s!,.?]*$/i,
  /^(ok|okay|k|sure|cool|nice|great|awesome|got it|understood|will do)\b[\s!,.?]*$/i,
  /^(?:(?:hi|hey|hello|greetings|howdy)\s+)?(?:i am|i'm|im|my name is)\s+[a-z0-9'-]+[\s!,.?]*$/i,
];

/**
 * Navigation verbs — the task implies going somewhere.
 *
 * "show me the" is deliberately NOT here: it is a knowledge phrase ("show me
 * the price"), not a navigation one, and listing it made a pure information
 * request look like a mixed navigation task.
 */
const NAV_VERB =
  /\b(open|opens|go|goes|going|visit|visits|navigate|navigates|launch|launches|browse|browses|land on|take me to)\b/i;

/** Information predicates — the task asks for knowledge, not a state change. */
const INFO_PREDICATE =
  /\b(what is|what's|whats|what are|who is|who's|who was|when did|when was|when is|where is|where was|where are|how many|how much|how does|how do|how did|why is|why does|why did|tell me|explain|describe|summar(?:y|ise|ize)|information about|info about|details about|facts about|history of|meaning of|define|definition of|find out about|research|look up|read about|learn about)\b/i;

/** Mutating verbs — the task changes browser or account state. */
const ACTION_VERB =
  /\b(buy|purchase|checkout|check out|cart|order|book|reserve|apply|submit|send|post|upload|download|delete|remove|transfer|withdraw|deposit|pay|add to|log ?in|sign ?in|sign ?up|register|subscribe|follow|like|comment|post a|fill|enter|type|click|press|accept|decline|confirm|cancel|close)\b/i;

/**
 * Capabilities the agent genuinely does not have. Fail closed rather than
 * improvise: the only correct behaviour is to decline honestly, because
 * "send this email" has no local execution path.
 */
const UNSUPPORTED_CAPABILITY =
  /\b(send (?:an? )?(?:e-?mail|email|sms|text message|message|whatsapp|telegram|dm)|(?:call|ring|phone) (?:me|him|her|them|someone|us)|voice ?call|make (?:a )?(?:phone )?call|download (?:and )?(?:run|execute)|run (?:this )?(?:script|code|command|program)|execute (?:code|script)|install (?:this |a )?(?:software|package|extension|app)\b|delete (?:this |my )?(?:account|all data)|transfer money|wire money|send money|pay (?:someone|them|him|her))\b/i;

/** A declared destination: an explicit URL, or a known site alias. */
const HAS_DESTINATION =
  /(https?:\/\/[^\s]+)|(\b[a-z0-9-]+\.(?:com|org|net|in|io|gov|edu|dev|app|ai|co)\b)/i;

/** Deictic/vague references that cannot be resolved to a determinate target. */
const VAGUE_OBJECT =
  /\b(it|that|this|those|these|them|the thing|the same|the one|the page|the site|the account|somewhere|somewhere else|some page|whatever|anything|something|the last one)\b/i;

function normalize(task: string): string {
  return task.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * True when the whole message is smalltalk and nothing else.
 *
 * EXPORTED (final acceptance audit) so the normal-chat route shares this one
 * definition rather than carrying a second, drift-prone copy of the greeting
 * vocabulary. The predicate itself is unchanged, and I-1's decisions are
 * unchanged with it.
 */
export function isPureGreeting(task: string): boolean {
  const n = normalize(task);
  if (n.length === 0) return false;
  for (const re of GREETING_PHRASES) if (re.test(n)) return true;

  // Every token is smalltalk AND there are few of them. Requiring the short
  // length stops "hi, open wikipedia" from being mistaken for a greeting.
  const tokens = n.replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
  if (tokens.length > 3) return false;
  return tokens.every((t) => GREETING_WORDS.has(t));
}

function decide(
  intent: TaskIntent,
  confidence: IntentConfidence,
  opts: { destination: boolean; evidence: boolean; admits: boolean; refusal?: IntentRefusalCode }
): IntentDecision {
  // FROZEN AT RUNTIME, not just by the `readonly` type.
  //
  // `readonly` is erased by the compiler, so a plain object literal is still
  // writable at runtime — which would have left "the model can never modify
  // intent" true only in the type system. Freezing makes the invariant real:
  // once admitted, nothing downstream (including anything derived from a model
  // response) can rewrite the decision for this run.
  return Object.freeze({
    intent,
    confidence,
    requiresDestination: opts.destination,
    requiresEvidence: opts.evidence,
    admitsBrowserAutomation: opts.admits,
    ...(opts.refusal ? { refusal: opts.refusal } : {}),
  });
}

/**
 * Classify a user task. Pure, deterministic, and local.
 *
 * Never throws: an unusable input is `AMBIGUOUS`, which is not admitted.
 */
export function classifyIntent(rawTask: unknown): IntentDecision {
  if (typeof rawTask !== 'string') {
    return decide('AMBIGUOUS', 'DETERMINISTIC', {
      destination: false, evidence: false, admits: false, refusal: 'AMBIGUOUS_NO_GUESS',
    });
  }

  const task = rawTask.trim();
  if (task.length === 0) {
    return decide('AMBIGUOUS', 'DETERMINISTIC', {
      destination: false, evidence: false, admits: false, refusal: 'AMBIGUOUS_NO_GUESS',
    });
  }

  // 1. Empty / pure smalltalk: never browser automation.
  if (isPureGreeting(task)) {
    return decide('GREETING_CASUAL', 'DETERMINISTIC', {
      destination: false, evidence: false, admits: false, refusal: 'GREETING_NO_AUTOMATION',
    });
  }

  // 2. Capability the agent does not have: decline honestly.
  if (UNSUPPORTED_CAPABILITY.test(task)) {
    return decide('UNSUPPORTED', 'DETERMINISTIC', {
      destination: false, evidence: false, admits: false, refusal: 'UNSUPPORTED_CAPABILITY',
    });
  }

  // 2b. A request whose only object is a deictic reference cannot be resolved
  // to a determinate target, so it is NOT admitted. This must be checked BEFORE
  // the knowledge rules: "find it" contains a knowledge verb, and classifying on
  // the verb alone would admit a request with no object to find anything about.
  const tokenList = normalize(task).replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
  if (tokenList.length <= 5 && VAGUE_OBJECT.test(task)) {
    return decide('AMBIGUOUS', 'DETERMINISTIC', {
      destination: false, evidence: false, admits: false, refusal: 'AMBIGUOUS_NO_GUESS',
    });
  }

  const hasInfo = INFO_PREDICATE.test(task) || KNOWLEDGE_VERB.test(task);
  const hasAction = ACTION_VERB.test(task);
  const hasNav = NAV_VERB.test(task);
  const hasDestination =
    HAS_DESTINATION.test(task) ||
    // A named portal the user expects us to know ("find Charminar on Wikipedia")
    // is a destination too. Resolved through the shared registry rather than a
    // brand list, so this cannot drift into the I-4 assumption it replaced.
    tokenList.some((t) => isKnownSearchPortalAlias(t));

  // 3. Mixed: a knowledge or mutation goal that ALSO implies navigation. This
  //    is the shape of the real Wikipedia task ("open wikipedia and find
  //    information about charminar") and of "find Charminar on Wikipedia" —
  //    both must retain the navigation requirement AND the evidence
  //    requirement, because completing them needs a verified page, not a click.
  if (hasInfo && (hasNav || hasDestination)) {
    return decide('MIXED_TASK', 'DETERMINISTIC', {
      // A navigation verb always carries a destination requirement, whether or
      // not the destination happens to be spelled out — an unspecified one must
      // be resolved from the current site or declared, never invented (I-4).
      destination: true,
      evidence: true,
      admits: true,
    });
  }

  // 3b. Navigation plus a mutation, with no knowledge goal.
  if (hasNav && hasAction) {
    return decide('MIXED_TASK', 'DETERMINISTIC', {
      destination: true,
      evidence: false,
      admits: true,
    });
  }

  // 4. Information request — the spine of I-5.
  if (hasInfo) {
    return decide('INFORMATION_REQUEST', 'DETERMINISTIC', {
      destination: false,
      evidence: true,
      admits: true,
    });
  }

  // 5. Pure state change.
  if (hasAction) {
    return decide('ACTION_REQUEST', 'DETERMINISTIC', {
      destination: hasDestination, evidence: false, admits: true,
    });
  }

  // 6. Pure navigation.
  if (hasNav) {
    return decide('NAVIGATION_REQUEST', 'DETERMINISTIC', {
      destination: true, evidence: false, admits: true,
    });
  }

  // 7. No signal at all, or an undeterminable object. FAIL CLOSED.
  if (VAGUE_OBJECT.test(task)) {
    return decide('AMBIGUOUS', 'DETERMINISTIC', {
      destination: false, evidence: false, admits: false, refusal: 'AMBIGUOUS_NO_GUESS',
    });
  }

  // A bare noun phrase ("charminar", "running shoes") is not an instruction.
  // Admitting it would be guessing at an action, so it is ambiguous.
  return decide('AMBIGUOUS', 'HEURISTIC', {
    destination: false, evidence: false, admits: false, refusal: 'AMBIGUOUS_NO_GUESS',
  });
}

/**
 * Refusals are surfaced as a truthful terminal state rather than a failure.
 * The model is never asked: refusing must not cost a provider round-trip.
 */
export function refusalUserMessage(decision: IntentDecision): string {
  switch (decision.refusal) {
    case 'GREETING_NO_AUTOMATION':
      return 'No browser action is needed for that.';
    case 'UNSUPPORTED_CAPABILITY':
      return 'That asks for a capability this agent does not have.';
    case 'AMBIGUOUS_NO_GUESS':
      return 'The request is too ambiguous to act on safely. Please say what to open or what to find.';
    default:
      return 'Task not admitted.';
  }
}