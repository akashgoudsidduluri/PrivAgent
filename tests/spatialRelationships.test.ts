/**
 * PrivAgent 2.0 — Spatial Relationships Test Suite (Phase 1)
 *
 * Exhaustively validates deterministic bounding-box spatial relationships:
 * ABOVE, BELOW, LEFT_OF, RIGHT_OF, CONTAINS, INSIDE, OVERLAPS, ADJACENT_TO, NEAR.
 */

import { describe, it, expect } from 'vitest';
import {
  toRect,
  computeEdgeDistance,
  computeCentroidDistance,
  isContains,
  isOverlaps,
  isAbove,
  isBelow,
  isLeftOf,
  isRightOf,
  isAdjacent,
  isNear,
  computeSpatialRelationships,
} from '../extension/src/worldModel/spatialEngine';

describe('SpatialEngine — Geometric Relationships', () => {
  it('computes rect coordinates correctly', () => {
    const rect = toRect([10, 20, 100, 50]);
    expect(rect.left).toBe(10);
    expect(rect.top).toBe(20);
    expect(rect.right).toBe(110);
    expect(rect.bottom).toBe(70);
    expect(rect.centerX).toBe(60);
    expect(rect.centerY).toBe(45);
  });

  it('detects strict CONTAINS and INSIDE relationships', () => {
    const parent = toRect([0, 0, 300, 300]);
    const child = toRect([50, 50, 100, 100]);
    const outside = toRect([400, 400, 100, 100]);

    expect(isContains(parent, child)).toBe(true);
    expect(isContains(child, parent)).toBe(false);
    expect(isContains(parent, outside)).toBe(false);
  });

  it('detects partial OVERLAPS without strict containment', () => {
    const r1 = toRect([0, 0, 100, 100]);
    const r2 = toRect([50, 50, 100, 100]);
    const r3 = toRect([200, 200, 50, 50]);

    expect(isOverlaps(r1, r2)).toBe(true);
    expect(isOverlaps(r1, r3)).toBe(false);
  });

  it('detects ABOVE and BELOW directional positioning', () => {
    const topBar = toRect([100, 0, 400, 50]);
    const mainContent = toRect([100, 80, 400, 300]);

    expect(isAbove(topBar, mainContent)).toBe(true);
    expect(isBelow(mainContent, topBar)).toBe(true);
    expect(isAbove(mainContent, topBar)).toBe(false);
  });

  it('detects LEFT_OF and RIGHT_OF directional positioning', () => {
    const sidebar = toRect([0, 100, 200, 500]);
    const content = toRect([220, 100, 600, 500]);

    expect(isLeftOf(sidebar, content)).toBe(true);
    expect(isRightOf(content, sidebar)).toBe(true);
    expect(isLeftOf(content, sidebar)).toBe(false);
  });

  it('calculates edge and centroid distances accurately', () => {
    const r1 = toRect([0, 0, 100, 100]);
    const r2 = toRect([120, 0, 100, 100]); // 20px gap on X axis

    expect(computeEdgeDistance(r1, r2)).toBe(20);
    expect(computeCentroidDistance(r1, r2)).toBe(120);
  });

  it('detects ADJACENT_TO when edge gap <= threshold (24px)', () => {
    const b1 = toRect([100, 100, 80, 35]);
    const b2 = toRect([190, 100, 80, 35]); // 10px gap
    const b3 = toRect([300, 100, 80, 35]); // 120px gap

    expect(isAdjacent(b1, b2, 24)).toBe(true);
    expect(isAdjacent(b1, b3, 24)).toBe(false);
  });

  it('detects NEAR when centroid distance <= threshold (150px)', () => {
    const a = toRect([100, 100, 50, 50]);
    const b = toRect([180, 120, 50, 50]);
    const far = toRect([800, 600, 50, 50]);

    expect(isNear(a, b, 150)).toBe(true);
    expect(isNear(a, far, 150)).toBe(false);
  });

  it('generates multi-element spatial relationship graphs without crashing or quadratic explosion', () => {
    const items = [
      { id: 'card-1', bbox: [100, 100, 250, 350] as [number, number, number, number] },
      { id: 'img-1', bbox: [110, 110, 230, 150] as [number, number, number, number] },
      { id: 'title-1', bbox: [110, 270, 230, 30] as [number, number, number, number] },
      { id: 'price-1', bbox: [110, 310, 100, 25] as [number, number, number, number] },
      { id: 'btn-1', bbox: [110, 345, 120, 35] as [number, number, number, number] },
    ];

    const rels = computeSpatialRelationships(items);
    expect(rels.length).toBeGreaterThan(5);

    // card-1 CONTAINS btn-1
    const cardContainsBtn = rels.some(
      r => r.sourceId === 'card-1' && r.targetId === 'btn-1' && r.relation === 'CONTAINS'
    );
    expect(cardContainsBtn).toBe(true);

    // btn-1 INSIDE card-1
    const btnInsideCard = rels.some(
      r => r.sourceId === 'btn-1' && r.targetId === 'card-1' && r.relation === 'INSIDE'
    );
    expect(btnInsideCard).toBe(true);

    // img-1 ABOVE btn-1
    const imgAboveBtn = rels.some(
      r => r.sourceId === 'img-1' && r.targetId === 'btn-1' && r.relation === 'ABOVE'
    );
    expect(imgAboveBtn).toBe(true);
  });
});
