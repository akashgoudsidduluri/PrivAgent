/**
 * PrivAgent — Goal Progress Tracker (Phase 4.10)
 *
 * Tracks measurable execution progress towards the high-level user goal
 * and validates subgoal completion conditions against live browser perception.
 *
 * ── PHASE 17.6 (C): FAIL CLOSED, AND PROVE FROM OBSERVATION ──────────────────
 *
 * This class was dead code with no caller anywhere in `extension/src` or
 * `tests/`, and it was FAIL-OPEN in a way that contradicted the whole agent
 * architecture:
 *
 *   * no `verificationCondition`            -> `satisfied: true`
 *   * `URL_CONTAINS` with an empty value   -> `satisfied: true`
 *   * `ELEMENT_EXISTS`                     -> `satisfied: true`, unconditionally
 *   * `AFFORDANCE_AVAILABLE`               -> `satisfied: true`, unconditionally
 *   * `STATE_CHANGED`                      -> `satisfied: true`, unconditionally
 *   * `USER_CONFIRMED`                     -> `satisfied: true`, unconditionally
 *   * `CUSTOM`                             -> falls through to the same `true`
 *
 * Five of the seven declared condition types therefore verified nothing at all.
 *
 * POST-17.10. `AFFORDANCE_AVAILABLE` was the one holdout Phase 17.6 missed.
 * Its empty-`expectedValue` form fell back to `affordances.length > 0`, which
 * is not a claim about the subgoal at all: `discoverActionAffordances` appends
 * a `SCROLL` affordance unconditionally for every document
 * (`actionAffordance.ts`), so the condition was satisfied by any page
 * whatsoever — including one with zero controls. It is now the seventh
 * condition type to require a NAMED affordance that is actually observed, and
 * an unnamed `AFFORDANCE_AVAILABLE` fails closed like its six siblings.
 * Read as a status oracle that is exactly "an action was dispatched and
 * returned without error" wearing a verification interface: the DISPATCH
 * SUCCESS != GOAL SUCCESS invariant in a second location the 17.2A goal
 * verifier audit did not reach. It happened to be harmless only because
 * nothing called it — wiring it up as written would have introduced precisely
 * the shortcut this project refuses to make.
 *
 * Every branch below now answers from OBSERVED, sanitized browser state only,
 * and every branch that cannot be proven from observation is NOT satisfied.
 * Absence of evidence is never evidence of completion.
 *
 * This does not create a second authorization system. `agentLoop` already owns
 * dispatch authorization; this function decides one narrow question — "is the
 * state the subgoal asked for actually observable right now?" — and the
 * subgoal it governs is planning bookkeeping, not permission. M5, Grounding,
 * the Security Critic, Risk/Confirmation, Containment, Effect Verification and
 * Goal Verification all remain authoritative and are untouched.
 */

import { HighLevelGoal, Subgoal, SubgoalVerificationCondition } from './hierarchicalTypes';
import { SubgoalGraph } from './subgoalGraph';
import { AgentContextPayload } from '../privacy/types';
import { verifyDestination, type DestinationObservation } from '../planning/destinationVerifier';

export interface ProgressEvaluation {
  percentComplete: number;
  isGoalSatisfied: boolean;
  completedSubgoalsCount: number;
  totalSubgoalsCount: number;
  pendingConditions: string[];
  summary: string;
}

/** The observation a subgoal condition is judged against. */
export interface SubgoalObservation {
  /** Live, sanitized page context from the current perception cycle. */
  context: AgentContextPayload;
  /**
   * Observed page generation, when one is known. A condition that was proven
   * against an older document is not evidence about this one.
   */
  pageGeneration?: number;
  /**
   * The immediately PRECEDING perception's sanitized context. Required to prove
   * a `STATE_CHANGED` condition: without a prior state there is nothing to have
   * changed relative to, so the condition fails closed.
   */
  previous?: AgentContextPayload;
  /**
   * Identifiers of actions the user explicitly confirmed AND that actually
   * dispatched. Required to prove a `USER_CONFIRMED` condition. A proposal
   * awaiting confirmation is never an entry, so this cannot manufacture consent.
   */
  userConfirmedActionIds?: string[];
}

