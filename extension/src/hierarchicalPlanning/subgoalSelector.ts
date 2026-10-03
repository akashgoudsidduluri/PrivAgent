/**
 * PrivAgent — Subgoal Selector (Phase 4.4)
 *
 * Deterministically selects the single highest-priority ready subgoal from the DAG,
 * taking into account current browser perception, affordance availability, and failure history.
 */

import { Subgoal } from './hierarchicalTypes';
import { SubgoalGraph } from './subgoalGraph';
import { BrowserWorldModel } from '../worldModel/types';
import { ActionAffordance } from '../semanticUnderstanding/semanticTypes';

export interface SubgoalSelectionResult {
  status: 'SELECTED' | 'ALL_COMPLETED' | 'BLOCKED' | 'NEEDS_REPLAN';
  selectedSubgoal?: Subgoal;
  reason: string;
}

export interface SubgoalSelectionContext {
  graph: SubgoalGraph;
  worldModel?: BrowserWorldModel;
  affordances?: ActionAffordance[];
  recentFailures?: Array<{ subgoalId: string; reason: string }>;
}

// ────────────────────────────────────────────────────────────────────────────
// G7 REPAIR 1 — DESTINATION SUBGOAL RE-EVALUATION
// ────────────────────────────────────────────────────────────────────────────

/**
 * What `selectDestinationSubgoalForRevisit` needs to decide whether the
 * browser has meaningfully moved since the last perception cycle.
 *
 * Deliberately narrow. It carries page IDENTITY (URL) and FRESHNESS
 * (generation) only. There is deliberately no field for an execution result, an
 * action, an action URL, a navigation destination, a previous action, an
 * affordance set or any model output — not because they are ignored, but
 * because they are not representable here, so a dispatch can never make a
 * destination subgoal look re-verifiable.
 */
export interface DestinationRevisitContext {
  graph: SubgoalGraph;
  /** URL observed in the current perception cycle. */
  currentUrl: string;
  /** Page generation of the current sanitized observation, when known. */
  currentGeneration?: number;
  /** URL observed in the immediately preceding cycle, when there was one. */
  previousUrl?: string;
  /** Page generation of the immediately preceding observation. */
  previousGeneration?: number;
}

export interface DestinationRevisitResult {
  status: 'REVISIT' | 'NONE';
  selectedSubgoal?: Subgoal;
  reason: string;
}

/**
 * True when this perception describes a different browser document than the
 * previous one — the URL changed, or the page generation advanced.
 *
 * This is a TRIGGER for re-evaluation, never evidence of arrival. It decides
 * only "is it worth asking the verifier again"; whether the destination is
 * actually reached is decided downstream, by
 * `GoalProgressTracker.verifySubgoalCondition` → `verifyDestination`, against
 * the current observation.
 */
function hasMeaningfulObservationChange(
  currentUrl: string,
  currentGeneration: number | undefined,
  previousUrl: string | undefined,
  previousGeneration: number | undefined
): boolean {
  if (previousUrl === undefined && previousGeneration === undefined) {
    // No prior perception to compare against (first cycle of the task).
    return true;
  }
  if (String(currentUrl ?? '') !== String(previousUrl ?? '')) return true;
  if (
    typeof currentGeneration === 'number' &&
    typeof previousGeneration === 'number' &&
    currentGeneration !== previousGeneration
  ) {
    return true;
  }
  return false;
}

