/**
 * PHASE 18.6 (I-4) — SEARCH / DESTINATION CAPABILITY.
 *
 * PrivAgent was quietly Google-centric in five separate places:
 *   goalParser.extractTargetSite()            "google" in task -> https://www.google.com
 *   targetResolver.buildProvisioningDestinationUrl()
 *                                               "google" -> google.com; ELSE -> https://www.<name>.com
 *   targetResolver.extractProvisioningDestination()
 *                                               /\bgoogle\b/ -> provisions a Google tab
 *   taskDecomposer.isAlreadyOnSearchPage       google|bing|duckduckgo substring test
 *   webDiscovery.planWebDiscovery()            always https://duckduckgo.com
 *   pageClassifier                              google.|bing.|duckduckgo.
 *
 * These tests pin the property that a brand swap would NOT restore:
 *
 *   NO BRAND IS PRIVILEGED, AND NO DESTINATION IS EVER INVENTED.
 *
 * The mutation they are written to catch is reintroducing either the
 * hand-written Google branch or the `https://www.<name>.com` fabrication.
 */
import { describe, it, expect } from 'vitest';
import {
  canonicalizeSiteOrigin,
  isKnownSearchPortalAlias,
  isSearchSurfaceUrl,
  observedSearchQuery,
  resolveSearchEntryPoint,
} from '../extension/src/planning/searchCapability';
import { extractTargetSite } from '../extension/src/agent/goalParser';
import { extractProvisioningDestination, buildProvisioningDestinationUrl } from '../extension/src/background/targetResolver';
import { planWebDiscovery } from '../extension/src/agent/webDiscovery';

describe('I-4 — no brand is privileged', () => {
  // A brand swap would fail this: each alias must resolve through the SAME path.
  it.each([
    ['google', 'https://www.google.com'],
    ['bing', 'https://www.bing.com'],
    ['duckduckgo', 'https://duckduckgo.com'],
    ['wikipedia', 'https://en.wikipedia.org'],
  ])('resolves the %s alias through the shared registry', (alias, origin) => {
    expect(canonicalizeSiteOrigin(alias)).toBe(origin);
    expect(isKnownSearchPortalAlias(alias)).toBe(true);
  });

  it('treats every alias identically in the provisioning path, not just Google', () => {
    // Each of these must provision through the SAME branch. A hand-written
    // Google special case plus a generic fallback cannot produce this.
    for (const [alias, origin] of [
      ['google', 'https://www.google.com'],
      ['bing', 'https://www.bing.com'],
      ['duckduckgo', 'https://duckduckgo.com'],
      ['wikipedia', 'https://en.wikipedia.org'],
    ] as const) {
      const dest = extractProvisioningDestination(`open ${alias} and search for cats`);
      expect(dest, `alias ${alias}`).toEqual({ url: origin, source: 'declared-portal-intent' });
    }
  });
});

describe('I-4 — no destination is ever invented', () => {
  // THE CORE DEFECT. `https://www.<name>.com` manufactured an origin for any
  // word the user typed. An invented destination is indistinguishable downstream
  // from a user-declared one, so it silently satisfied the Security Critic's
  // "destination is implied by the goal" check while being untrue.
  it.each([
    'notrealportal',
    'totallymadeupshop',
    'somefictionalbank',
  ])('returns NO origin for the unregistered name %s', (name) => {
    expect(canonicalizeSiteOrigin(name)).toBeUndefined();
    expect(isKnownSearchPortalAlias(name)).toBe(false);
  });

  it.each([
    'ecosia',
    'brave',
    'yahoo',
    'startpage',
    'mojeek',
    'qwant',
  ])('has no hidden secondary list: the real engine %s is still unknown', (name) => {
    // These are real search engines that are deliberately NOT in the registry.
    // If any other hard-coded list still existed behind the registry — the shape
    // a "brand swap" fix would leave behind — these would resolve. Proving they
    // do not is what makes the registry the single source of truth, rather than
    // the newest of several parallel lists.
    expect(canonicalizeSiteOrigin(name)).toBeUndefined();
    expect(isKnownSearchPortalAlias(name)).toBe(false);
    expect(extractProvisioningDestination(`open ${name} and search for cats`)).toBeNull();
  });

  it('provisions nothing rather than fabricating www.<name>.com', () => {
    expect(extractProvisioningDestination('open notrealportal and search for cats')).toBeNull();
  });

  it('builds no provisioning destination from an unregistered bare site name', () => {
    expect(buildProvisioningDestinationUrl({ siteName: 'notrealportal' } as never)).toBe('');
  });

  it('never invents a search destination for an informational or commerce task', () => {
    expect(planWebDiscovery('tell me about the history of Charminar').destinationUrl).toBeUndefined();
    expect(planWebDiscovery('buy a blue shirt').destinationUrl).toBeUndefined();
  });

  it('requires a nav verb before provisioning a registry alias', () => {
    // "google" mentioned incidentally must not silently redirect anywhere.
    expect(extractProvisioningDestination('read the google chrome settings page')).toBeNull();
  });
});

