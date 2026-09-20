/**
 * PrivAgent 2.0 — Subphase P2.3: Local Image & Object Perception Test Suite
 *
 * Covers:
 *  1. LocalVisionProvider pluggable interface and provider switching
 *  2. Deterministic layout-based visual object categorization (icons, logos, avatars, product photos, banners, controls)
 *  3. Explicit perception source tagging (source: 'layout')
 *  4. Generation stamping (pageGeneration)
 *  5. Image label sanitization (zero raw credential propagation)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DeterministicLayoutVisionProvider,
  detectVisualObjects,
  setLocalVisionProvider,
  LocalVisionProvider,
} from '../extension/src/visualPerception/localImagePerception';
import { ImageFinding } from '../extension/src/visualPerception/visualTypes';

describe('Subphase P2.3 — Local Image & Object Perception', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    setLocalVisionProvider(new DeterministicLayoutVisionProvider());
  });

  describe('Deterministic Layout Vision Categorization', () => {
    it('categorizes icons, logos, avatars, product photos, banners, and visual controls', async () => {
      document.body.innerHTML = `
        <header>
          <img id="site-logo" class="logo" alt="ApexStore Brand Logo" style="width: 150px; height: 50px;" />
        </header>
        <div id="user-profile">
          <img id="user-avatar" class="avatar" alt="John Doe Profile" style="width: 40px; height: 40px;" />
        </div>
        <article class="product-card">
          <img id="prod-img" alt="Wireless Noise Cancelling Headphones" style="width: 200px; height: 200px;" />
        </article>
        <div class="hero">
          <img id="hero-banner" alt="Summer Mega Sale Banner" style="width: 600px; height: 180px;" />
        </div>
        <button id="search-btn">
          <svg id="search-icon" class="icon" style="width: 20px; height: 20px;"></svg>
        </button>
      `;

      // Mock getBoundingClientRect
      const logo = document.getElementById('site-logo')!;
      logo.getBoundingClientRect = () => ({
        left: 10, top: 10, right: 160, bottom: 60, width: 150, height: 50, x: 10, y: 10, toJSON: () => {}
      });

      const avatar = document.getElementById('user-avatar')!;
      avatar.getBoundingClientRect = () => ({
        left: 200, top: 10, right: 240, bottom: 50, width: 40, height: 40, x: 200, y: 10, toJSON: () => {}
      });

      const prodImg = document.getElementById('prod-img')!;
      prodImg.getBoundingClientRect = () => ({
        left: 50, top: 100, right: 250, bottom: 300, width: 200, height: 200, x: 50, y: 100, toJSON: () => {}
      });

      const banner = document.getElementById('hero-banner')!;
      banner.getBoundingClientRect = () => ({
        left: 0, top: 350, right: 600, bottom: 530, width: 600, height: 180, x: 0, y: 350, toJSON: () => {}
      });

      const icon = document.getElementById('search-icon')!;
      icon.getBoundingClientRect = () => ({
        left: 20, top: 20, right: 40, bottom: 40, width: 20, height: 20, x: 20, y: 20, toJSON: () => {}
      });

      const findings = await detectVisualObjects({ pageGeneration: 5, root: document });
      expect(findings.length).toBeGreaterThanOrEqual(5);

      // Verify logo
      const logoFinding = findings.find(f => f.associatedElementId === 'site-logo');
      expect(logoFinding).toBeDefined();
      expect(logoFinding?.type).toBe('logo');
      expect(logoFinding?.source).toBe('layout'); // Honest capability labeling
      expect(logoFinding?.pageGeneration).toBe(5);

      // Verify avatar
      const avatarFinding = findings.find(f => f.associatedElementId === 'user-avatar');
      expect(avatarFinding).toBeDefined();
      expect(avatarFinding?.type).toBe('avatar');
      expect(avatarFinding?.source).toBe('layout');

      // Verify product image
      const prodFinding = findings.find(f => f.associatedElementId === 'prod-img');
      expect(prodFinding).toBeDefined();
      expect(prodFinding?.type).toBe('product_image');

      // Verify banner
      const bannerFinding = findings.find(f => f.associatedElementId === 'hero-banner');
      expect(bannerFinding).toBeDefined();
      expect(bannerFinding?.type).toBe('banner');

      // Verify icon
      const iconFinding = findings.find(f => f.associatedElementId === 'search-icon');
      expect(iconFinding).toBeDefined();
      expect(iconFinding?.type).toBe('icon');
    });

    it('sanitizes credential references in image alt and title attributes', async () => {
      document.body.innerHTML = `
        <img id="bad-img" alt="Master Password Secret Key" style="width: 80px; height: 80px;" />
      `;

      const img = document.getElementById('bad-img')!;
      img.getBoundingClientRect = () => ({
        left: 0, top: 0, right: 80, bottom: 80, width: 80, height: 80, x: 0, y: 0, toJSON: () => {}
      });

      const findings = await detectVisualObjects({ pageGeneration: 1, root: document });
      expect(findings.length).toBe(1);
      expect(findings[0]!.label).toBe('Protected Credential Asset');
    });
  });

  describe('LocalVisionProvider Abstraction', () => {
    it('supports custom LocalVisionProvider with simulated pixel/vision source', async () => {
      const customProvider: LocalVisionProvider = {
        async detect(input): Promise<ImageFinding[]> {
          return [
            {
              id: `vision-g${input.pageGeneration}-1`,
              type: 'product_image',
              bbox: [100, 100, 200, 200],
              confidence: 0.99,
              pageGeneration: input.pageGeneration,
              source: 'vision',
              label: 'Verified Vision Model Detection',
            },
          ];
        },
      };

      setLocalVisionProvider(customProvider);

      const findings = await detectVisualObjects({ pageGeneration: 9 });
      expect(findings.length).toBe(1);
      expect(findings[0]!.source).toBe('vision');
      expect(findings[0]!.pageGeneration).toBe(9);
      expect(findings[0]!.label).toBe('Verified Vision Model Detection');
    });
  });
});
