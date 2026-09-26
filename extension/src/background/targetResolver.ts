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
export function isEligibleWebTab(
  tab: MinimalTab,
  dashboardOrigin = 'http://localhost:5173',
  dashboardTabId?: number
): boolean {
  if (!tab.id) return false;
  if (typeof dashboardTabId === 'number' && tab.id === dashboardTabId) {
    return false;
  }
  const urlToTest = tab.url || (tab as any).pendingUrl;
  if (!urlToTest) return false;

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

export interface TaskTargetReference {
  rawTarget: string;
  hostname?: string;
  port?: string;
  siteName?: string;
  fullUrl?: string;
  isOpenIntent: boolean;
  isAlreadyOpenedIntent: boolean;
}

const COMMON_TLDS = new Set([
  'com', 'org', 'net', 'in', 'io', 'co', 'ai', 'dev', 'app', 'edu', 'gov',
  'uk', 'ca', 'de', 'jp', 'fr', 'au', 'ru', 'ch', 'it', 'nl', 'se', 'no', 'es', 'mil'
]);

/**
 * Parses generic target references from task text locally and deterministically.
 * Supports explicit URLs, domain names, localhost ports, and open/visit/already-opened intents.
 * Zero hardcoding of specific websites.
 */
export function parseTaskTargetReference(task: string): TaskTargetReference | null {
  if (!task) return null;
  const text = task.trim();
  const lower = text.toLowerCase();

  const isAlreadyOpenedIntent = /\b(already\s+(?:opened|open)|have\s+opened|opened)\b/i.test(lower);
  const isOpenIntent =
    !isAlreadyOpenedIntent &&
    /\b(open|opens|go\s+to|goto|visit|visits|navigate(?:\s+to)?|launch|launches|browse|browses)\b/i.test(lower);

  // 1. Explicit http(s) URL
  const urlMatch = text.match(/https?:\/\/[^\s"'`)\]]+/i);
  if (urlMatch && urlMatch[0]) {
    try {
      const parsed = new URL(urlMatch[0]);
      const hostParts = parsed.hostname.split('.');
      const sitePart = hostParts[0] === 'www' && hostParts.length > 1 ? hostParts[1] : hostParts[0];
      return {
        rawTarget: urlMatch[0],
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        fullUrl: parsed.toString(),
        siteName: sitePart,
        isOpenIntent: true,
        isAlreadyOpenedIntent,
      };
    } catch {
      // fall through
    }
  }

  // 2. Localhost / IP + port
  const hostPortMatch = lower.match(/\b(localhost|127\.0\.0\.1):(\d+)\b/);
  if (hostPortMatch) {
    return {
      rawTarget: hostPortMatch[0],
      hostname: hostPortMatch[1],
      port: hostPortMatch[2],
      isOpenIntent: true,
      isAlreadyOpenedIntent,
    };
  }

  const spacePortMatch = lower.match(/\b(localhost|127\.0\.0\.1)(?:\s+(?:port\s+)?(\d+))\b/);
  if (spacePortMatch) {
    return {
      rawTarget: spacePortMatch[0],
      hostname: spacePortMatch[1],
      port: spacePortMatch[2],
      isOpenIntent: true,
      isAlreadyOpenedIntent,
    };
  }

  // 3. Domain reference (e.g. "flipkart.com", "google.com", "sub.domain.org")
  const domainMatch = lower.match(/\b([a-zA-Z0-9-]+\.(?:[a-zA-Z]{2,}))(?::(\d+))?\b/);
  if (domainMatch) {
    const candidateHost = domainMatch[1];
    const parts = candidateHost.split('.');
    const tld = parts[parts.length - 1];
    if (COMMON_TLDS.has(tld) || tld.length === 2 || parts.length >= 2) {
      const sitePart = parts[0] === 'www' && parts.length > 1 ? parts[1] : parts[0];
      return {
        rawTarget: candidateHost,
        hostname: candidateHost,
        port: domainMatch[2] || undefined,
        siteName: sitePart,
        isOpenIntent,
        isAlreadyOpenedIntent,
      };
    }
  }

  // 4. Open / visit verb followed by site name (e.g. "open google and search for cats", "go to flipkart")
  const openVerbMatch = lower.match(
    /\b(?:open|opens|go\s+to|goto|visit|visits|navigate(?:\s+to)?|launch|launches|browse|browses)\s+([a-zA-Z0-9-]+)(?:\.([a-zA-Z]{2,}))?\b/i
  );
  if (openVerbMatch && openVerbMatch[1]) {
    const rawName = openVerbMatch[1];
    const rawTld = openVerbMatch[2];
    const STOP_WORDS = new Set(['tab', 'the', 'a', 'an', 'this', 'that', 'page', 'new', 'browser', 'link', 'url', 'window']);
    if (!STOP_WORDS.has(rawName)) {
      if (rawTld) {
        return {
          rawTarget: `${rawName}.${rawTld}`,
          hostname: `${rawName}.${rawTld}`,
          siteName: rawName,
          isOpenIntent: true,
          isAlreadyOpenedIntent: false,
        };
      }
      return {
        rawTarget: rawName,
        siteName: rawName,
        isOpenIntent: true,
        isAlreadyOpenedIntent: false,
      };
    }
  }

  // 5. Preposition indicating site (e.g. "search for cats on google", "on flipkart find shirts")
  const prepMatch = lower.match(/\b(?:on|in|at)\s+([a-zA-Z0-9-]+)(?:\.([a-zA-Z]{2,}))?\b/i);
  if (prepMatch && prepMatch[1]) {
    const rawName = prepMatch[1];
    const rawTld = prepMatch[2];
    const STOP_WORDS = new Set(['the', 'a', 'an', 'this', 'that', 'page', 'tab', 'window', 'top', 'bottom', 'left', 'right', 'screen']);
    if (!STOP_WORDS.has(rawName)) {
      if (rawTld) {
        return {
          rawTarget: `${rawName}.${rawTld}`,
          hostname: `${rawName}.${rawTld}`,
          siteName: rawName,
          isOpenIntent: false,
          isAlreadyOpenedIntent: false,
        };
      }
      return {
        rawTarget: rawName,
        siteName: rawName,
        isOpenIntent: false,
        isAlreadyOpenedIntent: false,
      };
    }
  }

  return null;
}

/**
 * Checks whether an open tab matches a parsed target reference.
 */
export function doesTabMatchTarget(tab: MinimalTab, ref: TaskTargetReference): boolean {
  const urlStr = tab.url || (tab as any).pendingUrl;
  if (!urlStr) return false;

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return false;
  }

  // 1. Port match if port specified
  if (ref.port) {
    if (parsed.port !== ref.port) return false;
    if (ref.hostname) {
      const isLocalRef = ref.hostname === 'localhost' || ref.hostname === '127.0.0.1';
      const isLocalTab = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      if (isLocalRef && isLocalTab) return true;
      return (
        parsed.hostname.toLowerCase() === ref.hostname.toLowerCase() ||
        parsed.hostname.toLowerCase().endsWith('.' + ref.hostname.toLowerCase())
      );
    }
    return true;
  }

  // 2. Full URL match
  if (ref.fullUrl) {
    try {
      const refParsed = new URL(ref.fullUrl);
      if (
        parsed.hostname.toLowerCase() === refParsed.hostname.toLowerCase() ||
        parsed.hostname.toLowerCase().endsWith('.' + refParsed.hostname.toLowerCase()) ||
        refParsed.hostname.toLowerCase().endsWith('.' + parsed.hostname.toLowerCase())
      ) {
        return true;
      }
    } catch {
      // ignore
    }
  }

  // 3. Hostname match
  if (ref.hostname) {
    const tabHost = parsed.hostname.toLowerCase();
    const refHost = ref.hostname.toLowerCase();
    if (
      tabHost === refHost ||
      tabHost.endsWith('.' + refHost) ||
      refHost.endsWith('.' + tabHost)
    ) {
      return true;
    }
  }

  // 4. SiteName match (domain name or page title)
  if (ref.siteName) {
    const site = ref.siteName.toLowerCase();
    const tabHost = parsed.hostname.toLowerCase();
    if (tabHost.includes(site)) {
      return true;
    }
    if (tab.title && tab.title.toLowerCase().includes(site)) {
      return true;
    }
  }

  return false;
}

export function buildProvisioningDestinationUrl(ref: TaskTargetReference): string {
  if (ref.fullUrl) return ref.fullUrl;
  if (ref.hostname) {
    const protocol = (ref.hostname === 'localhost' || ref.hostname === '127.0.0.1') ? 'http:' : 'https:';
    return `${protocol}//${ref.hostname}${ref.port ? `:${ref.port}` : ''}`;
  }
  if (ref.siteName) {
    if (ref.siteName.toLowerCase() === 'google') {
      return 'https://www.google.com';
    }
    return `https://www.${ref.siteName.toLowerCase()}.com`;
  }
  return '';
}

/**
 * Resolve the target web tab from a list of open tabs.
 */
export function resolveTargetWebTab(
  tabs: MinimalTab[],
  task: string,
  dashboardOrigin = 'http://localhost:5173',
  dashboardTabId?: number
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

    if (isEligibleWebTab(t, dashboardOrigin, dashboardTabId)) {
      eligibleTabs.push(t);
    }
  }

  const targetRef = parseTaskTargetReference(task);

  // ── 1. Explicit target resolution from task ──────────────────────────────
  if (targetRef) {
    const matchingTabs = eligibleTabs.filter((t) => doesTabMatchTarget(t, targetRef));

    if (matchingTabs.length > 0) {
      // Active matching tab wins; otherwise first matching tab
      const activeMatch = matchingTabs.find((t) => t.active);
      const selected = activeMatch || matchingTabs[0];
      return {
        selectedTab: selected,
        discoveredTabs,
        reason: `Matched explicit target in task: ${targetRef.rawTarget}`,
      };
    }

    // No matching tab among open tabs:
    // If the task expresses OPEN / VISIT intent for a web target (not a local port) -> provision a dedicated new tab
    if (targetRef.isOpenIntent && !targetRef.port) {
      const destUrl = buildProvisioningDestinationUrl(targetRef);
      if (destUrl && !isDashboardUrl(destUrl, dashboardOrigin)) {
        return {
          selectedTab: null,
          discoveredTabs,
          reason: `Target tab for "${targetRef.rawTarget}" not found. Provisioning a dedicated target tab at ${destUrl}.`,
          provisioning: {
            url: destUrl,
            source: targetRef.fullUrl ? 'explicit-url' : 'google-intent',
          },
        };
      }
    }

    // If user stated the site was already open, or port was not found: fail honestly.
    // NEVER hijack or navigate an unrelated user tab!
    const notFoundReason = targetRef.port
      ? `No target web tab found. Please open http://${targetRef.hostname || 'localhost'}:${targetRef.port}.`
      : `Target tab for "${targetRef.rawTarget}" was not found among open tabs. Please open ${targetRef.rawTarget} and try again.`;

    return {
      selectedTab: null,
      discoveredTabs,
      reason: notFoundReason,
      failureCode: 'DESTINATION_REQUIRED',
    };
  }

  // ── 2. Generic tasks without target site reference ───────────────────────
  if (eligibleTabs.length === 0) {
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

  // Use active eligible web tab (dynamic resolution, never forced to localhost:4173)
  const activeTab = eligibleTabs.find((t) => t.active);
  if (activeTab) {
    return {
      selectedTab: activeTab,
      discoveredTabs,
      reason: 'Selected active web tab.',
    };
  }

  // Fallback: First eligible web tab
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