describe('I-4 — search-surface detection is engine-agnostic', () => {
  it.each([
    'https://www.google.com/search?q=charminar',
    'https://www.bing.com/search?q=charminar',
    'https://duckduckgo.com/?q=charminar',
    'https://search.example.org/webhp?query=charminar',
    'https://some-unlisted-engine.test/find?text=charminar',
  ])('recognises an OBSERVED query on %s', (url) => {
    // The last two are deliberately NOT in any registry. Detection must come
    // from the observed structure of the URL, not from a vendor list, or an
    // unlisted engine is invisible to the planner.
    expect(isSearchSurfaceUrl(url)).toBe(true);
    expect(observedSearchQuery(url)).toBe('charminar');
  });

  it('does not treat a portal home page with no query as an observed search', () => {
    // A home page is a place you can SEARCH, not a search that happened.
    expect(observedSearchQuery('https://www.google.com/')).toBe('');
    expect(observedSearchQuery('https://www.google.com/search')).toBe('');
    expect(observedSearchQuery('https://duckduckgo.com/')).toBe('');
  });

  it('ignores incidental tracking parameters as if they were a query', () => {
    // Only a recognised query parameter name counts, so `?utm_source=` cannot
    // masquerade as an observed search result.
    expect(observedSearchQuery('https://duckduckgo.com/?utm_source=newsletter')).toBe('');
    expect(observedSearchQuery('https://www.google.com/?ref=toolbar')).toBe('');
  });

  it('does not treat an ordinary page as a search surface', () => {
    for (const url of [
      'http://localhost:4174/results.html',
      'https://en.wikipedia.org/wiki/Charminar',
      'https://example.com/',
    ]) {
      expect(isSearchSurfaceUrl(url), url).toBe(false);
    }
  });

  it('prefers the CURRENT site and declines to assume an entry point', () => {
    // Already on a search surface -> use it. Otherwise FAIL CLOSED rather than
    // defaulting to some brand's homepage.
    expect(resolveSearchEntryPoint('https://duckduckgo.com/?q=charminar').origin).toBe(
      'https://duckduckgo.com/?q=charminar'
    );
    expect(resolveSearchEntryPoint('https://en.wikipedia.org/wiki/Charminar').origin).toBeUndefined();
    expect(resolveSearchEntryPoint('').origin).toBeUndefined();
  });
});

describe('I-4 — user-provided destinations are still honoured', () => {
  it('honours a fully-qualified domain the user typed', () => {
    expect(canonicalizeSiteOrigin('example.org')).toBe('https://example.org');
  });

  it('honours an explicit URL in the task ahead of any alias', () => {
    expect(extractTargetSite('open https://example.com and search for cats')).toBe(
      'https://example.com'
    );
  });

  it('still resolves a named, registered site in the goal parser', () => {
    expect(extractTargetSite('Search google for cats')).toBe('https://www.google.com');
    expect(extractTargetSite('Search wikipedia for Charminar')).toBe('https://en.wikipedia.org');
  });
});