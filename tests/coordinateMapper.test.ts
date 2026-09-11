/**
 * Milestone 2 Tests: Coordinate Mapper
 *
 * Verifies the coordinate transformation pipeline:
 *  - documentToViewportBBox
 *  - clipToViewport
 *  - mapDOMToScreenshot (with actual screenshot dimensions)
 *
 * Key invariant: coordinate mapping uses actual decoded screenshot dimensions,
 * NOT devicePixelRatio * viewport.
 */

import { describe, it, expect } from 'vitest';
import {
  documentToViewportBBox,
  clipToViewport,
  mapDOMToScreenshot,
  ViewportGeometry,
  ActualScreenshotDimensions,
} from '../extension/src/capture/coordinateMapper';

// ── Shared test geometry ─────────────────────────────────────────────────────

const baseGeometry: ViewportGeometry = {
  viewportWidth: 1280,
  viewportHeight: 720,
  scrollX: 0,
  scrollY: 0,
  devicePixelRatio: 2.0, // diagnostic only — NOT used for coordinate math
};

/** Standard 2× HiDPI screenshot */
const hiDpiShot: ActualScreenshotDimensions = {
  screenshotWidth: 2560,
  screenshotHeight: 1440,
};

/** Non-standard screenshot (e.g., 1.5×) — must be handled empirically */
const nonStandardShot: ActualScreenshotDimensions = {
  screenshotWidth: 1920,
  screenshotHeight: 1080,
};

// ── documentToViewportBBox ───────────────────────────────────────────────────

describe('documentToViewportBBox', () => {
  it('converts document coords to viewport coords with no scroll', () => {
    expect(documentToViewportBBox([100, 200, 300, 50], 0, 0)).toEqual([100, 200, 300, 50]);
  });

  it('subtracts scrollX and scrollY correctly', () => {
    expect(documentToViewportBBox([400, 800, 200, 60], 100, 300)).toEqual([300, 500, 200, 60]);
  });

  it('allows negative viewport coordinates for off-screen elements', () => {
    const result = documentToViewportBBox([50, 100, 200, 40], 200, 0);
    expect(result[0]).toBe(-150); // partially off-screen to the left
    expect(result[2]).toBe(200);  // width unchanged
  });

  it('rounds fractional coordinates to integers', () => {
    const result = documentToViewportBBox([100.7, 200.3, 50.9, 30.1], 0, 0);
    expect(result).toEqual([101, 200, 51, 30]);
  });
});

// ── clipToViewport ───────────────────────────────────────────────────────────

describe('clipToViewport', () => {
  const vpW = 1280;
  const vpH = 720;

  it('returns null for zero-size bounding box', () => {
    expect(clipToViewport([100, 100, 0, 0], vpW, vpH)).toBeNull();
    expect(clipToViewport([100, 100, -5, 20], vpW, vpH)).toBeNull();
  });

  it('returns null for completely off-screen box (right side)', () => {
    expect(clipToViewport([1300, 100, 100, 50], vpW, vpH)).toBeNull();
  });

  it('returns null for completely off-screen box (bottom)', () => {
    expect(clipToViewport([100, 750, 200, 100], vpW, vpH)).toBeNull();
  });

  it('returns null for completely off-screen box (left)', () => {
    expect(clipToViewport([-200, 100, 100, 50], vpW, vpH)).toBeNull();
  });

  it('returns null for completely off-screen box (top)', () => {
    expect(clipToViewport([100, -200, 200, 100], vpW, vpH)).toBeNull();
  });

  it('preserves fully visible box unchanged', () => {
    const result = clipToViewport([100, 100, 200, 50], vpW, vpH);
    expect(result).not.toBeNull();
    expect(result!.clippedBBox).toEqual([100, 100, 200, 50]);
    expect(result!.isPartiallyVisible).toBe(false);
  });

  it('clips box partially off the right edge', () => {
    const result = clipToViewport([1200, 100, 200, 50], vpW, vpH);
    expect(result).not.toBeNull();
    expect(result!.clippedBBox[0]).toBe(1200);
    expect(result!.clippedBBox[2]).toBe(80); // 1280 - 1200
    expect(result!.isPartiallyVisible).toBe(true);
  });

  it('clips box partially off the top edge', () => {
    const result = clipToViewport([100, -30, 200, 100], vpW, vpH);
    expect(result).not.toBeNull();
    expect(result!.clippedBBox[1]).toBe(0);
    expect(result!.clippedBBox[3]).toBe(70); // 100 - 30
    expect(result!.isPartiallyVisible).toBe(true);
  });

  it('clips box crossing all four edges', () => {
    const result = clipToViewport([-50, -50, 1400, 900], vpW, vpH);
    expect(result).not.toBeNull();
    expect(result!.clippedBBox).toEqual([0, 0, vpW, vpH]);
    expect(result!.isPartiallyVisible).toBe(true);
  });
});

// ── mapDOMToScreenshot ───────────────────────────────────────────────────────

