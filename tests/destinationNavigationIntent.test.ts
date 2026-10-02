/**
 * PrivAgent — POST-17.10 Step 9: DESTINATION NAVIGATION INTENT.
 *
 * WHAT STEP 9's AUDIT FOUND (measured, not assumed)
 * ──────────────────────────────────────────────────
 * 1. Every action the agent takes comes from the REASONER. The deterministic
 *    action-selection class `OneActionPlanner.proposeSubgoalAction` had ZERO
 *    production callers — only a test — and it returns `null` for any NAVIGATE
 *    subgoal, so a destination subgoal could only be "reached" by whatever URL
 *    the model happened to guess.
 *
 * 2. The reasoner is NEVER TOLD the destination. Captured live from the service
 *    worker, the extension's egress payload to the backend is exactly
 *    `{task, context, previousActions}`. The typed declaration (`role: LISTING`),
 *    the active subgoal, and its description do not cross that boundary.
 *
 * 3. The system prompt then forbids the model from fixing it: rule 6 says
 *    `navigate` is "STRICTLY for loading a full new external URL" and must never
 *    be used to move within the current page. On `http://localhost:4174/` the
 *    model therefore went to `/search.html` — the reachable internal page — and
 *    the correctly-strict verifier refused to complete.
 *
 * 4. Separately, some real runs fail even earlier: the backend's text-safety scan
 *    rejects a model-emitted `reason` under `rule=person_name`. That is the
 *    documented pre-existing prose-embedded-PII tradeoff and is explicitly OUT OF
 *    SCOPE here.
 *
 * THE FIX, and its deliberate limits
 * ──────────────────────────────────
 * When the user named the destination as a URL, that URL is not a guess. It is
 * now proposed deterministically and the provider is not consulted for it.
 *
 * A ROLE-ONLY declaration returns `null` and still goes to the model: a semantic
 * destination has no URL, and inventing one would be both a fabrication and a
 * fixture special-case. That gap is reported, not papered over.
 *
 * Everything below pins the fix's LIMITS as hard as its benefits.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  classifyTaskCategory,
  decomposeTask,
} from '../extension/src/hierarchicalPlanning/taskDecomposer';
import { OneActionPlanner } from '../extension/src/hierarchicalPlanning/oneActionPlanner';
import { GoalProgressTracker } from '../extension/src/hierarchicalPlanning/goalProgressTracker';
import { type Subgoal } from '../extension/src/hierarchicalPlanning/hierarchicalTypes';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import type { SemanticPageType } from '../extension/src/semanticUnderstanding/semanticTypes';

const ORIGIN = 'http://localhost:4174';
const CANONICAL = `open the store catalog at ${ORIGIN}`;
const EXPLICIT_URL = 'open http://localhost:4174/results.html';
const EXPLICIT_URL_ECOM = `${EXPLICIT_URL} and buy the first product listed`;

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

const verify = (sg: Subgoal, c: AgentContextPayload, gen?: number) =>
  GoalProgressTracker.verifySubgoalCondition(sg, {
    context: c,
    pageGeneration: gen ?? c.semantic_context?.pageGeneration ?? 1,
  });

const plan = (p: string, currentUrl = `${ORIGIN}/`) => decomposeTask(p, { currentUrl });
const destOf = (p: string, currentUrl = `${ORIGIN}/`): Subgoal => {
  const found = plan(p, currentUrl).subgoals.filter((s) => s.destination !== undefined);
  expect(found.length, p).toBe(1);
  return found[0]!;
};
const navigate = (sg: Subgoal | undefined) =>
  OneActionPlanner.proposeDestinationNavigation(sg);

// ══════════════════════════════════════════════════════════════════════════════
// W1 / W2 — the destination reaches action planning as a TYPED constraint
// ══════════════════════════════════════════════════════════════════════════════

describe('W1/W2 · destination information reaches the action-selection layer', () => {
  it('W1. the canonical prompt still creates a destination subgoal', () => {
    expect(classifyTaskCategory(CANONICAL)).toBe('GENERIC_INTERACTION');
    const nav = destOf(CANONICAL);
    expect(nav.category).toBe('NAVIGATE');
    expect(nav.verificationCondition!.type).toBe('DESTINATION_VERIFIED');
  });

  it('W2a. an EXPLICIT destination URL is proposed verbatim, not guessed', () => {
    const nav = destOf(EXPLICIT_URL_ECOM);
    const action = navigate(nav);
    expect(action).not.toBeNull();
    expect(action!.action).toBe('navigate');
    expect((action as { url: string }).url).toBe(`${ORIGIN}/results.html`);
  });

  it('W2b. the proposal is a NAVIGATION CONSTRAINT, not an arrival claim', () => {
    // It proposes an action and nothing else: no state mutation, no status, no
    // assertion that the destination was reached.
    const action = navigate(destOf(EXPLICIT_URL_ECOM))!;
    expect(Object.keys(action).sort()).toEqual(['action', 'reason', 'url']);
    const nav = destOf(EXPLICIT_URL_ECOM);
    expect(verify(nav, classified(`${ORIGIN}/`, 'UNKNOWN', 0.1, 5)).satisfied).toBe(false);
  });

  it('W2c. a ROLE-ONLY declaration yields NO deterministic navigation', () => {
    // The core limit. A semantic destination has no URL; inventing one would be
    // a fabrication and a fixture special-case.
    expect(navigate(destOf(CANONICAL))).toBeNull();
    expect(navigate(destOf(`open the checkout page at ${ORIGIN}`))).toBeNull();
    expect(navigate(destOf(`open the contact form at ${ORIGIN}`))).toBeNull();
  });

  it('W2d. a subgoal with no destination yields NO deterministic navigation', () => {
    expect(navigate(undefined)).toBeNull();
    const noDestination = plan('click the submit button').subgoals[0]!;
    expect(navigate(noDestination)).toBeNull();
  });

  it('W2e. the reason text starts with an action verb', () => {
    // The prose heuristic that over-blocks model reasons must not apply here.
    const reason = (navigate(destOf(EXPLICIT_URL_ECOM)) as { reason: string }).reason;
    expect(/^navigating\b/i.test(reason)).toBe(true);
    expect(reason).not.toMatch(/[A-Z][a-z]+ [A-Z][a-z]+/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// W3 — navigation planning does not discard destination information
// ══════════════════════════════════════════════════════════════════════════════

describe('W3 · the declaration survives planning intact', () => {
  it('W3a. the subgoal declaration is the goal declaration, unmodified', () => {
    const g = plan(EXPLICIT_URL_ECOM);
    const nav = g.subgoals.find((s) => s.destination !== undefined)!;
    expect(JSON.parse(JSON.stringify(nav.destination))).toEqual(
      JSON.parse(JSON.stringify(g.goal.destinationDeclaration))
    );
  });

  it('W3b. the proposed URL is exactly the declared origin+path', () => {
    const d = destOf(EXPLICIT_URL_ECOM).destination as { url?: { origin: string; path: string } };
    const action = navigate(destOf(EXPLICIT_URL_ECOM)) as { url: string };
    expect(action.url).toBe(`${d.url!.origin}${d.url!.path}`);
    // No query string, no trailing slash added, no fragment, no scheme change.
    expect(action.url).not.toMatch(/[?#]/);
  });

  it('W3c. the proposed URL does not depend on the current browser state', () => {
    // The URL comes from the declaration alone. (The `reason` string embeds the
    // per-decomposition subgoal id, so only the URL is compared here.)
    const urlOf = (sg: Subgoal) => (navigate(sg) as { url: string } | null)?.url;
    expect(urlOf(destOf(EXPLICIT_URL_ECOM, `${ORIGIN}/`))).toBe(`${ORIGIN}/results.html`);
    expect(urlOf(destOf(EXPLICIT_URL_ECOM, `${ORIGIN}/results.html`))).toBe(`${ORIGIN}/results.html`);
    expect(urlOf(destOf(EXPLICIT_URL_ECOM, 'https://example.com/'))).toBe(`${ORIGIN}/results.html`);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// W4–W7, W17, W18 — completion semantics are unchanged by the navigation fix
// ══════════════════════════════════════════════════════════════════════════════

describe('W4-W7/W17/W18 · navigation never becomes completion', () => {
  it('W4. navigating to the right URL is NOT completion before observation', () => {
    const nav = destOf(EXPLICIT_URL_ECOM);
    const action = navigate(nav)!;
    expect((action as { url: string }).url).toBe(`${ORIGIN}/results.html`);
    // The proposal exists, but the subgoal has NOT completed: no observation yet.
    expect(verify(nav, classified(`${ORIGIN}/`, 'UNKNOWN', 0.1, 5)).satisfied).toBe(false);
  });

  it('W5. UNKNOWN cannot complete', () => {
    expect(verify(destOf(EXPLICIT_URL_ECOM), classified(`${ORIGIN}/`, 'UNKNOWN', 0.1, 5)).satisfied).toBe(
      false
    );
  });

  it('W6. MISMATCH cannot complete', () => {
    const nav = destOf(EXPLICIT_URL_ECOM);
    expect(verify(nav, classified(`${ORIGIN}/product.html`, 'UNKNOWN', 0.1, 7)).satisfied).toBe(false);
    expect(verify(nav, classified(`${ORIGIN}/product.html`, 'UNKNOWN', 0.1, 7)).reason).toMatch(/MISMATCH/);
  });

  it('W7. a fresh correct LISTING observation completes', () => {
    expect(verify(destOf(EXPLICIT_URL_ECOM), REAL_CATALOG).satisfied).toBe(true);
  });

  it('W17. a stale observation cannot complete, even at the declared URL', () => {
    const nav = destOf(EXPLICIT_URL_ECOM);
    expect(verify(nav, REAL_CATALOG, 5).satisfied).toBe(true);
    expect(verify(nav, REAL_CATALOG, 6).satisfied).toBe(false);
    expect(verify(nav, REAL_CATALOG, 6).reason).toMatch(/generation/i);
  });

  it('W18. arrival evidence requires a matching page generation', () => {
    const nav = destOf(EXPLICIT_URL_ECOM);
    // The observation at gen 5 is only evidence while the browser is at gen 5.
    for (const g2 of [4, 6, 9, 100]) {
      expect(verify(nav, REAL_CATALOG, g2).satisfied).toBe(false);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// W8–W11 — the shortcut sources remain unusable
// ══════════════════════════════════════════════════════════════════════════════

describe('W8-W11 · no shortcut can create or satisfy a destination', () => {
  it('W8. targetEntity cannot substitute for the declaration', () => {
    const forged = {
      ...destOf(EXPLICIT_URL_ECOM),
      destination: undefined,
      targetEntity: `${ORIGIN}/results.html`,
      expectedActionType: 'navigate',
    } as Subgoal;
    expect(navigate(forged)).toBeNull();
    expect(verify(forged, REAL_CATALOG).satisfied).toBe(false);
  });

  it('W9. affordance existence cannot substitute', () => {
    const nav = destOf(EXPLICIT_URL_ECOM);
    for (const affs of [['SCROLL'], ['SCROLL', 'ENTER_QUERY', 'SUBMIT_SEARCH', 'ADD_TO_CART']]) {
      expect(verify(nav, classified(`${ORIGIN}/`, 'UNKNOWN', 0.1, 5, affs)).satisfied, JSON.stringify(affs)).toBe(
        false
      );
    }
  });

  it('W10. model output cannot rewrite the declaration', () => {
    const nav = destOf(EXPLICIT_URL_ECOM);
    const before = JSON.stringify(nav.destination);
    verify(nav, REAL_CATALOG);
    verify(nav, classified(`${ORIGIN}/product.html`, 'UNKNOWN', 0.1, 7));
    expect(JSON.stringify(nav.destination)).toBe(before);
  });

  // ── The role-only case, against every non-user URL source ────────────────
  //
  // Mutations M3 ("fabricate a URL from targetEntity") and M5 ("use a model
  // proposed action URL") both SURVIVED the first run of this file. Their
  // predicates require a declaration that is DECLARED but carries NO `url` —
  // i.e. a role-only destination — combined with one of those fields. No test
  // ever constructed that combination, so neither mutant could fire. That is a
  // test gap, not an equivalent mutant.
  //
  // This is the important negative case: a ROLE-ONLY destination must never be
  // turned into a URL by ANY means, because there is no user-authorised URL to
  // navigate to.
  const roleOnly = (extra: Partial<Subgoal> = {}): Subgoal => ({
    ...destOf(CANONICAL),
    ...extra,
  });

  it('W10a. a role-only destination plus a targetEntity still proposes nothing', () => {
    expect(navigate(roleOnly({ targetEntity: 'store catalog' }))).toBeNull();
    expect(navigate(roleOnly({ targetEntity: `${ORIGIN}/results.html` }))).toBeNull();
  });

  it('W10b. a role-only destination plus a model proposed navigate still proposes nothing', () => {
    expect(
      navigate(
        roleOnly({
          suggestedAction: { action: 'navigate', url: `${ORIGIN}/results.html`, reason: 'model said so' },
        } as Partial<Subgoal>)
      )
    ).toBeNull();
  });

  it('W10c. a role-only destination plus executionSuccess still proposes nothing', () => {
    expect(navigate(roleOnly({ executionSuccess: true } as unknown as Partial<Subgoal>))).toBeNull();
  });

  it('W10d. a role-only destination with NO declaration yields nothing either', () => {
    const orphan = { ...destOf(CANONICAL), destination: undefined, targetEntity: 'x' } as Subgoal;
    expect(navigate(orphan)).toBeNull();
  });

  it('W10e. and a role-only destination never completes from any of them', () => {
    const loaded = roleOnly({
      targetEntity: `${ORIGIN}/results.html`,
      suggestedAction: { action: 'navigate', url: `${ORIGIN}/results.html` },
      executionSuccess: true,
    } as unknown as Partial<Subgoal>);
    expect(verify(loaded, classified(`${ORIGIN}/`, 'UNKNOWN', 0.1, 5)).satisfied).toBe(false);
  });

  it('W11. observation cannot rewrite the declaration', () => {
    const g = plan(EXPLICIT_URL_ECOM, `${ORIGIN}/`);
    const before = JSON.stringify(g.goal.destinationDeclaration);
    for (const c of [REAL_CATALOG, classified(`${ORIGIN}/checkout`, 'CHECKOUT', 0.97, 5)]) {
      verify(g.subgoals[0]!, c);
    }
    expect(JSON.stringify(g.goal.destinationDeclaration)).toBe(before);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// W12–W15 — Step 8 invariants must survive the navigation fix
// ══════════════════════════════════════════════════════════════════════════════

describe('W12-W15 · Step 8 invariants survive', () => {
  it('W12. no duplicate destination subgoals in any flow', () => {
    for (const p of [CANONICAL, EXPLICIT_URL, EXPLICIT_URL_ECOM, 'click the submit button', 'open the widget']) {
      expect(plan(p).subgoals.filter((s) => s.destination !== undefined).length, p).toBeLessThanOrEqual(1);
    }
  });

  it('W13. a generic prompt without a destination is untouched', () => {
    const g = plan('click the submit button');
    expect(g.subgoals.map((s) => s.category)).toEqual(['LOCATE', 'SELECT', 'VERIFY']);
    expect(g.subgoals.filter((s) => s.destination !== undefined)).toHaveLength(0);
    expect(navigate(g.subgoals[0]!)).toBeNull();
  });

  it('W14. an explicit destination URL remains EXACT — "/" never matches "/results.html"', () => {
    const nav = destOf(EXPLICIT_URL_ECOM);
    expect(verify(nav, REAL_CATALOG).satisfied).toBe(true);
    // A different real page at the same host does NOT satisfy it.
    expect(verify(nav, classified(`${ORIGIN}/search.html`, 'UNKNOWN', 0.1, 5)).satisfied).toBe(false);
    expect(verify(nav, classified(`${ORIGIN}/search.html`, 'UNKNOWN', 0.1, 5)).reason).toMatch(/MISMATCH/);
  });

  it('W15. the entry URL is still never proposed as the destination', () => {
    // The canonical prompt has entryUrl "/" and role LISTING, and NO url. The
    // deterministic navigator must therefore propose nothing at all.
    const nav = destOf(CANONICAL);
    expect((nav.destination as { entryUrl?: unknown }).entryUrl).toBeDefined();
    expect((nav.destination as { url?: unknown }).url).toBeUndefined();
    expect(navigate(nav)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// W16 — recovery / replanning cannot silently replace the destination
// ══════════════════════════════════════════════════════════════════════════════

describe('W16 · replanning cannot substitute a destination', () => {
  it('W16a. a replanned subgoal with no declaration proposes nothing', async () => {
    const { DynamicReplanner } = await import(
      '../extension/src/hierarchicalPlanning/dynamicReplanner'
    );
    const { SubgoalGraph } = await import('../extension/src/hierarchicalPlanning/subgoalGraph');
    const g = plan(EXPLICIT_URL_ECOM);
    const graph = new SubgoalGraph(g.goal.goalId, g.subgoals);
    const decision = DynamicReplanner.replan({
      graph,
      goal: g.goal,
      trigger: 'ACTION_NO_EFFECT',
      triggerReason: 'no effect observed',
      replanCount: 0,
      previousEffect: { changed: false },
    });
    for (const sg of decision.newSubgoals ?? []) {
      // A replanned subgoal that does not itself carry a declaration cannot be
      // navigated to deterministically.
      if (sg.destination === undefined) expect(navigate(sg), sg.id).toBeNull();
    }
  });

  it('W16b. replanning is not reached as a completion path at all', () => {
    // The tracker has no replanning branch: only verifyDestination can satisfy a
    // destination subgoal, so recovery cannot smuggle a success in.
    const nav = destOf(EXPLICIT_URL_ECOM);
    expect(verify(nav, classified(`${ORIGIN}/`, 'UNKNOWN', 0.1, 5)).satisfied).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// The wiring itself
// ══════════════════════════════════════════════════════════════════════════════

describe('the deterministic destination path is actually wired into the loop', () => {
  const src = readFileSync(resolve(process.cwd(), 'extension/src/agent/agentLoop.ts'), 'utf8');

  it('the loop consults the deterministic destination navigator', () => {
    expect(src).toContain('OneActionPlanner.proposeDestinationNavigation');
  });

  it('the provider call remains for every other action', () => {
    expect(src).toContain('requestActionWithBoundedRetry(task, context)');
  });

  it('the deterministic proposal still passes every downstream gate', () => {
    // It is an ACTION PROPOSAL, so it must flow through M5, the security
    // critic, privacy, risk and containment exactly like a model action.
    const start = src.indexOf('proposeDestinationNavigation');
    expect(start).toBeGreaterThan(-1);
    const untilExecute = src.slice(start);
    for (const gate of [
      'groundProposedTarget',
      'validateAction',
      'reviewProposedAction',
      'canPerformAction',
      'evaluateContainment',
    ]) {
      expect(untilExecute, gate).toContain(gate);
    }
    // And every gate must appear AFTER the deterministic proposal, never before.
    for (const gate of ['groundProposedTarget', 'validateAction', 'reviewProposedAction']) {
      expect(untilExecute.indexOf(gate), `${gate} must follow the proposal`).toBeGreaterThan(0);
    }
  });

  it('it never bypasses one-action validation', () => {
    expect(src).toContain('OneActionPlanner.validateSingleActionProposal');
  });
});