/** PHASE 17.6: lowercased alphanumeric words, length > 2, for label matching. */
function words(text: string): string[] {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
}

/** PHASE 17.6: a label/description "contains" the expected value, word-wise. */
function mentions(haystack: string, needle: string): boolean {
  const h = String(haystack ?? '').toLowerCase();
  const n = String(needle ?? '').toLowerCase().trim();
  if (!n) return false;
  if (h.includes(n)) return true;
  const nw = words(n);
  if (nw.length === 0) return false;
  return nw.every((w) => h.includes(w));
}

const verdict = (satisfied: boolean, reason: string) => ({ satisfied, reason });

export class GoalProgressTracker {
  /**
   * Evaluates overall goal progress across the subgoal DAG and live browser state.
   *
   * `completedSubgoalsCount` is exactly the number of subgoals whose state is
   * COMPLETED — and after 17.6 a subgoal can only reach COMPLETED through
   * `verifySubgoalCondition`, so this ratio is observation-backed. It is still
   * PLANNING progress, not goal satisfaction: the task-level status is decided
   * by the goal verifier, never by this percentage.
   */
  public static evaluateProgress(
    graph: SubgoalGraph,
    goal: HighLevelGoal,
    worldModel?: unknown
  ): ProgressEvaluation {
    const allSubgoals = graph.getAllSubgoals();
    const activeSubgoals = allSubgoals.filter((s) => s.state !== 'SKIPPED');

    if (activeSubgoals.length === 0) {
      return {
        percentComplete: 0,
        isGoalSatisfied: false,
        completedSubgoalsCount: 0,
        totalSubgoalsCount: 0,
        pendingConditions: ['No active subgoals in plan'],
        summary: 'Plan has no active subgoals.',
      };
    }

    const completed = activeSubgoals.filter((s) => s.state === 'COMPLETED');
    const pendingConditions: string[] = [];

    for (const sg of activeSubgoals) {
      if (sg.state !== 'COMPLETED') {
        const desc = sg.verificationCondition?.description || sg.description;
        pendingConditions.push(`[${sg.category}] ${desc}`);
      }
    }

    const ratio = completed.length / activeSubgoals.length;
    const percentComplete = Math.round(ratio * 100);

    // PHASE 17.6. Kept as a PLANNING signal only. It is deliberately NOT
    // named `goalSatisfied`-shaped any more than before, and the loop never
    // reads it as a task outcome — the goal verifier owns that decision. The
    // field is retained for the existing planner consumers.
    const isGoalSatisfied = completed.length === activeSubgoals.length;

    return {
      percentComplete,
      isGoalSatisfied,
      completedSubgoalsCount: completed.length,
      totalSubgoalsCount: activeSubgoals.length,
      pendingConditions,
      summary: `${completed.length}/${activeSubgoals.length} subgoals completed (${percentComplete}%).`,
    };
  }

