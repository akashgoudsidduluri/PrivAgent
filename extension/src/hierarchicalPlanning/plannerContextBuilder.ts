/**
 * PrivAgent — Planner Context Builder & Minimizer (Phase 4.14)
 *
 * Assembles a minimized, privacy-preserving context for the reasoning layer.
 *
 * Budget Rule:
 *  - Target <= 2 KB (2048 bytes).
 *  - If context exceeds the target, applies deterministic relevance ranking and minimization.
 *  - NEVER removes security-critical information (URL, category, constraints, active subgoal conditions)
 *    merely to satisfy the byte budget.
 *  - Strictly adheres to the M8 privacy/sanitization boundary.
 */

import {
  HighLevelGoal,
  Subgoal,
  DeclaredDestinationConstraint,
} from './hierarchicalTypes';
import { AgentContextPayload, AgentDetection } from '../privacy/types';
import { assertSanitizedContextSafe } from '../agent/privacyPolicy';
import type { DestinationDeclaration } from '../planning/destinationNormalizer';

export interface PlannerContextResult {
  contextPayload: AgentContextPayload;
  byteSize: number;
  targetBudgetMet: boolean;
  trimmedElementsCount: number;
}

export const TARGET_PLANNER_CONTEXT_BUDGET_BYTES = 2048;

/**
 * POST-17.10 Step 10 — project a readonly user destination declaration into the
 * typed shape the reasoner receives.
 *
 * Every input is user-derived. `declaration` is a `DestinationDeclaration`
 * produced once by `normalizeDestination(userPrompt)` and carried read-only on
 * the subgoal, so there is no channel by which an observation, a page type, an
 * affordance, an action URL, an execution result or model output could reach
 * this function. The projection below is total and total-only: when there is no
 * DECLARED destination it returns `undefined`, and no amount of page state can
 * make it return anything else.
 *
 * `AMBIGUOUS` and `UNSUPPORTED` yield `undefined` by design. Ambiguity is never
 * resolved into a destination on the agent's behalf, and an unmapped noun is
 * never guessed at.
 */
export function toDeclaredDestinationConstraint(
  declaration: DestinationDeclaration | undefined
): DeclaredDestinationConstraint | undefined {
  if (!declaration || declaration.kind !== 'DECLARED') return undefined;

  const role = declaration.role?.acceptablePageTypes;
  const constraint: {
    -readonly [K in keyof DeclaredDestinationConstraint]: DeclaredDestinationConstraint[K];
  } = {
    provenance: 'USER_DECLARED_DESTINATION',
    ...(role && role.length > 0 ? { role: [...role] } : {}),
    // Verbatim declared origin+path. Never normalised, never extended with a
    // query, and never derived from `entryUrl`.
    ...(declaration.url ? { destinationUrl: `${declaration.url.origin}${declaration.url.path}` } : {}),
    ...(declaration.entryUrl ? { entryUrl: `${declaration.entryUrl.origin}${declaration.entryUrl.path}` } : {}),
  };
  return constraint as DeclaredDestinationConstraint;
}

