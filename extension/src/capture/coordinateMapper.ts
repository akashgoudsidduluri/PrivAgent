/**
 * Coordinate Mapper for PrivAgent
 * Transforms DOM elements and bounding boxes into authoritative screenshot pixel coordinates.
 * 
 * Handles:
 * - Viewport coordinates vs Document coordinates
 * - Scrolling offsets
 * - Viewport clipping and partial visibility
 * - High-DPI / custom display scaling via empirical scale factors
 *   (scaleX = actualScreenshotWidth / viewportWidth, scaleY = actualScreenshotHeight / viewportHeight)
 */

export interface ViewportGeometry {
  viewportWidth: number;
  viewportHeight: number;
  scrollX: number;
  scrollY: number;
  devicePixelRatio: number;
}

export interface ActualScreenshotDimensions {
  screenshotWidth: number;
  screenshotHeight: number;
}

export interface MappedCoordinateResult {
  /** Viewport coordinates after clipping to visible viewport bounds: [clientX, clientY, width, height] */
  viewportBBox: [number, number, number, number];
  /** Authoritative pixel coordinates on the captured screenshot bitmap: [sx, sy, sw, sh] */
  screenshotBBox: [number, number, number, number];
  /** Whether the original element is partially clipped by the viewport boundaries */
  isPartiallyVisible: boolean;
  /** Empirical scale factors derived from actual screenshot dimensions */
  scaleX: number;
  scaleY: number;
}

/**
 * Converts document coordinates (relative to full HTML page) into viewport coordinates (relative to current visible window).
 */
export function documentToViewportBBox(
  docBBox: [number, number, number, number],
  scrollX: number,
  scrollY: number
): [number, number, number, number] {
  const [docX, docY, width, height] = docBBox;
  return [
    Math.round(docX - scrollX),
    Math.round(docY - scrollY),
    Math.round(width),
    Math.round(height),
  ];
}

/**
 * Clips a viewport bounding box against the visible viewport window [0, 0, viewportWidth, viewportHeight].
 * Returns null if the box is completely off-screen.
 */
export function clipToViewport(
  viewportBBox: [number, number, number, number],
  viewportWidth: number,
  viewportHeight: number
): { clippedBBox: [number, number, number, number]; isPartiallyVisible: boolean } | null {
  const [left, top, width, height] = viewportBBox;

  if (width <= 0 || height <= 0) {
    return null;
  }

  const right = left + width;
  const bottom = top + height;

  // Check if completely outside viewport
  if (right <= 0 || bottom <= 0 || left >= viewportWidth || top >= viewportHeight) {
    return null;
  }

  const clippedLeft = Math.max(0, left);
  const clippedTop = Math.max(0, top);
  const clippedRight = Math.min(viewportWidth, right);
  const clippedBottom = Math.min(viewportHeight, bottom);

  const clippedWidth = clippedRight - clippedLeft;
  const clippedHeight = clippedBottom - clippedTop;

  if (clippedWidth <= 0 || clippedHeight <= 0) {
    return null;
  }

  const isPartiallyVisible =
    clippedLeft !== left ||
    clippedTop !== top ||
    clippedRight !== right ||
    clippedBottom !== bottom;

  return {
    clippedBBox: [clippedLeft, clippedTop, clippedWidth, clippedHeight],
    isPartiallyVisible,
  };
}

/**
 * Maps a DOM bounding box (in document or viewport space) to authoritative screenshot pixel coordinates.
 * 
 * Uses actual captured image dimensions rather than assuming nominal DPR:
 * scaleX = actualScreenshotWidth / viewportWidth
 * scaleY = actualScreenshotHeight / viewportHeight
 */
export function mapDOMToScreenshot(
  rawBBox: [number, number, number, number],
  geometry: ViewportGeometry,
  screenshot: ActualScreenshotDimensions,
  isDocumentCoordinate = true
): MappedCoordinateResult | null {
  const { viewportWidth, viewportHeight, scrollX, scrollY } = geometry;
  const { screenshotWidth, screenshotHeight } = screenshot;

  if (viewportWidth <= 0 || viewportHeight <= 0 || screenshotWidth <= 0 || screenshotHeight <= 0) {
    return null;
  }

  // 1. Convert to viewport coordinates if input is in document space
  const viewportBox = isDocumentCoordinate
    ? documentToViewportBBox(rawBBox, scrollX, scrollY)
    : rawBBox;

  // 2. Clip against viewport boundaries
  const clipResult = clipToViewport(viewportBox, viewportWidth, viewportHeight);
  if (!clipResult) {
    return null; // Completely off-screen
  }

  const { clippedBBox, isPartiallyVisible } = clipResult;
  const [clientX, clientY, clientW, clientH] = clippedBBox;

  // 3. Derive empirical scale factors from authoritative screenshot dimensions
  const scaleX = screenshotWidth / viewportWidth;
  const scaleY = screenshotHeight / viewportHeight;

  // 4. Transform into screenshot bitmap pixels
  const sx = Math.round(clientX * scaleX);
  const sy = Math.round(clientY * scaleY);
  const sw = Math.round(clientW * scaleX);
  const sh = Math.round(clientH * scaleY);

  // Ensure transformed box stays within actual screenshot bounds
  const clampedSx = Math.max(0, Math.min(sx, screenshotWidth));
  const clampedSy = Math.max(0, Math.min(sy, screenshotHeight));
  const clampedSw = Math.min(sw, screenshotWidth - clampedSx);
  const clampedSh = Math.min(sh, screenshotHeight - clampedSy);

  if (clampedSw <= 0 || clampedSh <= 0) {
    return null;
  }

  return {
    viewportBBox: [clientX, clientY, clientW, clientH],
    screenshotBBox: [clampedSx, clampedSy, clampedSw, clampedSh],
    isPartiallyVisible,
    scaleX,
    scaleY,
  };
}
