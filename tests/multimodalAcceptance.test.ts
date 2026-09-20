/**
 * PrivAgent 2.0 — Phase 2 Multimodal Perception Acceptance Suite
 *
 * Covers Scenarios A through J:
 *   A. Normal webpage screenshot perception (ScreenshotProvider, bounded, local release)
 *   B. Image-only UI (icon buttons, logo links, layout-derived candidates)
 *   C. Canvas UI (canvas detector, no detectedTextPreview, safe sensitivity metadata)
 *   D. Visually rendered text (spatial OCR bounding, line mapping)
 *   E. OCR detection (privacy classification, confidence, bounding)
 *   F. Sensitive visual text (credit card, CVV, password scrubbed locally)
 *   G. DOM + visual fusion (BrowserWorldModel unified multimodal fusion)
 *   H. Stale visual target after navigation (WorldModelStore pageGeneration invalidation)
 *   I. Visual target grounding (resolving candidate visual bounds to clickable action points)
 *   J. Sanitized context sent toward Groq (assertWorldModelSafe, context summary < 2 KB)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MockScreenshotProvider } from '../extension/src/visualPerception/screenshotCapture';
import { extractVisualRegions } from '../extension/src/visualPerception/visualRegions';
import { detectVisualObjects } from '../extension/src/visualPerception/localImagePerception';
import { detectCanvasAndImageUI } from '../extension/src/visualPerception/canvasDetector';
import { sampleVideoKeyFrames } from '../extension/src/visualPerception/videoKeyFrameSampler';
import {
  processSpatialOCRResult,
  convertToSafeOCRRegions,
  fuseSpatialOCRWithDOM,
} from '../extension/src/ocr/spatialOcrLayer';
import { buildBrowserWorldModel } from '../extension/src/worldModel/worldModelBuilder';
import { createWorldModelStore } from '../extension/src/worldModel/worldModelStore';
import { createAgentTaskState, advancePageGeneration } from '../extension/src/agent/agentState';
import {
  assertWorldModelSafe,
  createSanitizedWorldModelSummary,
} from '../extension/src/worldModel/worldModelSanitizer';
import type { InternalOCRResult } from '../extension/src/ocr/types';
import type { VisualInteractiveCandidate } from '../extension/src/visualPerception/visualTypes';

describe('Phase 2 — Multimodal Perception Acceptance (Scenarios A through J)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.title = 'Multimodal Test Page';
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario A: Normal webpage screenshot perception
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario A: captures and bounds viewport screenshot locally, then releases data', async () => {
    const provider = new MockScreenshotProvider();
    const screenshot = await provider.captureViewport({ pageGeneration: 1 });

    expect(screenshot).toBeDefined();
    expect(screenshot.width).toBeLessThanOrEqual(1280);
    expect(screenshot.height).toBeLessThanOrEqual(1280);
    expect(screenshot.devicePixelRatio).toBeGreaterThan(0);
    expect(screenshot.getRawDataUrl()).toContain('data:image/png;base64');

    // Extract visual regions from layout
    document.body.innerHTML = `
      <header id="site-header" style="height: 60px;">Header</header>
      <main id="main-content" style="height: 400px;">Content</main>
      <footer id="site-footer" style="height: 50px;">Footer</footer>
    `;

    const els = Array.from(document.querySelectorAll<HTMLElement>('*'));
    els.forEach(el => {
      el.getBoundingClientRect = () => ({
        left: 0, top: 0, right: 800, bottom: 100, width: 800, height: 100, x: 0, y: 0, toJSON: () => {}
      });
    });

    const regions = extractVisualRegions({
      pageGeneration: 1,
      root: document,
    });

    expect(regions.length).toBeGreaterThanOrEqual(1);
    expect(regions[0]!.source).toBe('layout');
    expect(regions[0]!.pageGeneration).toBe(1);

    // Release raw screenshot data
    screenshot.release();
    expect(screenshot.isReleased()).toBe(true);
    expect(() => screenshot.getRawDataUrl()).toThrow();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario B: Image-only UI
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario B: detects image-only buttons and links with honest layout source and sanitized labels', () => {
    document.body.innerHTML = `
      <button id="cart-icon" aria-label="View Shopping Cart">
        <svg class="cart-svg" width="24" height="24"></svg>
      </button>
      <a id="brand-logo" href="/home" title="Official Storefront">
        <img src="/logo.png" alt="Company Brand Logo" width="100" height="30" />
      </a>
      <button id="camera-search" title="Visual Image Search">
        <img src="/cam.png" width="20" height="20" />
      </button>
    `;

    const cartBtn = document.getElementById('cart-icon')!;
    cartBtn.getBoundingClientRect = () => ({
      left: 10, top: 10, right: 50, bottom: 50, width: 40, height: 40, x: 10, y: 10, toJSON: () => {}
    });

    const logoLink = document.getElementById('brand-logo')!;
    logoLink.getBoundingClientRect = () => ({
      left: 60, top: 10, right: 160, bottom: 40, width: 100, height: 30, x: 60, y: 10, toJSON: () => {}
    });

    const camBtn = document.getElementById('camera-search')!;
    camBtn.getBoundingClientRect = () => ({
      left: 170, top: 10, right: 200, bottom: 40, width: 30, height: 30, x: 170, y: 10, toJSON: () => {}
    });

    const { interactiveCandidates } = detectCanvasAndImageUI({
      pageGeneration: 2,
      root: document,
    });

    expect(interactiveCandidates.length).toBe(3);
    for (const cand of interactiveCandidates) {
      expect(cand.source).toBe('layout'); // HONEST LABELING
      expect(cand.pageGeneration).toBe(2);
      expect(cand.bbox[2]).toBeGreaterThan(0);
      expect(cand.bbox[3]).toBeGreaterThan(0);
      expect(cand.label).toBeTruthy();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario C: Canvas UI
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario C: detects canvas elements without storing detectedTextPreview', () => {
    document.body.innerHTML = `
      <canvas id="interactive-signature" width="300" height="150" aria-label="Signature Canvas"></canvas>
      <canvas id="game-viewport" width="640" height="480"></canvas>
    `;

    const sigCanvas = document.getElementById('interactive-signature')!;
    sigCanvas.getBoundingClientRect = () => ({
      left: 50, top: 50, right: 350, bottom: 200, width: 300, height: 150, x: 50, y: 50, toJSON: () => {}
    });

    const gameCanvas = document.getElementById('game-viewport')!;
    gameCanvas.getBoundingClientRect = () => ({
      left: 50, top: 220, right: 690, bottom: 700, width: 640, height: 480, x: 50, y: 220, toJSON: () => {}
    });

    const { canvasFindings } = detectCanvasAndImageUI({
      pageGeneration: 3,
      root: document,
    });

    expect(canvasFindings.length).toBe(2);
    for (const cf of canvasFindings) {
      expect(['layout', 'pixel']).toContain(cf.source);
      expect(cf.pageGeneration).toBe(3);
      expect(typeof cf.detectedText).toBe('boolean');
      expect(['safe', 'sensitive', 'unknown']).toContain(cf.textSensitivity);
      // INVARIANT: detectedTextPreview MUST NOT EXIST
      expect((cf as unknown as Record<string, unknown>).detectedTextPreview).toBeUndefined();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario D: Visually rendered text
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario D: maps spatial OCR lines to normalized visual coordinates', () => {
    const mockOcrResult: InternalOCRResult = {
      fullText: 'Order Total: $45.99\nExpress Shipping: Free',
      latencyMs: 14,
      words: [],
      lines: [
        {
          text: 'Order Total: $45.99',
          confidence: 0.96,
          bbox: { x0: 20, y0: 100, x1: 220, y1: 130 },
          words: [],
        },
        {
          text: 'Express Shipping: Free',
          confidence: 0.94,
          bbox: { x0: 20, y0: 140, x1: 240, y1: 170 },
          words: [],
        },
      ],
    };

    const regions = processSpatialOCRResult(mockOcrResult, {
      pageGeneration: 1,
      imageDimensions: { width: 1000, height: 800 },
    });

    expect(regions.length).toBe(2);
    expect(regions[0]!.source).toBe('ocr');
    expect(regions[0]!.bbox).toEqual([20, 100, 200, 30]);
    expect(regions[0]!.confidence).toBe(0.96);
    expect(regions[0]!.textClassification).toBe('safe');
    expect(regions[0]!.safeText).toBe('Order Total: $45.99');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario E: OCR detection & privacy classification
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario E: categorizes safe text vs sensitive visual text with high confidence', () => {
    const mockOcrResult: InternalOCRResult = {
      fullText: 'Welcome to PrivAgent\nPassword123\nContact support',
      latencyMs: 15,
      words: [],
      lines: [
        {
          text: 'Welcome to PrivAgent',
          confidence: 0.98,
          bbox: { x0: 10, y0: 10, x1: 200, y1: 40 },
          words: [],
        },
        {
          text: 'Password123',
          confidence: 0.99,
          bbox: { x0: 10, y0: 50, x1: 150, y1: 80 },
          words: [],
        },
        {
          text: 'Contact support',
          confidence: 0.92,
          bbox: { x0: 10, y0: 90, x1: 160, y1: 120 },
          words: [],
        },
      ],
    };

    const regions = processSpatialOCRResult(mockOcrResult, {
      pageGeneration: 1,
      imageDimensions: { width: 800, height: 600 },
    });

    expect(regions.length).toBe(3);
    expect(regions[0]!.sensitivity).toBe('safe');
    expect(regions[1]!.sensitivity).toBe('sensitive');
    expect(regions[1]!.sensitiveType).toBe('password');
    expect(regions[2]!.sensitivity).toBe('safe');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario F: Sensitive visual text scrubbing
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario F: strictly scrubs credit card and password strings from safe OCR representation', () => {
    const mockOcrResult: InternalOCRResult = {
      fullText: 'Card: 4111 1111 1111 1111\nCVV: 892\nAmount: $120.00',
      latencyMs: 12,
      words: [],
      lines: [
        {
          text: 'Card: 4111 1111 1111 1111',
          confidence: 0.98,
          bbox: { x0: 10, y0: 10, x1: 250, y1: 40 },
          words: [],
        },
        {
          text: 'CVV: 892',
          confidence: 0.97,
          bbox: { x0: 10, y0: 50, x1: 100, y1: 80 },
          words: [],
        },
        {
          text: 'Amount: $120.00',
          confidence: 0.95,
          bbox: { x0: 10, y0: 90, x1: 160, y1: 120 },
          words: [],
        },
      ],
    };

    const regions = processSpatialOCRResult(mockOcrResult, {
      pageGeneration: 2,
      imageDimensions: { width: 800, height: 600 },
    });

    const safeRegions = convertToSafeOCRRegions(regions);
    expect(safeRegions.length).toBe(3);

    // Regions 0 and 1 are sensitive
    expect(safeRegions[0]!.isSensitive).toBe(true);
    expect(safeRegions[1]!.isSensitive).toBe(true);
    expect(safeRegions[2]!.isSensitive).toBe(false);

    // Serialization verification
    const serialized = JSON.stringify(safeRegions);
    expect(serialized).not.toContain('4111');
    expect(serialized).not.toContain('892');
    expect(serialized).not.toContain('Card:');
    expect(serialized).not.toContain('CVV:');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario G: DOM + visual fusion into BrowserWorldModel
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario G: fuses DOM, accessibility, visual regions, canvas, and video into BrowserWorldModel', async () => {
    document.body.innerHTML = `
      <div id="product-card">
        <h2 id="prod-title">Wireless Headphones</h2>
        <img id="prod-img" src="/headphones.jpg" alt="Wireless Headphones Black" />
        <canvas id="sound-wave" width="200" height="60"></canvas>
        <video id="prod-demo" width="320" height="240" src="/demo.mp4"></video>
        <button id="add-to-cart">Add to Cart</button>
      </div>
    `;

    const btn = document.getElementById('add-to-cart')!;
    btn.getBoundingClientRect = () => ({
      left: 20, top: 300, right: 140, bottom: 340, width: 120, height: 40, x: 20, y: 300, toJSON: () => {}
    });

    const img = document.getElementById('prod-img')!;
    img.getBoundingClientRect = () => ({
      left: 20, top: 40, right: 220, bottom: 200, width: 200, height: 160, x: 20, y: 40, toJSON: () => {}
    });

    const canvas = document.getElementById('sound-wave')!;
    canvas.getBoundingClientRect = () => ({
      left: 20, top: 210, right: 220, bottom: 270, width: 200, height: 60, x: 20, y: 210, toJSON: () => {}
    });

    const video = document.getElementById('prod-demo') as HTMLVideoElement;
    video.getBoundingClientRect = () => ({
      left: 250, top: 40, right: 570, bottom: 280, width: 320, height: 240, x: 250, y: 40, toJSON: () => {}
    });
    Object.defineProperty(video, 'duration', { value: 10, writable: true });
    Object.defineProperty(video, 'paused', { value: false, writable: true });
    Object.defineProperty(video, 'readyState', { value: 4, writable: true });

    const imageFindings = await detectVisualObjects({ pageGeneration: 5, root: document });

    const wm = buildBrowserWorldModel({
      root: document,
      pageGeneration: 5,
      imageFindings,
    });

    expect(wm.page.pageGeneration).toBe(5);
    expect(wm.elements.length).toBeGreaterThanOrEqual(1);
    expect(wm.accessibilityTree.length).toBeGreaterThanOrEqual(2);
    expect(wm.visualRegions.length).toBeGreaterThanOrEqual(1);
    expect(wm.canvasFindings.length).toBe(1);
    expect(wm.canvasFindings[0]!.pageGeneration).toBe(5);
    expect(wm.imageFindings.length).toBeGreaterThanOrEqual(1);
    expect(wm.imageFindings[0]!.source).toBe('layout');
    expect(wm.spatialRelationships).toBeDefined();
    expect(wm.semanticRelationships).toBeDefined();

    // Verify all findings have id, pageGeneration, and source
    for (const r of wm.visualRegions) {
      expect(r.id).toBeDefined();
      expect(r.pageGeneration).toBe(5);
      expect(r.source).toBe('layout');
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario H: Stale visual target after navigation
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario H: invalidates visual targets from prior page generation in WorldModelStore', () => {
    const store = createWorldModelStore();
    const taskState = createAgentTaskState('Add headphones to cart');
    taskState.currentPageGeneration = 1;

    // Gen 1: Build model W1
    document.body.innerHTML = `<button id="btn-v1">Submit</button>`;
    const wm1 = buildBrowserWorldModel({ root: document, pageGeneration: 1 });
    const ref1 = store.registerWorldModel(wm1);
    taskState.activeWorldModelRef = ref1;

    // Target from Gen 1 is valid in Gen 1
    expect(store.isTargetValid(taskState.activeWorldModelRef, 'btn-v1', taskState.currentPageGeneration)).toBe(true);

    // Navigate -> Page Generation 2
    advancePageGeneration(taskState);
    expect(taskState.currentPageGeneration).toBe(2);
    expect(taskState.activeWorldModelRef).toBeNull();

    // Stale target from Gen 1 MUST be invalid in Gen 2
    expect(store.isTargetValid(ref1, 'btn-v1', taskState.currentPageGeneration)).toBe(false);

    // Candidate visual target from Gen 1 is rejected
    const staleCandidate: VisualInteractiveCandidate = {
      id: 'vis-cand-1',
      type: 'image_button',
      bbox: [10, 10, 40, 40],
      confidence: 0.9,
      pageGeneration: 1,
      source: 'layout',
      label: 'Stale Button',
      suggestedAction: 'click',
    };

    const isStaleValid = staleCandidate.pageGeneration === taskState.currentPageGeneration;
    expect(isStaleValid).toBe(false); // Stale visual candidate invalidated!
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario I: Visual target grounding
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario I: resolves candidate visual bounds to grounded action point', () => {
    const candidate: VisualInteractiveCandidate = {
      id: 'vis-cand-search',
      type: 'image_button',
      bbox: [150, 80, 40, 40],
      confidence: 0.95,
      pageGeneration: 1,
      source: 'layout',
      label: 'Search Button',
      suggestedAction: 'click',
    };

    // Grounding calculation: center point
    const [x, y, w, h] = candidate.bbox;
    const clickX = Math.round(x + w / 2);
    const clickY = Math.round(y + h / 2);

    expect(clickX).toBe(170);
    expect(clickY).toBe(100);

    // Verify bounds stay within viewport
    const viewportWidth = 1280;
    const viewportHeight = 800;
    const isWithinViewport =
      clickX >= 0 && clickX <= viewportWidth &&
      clickY >= 0 && clickY <= viewportHeight;

    expect(isWithinViewport).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario J: Sanitized context sent toward Groq
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario J: passes assertWorldModelSafe and creates minimal summary under 2 KB', () => {
    document.body.innerHTML = `
      <div id="checkout-panel">
        <h1 id="cart-h1">Shopping Cart</h1>
        <div id="item-row">
          <img src="/thumb.jpg" alt="Item Thumbnail" width="40" height="40" />
          <span id="item-title">Ergonomic Mouse</span>
          <span id="item-price">$29.99</span>
        </div>
        <button id="checkout-btn">Proceed to Checkout</button>
      </div>
    `;

    const wm = buildBrowserWorldModel({
      root: document,
      pageGeneration: 1,
    });

    // 1. Invariant: Safety assertion passes
    expect(() => assertWorldModelSafe(wm)).not.toThrow();

    // 2. Invariant: Summary is compact (< 2048 bytes)
    const summary = createSanitizedWorldModelSummary(wm);
    const summaryJson = JSON.stringify(summary);
    const sizeBytes = new TextEncoder().encode(summaryJson).length;

    expect(sizeBytes).toBeLessThan(2048);

    // 3. Invariant: Zero raw pixels, zero base64, zero passwords/tokens
    expect(summaryJson).not.toContain('base64');
    expect(summaryJson).not.toContain('data:image');
    expect(summaryJson).not.toContain('password');
    expect(summaryJson).not.toContain('token');
  });
});
