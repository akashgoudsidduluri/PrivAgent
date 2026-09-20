/**
 * PrivAgent — Bounded Infinite Scroll & Lazy Content Discovery (M11)
 *
 * Implements bounded discovery across dynamic infinite scroll or lazy-loaded feeds.
 *
 * Policies:
 *  - Explicit scroll budget (default max 3-5 scrolls).
 *  - Never blindly scroll indefinitely.
 *  - Verifies scroll effect after each increment.
 *  - Returns honest NOT_FOUND state when search budget is exhausted without match.
 */

export interface ScrollBudgetConfig {
  maxScrolls: number;
  scrollDeltaY: number;
  settleTimeoutMs: number;
}

export const DEFAULT_SCROLL_BUDGET: ScrollBudgetConfig = {
  maxScrolls: 3,
  scrollDeltaY: 500,
  settleTimeoutMs: 800,
};

export interface BoundedScrollResult<T> {
  found: boolean;
  match?: T;
  scrollsUsed: number;
  budgetExhausted: boolean;
  reason: string;
}

/**
 * Executes bounded discovery over dynamic or lazy-loaded elements.
 */
export async function runBoundedScrollDiscovery<T>(
  matcher: () => Promise<T | null> | (T | null),
  scrollAction: (deltaY: number) => Promise<boolean> | boolean,
  config: Partial<ScrollBudgetConfig> = {}
): Promise<BoundedScrollResult<T>> {
  const budget: ScrollBudgetConfig = { ...DEFAULT_SCROLL_BUDGET, ...config };
  let scrollsUsed = 0;

  // 1. Check initial perception before scrolling
  const initialMatch = await matcher();
  if (initialMatch) {
    return {
      found: true,
      match: initialMatch,
      scrollsUsed: 0,
      budgetExhausted: false,
      reason: 'Target entity discovered in initial viewport perception',
    };
  }

  // 2. Bounded scroll loop
  while (scrollsUsed < budget.maxScrolls) {
    scrollsUsed++;
    const scrollEffect = await scrollAction(budget.scrollDeltaY);
    if (!scrollEffect) {
      return {
        found: false,
        scrollsUsed,
        budgetExhausted: false,
        reason: 'Scroll action produced no viewport effect (bottom of page reached)',
      };
    }

    // Wait for dynamic/lazy rendering
    if (budget.settleTimeoutMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, budget.settleTimeoutMs));
    }

    const currentMatch = await matcher();
    if (currentMatch) {
      return {
        found: true,
        match: currentMatch,
        scrollsUsed,
        budgetExhausted: false,
        reason: `Target entity discovered after ${scrollsUsed} scroll iteration(s)`,
      };
    }
  }

  // 3. Honest failure when budget is exhausted
  return {
    found: false,
    scrollsUsed,
    budgetExhausted: true,
    reason: `Target not found within bounded scroll budget of ${budget.maxScrolls} attempts`,
  };
}
