/**
 * PrivAgent 2.0 — Browser World Model Builder (Phase 1)
 *
 * Deterministically constructs the comprehensive BrowserWorldModel from the live DOM,
 * accessibility hierarchy, spatial geometry, and candidate entities.
 *
 * Security & Privacy Invariants:
 *  1. Zero raw PII: Input values, passwords, credentials, tokens are NEVER included.
 *  2. All elements stamped with monotonic pageGeneration.
 *  3. Computes deterministic spatial and semantic graphs on-device.
 */

import {
  BrowserWorldModel,
  PageModel,
  ViewportGeometry,
  DomWorldElement,
  SafeTextRegion,
  SafeOCRRegion,
} from './types';
import {
  VisualRegion,
  ImageFinding,
  CanvasFinding,
  VideoKeyFrameFinding,
  VisualInteractiveCandidate,
} from '../visualPerception/visualTypes';
import { PrivacyFinding } from '../privacy/fusion';
import { extractVisualRegions } from '../visualPerception/visualRegions';
import { detectCanvasAndImageUI } from '../visualPerception/canvasDetector';
import { computeSpatialRelationships } from './spatialEngine';
import { extractAccessibilityTree } from './accessibilityTree';
import { buildEntityGraph } from './entityGraph';
import {
  classifyPage,
  detectActiveModal,
  isElementVisible,
} from '../content/domInteractiveScanner';
import { DetectionEntityType, isSensitiveEntityType } from '../privacy/types';

function getBbox(el: HTMLElement): [number, number, number, number] {
  if (typeof el.getBoundingClientRect !== 'function') return [0, 0, 0, 0];
  const rect = el.getBoundingClientRect();
  const scrollX = typeof window !== 'undefined' ? window.scrollX || 0 : 0;
  const scrollY = typeof window !== 'undefined' ? window.scrollY || 0 : 0;
  return [
    Math.round(rect.left + scrollX),
    Math.round(rect.top + scrollY),
    Math.round(rect.width),
    Math.round(rect.height),
  ];
}

export interface BuildWorldModelOptions {
  id?: string;
  pageGeneration?: number;
  viewport?: ViewportGeometry;
  ocrRegions?: SafeOCRRegion[];
  visualRegions?: VisualRegion[];
  imageFindings?: ImageFinding[];
  canvasFindings?: CanvasFinding[];
  videoFindings?: VideoKeyFrameFinding[];
  interactiveCandidates?: VisualInteractiveCandidate[];
  privacyFindings?: PrivacyFinding[];
  root?: Document | HTMLElement;
}

/**
 * Builds a complete, deterministic BrowserWorldModel for the active web page.
 */
