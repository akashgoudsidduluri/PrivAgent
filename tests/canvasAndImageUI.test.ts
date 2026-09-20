/**
 * PrivAgent 2.0 — Subphase P2.4: Canvas & Image-Only UI Detection Test Suite
 *
 * Covers:
 *  1. Canvas element detection (charts, graphs, interactive controls)
 *  2. Verification that detectedTextPreview is NOT present (metadata only: detectedText, textSensitivity)
 *  3. Image-only interactive button extraction (type: 'image_button')
 *  4. Associated DOM element mapping
 *  5. Generation stamping and honest source labeling ('layout')
 *  6. Sensitive label sanitization
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { detectCanvasAndImageUI } from '../extension/src/visualPerception/canvasDetector';

describe('Subphase P2.4 — Canvas & Image-Only UI Detection', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('Canvas UI Detection', () => {
    it('detects charts and interactive canvas buttons with clean metadata (no text preview)', () => {
      document.body.innerHTML = `
        <canvas id="sales-chart" class="chart-container" width="400" height="200" role="img" aria-label="Monthly Sales"></canvas>
        <canvas id="canvas-game-btn" class="btn-canvas" width="120" height="40" role="button" tabindex="0" aria-label="Start Game"></canvas>
      `;

      const chart = document.getElementById('sales-chart')!;
      chart.getBoundingClientRect = () => ({
        left: 10, top: 10, right: 410, bottom: 210, width: 400, height: 200, x: 10, y: 10, toJSON: () => {}
      });

      const btn = document.getElementById('canvas-game-btn')!;
      btn.getBoundingClientRect = () => ({
        left: 50, top: 250, right: 170, bottom: 290, width: 120, height: 40, x: 50, y: 250, toJSON: () => {}
      });

      const { canvasFindings, interactiveCandidates } = detectCanvasAndImageUI({
        pageGeneration: 3,
        root: document,
      });

      expect(canvasFindings.length).toBe(2);

      // 1. Chart finding
      const chartFinding = canvasFindings.find(c => c.associatedElementId === 'sales-chart');
      expect(chartFinding).toBeDefined();
      expect(chartFinding?.isChartOrGraphic).toBe(true);
      expect(chartFinding?.hasInteractiveElements).toBe(false);
      expect(chartFinding?.detectedText).toBe(true);
      expect(chartFinding?.textSensitivity).toBe('safe');
      expect(chartFinding?.source).toBe('layout');
      expect(chartFinding?.pageGeneration).toBe(3);

      // INVARIANT: detectedTextPreview MUST NOT exist
      expect((chartFinding as any).detectedTextPreview).toBeUndefined();

      // 2. Interactive canvas button finding
      const btnFinding = canvasFindings.find(c => c.associatedElementId === 'canvas-game-btn');
      expect(btnFinding).toBeDefined();
      expect(btnFinding?.hasInteractiveElements).toBe(true);

      // Verify interactive candidate spawned for the canvas button
      const cand = interactiveCandidates.find(ic => ic.associatedElementId === 'canvas-game-btn');
      expect(cand).toBeDefined();
      expect(cand?.type).toBe('canvas_button');
      expect(cand?.suggestedAction).toBe('click');
      expect(cand?.label).toBe('Start Game');
      expect(cand?.pageGeneration).toBe(3);
    });

    it('classifies canvas text sensitivity as sensitive if credential keywords are found in label', () => {
      document.body.innerHTML = `
        <canvas id="pwd-canvas" width="200" height="50" aria-label="Enter your secret pin"></canvas>
      `;

      const canvas = document.getElementById('pwd-canvas')!;
      canvas.getBoundingClientRect = () => ({
        left: 0, top: 0, right: 200, bottom: 50, width: 200, height: 50, x: 0, y: 0, toJSON: () => {}
      });

      const { canvasFindings } = detectCanvasAndImageUI({ pageGeneration: 1, root: document });
      expect(canvasFindings.length).toBe(1);
      expect(canvasFindings[0]!.textSensitivity).toBe('sensitive');
    });
  });

  describe('Image-Only Interactive Controls', () => {
    it('detects buttons and links containing images with zero text', () => {
      document.body.innerHTML = `
        <button id="cart-icon-btn" aria-label="Shopping Cart">
          <svg class="cart-icon" width="24" height="24"></svg>
        </button>
        <a id="help-img-link" href="/help" title="Customer Help">
          <img src="/help.png" alt="Help Center" width="30" height="30" />
        </a>
      `;

      const cartBtn = document.getElementById('cart-icon-btn')!;
      cartBtn.getBoundingClientRect = () => ({
        left: 10, top: 10, right: 50, bottom: 50, width: 40, height: 40, x: 10, y: 10, toJSON: () => {}
      });

      const helpLink = document.getElementById('help-img-link')!;
      helpLink.getBoundingClientRect = () => ({
        left: 60, top: 10, right: 100, bottom: 50, width: 40, height: 40, x: 60, y: 10, toJSON: () => {}
      });

      const { interactiveCandidates } = detectCanvasAndImageUI({
        pageGeneration: 4,
        root: document,
      });

      expect(interactiveCandidates.length).toBe(2);

      const cartCand = interactiveCandidates.find(c => c.associatedElementId === 'cart-icon-btn');
      expect(cartCand).toBeDefined();
      expect(cartCand?.type).toBe('image_button');
      expect(cartCand?.label).toBe('Shopping Cart');
      expect(cartCand?.pageGeneration).toBe(4);
      expect(cartCand?.source).toBe('layout');

      const helpCand = interactiveCandidates.find(c => c.associatedElementId === 'help-img-link');
      expect(helpCand).toBeDefined();
      expect(helpCand?.type).toBe('image_button');
      expect(helpCand?.label).toBe('Customer Help');
    });

    it('sanitizes credential references in image button labels', () => {
      document.body.innerHTML = `
        <button id="auth-btn" aria-label="Enter CVV Code">
          <img src="/lock.png" alt="Lock" />
        </button>
      `;

      const authBtn = document.getElementById('auth-btn')!;
      authBtn.getBoundingClientRect = () => ({
        left: 0, top: 0, right: 50, bottom: 50, width: 50, height: 50, x: 0, y: 0, toJSON: () => {}
      });

      const { interactiveCandidates } = detectCanvasAndImageUI({ pageGeneration: 2, root: document });
      expect(interactiveCandidates.length).toBe(1);
      expect(interactiveCandidates[0]!.label).toBe('Protected Credential Control');
    });
  });
});
