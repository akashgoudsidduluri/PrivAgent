/**
 * PrivAgent 2.0 — Deterministic Spatial Relationship Engine (Phase 1)
 *
 * Computes deterministic geometric relationships between screen bounding boxes.
 * Bounding boxes are in standard format: [x, y, width, height].
 *
 * Supported Spatial Relations:
 *  - CONTAINS: Element A completely encloses Element B.
 *  - INSIDE: Element A is completely enclosed by Element B.
 *  - OVERLAPS: Element A and Element B intersect.
 *  - ABOVE: Element A is positioned vertically higher than Element B.
 *  - BELOW: Element A is positioned vertically lower than Element B.
 *  - LEFT_OF: Element A is positioned horizontally to the left of Element B.
 *  - RIGHT_OF: Element A is positioned horizontally to the right of Element B.
 *  - ADJACENT_TO: Element A and Element B borders are within close proximity (<= 24px).
 *  - NEAR: Element A and Element B centroids are within neighborhood distance (<= 150px).
 */

import { SpatialRelationship, SpatialRelationType } from './types';

export interface SpatialItem {
  id: string;
  bbox: [number, number, number, number];
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

export function toRect(bbox: [number, number, number, number]): Rect {
  const [x, y, w, h] = bbox;
  return {
    left: x,
    top: y,
    right: x + w,
    bottom: y + h,
    width: w,
    height: h,
    centerX: x + w / 2,
    centerY: y + h / 2,
  };
}

/**
 * Computes minimum edge-to-edge Euclidean distance between two non-overlapping rectangles.
 * Returns 0 if rectangles intersect.
 */
export function computeEdgeDistance(r1: Rect, r2: Rect): number {
  const dx = Math.max(0, Math.max(r1.left, r2.left) - Math.min(r1.right, r2.right));
  const dy = Math.max(0, Math.max(r1.top, r2.top) - Math.min(r1.bottom, r2.bottom));
  return Math.round(Math.sqrt(dx * dx + dy * dy));
}

/**
 * Computes centroid-to-centroid Euclidean distance.
 */
export function computeCentroidDistance(r1: Rect, r2: Rect): number {
  const dx = r1.centerX - r2.centerX;
  const dy = r1.centerY - r2.centerY;
  return Math.round(Math.sqrt(dx * dx + dy * dy));
}

/**
 * Determines if r1 strictly contains r2.
 */
export function isContains(r1: Rect, r2: Rect): boolean {
  return (
    r1.left <= r2.left &&
    r1.top <= r2.top &&
    r1.right >= r2.right &&
    r1.bottom >= r2.bottom &&
    (r1.width > r2.width || r1.height > r2.height)
  );
}

/**
 * Determines if r1 and r2 overlap (intersection area > 0).
 */
export function isOverlaps(r1: Rect, r2: Rect): boolean {
  const xOverlap = Math.max(0, Math.min(r1.right, r2.right) - Math.max(r1.left, r2.left));
  const yOverlap = Math.max(0, Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top));
  return xOverlap > 0 && yOverlap > 0;
}

/**
 * Determines if r1 is strictly above r2 with horizontal alignment or close proximity.
 */
export function isAbove(r1: Rect, r2: Rect, maxHorizOffset: number = 60): boolean {
  if (r1.bottom > r2.top) return false;
  // Horizontal projection gap
  const horizGap = Math.max(0, Math.max(r1.left, r2.left) - Math.min(r1.right, r2.right));
  return horizGap <= maxHorizOffset;
}

/**
 * Determines if r1 is strictly below r2.
 */
export function isBelow(r1: Rect, r2: Rect, maxHorizOffset: number = 60): boolean {
  return isAbove(r2, r1, maxHorizOffset);
}

/**
 * Determines if r1 is strictly to the left of r2 with vertical alignment or close proximity.
 */
export function isLeftOf(r1: Rect, r2: Rect, maxVertOffset: number = 60): boolean {
  if (r1.right > r2.left) return false;
  // Vertical projection gap
  const vertGap = Math.max(0, Math.max(r1.top, r2.top) - Math.min(r1.bottom, r2.bottom));
  return vertGap <= maxVertOffset;
}