export class SubgoalSelector {
  /**
   * Selects the next subgoal to execute from the ready subgoals in the graph.
   */
  public static selectNextSubgoal(context: SubgoalSelectionContext): SubgoalSelectionResult {
    const { graph, worldModel, affordances = [], recentFailures = [] } = context;

    if (graph.isAllCompleted()) {
      return {
        status: 'ALL_COMPLETED',
        reason: 'All subgoals in the plan have reached COMPLETED or SKIPPED state.',
      };
    }

    const readySubgoals = graph.getReadySubgoals();
    if (readySubgoals.length === 0) {
      // Check if there are uncompleted subgoals that are stuck
      const allSubgoals = graph.getAllSubgoals();
      const pendingOrFailed = allSubgoals.filter(
        (sg) => sg.state === 'PENDING' || sg.state === 'FAILED'
      );

      if (pendingOrFailed.length > 0) {
        return {
          status: 'NEEDS_REPLAN',
          reason: `No subgoals are currently READY, but ${pendingOrFailed.length} subgoals remain uncompleted. Replanning is required.`,
        };
      }

      return {
        status: 'BLOCKED',
        reason: 'Subgoal execution is blocked with no ready candidates available.',
      };
    }

    // Filter out subgoals that recently failed and exceeded max retries
    const failureCounts = new Map<string, number>();
    for (const f of recentFailures) {
      failureCounts.set(f.subgoalId, (failureCounts.get(f.subgoalId) || 0) + 1);
    }

    const viableCandidates = readySubgoals.filter((sg) => {
      const fails = failureCounts.get(sg.id) || 0;
      return fails < sg.maxRetries;
    });

    if (viableCandidates.length === 0) {
      return {
        status: 'NEEDS_REPLAN',
        reason: 'All ready subgoals have reached their maximum failure limit. Dynamic replanning triggered.',
      };
    }

    // Score candidates based on topological index and semantic affordance alignment
    let bestCandidate: Subgoal = viableCandidates[0]!;
    let highestScore = -Infinity;

    for (const candidate of viableCandidates) {
      let score = 100 - candidate.index; // Earlier topological subgoals have baseline priority

      // Semantic boost if current affordances directly match expected action
      if (candidate.category === 'SEARCH') {
        const hasSearchAffordance = affordances.some(
          (a) => a.type === 'ENTER_QUERY' || a.type === 'SUBMIT_SEARCH'
        );
        if (hasSearchAffordance) score += 50;
      } else if (candidate.category === 'SELECT' || candidate.category === 'FILL') {
        const hasInputAffordance = affordances.some(
          (a) => a.type === 'FILL_FIELD' || a.type === 'SELECT_OPTION' || a.type === 'GENERIC_CLICK'
        );
        if (hasInputAffordance) score += 30;
      } else if (candidate.category === 'NAVIGATE') {
        // If already on a page with content, navigate is lower priority than interacting
        if (worldModel?.page?.url && worldModel.page.url !== 'about:blank') {
          score -= 20;
        }
      }

      // Penalize subgoals with previous failures in this cycle
      const failCount = failureCounts.get(candidate.id) || 0;
      score -= failCount * 40;

      if (score > highestScore) {
        highestScore = score;
        bestCandidate = candidate;
      }
    }

    return {
      status: 'SELECTED',
      selectedSubgoal: bestCandidate,
      reason: `Selected subgoal "${bestCandidate.description}" (ID: ${bestCandidate.id}) with priority score ${highestScore}.`,
    };
  }

  /**
   * G7 REPAIR 1 — returns the IN_PROGRESS destination subgoal so it can be
   * RE-VERIFIED against a fresh observation.
   *
   * Why this exists. A destination subgoal is selected exactly once, while the
   * browser is still on the entry page, and `startSubgoal` moves it to
   * IN_PROGRESS. `getReadySubgoals` only ever returns READY or PENDING
   * subgoals, so from the next cycle onward `selectNextSubgoal` reports
   * NEEDS_REPLAN and the caller's `activeSubgoal` is undefined — which means
   * the AgentLoop's verification guard can never run again. The destination is
   * therefore proven once, before arrival, and never re-checked once the
   * browser actually reaches it. That is the G7 blocker.
   *
   * What this deliberately is NOT:
   *
   *  - It is NOT general IN_PROGRESS re-selection. Only a subgoal whose
   *    declared verification condition is `DESTINATION_VERIFIED` can ever be
   *    returned, so FILL/SELECT/STATE_CHANGED subgoals keep exactly the
   *    lifecycle they had.
   *  - It grants NO completion authority. The returned subgoal is still decided
   *    by `GoalProgressTracker.verifySubgoalCondition` → `verifyDestination`
   *    reading the CURRENT sanitized observation. This function returns a
   *    subgoal to ask about; it never returns a verdict, and it never touches
   *    the subgoal's state.
   *  - It never weakens freshness. It only asks the question; the verifier's
   *    existing page-generation semantics still decide whether the
   *    classification describes the document that is on screen now.
   *  - It does not duplicate DestinationVerifier logic — it does not classify,
   *    match a URL, or read a page role at all.
   */
  public static selectDestinationSubgoalForRevisit(
    context: DestinationRevisitContext
  ): DestinationRevisitResult {
    const { graph, currentUrl, currentGeneration, previousUrl, previousGeneration } = context;

    if (
      !hasMeaningfulObservationChange(
        currentUrl,
        currentGeneration,
        previousUrl,
        previousGeneration
      )
    ) {
      return {
        status: 'NONE',
        reason:
          'The browser has not observably changed since the previous perception, so there is nothing new for the destination verifier to rule on.',
      };
    }

    const candidates = graph
      .getAllSubgoals()
      .filter(
        (sg) =>
          sg.state === 'IN_PROGRESS' &&
          sg.verificationCondition?.type === 'DESTINATION_VERIFIED'
      )
      .sort((a, b) => a.index - b.index);

    if (candidates.length === 0) {
      return {
        status: 'NONE',
        reason:
          'No IN_PROGRESS subgoal declares a DESTINATION_VERIFIED condition, so no destination re-verification is due.',
      };
    }

    const selected = candidates[0]!;
    return {
      status: 'REVISIT',
      selectedSubgoal: selected,
      reason: `Destination subgoal "${selected.id}" remains unproven and the observed browser state has changed; it is eligible for re-verification against the current observation.`,
    };
  }
}