export class PlannerContextBuilder {
  /**
   * Builds and minimizes the planner context to target <= 2 KB without omitting security-critical data.
   */
  public static buildContext(
    baseContext: AgentContextPayload,
    goal: HighLevelGoal,
    activeSubgoal?: Subgoal,
    memoryHints?: import('../memory/memoryRetriever').MemoryHints
  ): PlannerContextResult {
    // 1. Verify privacy boundary safety
    assertSanitizedContextSafe(baseContext);

    // Deep copy detections to prevent mutating the original perception
    const candidateDetections: AgentDetection[] = baseContext.detections
      ? baseContext.detections.map((d) => ({ ...d }))
      : [];

    // 2. Score and rank detections deterministically based on the goal
    const rankedDetections = this.rankDetections(
      candidateDetections,
      goal,
      activeSubgoal,
      baseContext.semantic_context
    );

    // 3. Assemble initial context
    //
    // POST-17.10 Step 10: when the active subgoal carries a user-declared
    // destination, it travels with the reasoning request as TYPED data.
    //
    // This is the planner→reasoner boundary, and Step 9 proved the destination
    // was absent from it. It is added to `semantic_context`, which the backend
    // accepts as a free dictionary (`AgentContextPayload.semantic_context:
    // Optional[Dict[str, Any]]`), so no provider schema change is required and
    // the egress contract is otherwise byte-identical.
    //
    // POST-17.10 Step 10.3 (G5) — PROPAGATION SCOPE vs COMPLETION SCOPE.
    //
    // These were the same scope, and that was wrong. Reading only
    // `activeSubgoal.destination` made the user's declared destination vanish
    // from the model boundary on every turn in which a DIFFERENT subgoal was
    // active — the Step 10 case-B capture carried it on 2 of 7 requests. The
    // constraint is not a property of a subgoal; it is the user's standing
    // intent for the WHOLE task, which is exactly what
    // `HighLevelGoal.destinationDeclaration` holds, readonly and derived from
    // `rawUserPrompt` alone.
    //
    // So the declaration is now propagated from the GOAL, on every turn.
    //
    // COMPLETION scope is deliberately NOT changed. `Subgoal.destination`
    // remains the only thing `GoalProgressTracker.verifySubgoalCondition`
    // reads, so a MATCH still completes exactly the subgoal that owns that
    // declaration and nothing else. Widening what the MODEL is told cannot
    // complete anything — it is not an authority — which is why this is safe
    // and why the two scopes had to be separated rather than one of them
    // abandoned.
    //
    // `activeSubgoal?.destination` is retained as a fallback only, so a caller
    // that supplies a subgoal without a goal still gets a typed constraint.
    const declaredDestination = toDeclaredDestinationConstraint(
      goal.destinationDeclaration ?? activeSubgoal?.destination
    );
    const semanticContext = baseContext.semantic_context;

    const currentContext: AgentContextPayload = {
      ...baseContext,
      detections: rankedDetections,
      ...(semanticContext && declaredDestination
        ? {
            semantic_context: {
              ...semanticContext,
              declaredDestination,
            },
          }
        : {}),
      ...(memoryHints ? { memory_hints: { ...memoryHints } } : {})
    };

    let serialized = JSON.stringify(currentContext);
    let byteSize = new TextEncoder().encode(serialized).length;
    let trimmedCount = 0;

    // 4. If budget exceeded, minimize low-relevance candidates while preserving security-critical fields
    if (byteSize > TARGET_PLANNER_CONTEXT_BUDGET_BYTES) {
      // First trim memory hints if they exist and we are over budget
      if (currentContext.memory_hints) {
        while (byteSize > TARGET_PLANNER_CONTEXT_BUDGET_BYTES && currentContext.memory_hints.semanticHints.length > 0) {
          currentContext.memory_hints.semanticHints.pop();
          serialized = JSON.stringify(currentContext);
          byteSize = new TextEncoder().encode(serialized).length;
        }
      }

      // Then trim detections
      if (byteSize > TARGET_PLANNER_CONTEXT_BUDGET_BYTES && currentContext.detections.length > 3) {
        // Keep at least top 3 detections; trim from the end of the ranked list.
        //
        // Capability preservation: a byte budget must never eliminate an ENTIRE
        // interaction capability. On a large real page (200+ controls) naive
        // end-trimming can drop every input and leave the reasoner with only
        // buttons, so no click/type target can ever be grounded. We therefore
        // drop the lowest-ranked element whose capability still has another
        // representative, and only fall back to blind trimming when a capability
        // has exactly one member left.
        while (byteSize > TARGET_PLANNER_CONTEXT_BUDGET_BYTES && currentContext.detections.length > 3) {
          const idx = PlannerContextBuilder.findRedundantIndex(currentContext.detections);
          if (idx >= 0) {
            currentContext.detections.splice(idx, 1);
          } else {
            currentContext.detections.pop();
          }
          trimmedCount += 1;
          serialized = JSON.stringify(currentContext);
          byteSize = new TextEncoder().encode(serialized).length;
        }
      }
    }

    return {
      contextPayload: currentContext,
      byteSize,
      targetBudgetMet: byteSize <= TARGET_PLANNER_CONTEXT_BUDGET_BYTES,
      trimmedElementsCount: trimmedCount,
    };
  }

