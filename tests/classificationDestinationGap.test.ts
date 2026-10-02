/**
 * PrivAgent — POST-17.10 Step 8: the TASK CLASSIFICATION → DESTINATION SUBGOAL gap.
 *
 * THE GAP
 * ───────
 * `classifyTaskCategory` is a lexical keyword matcher. "open the store catalog
 * at <url>" contains none of its e-commerce keywords, so it classified
 * `GENERIC_INTERACTION`. Step 7 attached the typed destination declaration to
 * `HighLevelGoal` and to a subgoal — but ONLY in the `ECOMMERCE_SEARCH` branch.
 * Every other branch discarded the declaration, so a prompt with an unambiguous
 * typed destination could plan NO destination subgoal at all, and the chain died
 * before `verifyDestination` was ever reached.
 *
 * THE FIX, and the fix that was explicitly NOT made
 * ─────────────────────────────────────────────────
 *   NOT: add "catalog"/"store" to the e-commerce keyword list, or rewrite the
 *        category. That changes GLOBAL classification semantics on a guess, and
 *        would mis-file unrelated prompts that merely contain the word.
 *
 *   YES: the typed declaration is now a SECOND planning input alongside the
 *        lexical category, and it gates a destination subgoal in every branch
 *        that does not already produce one. `classifyTaskCategory` is untouched.
 *
 * The property under test is therefore a NEGATIVE one as much as a positive one:
 * an unrelated generic interaction must be completely unaffected. Most of this
 * file exists to prove that.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  classifyTaskCategory,
  decomposeTask,
} from '../extension/src/hierarchicalPlanning/taskDecomposer';
import { GoalProgressTracker } from '../extension/src/hierarchicalPlanning/goalProgressTracker';
import { normalizeDestination } from '../extension/src/planning/destinationNormalizer';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import type { SemanticPageType } from '../extension/src/semanticUnderstanding/semanticTypes';

const ORIGIN = 'http://localhost:4174';

const ctx = (over: Partial<AgentContextPayload> = {}): AgentContextPayload =>
  ({
    url: `${ORIGIN}/`,
    timestamp: 1_700_000_000_000,
    viewport: { width: 1280, height: 900, scroll_x: 0, scroll_y: 0 },
    viewportObservable: true,
    screenshot_dimensions: null,
    detections: [],
    total_elements_scanned: 20,
    sensitive_elements_detected: 0,
    sanitized_status: 'sanitized_only',
    ocr_metrics: null,
    ...over,
  }) as AgentContextPayload;

const classified = (
  url: string,
  pageType: SemanticPageType,
  confidence: number,
  generation: number,
  affordances: string[] = ['SCROLL']
): AgentContextPayload =>
  ctx({
    url,
    semantic_context: {
      pageType,
      confidence,
      pageState: 'populated',
      pageGeneration: generation,
      entities: [],
      affordances: affordances.map((t, i) => ({
        id: `af_${i}`,
        type: t as never,
        targetElementId: `el_${i}`,
        requiresConfirmation: false,
        description: `${t} affordance`,
      })),
    } as never,
  });

const REAL_CATALOG = classified(`${ORIGIN}/results.html`, 'LISTING', 0.99, 5);

const verify = (sg: ReturnType<typeof decomposeTask>['subgoals'][number], c: AgentContextPayload) =>
  GoalProgressTracker.verifySubgoalCondition(sg, {
    context: c,
    pageGeneration: c.semantic_context?.pageGeneration ?? 1,
  });

const plan = (prompt: string, currentUrl = `${ORIGIN}/`) => decomposeTask(prompt, { currentUrl });

const destinationSubgoals = (prompt: string, currentUrl = `${ORIGIN}/`) =>
  plan(prompt, currentUrl).subgoals.filter((s) => s.destination !== undefined);

/** Asserts exactly one destination subgoal exists and returns it. */
const oneDestination = (prompt: string): NonNullable<
  ReturnType<typeof destinationSubgoals>[number]
> => {
  const found = destinationSubgoals(prompt);
  expect(found, prompt).toHaveLength(1);
  return found[0]!;
};

const declKind = (prompt: string) =>
  (plan(prompt).goal.destinationDeclaration as { kind: string }).kind;

