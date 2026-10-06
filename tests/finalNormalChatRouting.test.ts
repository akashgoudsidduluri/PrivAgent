/**
 * FINAL PRODUCT ACCEPTANCE AUDIT — NORMAL CHAT vs BROWSER-TASK ROUTING.
 *
 * The question this file answers:
 *
 *   "Can a user simply say 'Hi' or ask a normal/basic question and receive a
 *    normal assistant response WITHOUT PrivAgent unnecessarily launching the
 *    browser agent?"
 *
 * Three layers:
 *
 *   1. the ROUTE decision (`conversationRoute.ts`) for every acceptance message —
 *      ordinary chat vs the existing browser pipeline;
 *   2. the typed outcome the pipeline reaches for the boundary cases, decided by
 *      the UNCHANGED I-1 intent boundary (`classifyIntent`);
 *   3. the structural placement in the service worker, because the routing
 *      guarantee is an ORDERING guarantee: the conversational branch must return
 *      before target resolution, tab provisioning and the loop exist as
 *      reachable code. The behavioural proof of that ordering is the real-Chrome
 *      run in `docs/evidence/post-17-10/audit/final_normal_chat_routing.json`
 *      (zero tab queries, zero provisions, zero dispatches).
 *
 * No existing authority is modified or relaxed here: I-1 is untouched, and the
 * conversational route can only ever REMOVE browser work from a message that
 * provably needs none.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

import {
  CONVERSATIONAL_CODES,
  classifyMessageRoute,
  isConversational,
  type MessageRouteCode,
} from '../extension/src/agent/conversationRoute';
import { classifyIntent } from '../extension/src/agent/intentBoundary';
import { projectAgentOutput } from '../extension/src/agent/agentOutput';
import { isTerminalTaskStatus } from '../extension/src/agent/agentState';

// ── Part 1. Normal chat ──────────────────────────────────────────────────────

const NORMAL_CHAT = [
  'Hi',
  'Hello',
  'How are you?',
  'What is machine learning?',
  'Explain TCP vs UDP',
  'What is 2 + 2?',
  'What is a binary search tree?',
];

describe('FINAL AUDIT — ordinary chat is answered, not automated', () => {
  it('1. every acceptance greeting and basic question routes to CONVERSATION', () => {
    for (const message of NORMAL_CHAT) {
      const decision = classifyMessageRoute(message);
      expect(decision.route, message).toBe('CONVERSATION');
      // …and only ever under a whitelisted conversational code.
      expect(CONVERSATIONAL_CODES.has(decision.code), `${message} -> ${decision.code}`).toBe(true);
    }
  });

  it('2. the three conversational codes are the WHOLE whitelist', () => {
    const seen = new Set(NORMAL_CHAT.map((m) => classifyMessageRoute(m).code));
    expect([...seen].sort()).toEqual(['ARITHMETIC', 'DEFINITIONAL_KNOWLEDGE', 'SMALLTALK']);
    expect([...CONVERSATIONAL_CODES].sort()).toEqual(['ARITHMETIC', 'DEFINITIONAL_KNOWLEDGE', 'SMALLTALK']);
  });

  it('3. a greeting is recognised by the SAME predicate I-1 uses (no second vocabulary)', () => {
    // The conversational route reuses I-1's smalltalk predicate, so the two
    // boundaries cannot drift apart about what "hi" is.
    for (const greeting of ['hi', 'hello', 'hey', 'thanks', 'good morning', 'how are you']) {
      expect(isConversational(greeting), greeting).toBe(true);
    }
  });

  it('4. a conversational answer is a typed terminal ANSWER that claims no page evidence', () => {
    const projected = projectAgentOutput({
      status: 'ANSWER',
      answer: 'Machine learning is a field of computer science.',
      answerSource: 'CONVERSATION',
      task: 'What is machine learning?',
      steps: [],
      currentStep: 0,
      maxSteps: 0,
    } as never) as any;

    expect(projected.outcome).toBe('ANSWERED');
    expect(projected.terminal.reason).toBe('CONVERSATIONAL_ANSWER');
    // The browser-pipeline wording must NOT be used: this run never read a page.
    expect(projected.terminal.headline).toBe('Answered directly.');
    expect(projected.terminal.headline).not.toMatch(/evidence verified on this page/i);
    expect(projected.finalResult.kind).toBe('ANSWER');
    expect(projected.finalResult.body).toBe('Machine learning is a field of computer science.');
    // No page provenance can be attached to a conversational answer.
    expect(projected.finalResult.provenance).toBeNull();
    expect(isTerminalTaskStatus('ANSWER')).toBe(true);
  });

  it('5. a PAGE-backed answer still says it came from the page (the distinction is real)', () => {
    const projected = projectAgentOutput({
      status: 'ANSWER',
      answer: 'Verified claim.',
      task: 'find the price',
      steps: [],
      currentStep: 1,
      maxSteps: 10,
    } as never) as any;
    expect(projected.terminal.reason).toBe('ANSWERED');
    expect(projected.terminal.headline).toMatch(/evidence verified on this page/i);
  });
});

// ── Part 2. Browser tasks must still reach the browser pipeline ──────────────

const BROWSER_TASKS = [
  'Find the top 5 products on the shopping fixture.',
  'Search for laptops under ₹50,000.',
  'Open the third result.',
  'Find the latest information about Charminar.',
];

describe('FINAL AUDIT — a real browser task is still a browser task', () => {
  it('6. every acceptance browser request routes to PIPELINE and I-1 admits it', () => {
    for (const task of BROWSER_TASKS) {
      const decision = classifyMessageRoute(task);
      expect(decision.route, `${task} -> ${decision.code}`).toBe('PIPELINE');
      const intent = classifyIntent(task);
      expect(intent.admitsBrowserAutomation, task).toBe(true);
      expect(intent.intent).not.toBe('GREETING_CASUAL');
    }
  });

  it('7. the pipeline keeps its own typed classes for those requests', () => {
    expect(classifyIntent('Find the top 5 products on the shopping fixture.').intent).toBe('INFORMATION_REQUEST');
    expect(classifyIntent('Search for laptops under ₹50,000.').intent).toBe('INFORMATION_REQUEST');
    expect(classifyIntent('Open the third result.').intent).toBe('NAVIGATION_REQUEST');
    expect(classifyIntent('Find the latest information about Charminar.').intent).toBe('INFORMATION_REQUEST');
  });
});

// ── Part 3. Boundaries ───────────────────────────────────────────────────────

describe('FINAL AUDIT — the boundary cases keep their typed outcomes', () => {
  it('8. a MIXED request that needs the browser is admitted to the browser', () => {
    const mixed = 'Tell me what machine learning is and then search for laptops.';
    expect(classifyMessageRoute(mixed).route).toBe('PIPELINE');
    expect(classifyMessageRoute(mixed).code).toBe('BROWSER_VERB');
    // Half the request genuinely needs the browser, so the browser pipeline owns
    // it — with every one of its gates still in force.
    expect(classifyIntent(mixed).admitsBrowserAutomation).toBe(true);
  });

  it('9. a question about THIS page is not answered conversationally', () => {
    const onPage = 'What is the price of this product?';
    const decision = classifyMessageRoute(onPage);
    expect(decision.route).toBe('PIPELINE');
    // Page deixis is the signal, not the word "what".
    expect(decision.code).toBe('PAGE_DEIXIS');
    expect(classifyIntent(onPage).admitsBrowserAutomation).toBe(true);
  });

  it('10. a dangling reference with no context is a CLARIFICATION, not an answer and not a browser run', () => {
    const dangling = 'Tell me about it.';
    // This case FAILED on the first run of this test and the route was fixed
    // rather than the expectation: "tell me about …" matched the definitional
    // shape and the pronoun was about to be answered. A bare deictic object now
    // goes to the pipeline, whose reference layer owns it.
    const decision = classifyMessageRoute(dangling);
    expect(decision.route).toBe('PIPELINE');
    expect(decision.code).toBe('VAGUE_REFERENCE');
    const intent = classifyIntent(dangling);
    expect(intent.admitsBrowserAutomation).toBe(false);
    expect(intent.intent).toBe('AMBIGUOUS');
    expect(intent.refusal).toBe('AMBIGUOUS_NO_GUESS');
  });

  it('11. "Search the web" with no target is not converted into an answer', () => {
    // It is a browser request, so the conversational route must not claim it.
    // Whether the pipeline then asks for a target is the pipeline's business —
    // and its own reference layer decides that from real context, not from here.
    expect(classifyMessageRoute('Search the web').route).toBe('PIPELINE');
  });

  it('12. a capability the agent does not have is never "answered" instead of refused', () => {
    const unsupported = ['Send an email to the team.', 'Call me in ten minutes.'];
    for (const message of unsupported) {
      expect(classifyMessageRoute(message).route, message).toBe('PIPELINE');
      expect(classifyIntent(message).refusal, message).toBe('UNSUPPORTED_CAPABILITY');
      expect(classifyIntent(message).admitsBrowserAutomation, message).toBe(false);
    }
  });
});

// ── The security property, as a corpus ───────────────────────────────────────

describe('FINAL AUDIT — the conversational route cannot be talked into browser work', () => {
  it('13. no browser-shaped message in the corpus is ever answered conversationally', () => {
    // The PROPERTY is the route, not which browser signal happened to match
    // first: a message is either safely answerable here or it is not.
    const corpus = [
      'search for cheap flights',
      'find the best laptop on the site',
      'open the settings page',
      'go to example.com',
      'what is the price of bitcoin',
      'what is the latest news about ISRO',
      'tell me the current stock price of Infosys',
      'what is in my cart',
      'explain the third result',
      'what is my account balance',
      'delete the draft',
      'buy the cheapest one',
      'transfer money to savings',
      'binary search tree',
      'shopping fixture products',
      'tell me about it',
      'what does that mean exactly',
    ];
    for (const message of corpus) {
      const decision = classifyMessageRoute(message);
      expect(decision.route, `${message} -> ${decision.route}`).toBe('PIPELINE');
      expect(CONVERSATIONAL_CODES.has(decision.code), `${message} -> ${decision.code}`).toBe(false);
    }
  });

  it('13b. each browser signal class is reported for a message where it is unambiguous', () => {
    const cases: Array<[string, MessageRouteCode]> = [
      ['search for cheap flights', 'BROWSER_VERB'],
      ['go to example.com', 'NAMED_DESTINATION'],
      ['what is the price of bitcoin', 'FRESHNESS_REQUIRED'],
      ['what is in my cart', 'PAGE_DEIXIS'],
      ['delete the draft', 'STATE_CHANGE'],
      ['transfer money to savings', 'UNSUPPORTED_CAPABILITY'],
      ['tell me about it', 'VAGUE_REFERENCE'],
      ['binary search tree', 'NO_CONVERSATIONAL_SHAPE'],
    ];
    for (const [message, code] of cases) {
      expect(classifyMessageRoute(message).code, message).toBe(code);
    }
  });

  it('14. the word "search" alone neither creates nor removes a browser task', () => {
    // The trap the audit names, in both directions:
    expect(classifyMessageRoute('What is a binary search tree?').route).toBe('CONVERSATION');
    expect(classifyMessageRoute('Search for laptops under ₹50,000.').route).toBe('PIPELINE');
  });

  it('15. unusable input is never admitted to the conversational path', () => {
    for (const bad of [null, undefined, 42, {}, [], '', '   ']) {
      expect(classifyMessageRoute(bad).route, String(bad)).toBe('PIPELINE');
    }
  });
});

// ── The ordering guarantee, structurally ─────────────────────────────────────

describe('FINAL AUDIT — the conversational branch returns before the browser pipeline exists', () => {
  const source = fs.readFileSync('extension/src/background/serviceWorker.ts', 'utf8');

  it('16. the conversational branch precedes every browser-stage entry point', () => {
    const branch = source.indexOf("messageRoute.route === 'CONVERSATION'");
    const returns = source.indexOf('return;', branch);
    expect(branch).toBeGreaterThan(-1);
    expect(returns).toBeGreaterThan(branch);

    // Every browser stage must appear AFTER the branch that returns.
    const stages = [
      'TARGET_RESOLUTION_STARTED',
      'chrome.tabs.query',
      'resolveTargetWebTab',
      'provisionTargetTab',
      'new AgentLoop(',
      'runTask(',
    ];
    for (const stage of stages) {
      const at = source.indexOf(stage, branch);
      expect(at, `${stage} must be after the conversational branch`).toBeGreaterThan(returns);
    }
  });

  it('17. the conversational branch performs no tab, perception or dispatch call at all', () => {
    const branch = source.indexOf("messageRoute.route === 'CONVERSATION'");
    const end = source.indexOf('// ── PHASE 18.7 / I-1: THE INTENT BOUNDARY', branch);
    expect(end).toBeGreaterThan(branch);
    const block = source.slice(branch, end);
    for (const forbidden of [
      'chrome.tabs',
      'resolveTargetWebTab',
      'provisionTargetTab',
      'perceivePage',
      'executeAction',
      'AgentLoop',
      'runTask',
    ]) {
      expect(block, forbidden).not.toContain(forbidden);
    }
    // It answers through the one conversational provider call and nothing else.
    expect(block).toContain('requestChat');
  });

  it('17b. the conversational branch ends with an UNCONDITIONAL early exit', () => {
    const branch = source.indexOf("messageRoute.route === 'CONVERSATION'");
    const end = source.indexOf('// \u2500\u2500 PHASE 18.7 / I-1: THE INTENT BOUNDARY', branch);
    expect(end).toBeGreaterThan(branch);
    const block = source.slice(branch, end);
    // The branch must acknowledge the port and then RETURN, so that execution
    // never falls through into the I-1 boundary, target resolution or the loop.
    // Pinned structurally because a deleted exit would otherwise let a normal
    // chat message flow into the browser pipeline while every behavioural test
    // (which exercises the router, not the dispatcher) still passed.
    expect(block.trimEnd()).toMatch(/\}\)\(\);\s*return;\s*\}$/);
  });
});