describe('mapDOMToScreenshot — actual screenshot dimensions as authority', () => {
  it('maps a centered DOM element to correct 2× HiDPI screenshot coordinates', () => {
    // Element at document (100, 200, 300, 50), no scroll
    const result = mapDOMToScreenshot([100, 200, 300, 50], baseGeometry, hiDpiShot, true);
    expect(result).not.toBeNull();
    // scaleX = 2560/1280 = 2.0, scaleY = 1440/720 = 2.0
    expect(result!.screenshotBBox).toEqual([200, 400, 600, 100]);
    expect(result!.scaleX).toBeCloseTo(2.0);
    expect(result!.scaleY).toBeCloseTo(2.0);
    expect(result!.isPartiallyVisible).toBe(false);
  });

  it('maps correctly with non-standard screenshot dimensions (1.5× empirical scale)', () => {
    // Element at document (0, 0, 640, 360), no scroll, viewport 1280×720
    const result = mapDOMToScreenshot([0, 0, 640, 360], baseGeometry, nonStandardShot, true);
    expect(result).not.toBeNull();
    // scaleX = 1920/1280 = 1.5, scaleY = 1080/720 = 1.5
    expect(result!.screenshotBBox).toEqual([0, 0, 960, 540]);
    expect(result!.scaleX).toBeCloseTo(1.5);
    expect(result!.scaleY).toBeCloseTo(1.5);
  });

  it('correctly accounts for scroll offset', () => {
    const geometry: ViewportGeometry = { ...baseGeometry, scrollX: 0, scrollY: 500 };
    // Element at document Y=600, after 500px scroll → viewportY = 100
    const result = mapDOMToScreenshot([0, 600, 400, 50], geometry, hiDpiShot, true);
    expect(result).not.toBeNull();
    // viewportY = 600 - 500 = 100; screenshotY = 100 * 2 = 200
    expect(result!.screenshotBBox[1]).toBe(200);
  });

  it('returns null for element completely below the viewport', () => {
    const geometry: ViewportGeometry = { ...baseGeometry, scrollX: 0, scrollY: 0 };
    // Element at document Y=800 which is below viewport (height=720)
    const result = mapDOMToScreenshot([0, 800, 400, 50], geometry, hiDpiShot, true);
    expect(result).toBeNull();
  });

  it('returns null for element completely above the viewport', () => {
    const geometry: ViewportGeometry = { ...baseGeometry, scrollX: 0, scrollY: 1000 };
    // Element at document Y=200, scroll=1000 → viewportY = -800 (off-screen top)
    const result = mapDOMToScreenshot([0, 200, 400, 50], geometry, hiDpiShot, true);
    expect(result).toBeNull();
  });

  it('marks partially clipped elements as isPartiallyVisible', () => {
    // Element near the bottom edge, partially off-screen
    const result = mapDOMToScreenshot([0, 700, 400, 100], baseGeometry, hiDpiShot, true);
    expect(result).not.toBeNull();
    expect(result!.isPartiallyVisible).toBe(true);
    // Visible height: 720 - 700 = 20 → screenshotHeight = 20 * 2 = 40
    expect(result!.screenshotBBox[3]).toBe(40);
  });

  it('clamps screenshot coordinates to actual screenshot bounds', () => {
    // A 1:1 screenshot (no scaling)
    const sameShot: ActualScreenshotDimensions = { screenshotWidth: 1280, screenshotHeight: 720 };
    const result = mapDOMToScreenshot([0, 0, 1280, 720], baseGeometry, sameShot, true);
    expect(result).not.toBeNull();
    expect(result!.screenshotBBox).toEqual([0, 0, 1280, 720]);
  });

  it('handles viewport coordinates mode (isDocumentCoordinate=false)', () => {
    // Pass viewport coords directly (scrollX/Y should not be subtracted)
    const result = mapDOMToScreenshot([100, 100, 200, 50], baseGeometry, hiDpiShot, false);
    expect(result).not.toBeNull();
    expect(result!.screenshotBBox).toEqual([200, 200, 400, 100]);
  });

  it('returns null for invalid viewport geometry', () => {
    const badGeo: ViewportGeometry = { ...baseGeometry, viewportWidth: 0, viewportHeight: 0 };
    expect(mapDOMToScreenshot([0, 0, 100, 100], badGeo, hiDpiShot, true)).toBeNull();
  });

  it('returns null for invalid screenshot dimensions', () => {
    const badShot: ActualScreenshotDimensions = { screenshotWidth: 0, screenshotHeight: 0 };
    expect(mapDOMToScreenshot([0, 0, 100, 100], baseGeometry, badShot, true)).toBeNull();
  });
});

// ── Invariant: devicePixelRatio is NEVER used as the scale factor ────────────

describe('DPR diagnostic invariant', () => {
  it('produces different results when screenshot dimensions differ from DPR prediction', () => {
    // If DPR=2 and viewport=1280×720, naive DPR prediction would be 2560×1440
    // But actual screenshot might be 1920×1080 (e.g., display scaling override)
    const dprPredicted: ActualScreenshotDimensions = { screenshotWidth: 2560, screenshotHeight: 1440 };
    const empirical: ActualScreenshotDimensions = { screenshotWidth: 1920, screenshotHeight: 1080 };

    const resDpr = mapDOMToScreenshot([100, 100, 200, 50], baseGeometry, dprPredicted, true);
    const resEmp = mapDOMToScreenshot([100, 100, 200, 50], baseGeometry, empirical, true);

    // Coordinates must differ because actual dimensions differ
    expect(resDpr!.screenshotBBox).not.toEqual(resEmp!.screenshotBBox);

    // Empirical scale factors should reflect actual dimensions
    expect(resEmp!.scaleX).toBeCloseTo(1.5); // 1920/1280
    expect(resEmp!.scaleY).toBeCloseTo(1.5); // 1080/720
    expect(resDpr!.scaleX).toBeCloseTo(2.0); // 2560/1280
  });
});
