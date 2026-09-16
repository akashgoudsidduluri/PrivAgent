/**
 * PrivAgent — Web Discovery & Error Taxonomy Tests (Phases 13 & 14)
 */

import { describe, it, expect } from 'vitest';
import { planWebDiscovery, isConsequentialAction } from '../extension/src/agent/webDiscovery';
import { classifyError, ERROR_TAXONOMY } from '../extension/src/telemetry/errorTaxonomy';

describe('PrivAgent Web Discovery & Error Taxonomy Suite', () => {
  describe('Web Discovery Foundation (Phase 13)', () => {
    it('plans direct banking discovery when banking terms are detected', () => {
      const plan = planWebDiscovery('Open the localhost 4173 and get my account number');
      expect(plan.category).toBe('DIRECT_BANKING');
      expect(plan.destinationUrl).toBe('http://localhost:4173');
      expect(plan.requiresGatedConfirmation).toBe(false);
    });

    it('plans e-commerce discovery for product queries and identifies consequential purchases', () => {
      const plan = planWebDiscovery('Find beige baggy pants under ₹1500');
      expect(plan.category).toBe('ECOMMERCE_DISCOVERY');
      expect(plan.destinationUrl).toBe('https://duckduckgo.com');
      expect(plan.searchQuery).toBe('Find beige baggy pants under ₹1500');
    });

    it('flags consequential actions (buy, pay, order) as requiring user confirmation', () => {
      expect(isConsequentialAction('click', 'Buy Now')).toBe(true);
      expect(isConsequentialAction('click', 'Confirm Payment')).toBe(true);
      expect(isConsequentialAction('click', 'Place Order')).toBe(true);
      expect(isConsequentialAction('click', 'Account Overview')).toBe(false);
      expect(isConsequentialAction('scroll', 'Scroll down')).toBe(false);
    });
  });

  describe('Error Taxonomy (Phase 14)', () => {
    it('classifies extension context invalidation as non-retryable with safe explanation', () => {
      const def = classifyError('Uncaught Error: Extension context invalidated.');
      expect(def.code).toBe('EXTENSION_CONTEXT_INVALIDATED');
      expect(def.retryable).toBe(false);
      expect(def.userFacingMessage).toMatch(/Extension context was invalidated/i);
      expect(def.telemetryCategory).toBe('EXTENSION_LIFECYCLE');
    });

    it('classifies HTTP 429 rate limit as strictly non-retryable', () => {
      const def = classifyError('Backend agent endpoint failed: HTTP 503: OpenRouter rate limit reached (HTTP 429)');
      expect(def.code).toBe('LLM_RATE_LIMIT');
      expect(def.retryable).toBe(false);
      expect(def.userFacingMessage).toMatch(/rate limit reached/i);
    });

    it('classifies missing target web tab with explicit guidance', () => {
      const def = classifyError('No target web tab found. Please open http://localhost:4173 in another tab.');
      expect(def.code).toBe('TARGET_TAB_NOT_FOUND');
      expect(def.retryable).toBe(false);
    });

    it('classifies action validation rejection safely', () => {
      const def = classifyError('Validator rejected action repeatedly: Target element not found');
      expect(def.code).toBe('INVALID_BROWSER_ACTION');
      expect(def.retryable).toBe(false);
    });

    it('classifies user aborts as STOPPED', () => {
      const def = classifyError('Task ABORT by user');
      expect(def.code).toBe('USER_STOPPED');
      expect(def.defaultTerminalStatus).toBe('STOPPED');
    });
  });
});