/**
 * Determines if r1 is strictly to the right of r2.
 */
export function isRightOf(r1: Rect, r2: Rect, maxVertOffset: number = 60): boolean {
  return isLeftOf(r2, r1, maxVertOffset);
}

/**
 * Determines if r1 and r2 are adjacent (edge distance <= threshold).
 */
export function isAdjacent(r1: Rect, r2: Rect, threshold: number = 24): boolean {
  return computeEdgeDistance(r1, r2) <= threshold;
}

/**
 * Determines if r1 and r2 are near (centroid distance <= threshold).
 */
export function isNear(r1: Rect, r2: Rect, threshold: number = 150): boolean {
  return computeCentroidDistance(r1, r2) <= threshold;
}

/**
 * Computes all pairwise spatial relationships between a collection of spatial items.
 * Bounded by maxRelationships to prevent quadratic explosion on dense DOMs.
 */
export function computeSpatialRelationships(
  items: SpatialItem[],
  options: {
    maxRelationships?: number;
    adjacencyThreshold?: number;
    nearThreshold?: number;
  } = {}
): SpatialRelationship[] {
  const maxRel = options.maxRelationships ?? 400;
  const adjThresh = options.adjacencyThreshold ?? 24;
  const nearThresh = options.nearThreshold ?? 150;

  const relationships: SpatialRelationship[] = [];
  const rects = items.map(item => ({
    id: item.id,
    rect: toRect(item.bbox),
  }));

  // Filter out invalid zero-dimension items
  const valid = rects.filter(r => r.rect.width > 0 && r.rect.height > 0);

  for (let i = 0; i < valid.length; i++) {
    for (let j = 0; j < valid.length; j++) {
      if (i === j) continue;
      if (relationships.length >= maxRel) break;

      const itemA = valid[i];
      const itemB = valid[j];
      if (!itemA || !itemB) continue;
      const rA = itemA.rect;
      const rB = itemB.rect;

      const edgeDist = computeEdgeDistance(rA, rB);
      const centroidDist = computeCentroidDistance(rA, rB);

      // 1. Containment
      if (isContains(rA, rB)) {
        relationships.push({
          sourceId: itemA.id,
          targetId: itemB.id,
          relation: 'CONTAINS',
          distancePixels: 0,
        });
        relationships.push({
          sourceId: itemB.id,
          targetId: itemA.id,
          relation: 'INSIDE',
          distancePixels: 0,
        });
        continue;
      }

      // 2. Overlap (partial)
      if (isOverlaps(rA, rB)) {
        relationships.push({
          sourceId: itemA.id,
          targetId: itemB.id,
          relation: 'OVERLAPS',
          distancePixels: 0,
        });
      }

      // 3. Directional relationships
      if (isAbove(rA, rB)) {
        relationships.push({
          sourceId: itemA.id,
          targetId: itemB.id,
          relation: 'ABOVE',
          distancePixels: edgeDist,
        });
      } else if (isBelow(rA, rB)) {
        relationships.push({
          sourceId: itemA.id,
          targetId: itemB.id,
          relation: 'BELOW',
          distancePixels: edgeDist,
        });
      }

      if (isLeftOf(rA, rB)) {
        relationships.push({
          sourceId: itemA.id,
          targetId: itemB.id,
          relation: 'LEFT_OF',
          distancePixels: edgeDist,
        });
      } else if (isRightOf(rA, rB)) {
        relationships.push({
          sourceId: itemA.id,
          targetId: itemB.id,
          relation: 'RIGHT_OF',
          distancePixels: edgeDist,
        });
      }

      // 4. Proximity relationships
      if (edgeDist <= adjThresh) {
        relationships.push({
          sourceId: itemA.id,
          targetId: itemB.id,
          relation: 'ADJACENT_TO',
          distancePixels: edgeDist,
        });
      }

      if (centroidDist <= nearThresh) {
        relationships.push({
          sourceId: itemA.id,
          targetId: itemB.id,
          relation: 'NEAR',
          distancePixels: centroidDist,
        });
      }
    }
    if (relationships.length >= maxRel) break;
  }

  return relationships;
}
