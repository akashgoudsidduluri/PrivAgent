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
 *  6. Target Tab Provisioning: when NO eligible tab exists, the resolver may propose a
 *     DETERMINISTIC destination for the service worker to open in a NEW dedicated tab.
 *     Provisioning is only ever a *destination* — it never proposes an action, never
 *     targets the dashboard, and never invents a website.
 */

export interface MinimalTab {
  id?: number;
  url?: string;
  active?: boolean;
  windowId?: number;
  title?: string;
}

/**
 * A deterministic destination the service worker may open in a NEW dedicated tab.
 * This is a URL only — it is never an action, so it cannot bypass the agent pipeline.
 */
export interface ProvisioningDestination {
  url: string;
  source: 'explicit-url' | 'google-intent';
}

export type TargetFailureCode = 'DESTINATION_REQUIRED';

export interface TargetResolutionResult {
  selectedTab: MinimalTab | null;
  discoveredTabs: Array<{ id?: number; origin?: string; url?: string }>;
  reason: string;
  /**
   * Present ONLY when no eligible tab exists AND a deterministic destination could be
   * extracted from the task. The service worker provisions a new tab for this URL.
   */
  provisioning?: ProvisioningDestination;
  /** Present ONLY when no eligible tab exists AND no deterministic destination exists. */
  failureCode?: TargetFailureCode;
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

const GOOGLE_ORIGIN = 'https://www.google.com';

/**
 * True when a URL points at the PrivAgent dashboard (or any port-5173 origin).
 * Provisioning MUST fail closed on these: the agent is never allowed to drive its
 * own control surface.
 */
export function isDashboardUrl(url: string, dashboardOrigin = 'http://localhost:5173'): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.port === '5173') return true;
  try {
    return parsed.origin === new URL(dashboardOrigin).origin;
  } catch {
    return false;
  }
}

/**
 * Extracts a DETERMINISTIC destination URL from task text for Target Tab Provisioning.
 * Zero LLM calls — pure regex inspection. Returns null when nothing can be
 * determined with certainty; the caller must then fail with DESTINATION_REQUIRED
 * rather than inventing a website.
 *
 * Supported (initial) cases:
 *  - an explicit http:// or https:// URL in the task
 *  - clear Google intent ("open google", "go to google and search ...")
 *
 * A destination is only produced for http/https origins and never for the dashboard.
 */
export function extractProvisioningDestination(
  task: string,
  dashboardOrigin = 'http://localhost:5173'
): ProvisioningDestination | null {
  if (!task) return null;

  // 1. Explicit http(s) URL — highest priority, and never the dashboard.
  const urlMatch = task.match(/https?:\/\/[^\s"'`)\]]+/i);
  if (urlMatch && urlMatch[0]) {
    const candidate = urlMatch[0];
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        if (isDashboardUrl(candidate, dashboardOrigin)) return null; // fail closed
        return { url: parsed.toString(), source: 'explicit-url' };
      }
    } catch {
      // fall through to intent detection
    }
  }

  // 2. Clear Google intent. Requires BOTH the site name and a navigation/search verb
  // so that incidental mentions (e.g. "the google chrome settings") never provision.
  const lower = task.toLowerCase();
  const mentionsGoogle = /\bgoogle\b/.test(lower);
  const hasNavVerb = /\b(open|opens|go|goes|visit|visits|navigate|navigates|launch|launches|search|searches|searching|browse|browses)\b/.test(
    lower
  );
  if (mentionsGoogle && hasNavVerb && !isDashboardUrl(GOOGLE_ORIGIN, dashboardOrigin)) {
    return { url: GOOGLE_ORIGIN, source: 'google-intent' };
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
    // No eligible tab: fall back to Target Tab Provisioning when — and only when —
    // a deterministic destination can be extracted from the task itself.
    const provisioning = extractProvisioningDestination(task, dashboardOrigin);
    if (provisioning) {
      return {
        selectedTab: null,
        discoveredTabs,
        reason: `No eligible web tab is open. Provisioning a dedicated target tab at ${provisioning.url} (${provisioning.source}).`,
        provisioning,
      };
    }
    return {
      selectedTab: null,
      discoveredTabs,
      reason: 'No browser tab is available for this task. Open the webpage you want PrivAgent to work with and try again.',
      failureCode: 'DESTINATION_REQUIRED',
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

/**
 * Verifies whether the specified targetTabId is currently open, valid, and responsive.
 */
export async function verifyTargetTabAlive(
  targetTabId: number,
  chromeTabsApi: any = typeof chrome !== 'undefined' ? chrome?.tabs : undefined
): Promise<{ alive: boolean; tab?: MinimalTab; reason: string }> {
  if (!chromeTabsApi) {
    return { alive: false, reason: 'Chrome tabs API unavailable' };
  }

  try {
    const tab = await chromeTabsApi.get(targetTabId);
    if (!tab) {
      return { alive: false, reason: `Target tab ${targetTabId} not found` };
    }
    return { alive: true, tab, reason: `Target tab ${targetTabId} verified alive` };
  } catch (err: any) {
    return { alive: false, reason: `Target tab ${targetTabId} inaccessible: ${err?.message || 'closed'}` };
  }
}