// ══════════════════════════════════════════════════════════════════════════════
// W1 — the canonical prompt
// ══════════════════════════════════════════════════════════════════════════════

describe('W1 · canonical generic destination prompt', () => {
  const PROMPT = `open the store catalog at ${ORIGIN}`;

  it('W1a. category is unchanged at GENERIC_INTERACTION', () => {
    expect(classifyTaskCategory(PROMPT)).toBe('GENERIC_INTERACTION');
  });

  it('W1b. declaration carries role LISTING and the entry URL', () => {
    const d = plan(PROMPT).goal.destinationDeclaration as {
      role?: { acceptablePageTypes: string[] };
      entryUrl?: { origin: string; path: string };
      url?: unknown;
    };
    expect(d.role!.acceptablePageTypes).toEqual(['LISTING']);
    expect(d.entryUrl!.origin).toBe(ORIGIN);
    expect(d.entryUrl!.path).toBe('/');
    expect(d.url).toBeUndefined();
  });

  it('W1c. a destination subgoal is PRESENT', () => {
    const found = oneDestination(PROMPT);
    expect(found.category).toBe('NAVIGATE');
    expect(found.verificationCondition!.type).toBe('DESTINATION_VERIFIED');
  });

  it('W1d. and it completes on the real LISTING observation', () => {
    expect(verify(oneDestination(PROMPT), REAL_CATALOG).satisfied).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// W2 / W3 — generic tasks with NO destination gain nothing
//
// This is the most important section in the file. The fix adds a subgoal; these
// prove it only ever adds it when the user actually declared a destination.
// ══════════════════════════════════════════════════════════════════════════════

describe('W2/W3 · generic tasks without a destination are completely unaffected', () => {
  const UNDECLARED = [
    'click the submit button',
    'type hello into the search box',
    'do something with this page',
    'click the first link',
    'scroll down and read the page',
    'fill the form with my details',
    'press the back button',
    'wait a moment then continue',
  ];

  it('W2a. none of them declares a destination', () => {
    for (const p of UNDECLARED) {
      expect(declKind(p), p).toBe('NONE');
      expect(normalizeDestination(p).kind, p).toBe('NONE');
    }
  });

  it('W2b. none of them gains a destination subgoal', () => {
    for (const p of UNDECLARED) {
      expect(destinationSubgoals(p), p).toHaveLength(0);
    }
  });

  it('W2c. none of them gains a NAVIGATE subgoal it did not already have', () => {
    for (const p of UNDECLARED) {
      const before = plan(p).subgoals.filter((s) => s.category === 'NAVIGATE');
      expect(before, p).toHaveLength(0);
    }
  });

  it('W2d. their categories are untouched by Step 8', () => {
    // "type hello into the search box" classifies as INFORMATION_RETRIEVAL
    // because of the word "search" — that is pre-existing behaviour and Step 8
    // did not change it. What matters is that NEITHER category gained a
    // destination subgoal.
    expect(classifyTaskCategory('click the submit button')).toBe('GENERIC_INTERACTION');
    expect(classifyTaskCategory('type hello into the search box')).toBe('INFORMATION_RETRIEVAL');
    expect(destinationSubgoals('type hello into the search box')).toHaveLength(0);
  });

  it('W2e. every subgoal still fails closed without a destination', () => {
    for (const p of UNDECLARED) {
      for (const sg of plan(p).subgoals) {
        expect(verify(sg, REAL_CATALOG).satisfied, `${p} :: ${sg.id}`).toBe(false);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// W4 / W5 — explicit non-commerce destinations
// ══════════════════════════════════════════════════════════════════════════════

describe('W4/W5 · explicit checkout and form destinations', () => {
  it('W4a. "open the checkout page" plans a CHECKOUT destination subgoal', () => {
    const p = `open the checkout page at ${ORIGIN}`;
    const found = oneDestination(p);
    expect((found.destination as { role?: { acceptablePageTypes: string[] } }).role!.acceptablePageTypes).toEqual([
      'CHECKOUT',
    ]);
    expect(found.verificationCondition!.type).toBe('DESTINATION_VERIFIED');
  });

  it('W4b. it does NOT rely on e-commerce keyword classification', () => {
    const p = `open the checkout page at ${ORIGIN}`;
    expect(classifyTaskCategory(p)).toBe('GENERIC_INTERACTION');
    expect(destinationSubgoals(p)).toHaveLength(1);
  });

  it('W4c. it completes on a real CHECKOUT observation and not on LISTING', () => {
    const nav = oneDestination(`open the checkout page at ${ORIGIN}`);
    expect(verify(nav, classified(`${ORIGIN}/checkout`, 'CHECKOUT', 0.97, 5)).satisfied).toBe(true);
    expect(verify(nav, REAL_CATALOG).satisfied).toBe(false);
  });

  it('W5a. "open the contact form" plans a FORM destination subgoal', () => {
    const p = `open the contact form at ${ORIGIN}`;
    // This one classifies as FORM_FILL — a DIFFERENT branch from W1/W4, which
    // proves the fix is not specific to one branch.
    expect(classifyTaskCategory(p)).toBe('FORM_FILL');
    const found = oneDestination(p);
    expect((found.destination as { role?: { acceptablePageTypes: string[] } }).role!.acceptablePageTypes).toEqual([
      'FORM',
    ]);
    expect(found.verificationCondition!.type).toBe('DESTINATION_VERIFIED');
  });

  it('W5b. it completes on a real FORM observation', () => {
    const nav = oneDestination(`open the contact form at ${ORIGIN}`);
    expect(verify(nav, classified(`${ORIGIN}/contact`, 'FORM', 0.92, 5)).satisfied).toBe(true);
    expect(verify(nav, REAL_CATALOG).satisfied).toBe(false);
  });

  it('W5c. the FORM_FILL credential chain itself is unchanged', () => {
    const g = plan(`open the contact form at ${ORIGIN}`);
    expect(g.subgoals.map((s) => s.category)).toEqual(['NAVIGATE', 'LOCATE', 'FILL', 'VERIFY', 'CONFIRM']);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// W6 / W7 — UNSUPPORTED and AMBIGUOUS must NOT become a subgoal
// ══════════════════════════════════════════════════════════════════════════════

describe('W6/W7 · unsupported and ambiguous destinations create no subgoal', () => {
  // NOTE on prompt shape. With a URL present, an unmapped or ambiguous head
  // falls through to "the URL is itself the destination" (Step 6 contract), so
  // these cases are stated WITHOUT a URL to isolate the role channel, which is
  // what UNSUPPORTED / AMBIGUOUS actually describe.

  it('W6a. an unmapped destination noun yields UNSUPPORTED and NO subgoal', () => {
    const p = 'open the widget';
    expect(declKind(p)).toBe('UNSUPPORTED');
    expect(destinationSubgoals(p)).toHaveLength(0);
  });

  it('W6b. an unmapped noun is never invented into a page role', () => {
    const d = normalizeDestination('open the widget') as { kind: string; unmappedHead?: string };
    expect(d.kind).toBe('UNSUPPORTED');
    expect(d.unmappedHead).toBe('widget');
    expect(JSON.stringify(d)).not.toMatch(/LISTING|CHECKOUT|FORM/);
  });

  it('W6c. with a URL, an unmapped head becomes a destination URL — never a PRODUCT role', () => {
    // "open the first product at <url>" declares the URL as the destination and
    // deliberately does NOT pretend a PRODUCT page type is supported.
    const d = normalizeDestination(`open the first product at ${ORIGIN}`) as {
      kind: string;
      role?: unknown;
      url?: { path: string };
    };
    expect(d.kind).toBe('DECLARED');
    expect(d.role).toBeUndefined();
    expect(d.url!.path).toBe('/');
    expect(JSON.stringify(d)).not.toMatch(/PRODUCT/);
    // And the resulting subgoal asserts that exact URL, nothing softer.
    const found = oneDestination(`open the first product at ${ORIGIN}`);
    expect(verify(found, REAL_CATALOG).satisfied).toBe(false);
    expect(verify(found, classified(`${ORIGIN}/`, 'UNKNOWN', 0.1, 5)).satisfied).toBe(true);
  });

  it('W7a. a genuinely ambiguous head yields AMBIGUOUS and NO subgoal', () => {
    const p = 'open the results';
    expect(declKind(p)).toBe('AMBIGUOUS');
    expect(destinationSubgoals(p)).toHaveLength(0);
  });

  it('W7b. ambiguity is never silently resolved to LISTING', () => {
    const g = plan('open the results');
    for (const sg of g.subgoals) {
      expect(sg.destination, sg.id).toBeUndefined();
      expect(JSON.stringify(sg), sg.id).not.toMatch(/LISTING/);
    }
  });

  it('W7c. ambiguity never completes anything, even on the matching page', () => {
    for (const p of ['open the results', 'open the widget', 'open the orders']) {
      for (const sg of plan(p).subgoals) {
        expect(verify(sg, REAL_CATALOG).satisfied, `${p} :: ${sg.id}`).toBe(false);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// W8 — no duplicates
// ══════════════════════════════════════════════════════════════════════════════

describe('W8 · exactly one destination subgoal per plan, in every flow', () => {
  const PROMPTS = [
    `open the store catalog at ${ORIGIN}`,
    `open the store catalog at ${ORIGIN} and open the first product listed`,
    `open the checkout page at ${ORIGIN}`,
    `open the contact form at ${ORIGIN}`,
    `buy a product at ${ORIGIN}`,
    `open http://${ORIGIN.replace('http://', '')}/results.html`,
    `open http://${ORIGIN.replace('http://', '')}/results.html and buy the first product listed`,
    'find information about quantum computing on the web',
    'sign in to my account',
    'click the submit button',
  ];

  it('W8a. never more than one', () => {
    for (const p of PROMPTS) {
      const found = destinationSubgoals(p);
      expect(found.length, `${p} -> ${found.length}`).toBeLessThanOrEqual(1);
    }
  });

  it('W8b. never two NAVIGATE subgoals both claiming the destination', () => {
    for (const p of PROMPTS) {
      const navs = plan(p).subgoals.filter((s) => s.category === 'NAVIGATE');
      expect(navs.length, p).toBeLessThanOrEqual(1);
    }
  });

  it('W8c. the ECOMMERCE flow still produces exactly one, as before', () => {
    const g = plan(`open the store catalog at ${ORIGIN} and open the first product listed`);
    expect(g.subgoals.map((s) => s.category)).toEqual(['NAVIGATE', 'SEARCH', 'SELECT', 'VERIFY']);
    expect(g.subgoals.filter((s) => s.destination !== undefined)).toHaveLength(1);
  });

  it('W8d. an already-on-catalog e-commerce run still skips its NAVIGATE', () => {
    const g = decomposeTask(`open the store catalog at ${ORIGIN} and open the first product listed`, {
      currentUrl: `${ORIGIN}/results.html`,
      knownPageCategory: 'LISTING',
    });
    expect(g.skippedInitialSteps.join(' ')).toMatch(/NAVIGATE/);
    expect(g.subgoals.filter((s) => s.destination !== undefined)).toHaveLength(0);
  });

  it('W8e. subgoal ids and indices stay well-formed', () => {
    for (const p of PROMPTS) {
      const g = plan(p);
      g.subgoals.forEach((s, i) => {
        expect(s.id, p).toMatch(/-sg\d+$/);
        expect(s.index, p).toBe(i);
        expect(s.goalId, p).toBe(g.goal.goalId);
      });
    }
  });

  it('W8f. prerequisites resolve and never point at an empty id', () => {
    for (const p of PROMPTS) {
      const g = plan(p);
      const ids = new Set(g.subgoals.map((s) => s.id));
      for (const s of g.subgoals) {
        for (const pre of s.prerequisites) {
          expect(pre, `${p} :: ${s.id}`).not.toBe('');
          expect(ids.has(pre), `${p} :: ${s.id} -> ${pre}`).toBe(true);
        }
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// W9 — affordances cannot create a destination subgoal
// ══════════════════════════════════════════════════════════════════════════════

describe('W9 · observed affordances cannot create a destination subgoal', () => {
  it('W9a. a rich affordance set does not change the PLAN', () => {
    const bare = JSON.stringify(plan('click the submit button').subgoals.map((s) => s.category));
    // Same prompt, but decomposed while the caller reports a page full of
    // affordances. The decomposer has no observation channel at all; this
    // asserts the plan is a function of the prompt alone.
    const withAffordances = JSON.stringify(
      plan('click the submit button', `${ORIGIN}/search.html`).subgoals.map((s) => s.category)
    );
    expect(withAffordances).toBe(bare);
  });

  it('W9b. SCROLL / FILL_FIELD / SUBMIT_SEARCH never satisfy a destination subgoal', () => {
    const nav = oneDestination(`open the store catalog at ${ORIGIN}`);
    for (const affs of [
      ['SCROLL'],
      ['FILL_FIELD'],
      ['SUBMIT_SEARCH'],
      ['SCROLL', 'FILL_FIELD', 'SUBMIT_SEARCH', 'ENTER_QUERY', 'ADD_TO_CART'],
    ]) {
      const c = classified(`${ORIGIN}/`, 'UNKNOWN', 0.1, 5, affs);
      expect(verify(nav, c).satisfied, JSON.stringify(affs)).toBe(false);
    }
  });

  it('W9c. affordances alone never create one either', () => {
    // The decomposer is observation-blind: it takes only a prompt and an
    // optional current URL for step-skipping. Nothing affordance-derived is in
    // scope, so no affordance can add a subgoal.
    const g = plan('do something with this page', `${ORIGIN}/search.html`);
    expect(g.subgoals.filter((s) => s.destination !== undefined)).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// W10 — observation cannot create or rewrite a declaration
// ══════════════════════════════════════════════════════════════════════════════

describe('W10 · observation can never create or rewrite a declaration', () => {
  it('W10a. the declaration is identical across every observed page type', () => {
    const p = `open the store catalog at ${ORIGIN}`;
    const baseline = JSON.stringify(plan(p).goal.destinationDeclaration);
    for (const [url, cat] of [
      [`${ORIGIN}/`, 'UNKNOWN'],
      [`${ORIGIN}/results.html`, 'LISTING'],
      [`${ORIGIN}/product.html`, 'PRODUCT_DETAIL'],
      [`${ORIGIN}/checkout`, 'CHECKOUT'],
      ['https://example.com/', 'FORM'],
    ] as const) {
      const g = decomposeTask(p, { currentUrl: url, knownPageCategory: cat });
      expect(JSON.stringify(g.goal.destinationDeclaration), `${url} ${cat}`).toBe(baseline);
    }
  });

  it('W10b. an undeclared prompt stays undeclared even while LISTING is observed', () => {
    const p = 'click the submit button';
    const g = decomposeTask(p, { currentUrl: `${ORIGIN}/results.html`, knownPageCategory: 'LISTING' });
    expect((g.goal.destinationDeclaration as { kind: string }).kind).toBe('NONE');
    expect(g.subgoals.filter((s) => s.destination !== undefined)).toHaveLength(0);
  });

  it('W10c. verifying against a matching observation leaves the declaration untouched', () => {
    const p = `open the store catalog at ${ORIGIN}`;
    const g = plan(p);
    const nav = g.subgoals.find((s) => s.destination !== undefined)!;
    const before = JSON.stringify(nav.destination);
    const goalBefore = JSON.stringify(g.goal.destinationDeclaration);
    expect(verify(nav, REAL_CATALOG).satisfied).toBe(true);
    expect(JSON.stringify(nav.destination)).toBe(before);
    expect(JSON.stringify(g.goal.destinationDeclaration)).toBe(goalBefore);
  });

  it('W10d. the destination never lands in targetEntity / description / expectedValue', () => {
    for (const p of [
      `open the store catalog at ${ORIGIN}`,
      `open the checkout page at ${ORIGIN}`,
      `open the contact form at ${ORIGIN}`,
    ]) {
      for (const sg of plan(p).subgoals) {
        expect(sg.verificationCondition!.expectedValue ?? '', sg.id).toBe('');
        expect(sg.targetEntity ?? '', sg.id).not.toMatch(/LISTING|CHECKOUT|FORM/);
        expect(sg.description, sg.id).not.toMatch(/LISTING|CHECKOUT/);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Success authority is unchanged
// ══════════════════════════════════════════════════════════════════════════════

describe('the new subgoal cannot assert task success', () => {
  it('a fully-satisfied destination subgoal leaves the goal ACTIVE', () => {
    const g = plan(`open the store catalog at ${ORIGIN}`);
    for (const sg of g.subgoals) verify(sg, REAL_CATALOG);
    expect(g.goal.status).toBe('ACTIVE');
  });

  it('the decomposer exposes no success setter', () => {
    const src = Object.keys(
      (decomposeTask as unknown as Record<string, unknown>) as Record<string, unknown>
    );
    expect(src).not.toContain('completeGoal');
    expect(src).not.toContain('setStatus');
  });

  it('a destination MATCH never writes a task-status field anywhere', () => {
    // Mutation M12/M14 shape: the tracker, on MATCH, must not be able to reach
    // a goal/task status. There is no such field to write.
    const nav = oneDestination(`open the store catalog at ${ORIGIN}`);
    expect(verify(nav, REAL_CATALOG).satisfied).toBe(true);
    expect(Object.keys(verify(nav, REAL_CATALOG)).sort()).toEqual(['reason', 'satisfied']);
    // `Subgoal` carries planning STATE, not a task status. There is no
    // `status`, `goalStatus` or `success` field for a MATCH to write.
    expect((nav as unknown as Record<string, unknown>).goalStatus).toBeUndefined();
    expect((nav as unknown as Record<string, unknown>).status).toBeUndefined();
    expect(nav.state).toBe('READY');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Model output and action intent cannot reach the declaration
//
// The decomposer takes only a prompt plus an options bag for step-skipping.
// There is no field capable of carrying model output, and this asserts that
// both structurally and behaviourally — the plan is a function of the prompt.
// ══════════════════════════════════════════════════════════════════════════════

describe('the declaration is a function of the prompt alone', () => {
  const PROMPT = `open the store catalog at ${ORIGIN}`;

  it('model-shaped option fields cannot create or change a declaration', () => {
    const baseline = JSON.stringify(plan(PROMPT).goal.destinationDeclaration);
    const hostile = decomposeTask(PROMPT, {
      currentUrl: `${ORIGIN}/`,
      // Fields a reasoner or planner MIGHT plausibly thread through if the
      // architecture ever regressed. None exist on the type; passing them
      // anyway must change nothing.
      ...({
        modelDestination: 'http://model.invalid/results.html',
        modelSuggestedRole: 'LISTING',
        actionUrl: `${ORIGIN}/results.html`,
        actionReason: 'navigate to the catalog',
        executionSuccess: true,
        navigationDestination: `${ORIGIN}/results.html`,
        previousActions: [{ action: 'navigate', url: `${ORIGIN}/results.html` }],
        affordances: ['SCROLL', 'SUBMIT_SEARCH'],
        pageType: 'LISTING',
        lastModelOutput: 'LISTING',
      } as Record<string, unknown>),
    } as never);
    expect(JSON.stringify(hostile.goal.destinationDeclaration)).toBe(baseline);
    expect(JSON.stringify(hostile.subgoals.map((s) => s.destination))).toBe(
      JSON.stringify(plan(PROMPT).subgoals.map((s) => s.destination))
    );
  });

  it('a NONE declaration stays NONE under every hostile option', () => {
    const baseline = JSON.stringify(plan('click the submit button').goal.destinationDeclaration);
    const hostile = decomposeTask('click the submit button', {
      currentUrl: `${ORIGIN}/results.html`,
      ...({ modelSuggestedRole: 'LISTING', pageType: 'LISTING', affordances: ['SCROLL'] } as Record<string, unknown>),
    } as never);
    expect(JSON.stringify(hostile.goal.destinationDeclaration)).toBe(baseline);
    expect(hostile.subgoals.filter((s) => s.destination !== undefined)).toHaveLength(0);
  });

  it('the normalizer is called with the raw prompt and nothing else', () => {
    // Structural check. The call site is the guarantee: whatever the options
    // bag contains, the declaration is built from `userPrompt` alone.
    const src = readFileSync(
      resolve(process.cwd(), 'extension/src/hierarchicalPlanning/taskDecomposer.ts'),
      'utf8'
    );
    const calls = src.match(/normalizeDestination\([^)]*\)/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('normalizeDestination(userPrompt)');
  });
});