export function buildBrowserWorldModel(options: BuildWorldModelOptions = {}): BrowserWorldModel {
  const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const doc = options.root
    ? 'defaultView' in options.root
      ? (options.root as Document)
      : options.root.ownerDocument || document
    : document;
  const pageGeneration = options.pageGeneration ?? 1;
  const worldModelId = options.id || `wm-g${pageGeneration}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
  const rootEl = options.root
    ? 'defaultView' in options.root
      ? (options.root as Document).body || (options.root as Document).documentElement
      : (options.root as HTMLElement)
    : doc.body || doc.documentElement;

  // 1. Extract Viewport Geometry
  const viewport: ViewportGeometry = options.viewport || {
    width: win?.innerWidth || 1280,
    height: win?.innerHeight || 800,
    scrollX: win?.scrollX || 0,
    scrollY: win?.scrollY || 0,
    devicePixelRatio: win?.devicePixelRatio || 1,
  };

  // 2. Classify Page & Detect Active Modals
  const classifiedType = classifyPage(doc);
  const activeModal = detectActiveModal(doc);

  const page: PageModel = {
    url: (win?.location?.href || 'https://localhost/').replace(/\?.*/, ''), // Stripped of query params
    origin: win?.location?.origin || 'https://localhost',
    title: (doc.title || '').slice(0, 100),
    pageType: classifiedType,
    pageGeneration,
    isReady: doc.readyState === 'complete' || doc.readyState === 'interactive',
    hasActiveModal: Boolean(activeModal),
    activeModalSelector: activeModal?.selector,
    activeModalLabel: activeModal?.label,
    totalDomElements: doc.querySelectorAll('*').length,
    isLargeDom: doc.querySelectorAll('*').length > 800,
    timestamp: Date.now(),
  };

  // 3. Scan Interactive Elements & Candidate Interactive Nodes
  const elements: DomWorldElement[] = [];
  const interactiveCandidates = Array.from(
    rootEl.querySelectorAll<HTMLElement>(
      'button, a, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [tabindex]:not([tabindex="-1"])'
    )
  );

  interactiveCandidates.forEach((el, index) => {
    const isVisible = isElementVisible(el);
    if (!isVisible) return;

    const tag = el.tagName.toLowerCase();
    const bbox = getBbox(el);

    // Heuristic entity type mapping
    let type: DetectionEntityType = 'button';
    if (tag === 'a') type = 'link';
    else if (tag === 'select') type = 'select';
    else if (tag === 'textarea') type = 'input';
    else if (tag === 'input') {
      const inputType = (el.getAttribute('type') || 'text').toLowerCase();
      if (inputType === 'search') type = 'search';
      else if (inputType === 'password') type = 'password';
      else type = 'input';
    }

    const id = el.id || `wm-elem-${pageGeneration}-${index + 1}`;
    const placeholder = typeof (el as any).placeholder === 'string' ? (el as any).placeholder : '';
    const label = (
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      placeholder ||
      (el.innerText || el.textContent || '')
    ).trim().slice(0, 60);

    const isEnabled = !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true';

    elements.push({
      id,
      tag,
      role: el.getAttribute('role') || undefined,
      type,
      label,
      bbox,
      selector: el.id ? `#${el.id}` : tag,
      isVisible,
      isEnabled,
      pageGeneration,
      source: 'DOM',
      confidence: 1.0,
      isSensitive: isSensitiveEntityType(type),
      length: label.length,
    });
  });

  // 4. Extract Accessibility Tree
  const accessibilityTree = extractAccessibilityTree(rootEl);

  // 5. Build Entity Graph & Semantic Relationships
  const { entities, relationships: semanticRelationships } = buildEntityGraph(elements, rootEl, pageGeneration);

  // 6. Compute Deterministic Spatial Relationships
  const spatialItems = [
    ...elements.map(e => ({ id: e.id, bbox: e.bbox })),
    ...entities.map(ent => ({ id: ent.id, bbox: ent.bbox })),
  ];
  const spatialRelationships = computeSpatialRelationships(spatialItems, {
    maxRelationships: 300,
    adjacencyThreshold: 24,
    nearThreshold: 120,
  });

  // 7. Extract Safe Text Regions (Headings & major text blocks, non-sensitive)
  const textRegions: SafeTextRegion[] = [];
  const headingElements = Array.from(rootEl.querySelectorAll<HTMLElement>('h1, h2, h3, p'));
  headingElements.slice(0, 30).forEach((el, idx) => {
    const text = (el.textContent || '').trim();
    if (text.length > 2 && isElementVisible(el)) {
      textRegions.push({
        id: el.id || `text-region-${idx + 1}`,
        bbox: getBbox(el),
        length: text.length,
        tag: el.tagName.toLowerCase(),
        isHeading: ['h1', 'h2', 'h3'].includes(el.tagName.toLowerCase()),
        sanitizedPreview: text.slice(0, 40),
      });
    }
  });

  // 8. Extract Visual & Canvas Findings
  const visualRegions = options.visualRegions ?? extractVisualRegions({ pageGeneration, root: options.root });
  const canvasAndImage =
    options.canvasFindings && options.interactiveCandidates
      ? { canvasFindings: options.canvasFindings, interactiveCandidates: options.interactiveCandidates }
      : detectCanvasAndImageUI({ pageGeneration, root: options.root });

  const endTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const buildDurationMs = Math.round((endTime - startTime) * 100) / 100;

  return {
    id: worldModelId,
    page,
    viewport,
    elements,
    accessibilityTree,
    entities,
    spatialRelationships,
    semanticRelationships,
    textRegions,
    ocrRegions: options.ocrRegions ?? [],
    visualRegions,
    imageFindings: options.imageFindings ?? [],
    canvasFindings: canvasAndImage.canvasFindings,
    videoFindings: options.videoFindings ?? [],
    interactiveCandidates: canvasAndImage.interactiveCandidates,
    privacyFindings: options.privacyFindings ?? [],
    buildDurationMs,
  };
}
