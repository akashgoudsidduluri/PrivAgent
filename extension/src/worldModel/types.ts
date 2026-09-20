/**
 * PrivAgent 2.0 — Browser World Model Type Definitions (Phase 1)
 *
 * Provides a strongly typed, unified structural and spatial representation
 * of the active web page by combining DOM perception, accessibility hierarchy,
 * interactive controls, spatial geometry, and candidate entities.
 *
 * Security & Privacy Invariants:
 *  1. NEVER exposes raw passwords, credentials, OTPs, CVVs, card numbers, or tokens.
 *  2. Elements, accessibility nodes, and entities contain ONLY safe structural metadata.
 *  3. All bounding boxes use standard [x, y, width, height] viewport coordinates.
 *  4. Monotonic pageGeneration stamps every node to prevent stale-world execution.
 */

import { DetectionEntityType, SensitiveEntityType, InteractiveEntityType } from '../privacy/types';
import { CandidateEntityType } from '../agent/candidateEntities';

export type SpatialRelationType =
  | 'ABOVE'
  | 'BELOW'
  | 'LEFT_OF'
  | 'RIGHT_OF'
  | 'INSIDE'
  | 'CONTAINS'
  | 'NEAR'
  | 'OVERLAPS'
  | 'ADJACENT_TO';

export type SemanticRelationType =
  | 'HAS_TITLE'
  | 'HAS_PRICE'
  | 'HAS_IMAGE'
  | 'HAS_ACTION'
  | 'LABEL_FOR'
  | 'SUBMIT_FOR'
  | 'MEMBER_OF'
  | 'CHILD_OF'
  | 'PARENT_OF';

export interface ViewportGeometry {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  devicePixelRatio: number;
}

export interface PageModel {
  url: string;
  origin: string;
  title: string;
  pageType: string;
  pageGeneration: number;
  isReady: boolean;
  hasActiveModal: boolean;
  activeModalSelector?: string;
  activeModalLabel?: string;
  totalDomElements: number;
  isLargeDom: boolean;
  timestamp: number;
}

export interface DomWorldElement {
  id: string;
  tag: string;
  role?: string;
  type: DetectionEntityType;
  label: string;
  bbox: [number, number, number, number]; // [x, y, width, height]
  selector: string;
  isVisible: boolean;
  isEnabled: boolean;
  pageGeneration: number;
  source: 'DOM' | 'OCR' | 'FUSED';
  confidence: number;
  isSensitive: boolean;
  length?: number;
}

export interface AccessibilityNode {
  id: string;
  elementId?: string;
  role: string;
  name: string; // Sanitized accessible name (zero credentials)
  bbox: [number, number, number, number];
  disabled: boolean;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  focused?: boolean;
  modal?: boolean;
  childrenIds: string[];
  parentId?: string;
}

export interface SpatialRelationship {
  sourceId: string;
  targetId: string;
  relation: SpatialRelationType;
  distancePixels: number;
}

export interface SemanticRelationship {
  sourceId: string;
  targetId: string;
  relation: SemanticRelationType;
  confidence: number;
}

export interface WorldEntity {
  id: string;
  type: CandidateEntityType;
  title: string;
  bbox: [number, number, number, number];
  associatedElementIds: string[];
  attributes: Record<string, string | number | boolean>;
  confidence: number;
  pageGeneration: number;
}

export interface SafeTextRegion {
  id: string;
  bbox: [number, number, number, number];
  length: number;
  tag: string;
  isHeading: boolean;
  sanitizedPreview: string;
}

export interface SafeOCRRegion {
  id: string;
  bbox: [number, number, number, number];
  confidence: number;
  isSensitive: boolean;
  sensitiveType?: SensitiveEntityType;
}

export interface ActiveWorldModelRef {
  pageGeneration: number;
  worldModelId: string;
}

export interface BrowserWorldModel {
  id: string;
  page: PageModel;
  viewport: ViewportGeometry;
  elements: DomWorldElement[];
  accessibilityTree: AccessibilityNode[];
  entities: WorldEntity[];
  spatialRelationships: SpatialRelationship[];
  semanticRelationships: SemanticRelationship[];
  textRegions: SafeTextRegion[];
  ocrRegions: SafeOCRRegion[];
  buildDurationMs: number;
}

/**
 * Compact sanitized summary safe for context minimization and LLM reasoners.
 * Contains only structural IDs, types, roles, and geometry.
 */
export interface SanitizedWorldModelSummary {
  pageType: string;
  url: string;
  pageGeneration: number;
  viewport: { width: number; height: number };
  elementCount: number;
  interactiveCount: number;
  entityCount: number;
  hasModal: boolean;
  keyEntities: Array<{
    id: string;
    type: string;
    title: string;
    actionElementId?: string;
    bbox: [number, number, number, number];
  }>;
  spatialHighlights: Array<{
    sourceId: string;
    relation: SpatialRelationType;
    targetId: string;
  }>;
}
