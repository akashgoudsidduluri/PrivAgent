/**
 * PrivAgent — PHASE 17.7: regression tests for the mutation-audit coverage gaps.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * Phase 17.7 is an ADVERSARIAL MUTATION AUDIT of the safety authorities: each
 * mutation disables exactly one safeguard in production code and the existing
 * suite is asked whether it notices. See `scratch/mut17_7.mjs`.
 *
 * Fifteen mutations were run. Twelve were caught. Three were not, and they are
 * the reason this file exists:
 *
 *   M5   `verifyActionEffect` derived `pageObservable` from `pageStateObservable`
 *        with a comparison that always evaluates to `true`. The Phase 16
 *        DEFECT 3 flag — "the tab record was readable, the page was not" — would
 *        then be ignored, and a page-local comparison would be reported as an
 *        OBSERVED effect on a page nobody could read. No test in the 114-file
 *        suite noticed. That is the fabrication this project exists to refuse,
 *        and it was invisible to the suite.
 *
 *   M9b  the self-heal branch adopted a recovered action and marked it allowed
 *        without re-checking the healed target against GATE 1 and M5. A healed
 *        target that FAILED re-grounding would be dispatched anyway. No test in
 *        the suite noticed: `tests/selfHealing.test.ts` only exercises
 *        `recoverStaleTarget` in isolation and never runs the LOOP, which is
 *        the only place the authorisation decision is made.
 *
 *   M9   the same branch with its condition neutralised but its body intact.
 *        This one is an EQUIVALENT MUTANT and is documented rather than tested:
 *        the branch is only ever entered when the original validation was
 *        already `allowed: false`, and its body assigns `validation = healedVal`,
 *        so forcing the branch to run can never turn a refusal into a dispatch.
 *        There is no behaviour to test and no bug to fix. M9b — which also
 *        rewrites `validation` — is the honest form of this attack, and it is
 *        covered below.
 *
 * Every assertion is written so that the mutation which motivated it makes the
 * test fail. The two "control" cases are deliberate: each gate that blocks
 * something in production is also shown ALLOWING the honest version of the same
 * scenario, so these tests cannot pass vacuously by refusing everything.
 */

import { describe, it, expect } from 'vitest';

import {
  verifyActionEffect,
  observedSnapshotFields,
  type PreActionSnapshot,
  type PostActionSnapshot,
} from '../../extension/src/agent/effectVerifier';
import { AgentLoop } from '../../extension/src/agent/agentLoop';
import { recoverStaleTarget } from '../../extension/src/agent/selfHealing';
import { validateAction } from '../../extension/src/agent/actionValidator';
import type { AgentContextPayload, AgentDetection } from '../../extension/src/privacy/types';
import type { BrowserAction } from '../../extension/src/agent/actionTypes';

// ══════════════════════════════════════════════════════════════════════════════
// GAP 1 (mutation M5) — the pageStateObservable flag is authoritative
// ══════════════════════════════════════════════════════════════════════════════

const snap = (over: Partial<PostActionSnapshot> = {}): PreActionSnapshot => ({
  url: 'https://shop.example/checkout',
  scrollX: 0,
  scrollY: 0,
  domElementCount: 40,
  openModalsCount: 0,
  targetValueLength: 0,
  activeElementSelector: '',
  timestamp: 1_700_000_000_000,
  ...over,
});

/**
 * Both snapshots claim EVERY field was directly observed.
 *
 * That is the whole point: the per-field states agree with each other, and the
 * only thing that says the page could not be read is `pageStateObservable`.
 * A verifier that trusts the field states over the flag has no way to notice it
 * is reasoning about a page it never saw.
 */
const bothFullyObserved = (over: Partial<PostActionSnapshot> = {}) => ({
  pre: {
    ...snap(),
    pageStateObservable: true,
    observation: {
      observedAt: 1_700_000_000_000,
      tabId: 7,
      pageGeneration: 3,
      tabLifecycleObserved: true,
      pageReadable: true,
      fields: observedSnapshotFields(),
    },
  } as PreActionSnapshot,
  post: {
    ...snap({ domElementCount: 61 }),
    pageStateObservable: false,
    observation: {
      observedAt: 1_700_000_100_000,
      tabId: 7,
      pageGeneration: 3,
      tabLifecycleObserved: true,
      pageReadable: false,
      fields: observedSnapshotFields(),
    },
  } as PostActionSnapshot,
});

