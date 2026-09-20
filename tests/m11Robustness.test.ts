import { describe, it, expect, vi } from 'vitest';
import {
  createAgentTaskState,
  advancePageGeneration,
  FailureCategory,
  FailureRecord,
} from '../extension/src/agent/agentState';
import {
  isElementVisible,
  detectActiveModal,
  scanSameOriginIframes,
  scanInteractiveElements,
} from '../extension/src/content/domInteractiveScanner';
import { verifyTargetTabAlive } from '../extension/src/background/targetResolver';
import { checkActionIdempotency } from '../extension/src/agent/actionIdempotency';
import { runBoundedScrollDiscovery } from '../extension/src/agent/infiniteScrollScanner';

describe('PrivAgent M11 Browser Robustness Suite', () => {
  // ── 1. Failure Taxonomy & State Tracking ─────────────────────────────────
  describe('1. Failure Taxonomy & State Tracking', () => {
    it('should initialize clean agent state with empty failure history and null lastFailure', () => {
      const state = createAgentTaskState('Search for products');
      expect(state.lastFailure).toBeNull();
      expect(state.failureHistory).toEqual([]);
      expect(state.goalStatus).toBe('IN_PROGRESS');
    });

    it('should track structured FailureRecord with valid FailureCategory', () => {
      const state = createAgentTaskState('Test failure logging');
      const failure: FailureRecord = {
        category: 'TARGET_NOT_FOUND',
        reason: 'Element #btn-missing was not detected in live DOM',
        pageGeneration: state.currentPageGeneration,
        attemptedAction: { action: 'click', target: 'btn-missing', reason: 'Attempted click' },
        recoveryAttempted: true,
        finalState: 'IN_PROGRESS',
        timestamp: Date.now(),
      };

      state.lastFailure = failure;
      state.failureHistory = state.failureHistory || [];
      state.failureHistory.push(failure);

      expect(state.lastFailure?.category).toBe('TARGET_NOT_FOUND');
      expect(state.failureHistory).toHaveLength(1);
      expect(state.failureHistory?.[0]?.recoveryAttempted).toBe(true);
    });
  });

  // ── 2. Visibility & Interactivity Filtering ──────────────────────────────
  describe('2. Disabled and Invisible Element Filtering', () => {
    it('should reject elements with disabled attribute', () => {
      const btn = document.createElement('button');
      btn.setAttribute('disabled', 'true');
      document.body.appendChild(btn);

      expect(isElementVisible(btn)).toBe(false);
      btn.remove();
    });

    it('should reject elements with aria-disabled="true"', () => {
      const btn = document.createElement('button');
      btn.setAttribute('aria-disabled', 'true');
      document.body.appendChild(btn);

      expect(isElementVisible(btn)).toBe(false);
      btn.remove();
    });
  });

  // ── 3. Active Modal & Cookie Banner Detection ────────────────────────────
  describe('3. Modal & Popup Detection', () => {
    it('should detect open dialog or cookie banner', () => {
      const banner = document.createElement('div');
      banner.id = 'cookie-consent';
      banner.innerHTML = '<span class="title">Cookie Policy</span><button id="btn-accept">Accept</button>';
      document.body.appendChild(banner);

      const modal = detectActiveModal(document);
      expect(modal).not.toBeNull();
      expect(modal?.selector).toBe('#cookie-consent');
      expect(modal?.label).toContain('Cookie Policy');

      banner.remove();
    });

    it('should return null when no modal is active', () => {
      const modal = detectActiveModal(document);
      expect(modal).toBeNull();
    });
  });

  // ── 4. Iframe Safety Boundary ────────────────────────────────────────────
  describe('4. Iframe Handling Boundary', () => {
    it('should safely catch cross-origin or inaccessible iframe errors without crashing', () => {
      const iframe = document.createElement('iframe');
      Object.defineProperty(iframe, 'contentDocument', {
        get() {
          throw new DOMException('Blocked a frame with origin from accessing a cross-origin frame.', 'SecurityError');
        },
      });
      document.body.appendChild(iframe);

      const results = scanSameOriginIframes(document);
      expect(Array.isArray(results)).toBe(true);

      iframe.remove();
    });
  });

  // ── 5. Large DOM Perception & Context Bounds ─────────────────────────────
  describe('5. Large DOM Bounded Context & Label Disambiguation', () => {
    it('should bound interactive elements to maximum 40 items and disambiguate duplicate labels', () => {
      const container = document.createElement('div');
      for (let i = 1; i <= 60; i++) {
        const card = document.createElement('div');
        card.className = 'product-card';
        card.innerHTML = `<h3 class="product-title">Item ${i}</h3><button class="btn-buy" id="btn-${i}">Add to Cart</button>`;
        container.appendChild(card);
      }
      document.body.appendChild(container);

      const understanding = scanInteractiveElements(document);
      expect(understanding.interactiveElements.length).toBeLessThanOrEqual(40);

      // Verify label disambiguation occurred for duplicate "Add to Cart"
      const labels = understanding.interactiveElements.map((e) => e.label || '');
      const uniqueLabels = new Set(labels);
      expect(uniqueLabels.size).toBeGreaterThan(1);

      container.remove();
    });
  });

  // ── 6. Multi-Tab Lifecycle & Target Tab Verification ──────────────────────
  describe('6. Target Tab Lifecycle Verification', () => {
    it('should verify alive target tab when chrome.tabs.get succeeds', async () => {
      const mockTabsApi = {
        get: vi.fn().mockResolvedValue({ id: 101, url: 'http://localhost:4174/', active: true }),
      };

      const res = await verifyTargetTabAlive(101, mockTabsApi);
      expect(res.alive).toBe(true);
      expect(res.tab?.id).toBe(101);
      expect(mockTabsApi.get).toHaveBeenCalledWith(101);
    });

    it('should fail closed when target tab is closed or missing', async () => {
      const mockTabsApi = {
        get: vi.fn().mockRejectedValue(new Error('No tab with id: 999.')),
      };

      const res = await verifyTargetTabAlive(999, mockTabsApi);
      expect(res.alive).toBe(false);
      expect(res.reason).toContain('inaccessible');
    });
  });

  // ── 7. Action Idempotency ────────────────────────────────────────────────
  describe('7. Action Idempotency Guard', () => {
    it('should skip duplicate navigation when already at target URL', () => {
      const action = { action: 'navigate' as const, url: 'http://localhost:4174/spa.html', reason: 'Nav' };
      const res = checkActionIdempotency(action, [], { currentUrl: 'http://localhost:4174/spa.html' });

      // If observed URL matches, should skip
      const res2 = checkActionIdempotency(action, [action], { currentUrl: 'http://localhost:4174/spa.html' });
      expect(res2.isDuplicate).toBe(true);
      expect(res2.shouldSkip).toBe(true);
    });

    it('should prevent repeated clicks on consequential submit/buy targets', () => {
      const buyAction = { action: 'click' as const, target: 'btn-buy-now', reason: 'Confirm purchase' };
      const res = checkActionIdempotency(buyAction, [buyAction]);

      expect(res.isDuplicate).toBe(true);
      expect(res.shouldSkip).toBe(true);
      expect(res.reason).toContain('Duplicate click prevented');
    });

    it('should allow legitimate unique sequential actions', () => {
      const typeAction = { action: 'type' as const, target: 'input-query', text: 'shoes', reason: 'Search' };
      const clickAction = { action: 'click' as const, target: 'btn-submit', reason: 'Submit' };
      const res = checkActionIdempotency(clickAction, [typeAction]);

      expect(res.isDuplicate).toBe(false);
      expect(res.shouldSkip).toBe(false);
    });
  });

  // ── 8. Bounded Infinite Scroll Discovery ─────────────────────────────────
  describe('8. Bounded Infinite Scroll Discovery', () => {
    it('should discover target item when reached within scroll budget', async () => {
      let callCount = 0;
      const matcher = () => {
        callCount++;
        return callCount >= 3 ? { id: 'item-emerald', title: 'Emerald Backpack' } : null;
      };
      const scrollAction = vi.fn().mockResolvedValue(true);

      const res = await runBoundedScrollDiscovery(matcher, scrollAction, {
        maxScrolls: 4,
        settleTimeoutMs: 10,
      });

      expect(res.found).toBe(true);
      expect(res.match?.title).toBe('Emerald Backpack');
      expect(res.scrollsUsed).toBe(2);
      expect(res.budgetExhausted).toBe(false);
    });

    it('should fail honestly and declare budgetExhausted when item not found within budget', async () => {
      const matcher = () => null;
      const scrollAction = vi.fn().mockResolvedValue(true);

      const res = await runBoundedScrollDiscovery(matcher, scrollAction, {
        maxScrolls: 3,
        settleTimeoutMs: 10,
      });

      expect(res.found).toBe(false);
      expect(res.budgetExhausted).toBe(true);
      expect(res.scrollsUsed).toBe(3);
      expect(res.reason).toContain('bounded scroll budget');
    });
  });
});