  /**
   * Deterministically scores and ranks detections based on relevance to the active subgoal.
   */
  /**
   * Returns the index of the lowest-ranked detection whose type still has at
   * least one other representative in the list, or -1 when every remaining
   * detection is the last of its type.
   */
  private static findRedundantIndex(detections: AgentDetection[]): number {
    const counts = new Map<string, number>();
    for (const det of detections) {
      const key = (det.type || 'element').toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (let i = detections.length - 1; i >= 0; i--) {
      const key = (detections[i]!.type || 'element').toLowerCase();
      if ((counts.get(key) ?? 0) > 1) {
        return i;
      }
    }
    return -1;
  }

  /** Deterministic stopwords excluded from goal-token matching. */
  private static readonly GOAL_STOPWORDS: ReadonlySet<string> = new Set([
    'the', 'and', 'then', 'for', 'with', 'from', 'into', 'onto', 'this', 'that',
    'these', 'those', 'please', 'open', 'show', 'go', 'goto', 'navigate', 'click',
    'on', 'in', 'at', 'to', 'of', 'a', 'an', 'is', 'are', 'it', 'its', 'page',
    'using', 'use', 'find', 'search', 'look', 'up', 'me', 'my', 'all', 'any',
  ]);

  /** Deterministic tokens a search-intent goal needs, split on non-alphanumerics. */
  private static tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !this.GOAL_STOPWORDS.has(t));
  }

  private static rankDetections(
    detections: AgentDetection[],
    goal: HighLevelGoal,
    subgoal?: Subgoal,
    semanticContext?: AgentContextPayload['semantic_context']
  ): AgentDetection[] {
    // ── Deterministic goal profile ───────────────────────────────────────────
    // Every signal below is derived from data already inside the sanitized
    // contract: the goal's target entities, its sanitized description, the
    // active subgoal, and the local semantic understanding. No raw page text,
    // no OCR, no values.
    const targetTerms: string[] = [];
    if (subgoal?.targetEntity) targetTerms.push(subgoal.targetEntity.toLowerCase());
    for (const ent of goal.targetEntities) targetTerms.push(ent.toLowerCase());

    const goalTokens = new Set<string>([
      ...targetTerms.flatMap((t) => this.tokenize(t)),
      ...this.tokenize(goal.sanitizedGoalDescription || ''),
    ]);

    // Search intent is a property of the goal, not of any single subgoal, so a
    // NAVIGATE/LOCATE subgoal on the way to a search still ranks the affordance
    // the task actually needs: the query input.
    const searchIntent =
      subgoal?.category === 'SEARCH' || /\bsearch|look\s*up|find\s+information/i.test(
        `${goal.sanitizedGoalDescription || ''} ${goal.taskCategory || ''}`
      );

    // Semantic affordances are computed locally and already name the element
    // they apply to, so they are an exact, deterministic relevance signal.
    const affordanceTargets = new Set<string>(
      (semanticContext?.affordances ?? [])
        .map((a) => a.targetElementId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    );

    const expectedAction = subgoal?.expectedActionType;

    const scored = detections.map((det) => {
      let score = 0;
      const label = (det.label || '').toLowerCase();
      const type = (det.type || '').toLowerCase();
      const selector = (det.selector || '').toLowerCase();
      const id = (det.id || '').toLowerCase();
      const surface = `${label} ${selector} ${id}`;

      // Action type alignment
      if (expectedAction === 'type' && (type === 'search' || type === 'input')) score += 50;
      if (expectedAction === 'click' && (type === 'button' || type === 'link')) score += 40;

      // Entity keyword matches (exact substring, as before)
      for (const term of targetTerms) {
        if (term && (label.includes(term) || selector.includes(term))) {
          score += 60;
        }
      }

      // Goal-token overlap: deterministic token-level relevance across the
      // machine-generated surface (label, selector, id). Capped so one long
      // label cannot dominate the ranking.
      let tokenHits = 0;
      const detTokens = new Set(this.tokenize(surface));
      for (const token of goalTokens) {
        if (detTokens.has(token)) tokenHits++;
      }
      score += Math.min(tokenHits, 3) * 12;

      // Locally computed semantic affordance: the strongest exact signal.
      if (affordanceTargets.has(det.id)) score += 35;

      // Search affordance priors. For a search goal the query input is the only
      // way to express the task, and the submit control is the only way to run
      // it — both must outrank decorative controls that merely mention the goal
      // entity in their label.
      if (searchIntent) {
        if (type === 'search' || type === 'input') score += 45;
        else if (
          (type === 'button' || type === 'link') &&
          /\bsearch|\bgo\b|submit|find/.test(surface)
        ) {
          score += 25;
        }
      }

      // Proximity / Primary role boost
      if (type === 'button' || type === 'search' || type === 'input') score += 10;

      return { det, score };
    });

    // Deterministic sort: descending by score, then ascending by element ID
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.det.id.localeCompare(b.det.id);
    });

    return scored.map((s) => s.det);
  }
}