describe('17.7-G1 · an unreadable page is never evidence of a page-local effect (M5)', () => {
  it('a click is UNVERIFIABLE when the page could not be read, despite a DOM delta', () => {
    const { pre, post } = bothFullyObserved();
    const r = verifyActionEffect({ action: 'click', target: 'pay' } as BrowserAction, pre, post);

    // "unobservable is not zero" — and here it is not even a number.
    expect(r.hasEffect).toBe(false);
    expect(r.status).toBe('EFFECT_UNVERIFIABLE');
    expect(r.diagnostics.pageStateObservable).toBe(false);
    // The refusal must not also claim the opposite.
    expect(r.status).not.toBe('DOM_MUTATION_OBSERVED');
  });

  it('a scroll is UNVERIFIABLE on an unreadable page, despite a real scrollDelta', () => {
    const { pre, post } = bothFullyObserved();
    const scrolledPost: PostActionSnapshot = { ...post, scrollY: 900 };
    const r = verifyActionEffect(
      { action: 'scroll', direction: 'down', amount: 900 } as BrowserAction,
      pre,
      scrolledPost
    );

    expect(r.hasEffect).toBe(false);
    expect(r.status).toBe('EFFECT_UNVERIFIABLE');
    expect(r.status).not.toBe('SCROLL_CHANGED');
  });

  it('CONTROL: with the page readable, the very same deltas ARE reported', () => {
    // Without this the two tests above would pass for a verifier that simply
    // refuses everything, which is not the contract.
    const { pre, post } = bothFullyObserved();
    const readable = { ...post, pageStateObservable: true } as PostActionSnapshot;

    const click = verifyActionEffect({ action: 'click', target: 'pay' } as BrowserAction, pre, readable);
    expect(click.status).toBe('DOM_MUTATION_OBSERVED');
    expect(click.hasEffect).toBe(true);

    const scroll = verifyActionEffect(
      { action: 'scroll', direction: 'down', amount: 900 } as BrowserAction,
      pre,
      { ...readable, scrollY: 900 } as PostActionSnapshot
    );
    expect(scroll.status).toBe('SCROLL_CHANGED');
  });

  it('CONTROL: a URL change is still evidence when the page is gone (Phase 16 fix)', () => {
    // The flag governs PAGE-LOCAL comparisons. The tab record is a different
    // channel and a real navigation is a real observation, which is exactly why
    // the Phase 16 DEFECT 3 fix works. A verifier that let M5 leak into this
    // case would throw that fix away.
    const { pre, post } = bothFullyObserved();
    const navigated: PostActionSnapshot = { ...post, url: 'https://shop.example/receipt' };

    const r = verifyActionEffect(
      { action: 'navigate', url: 'https://shop.example/receipt' } as BrowserAction,
      pre,
      navigated
    );
    expect(r.status).toBe('URL_NAVIGATION_OBSERVED');
    expect(r.hasEffect).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GAP 2 (mutation M9b) — a self-healed target is re-authorised, not trusted
// ══════════════════════════════════════════════════════════════════════════════

const det = (id: string, type: string, selector: string, dims = { width: 160, height: 32 }): AgentDetection =>
  ({
    id,
    type,
    selector,
    confidence: 0.95,
    bbox: { x: 12, y: 40, ...dims },
    length: 0,
    source: 'dom_attribute',
    is_partially_visible: false,
  }) as unknown as AgentDetection;

const ORIGIN = 'https://shop.example';

/**
 * The page the loop is looking at.
 *
 *   det-stale-node        the target the model asked for. It EXISTS and is
 *                         interactable, so GATE 1 grounds it and the loop
 *                         proceeds to M5.
 *   det-stale-node-apply  the only label-similar candidate recovery can find.
 *                         What it IS decides how re-grounding treats it.
 *
 * The selectors are written without punctuation on purpose: the recovery
 * metric tokenises on `[\s_-]` only, so `#stale-node-apply` would tokenise as
 * `#stale / node / apply` and never overlap the target hint `stale / node`.
 * That is a property of the recovery metric, and the fixture states it
 * explicitly rather than hiding it behind a lucky selector.
 */
interface HealedNode {
  type: string;
  dims: { width: number; height: number };
}

const HEALED_INTERACTABLE: HealedNode = { type: 'button', dims: { width: 160, height: 32 } };
/** Zero geometry — a DISABLED_OR_HIDDEN node. */
const HEALED_HIDDEN: HealedNode = { type: 'button', dims: { width: 0, height: 0 } };
/** Visible, same origin, but a label rather than a control: a TARGET_MISMATCH. */
const HEALED_NON_INTERACTIVE: HealedNode = { type: 'text', dims: { width: 160, height: 32 } };

const healingCtx = (healed: HealedNode): AgentContextPayload =>
  ({
    url: `${ORIGIN}/checkout`,
    timestamp: 1_700_000_000_000,
    viewport: { width: 1280, height: 900, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: { width: 1280, height: 900 },
    sanitized_status: 'sanitized_only',
    total_elements_scanned: 2,
    sensitive_elements_detected: 0,
    ocr_metrics: null,
    detections: [
      det('det-stale-node', 'button', 'shell'),
      det('det-stale-node-apply', healed.type, 'stale-node-apply', healed.dims),
    ],
  }) as unknown as AgentContextPayload;

/**
 * A proposal that GATE 1 accepts and M5 refuses: the reason restates a
 * customer's name, which is PII in free text. Reasons re-enter `previousActions`
 * and the next prompt, so M5 refuses the whole action.
 *
 * (An email address would refuse it too, but that one never reaches the
 * self-heal branch: the decision tracer's raw-value firewall throws on it
 * first, which is a different and also correct refusal.)
 */
const piiProposal = (): BrowserAction =>
  ({ action: 'click', target: 'det-stale-node', reason: 'Recipient Aria Vasquez on the checkout page' }) as BrowserAction;

const runHealingLoop = async (healed: HealedNode) => {
  const dispatched: BrowserAction[] = [];
  const context = healingCtx(healed);

  const loop = new AgentLoop(
    {
      name: 'Phase17.7Provider',
      // Always proposes the same refused action, so the loop cannot escape the
      // scenario by simply being asked for something else.
      requestAction: async () => piiProposal(),
      registerFailure: () => {},
      resetEscalation: () => {},
    },
    {
      perceivePage: async () => context,
      getEffectSnapshot: async () => ({
        url: `${ORIGIN}/checkout`,
        scrollX: 0,
        scrollY: 0,
        domElementCount: 2,
        openModalsCount: 0,
        targetValueLength: 0,
        timestamp: Date.now(),
      }),
      executeAction: async (a) => {
        dispatched.push(a);
        return { success: true };
      },
    },
    { maxSteps: 1, maxRetries: 1, delayBetweenStepsMs: 0 }
  );

  const finalState = await loop.runTask('apply the pending change');
  return { dispatched, finalState };
};describe('17.7-G2 · a self-healed target must pass the same gates as any proposal (M9b)', () => {
  it('recovery really does find the candidate, and M5 alone would wave it through', () => {
    const context = healingCtx(HEALED_NON_INTERACTIVE);
    const proposal = piiProposal();

    // M5 refuses the proposal as proposed...
    const m5 = validateAction(proposal, context);
    expect(m5.allowed).toBe(false);
    expect(m5.reason).toMatch(/sensitive values \(PII\)/i);

    // ...recovery finds a different target...
    const healing = recoverStaleTarget(proposal, context);
    expect(healing.recovered).toBe(true);
    expect(healing.recoveredTargetId).toBe('det-stale-node-apply');

    // ...and the healed action M5 builds from it carries NO page-derived PII, so
    // M5 on its own waves it through. Only RE-GROUNDING refuses it. That is the
    // point: a healed target is untrusted until it passes GATE 1 again, and
    // M5's existence check is not a substitute for that.
    expect(validateAction(healing.recoveredAction!, context).allowed).toBe(true);
  });

  it('a healed target that FAILED re-grounding is never dispatched', async () => {
    // The recovered node is visible and same-origin but is a label, not a
    // control, so GATE 1 refuses the healed click (TARGET_MISMATCH). Every
    // LATER gate is happy with it — M5 only checks that the element exists, and
    // a visible, same-origin element passes containment. If the self-heal gate
    // were bypassed, this click WOULD reach the browser. That is what the next
    // test pair pins.
    const { dispatched, finalState } = await runHealingLoop(HEALED_NON_INTERACTIVE);

    expect(dispatched).toEqual([]);
    expect(dispatched.map((a) => (a as { target?: string }).target)).not.toContain(
      'det-stale-node-apply'
    );
    expect(finalState.status).not.toBe('SUCCESS');
  });

  it('a healed target with no geometry is refused twice over (defence in depth)', async () => {
    // Same outcome for a zero-dimension node — and here the LATER geometry
    // authority catches it too, so the loop is protected even if the self-heal
    // gate were removed. Stated explicitly because it is the reason the
    // previous test had to use a visible node: a hidden node cannot tell you
    // whether the self-heal gate is doing its job.
    const { dispatched } = await runHealingLoop(HEALED_HIDDEN);
    expect(dispatched).toEqual([]);
  });

  it('CONTROL: when the healed candidate really is interactable, it IS dispatched', async () => {
    // Same provider, same refused proposal, same recovery result — only the
    // healed node differs. If the loop dispatched nothing in every case, the
    // tests above would be proving nothing.
    const { dispatched } = await runHealingLoop(HEALED_INTERACTABLE);

    expect(dispatched).toHaveLength(1);
    expect((dispatched[0] as { target?: string }).target).toBe('det-stale-node-apply');
  });
});
