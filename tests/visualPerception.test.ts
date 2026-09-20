/**
 * PrivAgent 2.0 — Subphase P2.1: Visual Region Perception Test Suite
 *
 * Covers:
 *  1. ScreenshotProvider abstraction, MockScreenshotProvider, and ExtensionScreenshotProvider
 *  2. LocalScreenshot bounded scaling, generation stamping, and deterministic memory release
 *  3. Stale generation rejection for screenshot captures
 *  4. VisualRegion extraction across cards, buttons, images, canvas, video, banners
 *  5. Explicit perception source tagging (source: 'layout')
 *  6. Bounding box normalization and micro-element suppression
 *  7. Sensitive semantic hint sanitization
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createLocalScreenshot,
  isScreenshotValidForGeneration,
  captureViewportScreenshot,
  MockScreenshotProvider,
  setScreenshotProvider,
} from '../extension/src/visualPerception/screenshotCapture';
import { extractVisualRegions } from '../extension/src/visualPerception/visualRegions';

describe('Subphase P2.1 — Visual Region Perception', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('ScreenshotProvider & Memory Lifecycle', () => {
    it('creates local screenshot with bounded dimensions and generation stamping', () => {
      const dummyDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const shot = createLocalScreenshot(dummyDataUrl, {
        width: 1920,
        height: 1080,
        pageGeneration: 3,
        maxDimension: 1280,
      });

      expect(shot.pageGeneration).toBe(3);
      expect(shot.width).toBe(1280); // Scaled from 1920 to 1280
      expect(shot.height).toBe(720); // 1080 * (1280 / 1920) = 720
      expect(shot.source).toBe('pixel');
      expect(shot.isReleased()).toBe(false);
      expect(shot.getRawDataUrl()).toBe(dummyDataUrl);
    });

    it('release() strictly wipes raw data URL from memory', () => {
      const dummyDataUrl = 'data:image/png;base64,abc123secretdata';
      const shot = createLocalScreenshot(dummyDataUrl, {
        width: 800,
        height: 600,
        pageGeneration: 1,
      });

      expect(shot.isReleased()).toBe(false);
      expect(shot.getRawDataUrl()).toBe(dummyDataUrl);

      // Trigger deterministic memory release
      shot.release();

      expect(shot.isReleased()).toBe(true);
      expect(() => shot.getRawDataUrl()).toThrow(/released from memory/);
    });

    it('isScreenshotValidForGeneration correctly rejects stale or released captures', () => {
      const dummy = 'data:image/png;base64,data';
      const shot = createLocalScreenshot(dummy, { width: 100, height: 100, pageGeneration: 41 });

      expect(isScreenshotValidForGeneration(shot, 41)).toBe(true);
      expect(isScreenshotValidForGeneration(shot, 42)).toBe(false); // Stale generation rejected

      shot.release();
      expect(isScreenshotValidForGeneration(shot, 41)).toBe(false); // Released capture rejected
    });

    it('supports custom ScreenshotProvider injection and capturing', async () => {
      const customMock = new MockScreenshotProvider('data:image/png;base64,customPixelData');
      setScreenshotProvider(customMock);

      const shot = await captureViewportScreenshot({ pageGeneration: 8 });
      expect(shot).toBeDefined();
      expect(shot.pageGeneration).toBe(8);
      expect(shot.getRawDataUrl()).toBe('data:image/png;base64,customPixelData');
      shot.release();
    });
  });

  describe('Visual Region Extraction & Segmentation', () => {
    it('segments cards, buttons, images, canvases, and videos with honest source labeling', () => {
      document.body.innerHTML = `
        <article id="item-card" class="product-card">
          <h2 class="title">Quantum Headphones</h2>
          <img id="item-img" src="/img.jpg" alt="Headphones" />
          <button id="item-buy" class="btn">Buy Now</button>
        </article>
        <canvas id="live-chart" width="300" height="150"></canvas>
        <video id="promo-vid" width="400" height="250"></video>
        <div id="cookie-notice" class="cookie-banner">Accept cookies</div>
      `;

      // Mock getBoundingClientRect for elements in JSDOM
      const elements = Array.from(document.querySelectorAll<HTMLElement>('*'));
      elements.forEach(el => {
        el.getBoundingClientRect = () => ({
          left: 10,
          top: 10,
          right: 110,
          bottom: 110,
          width: 100,
          height: 100,
          x: 10,
          y: 10,
          toJSON: () => {},
        });
      });

      const regions = extractVisualRegions({ pageGeneration: 7, root: document });
      expect(regions.length).toBeGreaterThanOrEqual(5);

      // Verify card region
      const card = regions.find(r => r.associatedElementId === 'item-card');
      expect(card).toBeDefined();
      expect(card?.type).toBe('card');
      expect(card?.pageGeneration).toBe(7);
      expect(card?.source).toBe('layout'); // Honest capability labeling
      expect(card?.semanticHint).toContain('Quantum Headphones');

      // Verify button-like region
      const btn = regions.find(r => r.associatedElementId === 'item-buy');
      expect(btn).toBeDefined();
      expect(btn?.type).toBe('button_like');
      expect(btn?.source).toBe('layout');

      // Verify image region
      const img = regions.find(r => r.associatedElementId === 'item-img');
      expect(img).toBeDefined();
      expect(img?.type).toBe('image');
      expect(img?.source).toBe('layout');

      // Verify canvas region
      const canvas = regions.find(r => r.associatedElementId === 'live-chart');
      expect(canvas).toBeDefined();
      expect(canvas?.type).toBe('canvas');
      expect(canvas?.source).toBe('layout');

      // Verify video region
      const video = regions.find(r => r.associatedElementId === 'promo-vid');
      expect(video).toBeDefined();
      expect(video?.type).toBe('video');
      expect(video?.source).toBe('layout');

      // Verify banner region
      const banner = regions.find(r => r.associatedElementId === 'cookie-notice');
      expect(banner).toBeDefined();
      expect(banner?.type).toBe('banner');
      expect(banner?.source).toBe('layout');
    });

    it('sanitizes sensitive semantic hints in visual regions', () => {
      document.body.innerHTML = `
        <div id="pwd-card" class="card">
          <h3>Your Account Password</h3>
          <button id="pwd-btn">Reset Password</button>
        </div>
      `;

      const elements = Array.from(document.querySelectorAll<HTMLElement>('*'));
      elements.forEach(el => {
        el.getBoundingClientRect = () => ({
          left: 10,
          top: 10,
          right: 110,
          bottom: 110,
          width: 100,
          height: 100,
          x: 10,
          y: 10,
          toJSON: () => {},
        });
      });

      const regions = extractVisualRegions({ pageGeneration: 2, root: document });
      const pwdCard = regions.find(r => r.associatedElementId === 'pwd-card');
      expect(pwdCard).toBeDefined();
      expect(pwdCard?.semanticHint).toBe('Protected Credential Region');
    });

    it('filters out micro-elements smaller than 8x8 pixels', () => {
      document.body.innerHTML = `
        <button id="normal-btn">Normal</button>
        <button id="micro-btn">Micro</button>
      `;

      const normal = document.getElementById('normal-btn')!;
      normal.getBoundingClientRect = () => ({
        left: 0, top: 0, right: 80, bottom: 30, width: 80, height: 30, x: 0, y: 0, toJSON: () => {}
      });

      const micro = document.getElementById('micro-btn')!;
      micro.getBoundingClientRect = () => ({
        left: 0, top: 0, right: 4, bottom: 4, width: 4, height: 4, x: 0, y: 0, toJSON: () => {}
      });

      const regions = extractVisualRegions({ pageGeneration: 1, root: document });
      expect(regions.some(r => r.associatedElementId === 'normal-btn')).toBe(true);
      expect(regions.some(r => r.associatedElementId === 'micro-btn')).toBe(false);
    });
  });
});
