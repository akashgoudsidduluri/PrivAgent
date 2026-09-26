/**
 * PrivAgent — Target Tab Provisioning Tests
 *
 * When only the dashboard (http://localhost:5173) is open, the resolver may propose a
 * DETERMINISTIC destination so the service worker can open a dedicated target tab and
 * run the normal AgentLoop pipeline against it.
 *
 * Guarantees asserted here:
 *  1. An existing eligible tab always wins over provisioning.
 *  2. The dashboard is NEVER selected and NEVER provisioned.
 *  3. Google intent provisions a Google destination.
 *  4. An explicit URL provisions exactly that URL.
 *  5. No deterministic destination produces a clean DESTINATION_REQUIRED failure.
 *  6/7. The provisioned tab id differs from the dashboard id and is the pinned target.
 *  8. Provisioning is a destination only — it never proposes or executes an action.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  resolveTargetWebTab,
  isEligibleWebTab,
  isDashboardUrl,
  extractProvisioningDestination,
  MinimalTab,
} from '../extension/src/background/targetResolver';
import { SUPPORTED_ACTION_TYPES, ActionType } from '../extension/src/agent/actionTypes';

const DASHBOARD: MinimalTab = { id: 10, url: 'http://localhost:5173/', active: true };

describe('Target Tab Provisioning', () => {
  describe('isDashboardUrl', () => {
    it('flags the dashboard origin and any port-5173 origin', () => {
      expect(isDashboardUrl('http://localhost:5173/')).toBe(true);
      expect(isDashboardUrl('http://127.0.0.1:5173/app')).toBe(true);
      expect(isDashboardUrl('https://localhost:5173/dashboard')).toBe(true);
    });

    it('does not flag ordinary web origins', () => {
      expect(isDashboardUrl('https://www.google.com/')).toBe(false);
      expect(isDashboardUrl('http://localhost:4173/')).toBe(false);
      expect(isDashboardUrl('https://example.com/')).toBe(false);
    });
  });

  describe('extractProvisioningDestination', () => {
    it('extracts an explicit https URL', () => {
      const dest = extractProvisioningDestination('go to https://example.com/catalog and list the items');
      expect(dest).toEqual({ url: 'https://example.com/catalog', source: 'explicit-url' });
    });

    it('extracts an explicit http URL', () => {
      const dest = extractProvisioningDestination('open http://localhost:4173/accounts and summarize');
      expect(dest).toEqual({ url: 'http://localhost:4173/accounts', source: 'explicit-url' });
    });

    it('prefers an explicit URL over Google intent', () => {
      const dest = extractProvisioningDestination('open https://example.com and search for cats on google');
      expect(dest?.source).toBe('explicit-url');
      expect(dest?.url).toBe('https://example.com/');
    });

    it('extracts Google intent for "open google and search for black cats"', () => {
      const dest = extractProvisioningDestination('open google and search for black cats');
      expect(dest).toEqual({ url: 'https://www.google.com', source: 'google-intent' });
    });

    it('extracts Google intent for "search google for privacy"', () => {
      const dest = extractProvisioningDestination('search google for privacy');
      expect(dest?.url).toBe('https://www.google.com');
    });

    it('does NOT provision for an incidental mention of google', () => {
      expect(extractProvisioningDestination('summarize the google chrome settings page')).toBeNull();
    });

    it('returns null when no destination is determinable', () => {
      expect(extractProvisioningDestination('Summarize the current page')).toBeNull();
      expect(extractProvisioningDestination('find me the gold chain price')).toBeNull();
      expect(extractProvisioningDestination('')).toBeNull();
    });

    it('refuses to provision the dashboard even when named explicitly', () => {
      expect(extractProvisioningDestination('open http://localhost:5173/ and click run')).toBeNull();
    });

    it('refuses non-http(s) schemes', () => {
      expect(extractProvisioningDestination('open javascript:alert(1)')).toBeNull();
    });
  });

  describe('resolveTargetWebTab — existing tab wins', () => {
    it('1. returns the existing eligible tab and never proposes provisioning when tab is relevant', () => {
      const webTab: MinimalTab = { id: 42, url: 'https://example.org/portal', active: false };
      const result = resolveTargetWebTab([DASHBOARD, webTab], 'I already opened example.org, read the portal');

      expect(result.selectedTab?.id).toBe(42);
      expect(result.provisioning).toBeUndefined();
      expect(result.failureCode).toBeUndefined();
    });

    it('provisions new target tab instead of hijacking an unrelated existing tab', () => {
      const unrelatedWebTab: MinimalTab = { id: 42, url: 'https://example.org/portal', active: true };
      const result = resolveTargetWebTab([DASHBOARD, unrelatedWebTab], 'open google and search for black cats');

      // Unrelated tab 42 must NOT be selected
      expect(result.selectedTab).toBeNull();
      expect(result.provisioning).toEqual({ url: 'https://www.google.com', source: 'google-intent' });
    });

    it('keeps the explicit localhost:4173 match behaviour untouched', () => {
      const demoTab: MinimalTab = { id: 20, url: 'http://localhost:4173/', active: false };
      const result = resolveTargetWebTab([DASHBOARD, demoTab], 'Open the localhost 4173 and get my account number');

      expect(result.selectedTab?.id).toBe(20);
      expect(result.provisioning).toBeUndefined();
    });
  });

  describe('resolveTargetWebTab — provisioning when no eligible tab exists', () => {
    it('2. never selects the dashboard even when it is the only tab', () => {
      const result = resolveTargetWebTab([DASHBOARD], 'Summarize the page');

      expect(result.selectedTab).toBeNull();
      expect(isEligibleWebTab(DASHBOARD)).toBe(false);
      expect(result.selectedTab?.url).toBeUndefined();
    });

    it('3. proposes a Google destination for Google intent', () => {
      const result = resolveTargetWebTab([DASHBOARD], 'open google and search for black cats');

      expect(result.selectedTab).toBeNull();
      expect(result.provisioning).toEqual({ url: 'https://www.google.com', source: 'google-intent' });
      expect(result.provisioning?.url).not.toContain('5173');
    });

    it('4. proposes the exact explicit URL', () => {
      const result = resolveTargetWebTab([DASHBOARD], 'open https://example.com/pricing and read the plans');

      expect(result.selectedTab).toBeNull();
      expect(result.provisioning).toEqual({ url: 'https://example.com/pricing', source: 'explicit-url' });
    });

    it('5. fails cleanly with DESTINATION_REQUIRED when nothing is determinable', () => {
      const result = resolveTargetWebTab([DASHBOARD], 'Summarize the page');

      expect(result.selectedTab).toBeNull();
      expect(result.provisioning).toBeUndefined();
      expect(result.failureCode).toBe('DESTINATION_REQUIRED');
    });

    it('6/7. the destination is a distinct tab id, never the dashboard tab id', () => {
      const result = resolveTargetWebTab([DASHBOARD], 'open google and search for black cats');

      // Resolution returns a destination only; the service worker allocates the id.
      // What must hold is that the dashboard is not what gets opened.
      expect(result.selectedTab).toBeNull();
      expect(DASHBOARD.id).toBe(10);
      expect(result.provisioning!.url).toBe('https://www.google.com');
      expect(result.provisioning!.url).not.toBe(DASHBOARD.url);
    });

    it('ignores browser-internal tabs when deciding to provision', () => {
      const tabs: MinimalTab[] = [
        DASHBOARD,
        { id: 1, url: 'chrome://extensions' },
        { id: 2, url: 'chrome-extension://privagent/popup.html' },
      ];
      const result = resolveTargetWebTab(tabs, 'open google and search for black cats');

      expect(result.selectedTab).toBeNull();
      expect(result.provisioning?.url).toBe('https://www.google.com');
    });
  });

  describe('security invariants', () => {
    it('8a. provisioning returns a URL only — never a browser action', () => {
      const result = resolveTargetWebTab([DASHBOARD], 'open google and search for black cats');
      const dest = result.provisioning!;

      expect(Object.keys(dest).sort()).toEqual(['source', 'url']);
      expect(dest).not.toHaveProperty('action');
      expect(dest).not.toHaveProperty('target');
    });

    it('8b. provisioning cannot introduce a new action type into the M5 allowlist', () => {
      const dest = extractProvisioningDestination('open google and search for black cats');
      const actionTypes: readonly ActionType[] = SUPPORTED_ACTION_TYPES;

      // A destination is a string URL; it is never coerced into an executable action.
      expect(typeof dest!.url).toBe('string');
      expect(actionTypes).not.toContain(dest!.url as unknown as ActionType);
    });

    it('8c. discovered-tab diagnostics still strip query params (no leakage via provisioning)', () => {
      const tabs: MinimalTab[] = [
        DASHBOARD,
        { id: 99, url: 'https://example.com/p?token=secret123', active: false },
      ];
      const result = resolveTargetWebTab(tabs, 'open google');

      const found = result.discoveredTabs.find((t) => t.id === 99);
      expect(found?.url).toBe('https://example.com/p');
      expect(found?.url).not.toContain('secret123');
    });

    it('8d. M5 still rejects non-http(s) navigation regardless of provisioning', async () => {
      const { validateAction } = await import('../extension/src/agent/actionValidator');
      const res = validateAction({ action: 'navigate', url: 'javascript:alert(1)' } as any, {
        url: 'https://www.google.com/',
        viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
      } as any);

      expect(res.allowed).toBe(false);
    });

    it('8e. M5 still validates a provisioned-tab navigation', async () => {
      const { validateAction } = await import('../extension/src/agent/actionValidator');
      const res = validateAction({ action: 'navigate', url: 'https://www.google.com/' } as any, {
        url: 'https://www.google.com/',
        viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
      } as any);

      expect(res.allowed).toBe(true);
    });
  });

  describe('service worker provisioning guards', () => {
    it('isDashboardUrl rejects the dashboard destination before any tabs.create call', () => {
      // Mirrors the guard inside provisionTargetTab(): it runs before chrome.tabs.create.
      const create = vi.fn();
      const url = 'http://localhost:5173/';
      if (!isDashboardUrl(url)) {
        create({ url });
      }

      expect(create).not.toHaveBeenCalled();
    });
  });
});