  /**
   * PHASE 17.6. Verifies a subgoal's completion criterion against OBSERVED
   * sanitized browser state.
   *
   * Fail-closed in every branch. A subgoal with no declared condition, an
   * unimplemented condition type, an empty `expectedValue`, or an observation
   * that does not contain the thing the subgoal asked for is NOT satisfied.
   * Callers must therefore leave such a subgoal IN_PROGRESS (or route it to
   * bounded recovery) — it may never be marked COMPLETED.
   *
   * This never authorizes anything. It reads only the sanitized context the
   * perception cycle already produced; it does not dispatch, and it cannot
   * widen containment, risk or confirmation.
   */
  public static verifySubgoalCondition(
    subgoal: Subgoal,
    observation: SubgoalObservation | undefined
  ): { satisfied: boolean; reason: string } {
    const cond: SubgoalVerificationCondition | undefined = subgoal.verificationCondition;

    if (!cond) {
      // PHASE 17.6. Previously "satisfied: true — rely on successful
      // execution". That is dispatch state, not evidence. A subgoal with no
      // declared, provable criterion cannot be shown complete.
      return verdict(
        false,
        `Subgoal ${subgoal.id} declares no verification condition, so its completion cannot be proven from observation.`
      );
    }

    if (!observation || !observation.context) {
      return verdict(false, `No observation available to verify subgoal ${subgoal.id}.`);
    }

    const ctx = observation.context;
    const semantic = ctx.semantic_context;
    const currentUrl = String(ctx.url ?? '');

    switch (cond.type) {
      case 'URL_CONTAINS': {
        const want = String(cond.expectedValue ?? '').trim().toLowerCase();
        if (!want) {
          // Previously an empty expected value satisfied the condition.
          return verdict(false, `Subgoal ${subgoal.id} declares URL_CONTAINS with no expected value.`);
        }
        const match = currentUrl.toLowerCase().includes(want);
        return verdict(
          match,
          match
            ? `Observed URL contains "${want}".`
            : `Observed URL "${currentUrl}" does not contain "${want}".`
        );
      }

      case 'ELEMENT_EXISTS': {
        const want = String(cond.expectedValue ?? subgoal.targetEntity ?? '').trim();
        if (!want) {
          return verdict(false, `Subgoal ${subgoal.id} declares ELEMENT_EXISTS with no expected value.`);
        }
        const byDetection = (ctx.detections ?? []).some(
          (d) =>
            d.id === want ||
            mentions(d.label ?? '', want) ||
            mentions(d.selector ?? '', want) ||
            mentions(d.type ?? '', want)
        );
        const byEntity = (semantic?.entities ?? []).some(
          (e) => e.id === want || mentions(e.label ?? '', want) || mentions(e.type ?? '', want)
        );
        const byAffordance = (semantic?.affordances ?? []).some(
          (a) => a.targetElementId === want || mentions(a.description ?? '', want)
        );
        const found = byDetection || byEntity || byAffordance;
        return verdict(
          found,
          found
            ? `Element "${want}" is observable in the current sanitized page state.`
            : `Element "${want}" is not observable in the current sanitized page state.`
        );
      }

      case 'ELEMENT_TEXT_CONTAINS': {
        const want = String(cond.expectedValue ?? '').trim();
        if (!want) {
          return verdict(false, `Subgoal ${subgoal.id} declares ELEMENT_TEXT_CONTAINS with no expected value.`);
        }
        // The sanitized context is metadata-only: it carries no page text, so
        // a text-content claim can never be proven here. Failing closed is the
        // only honest answer; asserting a match would be fabricated evidence.
        const structuralHit = (ctx.detections ?? []).some(
          (d) => mentions(d.label ?? '', want) || mentions(d.selector ?? '', want)
        );
        return verdict(
          structuralHit,
          structuralHit
            ? `Marker "${want}" is observable as page structure in the sanitized state.`
            : `Marker "${want}" is not observable. Sanitized context carries no raw page text, so a text-content claim cannot be proven.`
        );
      }

      case 'AFFORDANCE_AVAILABLE': {
        // The claim is "the OBSERVED affordance set contains THIS named
        // affordance" — not "the page has affordances". With no name there is
        // nothing to look for, and an unnamed condition previously degraded to
        // `affordances.length > 0`. That test is vacuous: `discoverActionAffordances`
        // appends an unconditional `SCROLL` affordance for every document, so it
        // was satisfied by every page, including one with no controls at all —
        // a "verification" that could never fail. Absence of evidence is never
        // evidence of completion.
        const want = String(cond.expectedValue ?? '').trim();
        if (!want) {
          return verdict(
            false,
            `Subgoal ${subgoal.id} declares AFFORDANCE_AVAILABLE with no named affordance, so no specific affordance can be shown present.`
          );
        }
        const affordances = semantic?.affordances ?? [];
        const found = affordances.some(
          (a) => a.type === want || mentions(a.description ?? '', want) || a.targetElementId === want
        );
        return verdict(
          found,
          found
            ? `Affordance "${want}" is available in the observed affordance set.`
            : `Affordance "${want}" is not available in the observed affordance set.`
        );
      }

      case 'STATE_CHANGED': {
        // PHASE 17.6. A state-change claim needs a PRIOR observed state to
        // compare against. The perception cycle provides the current one; with
        // no prior observation there is nothing to have changed relative to,
        // so this cannot be proven. (The loop supplies the prior snapshot.)
        const prior = observation.previous;
        if (!prior) {
          return verdict(
            false,
            `Subgoal ${subgoal.id} claims STATE_CHANGED but no prior observation was supplied, so no change can be established.`
          );
        }
        const changed =
          String(prior.url ?? '') !== currentUrl ||
          (prior.detections ?? []).length !== (ctx.detections ?? []).length ||
          (prior.viewport?.scroll_y ?? null) !== (ctx.viewport?.scroll_y ?? null);
        return verdict(
          changed,
          changed
            ? `Observed state differs from the prior observation (URL, element count or scroll position).`
            : `Observed state is identical to the prior observation.`
        );
      }

      case 'USER_CONFIRMED': {
        // A user-confirmation subgoal is proven by the loop having actually
        // recorded a confirmed action — never by a proposal. The loop sets
        // this flag only after `resumeWithConfirmation` executes, so reading
        // it here cannot manufacture confirmation.
        const confirmed = observation.userConfirmedActionIds ?? [];
        const proven = confirmed.length > 0;
        return verdict(
          proven,
          proven
            ? `User confirmation was recorded for ${confirmed.length} action(s).`
            : `No confirmed user action has been recorded for this subgoal.`
        );
      }

      case 'DESTINATION_VERIFIED': {
        // POST-17.10 Step 7. The ONLY path by which a destination subgoal can
        // complete, and it is observation-only.
        //
        // Note what is NOT read here. `SubgoalObservation` carries no
        // executionSuccess, no action, no action URL, no navigation
        // destination, no previous action, no affordance set and no model
        // output — those are not fields of the type, so they cannot be
        // consulted even by accident. The destination subgoal completes on a
        // MATCH and on nothing else.
        const declaration = subgoal.destination;

        if (!declaration || declaration.kind !== 'DECLARED') {
          // Fail closed. A destination condition with no typed, user-derived
          // declaration has nothing to verify. An AMBIGUOUS or UNSUPPORTED
          // declaration lands here too: ambiguity is never resolved into a
          // destination on the agent's behalf.
          return verdict(
            false,
            `Subgoal ${subgoal.id} declares DESTINATION_VERIFIED but carries no user-derived destination declaration, so its completion cannot be proven.`
          );
        }

        const classification = semantic;
        if (!classification) {
          return verdict(
            false,
            `No sanitized page classification is available to verify subgoal ${subgoal.id} against the declared destination.`
          );
        }

        // Freshness is the verifier's existing page-generation semantics, not a
        // new one. The OBSERVED generation is the generation the sanitized
        // classification was captured at; `observation.pageGeneration` is the
        // generation the browser is at NOW. When the two differ the
        // classification describes a document that no longer exists, and
        // `verifyDestination` returns UNKNOWN rather than a verdict.
        const observedGeneration = Number(classification.pageGeneration);
        const destinationObservation: DestinationObservation = {
          url: currentUrl,
          pageGeneration: observedGeneration,
          semantic: {
            pageType: classification.pageType,
            confidence: classification.confidence,
            pageGeneration: observedGeneration,
          },
        };

        const result = verifyDestination({
          declaration,
          observation: destinationObservation,
          currentPageGeneration: observation.pageGeneration,
        });

        // Only MATCH satisfies. MISMATCH and UNKNOWN both leave the subgoal
        // incomplete, and UNKNOWN is never converted to either of the others.
        return verdict(
          result.kind === 'MATCH',
          result.kind === 'MATCH'
            ? result.reason
            : `Subgoal ${subgoal.id} destination not confirmed (${result.kind}): ${result.reason}`
        );
      }

      case 'CUSTOM':
      default: {
        // PHASE 17.6. Previously fell through to `satisfied: true`. A custom
        // condition is by definition not implemented here, so it is unproven.
        return verdict(
          false,
          `Verification condition type '${cond.type}' has no observation-backed implementation, so subgoal ${subgoal.id} cannot be verified here.`
        );
      }
    }
  }
}
