/**
 * PHASE 18.6 (I-4) — SEARCH / DESTINATION CAPABILITY ABSTRACTION.
 *
 * WHY THIS EXISTS
 *
 * PrivAgent was quietly Google-centric. Four separate production sites each
 * carried their own private knowledge of what "a search site" is:
 *
 *   goalParser.extractTargetSite()   "google" in the task  -> https://www.google.com
 *   targetResolver.buildProvisioningDestinationUrl()
 *                                    siteName "google"   -> https://www.google.com
 *                                    anything else       -> https://www.<name>.com   <-- FABRICATED
 *   taskDecomposer.isAlreadyOnSearchPage  google|bing|duckduckgo
 *   webDiscovery                     duckduckgo.com
 *   pageClassifier                   google.|bing.|duckduckgo.
 *
 * That is three distinct problems, and they must not be "fixed" by swapping one
 * brand for another:
 *
 *   1. BRAND PRIVILEGE. Google got a hand-written mapping the others did not.
 *   2. URL FABRICATION. `https://www.<name>.com` invents an origin for any
 *      word the user typed. Inventing a destination is the exact thing the
 *      destination declaration exists to prevent, and it silently bypasses the
 *      Security Critic's "destination is implied by the goal" check, because the
 *      system itself invented the destination.
 *   3. BRAND LIST DRIFT. A new engine silently stops being recognised, and the
 *      recognition logic is duplicated four times so the copies drift.
 *
 * THE FIX
 *
 * One capability module owns all of it, and it is deliberately FAIL CLOSED:
 *
 *   - `SEARCH_PORTAL_REGISTRY` is an explicit, data-driven alias table. It is
 *     symmetric — every entry is handled identically and none is special-cased.
 *   - `canonicalizeSiteOrigin()` NEVER fabricates. A bare word with no registry
 *     entry returns `undefined`, so the planner has to ask rather than guess.
 *   - `isSearchSurfaceUrl()` decides engine-agnostically, from the OBSERVED
 *     structure of the URL (a real query parameter on a non-root path), not
 *     from a list of hostnames.
 */

/**
 * Explicit alias -> canonical origin table.
 *
 * Symmetric by construction: adding an entry is the ONLY way a site becomes
 * known, every entry is treated identically, and there is no fallback that
 * synthesises an origin for an unlisted name. Deliberately small and explicit
 * rather than a broad guess, because a wrong destination is a privacy and
 * safety failure, not a cosmetic one.
 */
const SEARCH_PORTAL_REGISTRY: ReadonlyArray<readonly [string, string]> = [
  ['google', 'https://www.google.com'],
  ['bing', 'https://www.bing.com'],
  ['duckduckgo', 'https://duckduckgo.com'],
  ['ddg', 'https://duckduckgo.com'],
  ['wikipedia', 'https://en.wikipedia.org'],
  ['wiki', 'https://en.wikipedia.org'],
];

/** Query-string parameters that carry an OBSERVED search, across real engines. */
const SEARCH_QUERY_PARAMS: readonly string[] = ['q', 'query', 'search', 'search_query', 'wd', 'text'];

/** Hosts that are known search/knowledge portals but expose no query parameter. */
const SEARCH_PORTAL_HOSTS: readonly string[] = [
  'google.com',
  'www.google.com',
  'bing.com',
  'www.bing.com',
  'duckduckgo.com',
  'www.duckduckgo.com',
  'en.wikipedia.org',
];

const ALIAS_TO_ORIGIN: ReadonlyMap<string, string> = new Map(SEARCH_PORTAL_REGISTRY);

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Resolve a user-mentioned site alias to a canonical origin.
 *
 * Returns `undefined` for an unknown alias. It NEVER fabricates a URL: guessing
 * `https://www.<name>.com` was the core I-4 defect, because an invented
 * destination is indistinguishable from a user-declared one downstream.
 */
export function canonicalizeSiteOrigin(nameOrAlias: string): string | undefined {
  const key = nameOrAlias.trim().toLowerCase().replace(/^www\./, '');
  if (!key) return undefined;
  if (ALIAS_TO_ORIGIN.has(key)) return ALIAS_TO_ORIGIN.get(key);

  // An explicit, fully-qualified domain in the user's own words is a
  // user-provided destination, not a guess, so it may be canonicalised.
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(key)) {
    const url = parse(`https://${key}`);
    if (url && url.hostname === key) return url.origin;
  }
  return undefined;
}

/** True when `alias` is a known portal alias. Used to keep tests honest. */
export function isKnownSearchPortalAlias(alias: string): boolean {
  return ALIAS_TO_ORIGIN.has(alias.trim().toLowerCase());
}

/**
 * The observed search query in a results URL, or '' when there is none.
 *
 * Engine-agnostic: it reads whatever query parameter is actually present rather
 * than assuming a particular vendor's parameter name.
 */
export function observedSearchQuery(url: string): string {
  const parsed = parse(url);
  if (!parsed) return '';
  // No root-path special case: DuckDuckGo and others legitimately serve their
  // results from `/` with the query in the search string. Only the parameter
  // NAME decides this, so an incidental `?ref=` or `?utm_` cannot masquerade as
  // an observed search.
  for (const param of SEARCH_QUERY_PARAMS) {
    const value = (parsed.searchParams.get(param) || '').trim();
    if (value) return value;
  }
  return '';
}

/**
 * True when the current page is a surface on which a search can be PERFORMED.
 *
 * Deliberately structural, not a hostname list: a results page is a URL that
 * actually carries an observed query parameter on a non-root path. Portal home
 * pages are recognised through the registry only, so an unlisted engine is
 * still detected as a results page once it produces a query.
 */
export function isSearchSurfaceUrl(url: string): boolean {
  if (!url) return false;
  // 1. An OBSERVED query is a results page, whatever engine produced it.
  if (observedSearchQuery(url).length > 0) return true;

  const parsed = parse(url);
  if (!parsed) return false;

  // 2. Otherwise the page counts only if it is a PORTAL HOME page — somewhere a
  //    search can be performed. A deep content path on the same host is an
  //    ARTICLE, not a search surface: `en.wikipedia.org/wiki/Charminar` is a
  //    knowledge article and must not be classified as a search page.
  const path = parsed.pathname.toLowerCase();
  const isPortalHome = path === '/' || path === '/webhp' || path === '/home';
  if (!isPortalHome) return false;

  const host = parsed.hostname.toLowerCase();
  if (SEARCH_PORTAL_HOSTS.includes(host)) return true;
  for (const origin of ALIAS_TO_ORIGIN.values()) {
    const originUrl = parse(origin);
    if (originUrl && originUrl.hostname === host) return true;
  }
  return false;
}

/**
 * Whether the agent may proceed with a SEARCH subgoal from where it stands.
 *
 * Preferring the CURRENT site over any registry entry is what stops the system
 * from quietly redirecting a task to a search engine: if the user is already on
 * a search surface, the agent searches THERE. The registry is only consulted
 * when there is genuinely nothing to work with, and it returns undefined rather
 * than guessing.
 */
export function resolveSearchEntryPoint(currentUrl: string): {
  origin: string | undefined;
  reason: string;
} {
  if (isSearchSurfaceUrl(currentUrl)) {
    return { origin: currentUrl, reason: 'Current page already exposes a search surface' };
  }
  return {
    origin: undefined,
    reason:
      'No declared destination and the current page exposes no search surface; ' +
      'a search entry point must be declared rather than assumed',
  };
}