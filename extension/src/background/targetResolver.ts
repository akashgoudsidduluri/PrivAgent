/**
 * PrivAgent — Target Web Tab Resolver
 *
 * Deterministically discovers the target browser tab for the M6 agent loop.
 *
 * Policies:
 *  1. Never selects the dashboard origin (localhost:5173).
 *  2. Never selects browser-internal schemes (chrome://, extension://, devtools://, about:).
 *  3. Explicit target URL/port in task has highest priority (e.g. "localhost 4173" or "localhost:4173").
 *  4. Otherwise, falls back to an active eligible web tab, then demo tab (localhost:4173), then first eligible web tab.
 *  5. Honest failure (returns null) when no eligible web tab is found.
 */

export interface MinimalTab {
  id?: number;
  url?: string;
  active?: boolean;
  windowId?: number;
  title?: string;
}

export interface TargetResolutionResult {
  selectedTab: MinimalTab | null;
  discoveredTabs: Array<{ id?: number; origin?: string; url?: string }>;
  reason: string;
}

/**
 * Extracts explicit port or target hostname from task text locally and deterministically.
 * Zero LLM calls — pure regex inspection.
 */
export function extractExplicitTargetFromTask(task: string): { hostname?: string; port?: string } | null {
  if (!task) return null;
  const text = task.toLowerCase();

  // Pattern 1: http(s)://localhost:4173 or http(s)://127.0.0.1:4173
  const urlMatch = text.match(/https?:\/\/([a-zA-Z0-9.-]+)(?::(\d+))?/);
  if (urlMatch && urlMatch[1]) {
    return {
      hostname: urlMatch[1],
      port: urlMatch[2],
    };
  }

  // Pattern 2: "localhost:4173" or "127.0.0.1:4173"
  const hostPortMatch = text.match(/(localhost|127\.0\.0\.1):(\d+)/);
  if (hostPortMatch && hostPortMatch[1] && hostPortMatch[2]) {
    return {
      hostname: hostPortMatch[1],
      port: hostPortMatch[2],
    };
  }

  // Pattern 3: "localhost 4173" or "localhost port 4173"
  const spacePortMatch = text.match(/(localhost|127\.0\.0\.1)(?:\s+(?:port\s+)?(\d+))/);
  if (spacePortMatch && spacePortMatch[1] && spacePortMatch[2]) {
    return {
      hostname: spacePortMatch[1],
      port: spacePortMatch[2],
    };
  }

  return null;
}

/**
 * Checks if a tab is a valid web tab and NOT the dashboard.
 */
export function isEligibleWebTab(tab: MinimalTab, dashboardOrigin = 'http://localhost:5173'): boolean {
  const urlToTest = tab.url || (tab as any).pendingUrl;
  if (!tab.id || !urlToTest) return false;

  let parsed: URL;
  try {
    parsed = new URL(urlToTest);
  } catch {
    return false;
  }

  // Must be http or https (already excludes chrome:, edge:, about:, devtools:, extension schemes)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  // Exclude dashboard tab (default port 5173)
  let dashParsed: URL | null = null;
  try {
    dashParsed = new URL(dashboardOrigin);
  } catch {
    // ignore
  }

  if (dashParsed && parsed.origin === dashParsed.origin) {
    return false;
  }

  if (parsed.port === '5173') {
    return false;
  }

  if (parsed.hostname === 'localhost' && parsed.port === '5173') {
    return false;
  }

  return true;
}

/**
 * Resolve the target web tab from a list of open tabs.
 */
export function resolveTargetWebTab(
  tabs: MinimalTab[],
  task: string,
  dashboardOrigin = 'http://localhost:5173'
): TargetResolutionResult {
  const discoveredTabs: Array<{ id?: number; origin?: string; url?: string }> = [];
  const eligibleTabs: MinimalTab[] = [];

  for (const t of tabs) {
    const tabUrl = t.url || (t as any).pendingUrl;
    if (!tabUrl) continue;

    let origin = '';
    try {
      origin = new URL(tabUrl).origin;
    } catch {
      origin = 'invalid';
    }

    discoveredTabs.push({
      id: t.id,
      origin,
      url: tabUrl.split('?')[0], // strip query params for safe diagnostics
    });

    if (isEligibleWebTab(t, dashboardOrigin)) {
      eligibleTabs.push(t);
    }
  }

  if (eligibleTabs.length === 0) {
    const explicit = extractExplicitTargetFromTask(task);
    if (explicit && explicit.port) {
      return {
        selectedTab: null,
        discoveredTabs,
        reason: `No target web tab found. Please open http://${explicit.hostname || 'localhost'}:${explicit.port}.`,
      };
    }
    return {
      selectedTab: null,
      discoveredTabs,
      reason: 'No browser tab is available for this task. Open the webpage you want PrivAgent to work with and try again.',
    };
  }

  // 1. Explicit target resolution from task
  const explicit = extractExplicitTargetFromTask(task);
  if (explicit) {
    if (explicit.port) {
      const matchedTab = eligibleTabs.find((t) => {
        try {
          const tabUrl = t.url || (t as any).pendingUrl;
          if (!tabUrl) return false;
          const u = new URL(tabUrl);
          const isLocalMatch =
            (explicit.hostname === 'localhost' || explicit.hostname === '127.0.0.1') &&
            (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
          const isHostMatch = u.hostname.toLowerCase() === explicit.hostname?.toLowerCase();
          return (isLocalMatch || isHostMatch) && u.port === explicit.port;
        } catch {
          return false;
        }
      });

      if (matchedTab) {
        return {
          selectedTab: matchedTab,
          discoveredTabs,
          reason: `Matched explicit target in task: ${explicit.hostname || 'localhost'}:${explicit.port}`,
        };
      }

      // If user explicitly asked for a specific port (e.g. 4173) and it wasn't found,
      // fail honestly and tell the user to open that specific target.
      return {
        selectedTab: null,
        discoveredTabs,
        reason: `No target web tab found. Please open http://${explicit.hostname || 'localhost'}:${explicit.port}.`,
      };
    } else if (explicit.hostname && explicit.hostname !== 'localhost' && explicit.hostname !== '127.0.0.1') {
      const matchedTab = eligibleTabs.find((t) => {
        try {
          const tabUrl = t.url || (t as any).pendingUrl;
          if (!tabUrl) return false;
          const u = new URL(tabUrl);
          return (
            u.hostname.toLowerCase() === explicit.hostname?.toLowerCase() ||
            u.hostname.toLowerCase().endsWith('.' + explicit.hostname?.toLowerCase())
          );
        } catch {
          return false;
        }
      });

      if (matchedTab) {
        return {
          selectedTab: matchedTab,
          discoveredTabs,
          reason: `Matched explicit hostname in task: ${explicit.hostname}`,
        };
      }
    }
  }

  // 2. Otherwise: Use active eligible web tab (dynamic resolution, never forced to localhost:4173)
  const activeTab = eligibleTabs.find((t) => t.active);
  if (activeTab) {
    return {
      selectedTab: activeTab,
      discoveredTabs,
      reason: 'Selected active web tab.',
    };
  }

  // 3. Fallback: First eligible web tab (e.g. if focus was on extension or dashboard)
  return {
    selectedTab: eligibleTabs[0] || null,
    discoveredTabs,
    reason: 'Selected first eligible web tab.',
  };
}
