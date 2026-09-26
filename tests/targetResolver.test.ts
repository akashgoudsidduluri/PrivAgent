import { describe, it, expect } from 'vitest';
import {
  extractExplicitTargetFromTask,
  isEligibleWebTab,
  resolveTargetWebTab,
  MinimalTab,
} from '../extension/src/background/targetResolver';

describe('targetResolver', () => {
  describe('extractExplicitTargetFromTask', () => {
    it('extracts "localhost 4173" from natural language', () => {
      const result = extractExplicitTargetFromTask('Open the localhost 4173 and get my account number');
      expect(result).toEqual({ hostname: 'localhost', port: '4173' });
    });

    it('extracts "localhost:4173"', () => {
      const result = extractExplicitTargetFromTask('Please check localhost:4173/dashboard');
      expect(result).toEqual({ hostname: 'localhost', port: '4173' });
    });

    it('extracts full URL "http://localhost:4173/"', () => {
      const result = extractExplicitTargetFromTask('Navigate to http://localhost:4173/ and log in');
      expect(result).toEqual({ hostname: 'localhost', port: '4173' });
    });

    it('extracts "127.0.0.1 4173"', () => {
      const result = extractExplicitTargetFromTask('Go to 127.0.0.1 4173');
      expect(result).toEqual({ hostname: '127.0.0.1', port: '4173' });
    });

    it('returns null for generic tasks without targets', () => {
      const result = extractExplicitTargetFromTask('Summarize this page');
      expect(result).toBeNull();
    });
  });

  describe('isEligibleWebTab', () => {
    it('excludes dashboard tab (http://localhost:5173)', () => {
      const tab: MinimalTab = { id: 1, url: 'http://localhost:5173/' };
      expect(isEligibleWebTab(tab)).toBe(false);
    });

    it('excludes dashboard tab on 127.0.0.1:5173', () => {
      const tab: MinimalTab = { id: 1, url: 'http://127.0.0.1:5173/app' };
      expect(isEligibleWebTab(tab)).toBe(false);
    });

    it('excludes browser privileged schemes (chrome://, devtools://, about:)', () => {
      expect(isEligibleWebTab({ id: 1, url: 'chrome://extensions' })).toBe(false);
      expect(isEligibleWebTab({ id: 2, url: 'devtools://devtools/bundled/inspector.html' })).toBe(false);
      expect(isEligibleWebTab({ id: 3, url: 'about:blank' })).toBe(false);
      expect(isEligibleWebTab({ id: 4, url: 'chrome-extension://abcdef/popup.html' })).toBe(false);
    });

    it('allows valid web tabs', () => {
      expect(isEligibleWebTab({ id: 1, url: 'http://localhost:4173' })).toBe(true);
      expect(isEligibleWebTab({ id: 2, url: 'http://localhost:4173/' })).toBe(true);
      expect(isEligibleWebTab({ id: 3, url: 'https://example.com' })).toBe(true);
    });
  });

  describe('resolveTargetWebTab', () => {
    const dashboardTab: MinimalTab = { id: 10, url: 'http://localhost:5173/', active: true };
    const demoTab: MinimalTab = { id: 20, url: 'http://localhost:4173/', active: false };
    const unrelatedPortTab: MinimalTab = { id: 30, url: 'http://localhost:3000/', active: false };
    const webTab: MinimalTab = { id: 40, url: 'https://example.org/portal', active: false };
    const activeWebTab: MinimalTab = { id: 50, url: 'https://news.ycombinator.com', active: true };

    it('resolves localhost:4173 exact match when task mentions localhost 4173', () => {
      const tabs = [dashboardTab, demoTab];
      const result = resolveTargetWebTab(tabs, 'Open the localhost 4173 and get my account number');

      expect(result.selectedTab?.id).toBe(20);
      expect(result.selectedTab?.url).toBe('http://localhost:4173/');
    });

    it('resolves localhost:4173/ match with trailing slash or subpaths', () => {
      const tabs = [dashboardTab, { id: 22, url: 'http://localhost:4173/accounts/summary', active: false }];
      const result = resolveTargetWebTab(tabs, 'Open localhost:4173 and find my balance');

      expect(result.selectedTab?.id).toBe(22);
    });

    it('strictly excludes dashboard localhost:5173 even if it is the only active tab', () => {
      const tabs = [dashboardTab];
      const result = resolveTargetWebTab(tabs, 'Summarize the page');

      expect(result.selectedTab).toBeNull();
      expect(result.reason).toContain('No browser tab is available for this task');
    });

    it('excludes unrelated localhost port when task explicitly requests 4173', () => {
      const tabs = [dashboardTab, unrelatedPortTab];
      const result = resolveTargetWebTab(tabs, 'Open the localhost 4173 and get my account number');

      // Port 3000 MUST NOT be chosen when 4173 was explicitly requested
      expect(result.selectedTab).toBeNull();
      expect(result.reason).toContain('4173');
    });

    it('falls back to active eligible web tab when task does not specify explicit target', () => {
      const tabs = [
        { id: 10, url: 'http://localhost:5173/', active: false }, // dashboard
        activeWebTab, // active news tab
        webTab,       // inactive web tab
      ];
      const result = resolveTargetWebTab(tabs, 'Click the login button');

      expect(result.selectedTab?.id).toBe(50);
      expect(result.selectedTab?.url).toBe('https://news.ycombinator.com');
    });

    it('does NOT force localhost:4173 when an active web tab is present for generic tasks', () => {
      const tabs = [dashboardTab, demoTab, activeWebTab];
      const result = resolveTargetWebTab(tabs, 'find me the gold chain price');

      // Must select the active web tab, NOT forced to demoTab
      expect(result.selectedTab?.id).toBe(50);
      expect(result.selectedTab?.url).toBe('https://news.ycombinator.com');
    });

    it('returns honest failure with generic message when no eligible tab exists', () => {
      const tabs = [
        { id: 1, url: 'chrome://extensions' },
        { id: 2, url: 'chrome-extension://privagent/popup.html' },
        { id: 10, url: 'http://localhost:5173/' },
      ];
      const result = resolveTargetWebTab(tabs, 'find me the gold chain price');

      expect(result.selectedTab).toBeNull();
      expect(result.reason).toContain('No browser tab is available for this task');
    });

    it('diagnostics never expose PII or query params', () => {
      const tabs = [
        dashboardTab,
        { id: 99, url: 'http://localhost:4173/profile?token=secret123&account=99998888', active: false },
      ];
      const result = resolveTargetWebTab(tabs, 'Open localhost 4173');

      expect(result.selectedTab?.id).toBe(99);
      // Discovered tab urls must not include query params
      const tab99 = result.discoveredTabs.find((t) => t.id === 99);
      expect(tab99?.url).toBe('http://localhost:4173/profile');
      expect(tab99?.url).not.toContain('secret123');
      expect(tab99?.url).not.toContain('99998888');
    });

    it('Case A: does NOT hijack unrelated user tab when task asks to open Google; provisions dedicated Google tab', () => {
      const unrelatedGitHubTab: MinimalTab = {
        id: 77,
        url: 'https://github.com/my-org/private-repo',
        title: 'private-repo: Pull Requests',
        active: true,
      };
      const tabs = [dashboardTab, unrelatedGitHubTab];

      const result = resolveTargetWebTab(tabs, 'open google and search for cats', 'http://localhost:5173', 10);

      // Unrelated tab MUST NOT be selected
      expect(result.selectedTab).toBeNull();
      // Must provision dedicated Google tab
      expect(result.provisioning).toBeDefined();
      expect(result.provisioning?.url).toBe('https://www.google.com');
      expect(result.reason).toContain('google');
    });

    it('Case B: reuses existing Flipkart tab without creating a new tab or touching unrelated user tab', () => {
      const flipkartTab: MinimalTab = {
        id: 88,
        url: 'https://www.flipkart.com/account/orders',
        title: 'Flipkart - Online Shopping',
        active: false,
      };
      const unrelatedDocsTab: MinimalTab = {
        id: 99,
        url: 'https://docs.google.com/document/d/12345/edit',
        title: 'Quarterly Report - Google Docs',
        active: true,
      };
      const tabs = [dashboardTab, flipkartTab, unrelatedDocsTab];

      const result = resolveTargetWebTab(tabs, 'I already opened flipkart.com, perform login', 'http://localhost:5173', 10);

      // Flipkart tab MUST be selected
      expect(result.selectedTab?.id).toBe(88);
      expect(result.selectedTab?.url).toContain('flipkart.com');
      // No provisioning should take place
      expect(result.provisioning).toBeUndefined();
    });

    it('Case C: fails honestly with DESTINATION_REQUIRED when user claims site was already opened but no matching tab exists', () => {
      const unrelatedTab: MinimalTab = {
        id: 77,
        url: 'https://news.ycombinator.com',
        title: 'Hacker News',
        active: true,
      };
      const tabs = [dashboardTab, unrelatedTab];

      const result = resolveTargetWebTab(tabs, 'I already opened flipkart.com, perform login', 'http://localhost:5173', 10);

      // Must NOT select unrelated tab
      expect(result.selectedTab).toBeNull();
      // Must NOT provision a tab when user asserted it was already open
      expect(result.provisioning).toBeUndefined();
      expect(result.failureCode).toBe('DESTINATION_REQUIRED');
      expect(result.reason).toContain('flipkart.com');
    });

    it('strictly excludes dashboard tab by numeric dashboardTabId regardless of URL', () => {
      const maskedDashboardTab: MinimalTab = {
        id: 10,
        url: 'https://custom-domain.internal/dashboard',
        active: true,
      };
      const tabs = [maskedDashboardTab];

      expect(isEligibleWebTab(maskedDashboardTab, 'http://localhost:5173', 10)).toBe(false);

      const result = resolveTargetWebTab(tabs, 'click something', 'http://localhost:5173', 10);
      expect(result.selectedTab).toBeNull();
    });
  });
});

