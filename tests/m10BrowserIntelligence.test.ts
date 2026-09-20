/**
 * PrivAgent — M10 Advanced Browser Intelligence Unit Tests
 *
 * Tests:
 *  1. General page understanding & classification (classifyPage)
 *  2. Semantic element relationships & grouping (extractSemanticGroups)
 *  3. Multi-signal semantic target grounding (groundProposedTarget)
 *  4. Action effect verification engine (verifyActionEffect)
 *  5. Generic candidate entity extraction & constraint verification (candidateEntities)
 */

import { describe, it, expect } from 'vitest';
import { classifyPage } from '../extension/src/content/domInteractiveScanner';
import { groundProposedTarget } from '../extension/src/agent/groundingEngine';
import { verifyActionEffect } from '../extension/src/agent/effectVerifier';
import {
  extractGenericEntities,
  verifyEntityConstraints,
  CandidateEntity,
} from '../extension/src/agent/candidateEntities';
import { DetectionResult } from '../extension/src/privacy/types';

describe('PrivAgent M10 — Advanced Browser Intelligence Suite', () => {
  // ── 1. General Page Understanding ───────────────────────────────────────────
  describe('General Page Understanding (classifyPage)', () => {
    it('classifies login page with password input', () => {
      const doc = document.implementation.createHTMLDocument('Sign In Page');
      const pwd = doc.createElement('input');
      pwd.type = 'password';
      doc.body.appendChild(pwd);

      expect(classifyPage(doc)).toBe('login');
    });

    it('classifies search page with query input and search role', () => {
      const doc = document.implementation.createHTMLDocument('Search Portal');
      const input = doc.createElement('input');
      input.type = 'search';
      input.name = 'q';
      doc.body.appendChild(input);

      expect(classifyPage(doc)).toBe('search');
    });

    it('classifies listing page with product cards', () => {
      const doc = document.implementation.createHTMLDocument('Catalog');
      const card = doc.createElement('div');
      card.className = 'product-card';
      doc.body.appendChild(card);

      expect(classifyPage(doc)).toBe('listing');
    });

    it('classifies checkout page with payment controls', () => {
      const doc = document.implementation.createHTMLDocument('Checkout & Pay');
      const form = doc.createElement('form');
      form.setAttribute('data-checkout', 'true');
      const btn = doc.createElement('button');
      btn.id = 'btn-pay';
      form.appendChild(btn);
      doc.body.appendChild(form);

      expect(classifyPage(doc)).toBe('checkout');
    });

    it('classifies article/content page with article elements', () => {
      const doc = document.implementation.createHTMLDocument('Tech Blog Post');
      const art = doc.createElement('article');
      art.className = 'post-content';
      doc.body.appendChild(art);

      expect(classifyPage(doc)).toBe('article');
    });

    it('classifies dashboard with table data', () => {
      const doc = document.implementation.createHTMLDocument('Admin Panel');
      const tbl = doc.createElement('table');
      const tbody = doc.createElement('tbody');
      const tr = doc.createElement('tr');
      tbody.appendChild(tr);
      tbl.appendChild(tbody);
      doc.body.appendChild(tbl);

      expect(classifyPage(doc)).toBe('dashboard');
    });

    it('classifies error page on 404', () => {
      const doc = document.implementation.createHTMLDocument('404 Not Found');
      const h1 = doc.createElement('h1');
      h1.textContent = '404 - Page Not Found';
      doc.body.appendChild(h1);

      expect(classifyPage(doc)).toBe('error');
    });
  });

  // ── 2. Multi-Signal Semantic Target Grounding ──────────────────────────────
  describe('Multi-Signal Target Grounding (groundProposedTarget)', () => {
    const mockDetections: DetectionResult[] = [
      {
        id: 'btn-search-submit',
        type: 'button',
        confidence: 0.95,
        selector: '#btn-search-submit',
        bbox: [100, 100, 80, 30],
        length: 6,
        source: 'dom_attribute',
        label: 'Search',
      },
      {
        id: 'input-query',
        type: 'input',
        confidence: 0.95,
        selector: '#input-query',
        bbox: [20, 100, 150, 30],
        length: 12,
        source: 'dom_attribute',
        label: 'Search Products',
      },
      {
        id: 'hidden-btn',
        type: 'button',
        confidence: 0.95,
        selector: '#hidden-btn',
        bbox: [0, 0, 0, 0], // zero geometry
        length: 4,
        source: 'dom_attribute',
        label: 'Hide',
      },
    ];

    it('authoritatively grounds exact ID match with compatible type', () => {
      const result = groundProposedTarget(
        { action: 'click', target: 'btn-search-submit' },
        mockDetections,
        { currentPageGeneration: 1, actionPageGeneration: 1 }
      );

      expect(result.grounded).toBe(true);
      expect(result.targetId).toBe('btn-search-submit');
      expect(result.confidence).toBe(1.0);
    });

    it('rejects stale target from previous page generation', () => {
      const result = groundProposedTarget(
        { action: 'click', target: 'btn-search-submit' },
        mockDetections,
        { currentPageGeneration: 2, actionPageGeneration: 1 }
      );

      expect(result.grounded).toBe(false);
      expect(result.failureReason).toBe('STALE_TARGET');
      expect(result.confidence).toBe(0);
    });

    it('rejects target mismatch when action type is incompatible with element', () => {
      // Trying to TYPE into a button
      const result = groundProposedTarget(
        { action: 'type', target: 'btn-search-submit', text: 'shoes' },
        mockDetections,
        { currentPageGeneration: 1, actionPageGeneration: 1 }
      );

      expect(result.grounded).toBe(false);
      expect(result.failureReason).toBe('TARGET_MISMATCH');
    });

    it('rejects disabled or zero-dimension hidden elements', () => {
      const result = groundProposedTarget(
        { action: 'click', target: 'hidden-btn' },
        mockDetections,
        { currentPageGeneration: 1, actionPageGeneration: 1 }
      );

      expect(result.grounded).toBe(false);
      expect(result.failureReason).toBe('DISABLED_OR_HIDDEN');
    });

    it('semantically grounds fuzzy / descriptive targets by accessible label', () => {
      const result = groundProposedTarget(
        { action: 'click', target: 'Search' },
        mockDetections,
        { currentPageGeneration: 1, actionPageGeneration: 1 }
      );

      expect(result.grounded).toBe(true);
      expect(result.targetId).toBe('btn-search-submit');
      expect(result.confidence).toBeGreaterThanOrEqual(0.65);
    });

    it('fails closed on hallucinated nonexistent targets', () => {
      const result = groundProposedTarget(
        { action: 'click', target: 'nonexistent_invented_button_999' },
        mockDetections,
        { currentPageGeneration: 1, actionPageGeneration: 1 }
      );

      expect(result.grounded).toBe(false);
      expect(result.failureReason).toBe('ELEMENT_NOT_FOUND');
    });
  });

  // ── 3. Action Effect Verification ───────────────────────────────────────────
  describe('Action Effect Verification (verifyActionEffect)', () => {
    it('verifies navigate action effect when URL changes', () => {
      const res = verifyActionEffect(
        { action: 'navigate', url: 'https://example.com/results' },
        { url: 'https://example.com/search', scrollX: 0, scrollY: 0, timestamp: 1 },
        { url: 'https://example.com/results', scrollX: 0, scrollY: 0, timestamp: 2 }
      );

      expect(res.hasEffect).toBe(true);
      expect(res.status).toBe('URL_NAVIGATION_OBSERVED');
      expect(res.shouldRecover).toBe(false);
    });

    it('detects ACTION_NO_EFFECT when navigate fails to change URL', () => {
      const res = verifyActionEffect(
        { action: 'navigate', url: 'https://example.com/results' },
        { url: 'https://example.com/search', scrollX: 0, scrollY: 0, timestamp: 1 },
        { url: 'https://example.com/search', scrollX: 0, scrollY: 0, timestamp: 2 }
      );

      expect(res.hasEffect).toBe(false);
      expect(res.status).toBe('ACTION_NO_EFFECT');
      expect(res.shouldRecover).toBe(true);
    });

    it('verifies click action effect when DOM elements mutate', () => {
      const res = verifyActionEffect(
        { action: 'click', target: 'btn-load-more' },
        { url: 'http://localhost/app', scrollX: 0, scrollY: 0, domElementCount: 20, timestamp: 1 },
        { url: 'http://localhost/app', scrollX: 0, scrollY: 0, domElementCount: 30, timestamp: 2 }
      );

      expect(res.hasEffect).toBe(true);
      expect(res.status).toBe('DOM_MUTATION_OBSERVED');
      expect(res.shouldRecover).toBe(false);
    });

    it('detects ACTION_NO_EFFECT when click produces no DOM, URL, or modal changes', () => {
      const res = verifyActionEffect(
        { action: 'click', target: 'inert-button' },
        { url: 'http://localhost/app', scrollX: 0, scrollY: 0, domElementCount: 20, timestamp: 1 },
        { url: 'http://localhost/app', scrollX: 0, scrollY: 0, domElementCount: 20, timestamp: 2 }
      );

      expect(res.hasEffect).toBe(false);
      expect(res.status).toBe('ACTION_NO_EFFECT');
      expect(res.shouldRecover).toBe(true);
    });

    it('verifies type action when target input value length changes locally', () => {
      const res = verifyActionEffect(
        { action: 'type', target: 'search-box', text: 'cats' },
        { url: 'http://localhost/app', scrollX: 0, scrollY: 0, targetValueLength: 0, timestamp: 1 },
        { url: 'http://localhost/app', scrollX: 0, scrollY: 0, targetValueLength: 4, timestamp: 2 }
      );

      expect(res.hasEffect).toBe(true);
      expect(res.status).toBe('VALUE_STATE_CHANGED');
    });

    it('verifies scroll action when scrollY shifts', () => {
      const res = verifyActionEffect(
        { action: 'scroll', direction: 'down', amount: 500 },
        { url: 'http://localhost/app', scrollX: 0, scrollY: 0, timestamp: 1 },
        { url: 'http://localhost/app', scrollX: 0, scrollY: 500, timestamp: 2 }
      );

      expect(res.hasEffect).toBe(true);
      expect(res.status).toBe('SCROLL_CHANGED');
    });
  });

  // ── 4. Generic Candidate Entities & Constraints ─────────────────────────────
  describe('Generic Candidate Entity Model', () => {
    it('extracts products, articles, search results, and table rows', () => {
      const doc = document.implementation.createHTMLDocument('Multi-Entity Page');

      // Product Card
      const p = doc.createElement('div');
      p.className = 'product-card';
      p.id = 'product-1';
      p.dataset.size = 'XXL';
      p.dataset.color = 'black';
      p.dataset.price = '899';
      p.innerHTML = '<h3 class="product-title">Black Baggy Bag</h3>';
      doc.body.appendChild(p);

      // Article
      const a = doc.createElement('article');
      a.id = 'article-1';
      a.innerHTML = '<h2 class="article-title">AI Browser Agents</h2><p class="summary">Summary snippet...</p>';
      doc.body.appendChild(a);

      // Table Row
      const table = doc.createElement('table');
      const tbody = doc.createElement('tbody');
      const tr = doc.createElement('tr');
      tr.id = 'row-1';
      tr.innerHTML = '<td>Tx #1001</td><td>Completed</td>';
      tbody.appendChild(tr);
      table.appendChild(tbody);
      doc.body.appendChild(table);

      const entities = extractGenericEntities(doc);
      expect(entities.some(e => e.type === 'Product')).toBe(true);
      expect(entities.some(e => e.type === 'Article')).toBe(true);
      expect(entities.some(e => e.type === 'TableRow')).toBe(true);
    });

    it('verifies multi-constraint criteria deterministically', () => {
      const candidate: CandidateEntity = {
        id: 'product-1',
        type: 'Product',
        title: 'XXL Black Baggy Travel Bag',
        attributes: {
          size: 'XXL',
          color: 'black',
          style: 'baggy',
          price: 899,
        },
      };

      const constraints = {
        size: 'XXL',
        color: 'black',
        style: 'baggy',
        maxPrice: 1000,
      };

      const verification = verifyEntityConstraints(candidate, constraints);
      expect(verification.matches).toBe(true);
      expect(verification.details.size).toBe(true);
      expect(verification.details.color).toBe(true);
      expect(verification.details.maxPrice).toBe(true);
    });

    it('rejects candidate when any constraint fails', () => {
      const candidate: CandidateEntity = {
        id: 'product-2',
        type: 'Product',
        title: 'L Black Baggy Travel Bag',
        attributes: {
          size: 'L', // size mismatch
          color: 'black',
          price: 899,
        },
      };

      const verification = verifyEntityConstraints(candidate, { size: 'XXL', color: 'black' });
      expect(verification.matches).toBe(false);
      expect(verification.details.size).toBe(false);
    });
  });
});
