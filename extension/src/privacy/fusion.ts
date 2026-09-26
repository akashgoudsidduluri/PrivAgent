/**
 * PrivAgent — Privacy Fusion (M8: Privacy Fusion + Context Minimization)
 *
 * A single NORMALIZED representation for privacy findings produced by the
 * existing local perception sources, plus deterministic fusion rules that turn
 * multiple signals about the same sensitive element into ONE finding.
 *
 *   DOM (M1 scanDOM)              ─┐
 *   Visual / coordinate mapping (M2)├─→ fusePrivacyFindings() ─→ PrivacyFinding[]
 *   OCR (M3 OCR detector)          ─┘
 *
 * Design rules (do not break):
 *  1. This module DUPLICATES NO DETECTOR. It only adapts the outputs that the
 *     existing M1/M2/M3 detectors already produce (DetectionResult,
 *     VisualDetectionResult, SafeOCRDetection, AgentDetection) into a common
 *     shape. Detector precision/recall is unchanged.
 *  2. Fusion NEVER weakens privacy. When several signals describe the same
 *     element the decision is the STRONGEST applicable one (highest severity,
 *     must-redact OR-ed); the lowest-confidence contributor can never lower the
 *     verdict. All contributing sources are retained for auditability.
 *  3. Findings carry METADATA ONLY — category, confidence, geometry, evidence
 *     codes, contributing ids. No raw values, ever.
 *  4. `region` is expressed in ONE coordinate space per fusion run (the space of
 *     the inputs). The M4 agent payload is already single-space (screenshot
 *     pixels when a visual report exists, document pixels otherwise), so fusion
 *     over payload detections is unambiguous.
 *
 * The category/severity/transmission policy itself lives in `privacyDecision.ts`
 * (the centralized policy layer); this module only fuses evidence and asks that
 * policy for the resulting verdict.
 */

import { AgentBoundingBox, AgentDetection, DetectionResult, DetectionSource, InteractiveEntityType, isSensitiveEntityType, SensitiveEntityType, VisualDetectionResult } from './types';
import { SafeOCRDetection } from '../ocr/types';
import { decideTransmission, PolicyDecisionRecord, severityForCategory, severityRank } from './privacyDecision';
import type { ContextualPrivacyCategory } from './contextualPii';

// ── Normalized finding model ─────────────────────────────────────────────────

/** Which local perception source contributed evidence. */
export type FindingSource = 'dom' | 'ocr' | 'visual' | 'nlp';

/** Privacy categories. A superset of M1's SensitiveEntityType. */
export type PrivacyCategory = SensitiveEntityType | InteractiveEntityType | 'face' | 'unknown' | (string & {});

/** Severity ladder used to pick the strongest applicable decision. */
export type PrivacySeverity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

export interface PrivacyFinding {
  /** Stable fused id: `finding-{category}-{index}`. */
  id: string;
  /** Strongest applicable category for this element. */
  category: PrivacyCategory;
  /** Every category any contributing signal proposed (audit trail). */
  categories: PrivacyCategory[];
  /** Strongest severity across contributing categories. */
  severity: PrivacySeverity;
  /** Strongest contributing confidence (never lowered by weaker signals). */
  confidence: number;
  /** All contributing perception sources, deduplicated. */
  sources: FindingSource[];
  /** Fine-grained provenance (dom_input_type, dom_label, ocr, ...). */
  detectionSources: DetectionSource[];
  /** Ids of the contributing detections (for tracing back to the report). */
  evidenceIds: string[];
  /** Unified region, in the coordinate space of the inputs. */
  region: [number, number, number, number] | null;
  /** Structural selector when the contributing source had one. */
  selector: string | null;
  /** Character count of the underlying value — never the value. */
  length: number | null;
  /** True when any contributing signal was clipped by the viewport. */
  isPartiallyVisible: boolean;
  /**
   * Phase 15: true when this finding MUST be redacted but cannot be safely
   * located — no region and no selector, so nothing can be reliably masked.
   * Such a finding is never reported as safely handled: `exportable` is forced
   * false and `evidence` carries `fail_closed:unmappable`. Dropping it would
   * under-report a real sensitive region, which is the worse failure.
   */
  unmappable: boolean;
  /** How many raw detections were merged into this finding. */
  fusedFrom: number;
  /** Multi-source fusion (i.e. more than one perception source agreed). */
  multiSource: boolean;
  /** Explainable evidence codes (no raw values, no page text). */
  evidence: string[];
  /** Centralized policy verdict for this finding. */
  decision: PolicyDecisionRecord;
  /** Whether the region must be locally redacted (from the policy verdict). */
  mustRedact: boolean;
  /** Whether the finding's metadata may enter sanitized context. */
  exportable: boolean;
}

// ── Candidates (one per raw detection signal) ────────────────────────────────

export interface FusionCandidate {
  /** Detection id from the originating pipeline. */
  evidenceId: string;
  category: PrivacyCategory;
  confidence: number;
  source: FindingSource;
  detectionSource: DetectionSource;
  region: [number, number, number, number] | null;
  selector: string | null;
  length: number | null;
  isPartiallyVisible: boolean;
  evidence: string[];
}

/** Maps an M1/M2/M3 detection source onto its coarse perception source. */
export function findingSourceFor(detectionSource: DetectionSource): FindingSource {
  if (detectionSource === 'ocr') return 'ocr';
  return 'dom';
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Approximate page-space → screenshot-space mapping is NOT done here. */
export function candidateFromDOMPageDetection(det: DetectionResult): FusionCandidate {
  return {
    evidenceId: det.id,
    category: det.type as PrivacyCategory,
    confidence: clampConfidence(det.confidence),
    source: 'dom',
    detectionSource: det.source,
    region: [det.bbox[0], det.bbox[1], det.bbox[2], det.bbox[3]],
    selector: det.selector || null,
    length: typeof det.length === 'number' ? det.length : null,
    isPartiallyVisible: false,
    evidence: [`dom:${det.source}`],
  };
}

/** M2 mapped detection (DOM element projected into stream/screenshot space). */
export function candidateFromVisualDetection(det: VisualDetectionResult): FusionCandidate {
  const isOcr = det.source === 'ocr';
  return {
    evidenceId: det.id,
    category: det.type,
    confidence: clampConfidence(det.confidence),
    source: isOcr ? 'ocr' : 'visual',
    detectionSource: det.source,
    region: [
      det.screenshotBBox[0],
      det.screenshotBBox[1],
      det.screenshotBBox[2],
      det.screenshotBBox[3],
    ],
    selector: det.selector || null,
    length: null,
    isPartiallyVisible: det.isPartiallyVisible,
    evidence: [isOcr ? 'ocr:region' : 'visual:mapped_region'],
  };
}

/** M3 OCR detection (already sanitized by ocrSecurityBoundary). */
export function candidateFromOCRDetection(det: SafeOCRDetection): FusionCandidate {
  return {
    evidenceId: det.id,
    category: det.type,
    confidence: clampConfidence(det.confidence),
    source: 'ocr',
    detectionSource: 'ocr',
    region: [det.bbox[0], det.bbox[1], det.bbox[2], det.bbox[3]],
    selector: null,
    length: typeof det.length === 'number' ? det.length : null,
    isPartiallyVisible: det.isPartiallyVisible,
    evidence: ['ocr:region'],
  };
}

/**
 * Phase 15: a contextual (NLP) finding from DOM text or OCR.
 *
 * This ADAPTS an already-computed contextual hit into the same candidate shape
 * every other source uses. It duplicates no detector and defines no boundary:
 * the policy verdict below is still `privacyDecision`, and the redaction engine
 * is still the only thing that redacts.
 *
 * When `bbox` is null the candidate is deliberately still emitted. Fusion then
 * raises it as `unmappable` and fails closed, rather than quietly discarding a
 * high-confidence sensitive finding we simply could not locate.
 */
export function candidateFromContextualDetection(input: {
  id: string;
  type: ContextualPrivacyCategory;
  confidence: number;
  bbox: [number, number, number, number] | null;
  selector?: string | null;
  length?: number | null;
  evidence?: string;
}): FusionCandidate {
  return {
    evidenceId: input.id,
    category: input.type as PrivacyCategory,
    confidence: clampConfidence(input.confidence),
    source: 'nlp',
    detectionSource: 'text_pattern',
    region: input.bbox,
    selector: input.selector ?? null,
    length: typeof input.length === 'number' ? input.length : null,
    isPartiallyVisible: false,
    evidence: [input.evidence ?? 'nlp:contextual'],
  };
}

/** M4 sanitized payload detection (what reasoning providers may receive). */
export function candidateFromAgentDetection(
  det: AgentDetection,
  source?: FindingSource
): FusionCandidate {
  // `ocr` source detections carry the synthetic selector 'canvas:visual-ocr'.
  const inferred: FindingSource =
    source ?? (det.source === 'ocr' ? 'ocr' : det.is_partially_visible ? 'visual' : 'dom');
  const isSyntheticSelector = !det.selector || det.selector === 'canvas:visual-ocr';
  return {
    evidenceId: det.id,
    category: det.type as PrivacyCategory,
    confidence: clampConfidence(det.confidence),
    source: inferred,
    detectionSource: det.source,
    region: [det.bbox.x, det.bbox.y, det.bbox.width, det.bbox.height],
    selector: isSyntheticSelector ? null : det.selector,
    length: typeof det.length === 'number' ? det.length : null,
    isPartiallyVisible: det.is_partially_visible,
    evidence: [`${inferred}:${det.source}`],
  };
}

// ── Fusion ───────────────────────────────────────────────────────────────────

export interface FusionOptions {
  /**
   * Containment ratio (overlap area / smaller area) required to treat two
   * same-category boxes as the same element. Default 0.6 — mirrors the OCR
   * deduplicator's existing threshold.
   */
  sameCategoryOverlap?: number;
  /**
   * Containment ratio required to merge two DIFFERENT categories into one
   * unified sensitive region. Strict by default so that a small adjacent CVV
   * box is not silently absorbed into a neighbouring card box.
   */
  crossCategoryOverlap?: number;
}

const DEFAULT_SAME_CATEGORY_OVERLAP = 0.6;
const DEFAULT_CROSS_CATEGORY_OVERLAP = 0.9;

export interface FusionResult {
  findings: PrivacyFinding[];
  /** Number of raw signals considered. */
  candidateCount: number;
  /** Groups that combined more than one signal. */
  fusedGroupCount: number;
  /** Signals collapsed away by fusion (candidateCount - findings.length). */
  collapsedCount: number;
  /** How many signals each perception source contributed. */
  sourceCounts: Record<FindingSource, number>;
  /** Per-category signal counts (pre-fusion, so counts stay accurate). */
  categoryCounts: Record<string, number>;
}

/**
 * Fuses normalized candidates into unified privacy findings.
 *
 * Grouping rules, in order (first match wins):
 *   1. Same evidence id — a DOM detection and its M2 mapped twin share an id.
 *   2. Same meaningful selector — same DOM element seen by two pipelines.
 *   3. Same category + containment ≥ sameCategoryOverlap — DOM field + OCR read
 *      of the same number.
 *   4. Different category + containment ≥ crossCategoryOverlap — effectively the
 *      same box read differently by two detectors.
 *
 * Synthetic selectors ('canvas:visual-ocr', empty) are never used for grouping:
 * every OCR detection shares one.
 */
export function fusePrivacyFindings(
  candidates: FusionCandidate[],
  options: FusionOptions = {}
): FusionResult {
  const sameThreshold = options.sameCategoryOverlap ?? DEFAULT_SAME_CATEGORY_OVERLAP;
  const crossThreshold = options.crossCategoryOverlap ?? DEFAULT_CROSS_CATEGORY_OVERLAP;

  const groups: FusionCandidate[][] = [];
  const sourceCounts: Record<FindingSource, number> = { dom: 0, ocr: 0, visual: 0, nlp: 0 };
  const categoryCounts: Record<string, number> = {};

  for (const candidate of candidates) {
    sourceCounts[candidate.source] += 1;
    categoryCounts[candidate.category] = (categoryCounts[candidate.category] ?? 0) + 1;

    const target = groups.find((group) => group.some((member) => shouldMerge(member, candidate, sameThreshold, crossThreshold)));
    if (target) {
      target.push(candidate);
    } else {
      groups.push([candidate]);
    }
  }

  const findings = groups.map((group, index) => buildFinding(group, index));
  const fusedGroupCount = groups.filter((g) => g.length > 1).length;

  return {
    findings,
    candidateCount: candidates.length,
    fusedGroupCount,
    collapsedCount: candidates.length - findings.length,
    sourceCounts,
    categoryCounts,
  };
}

/** Convenience entry point for the M4 sanitized payload (single coordinate space). */
export function fuseAgentDetections(detections: AgentDetection[]): FusionResult {
  return fusePrivacyFindings(detections.map((d) => candidateFromAgentDetection(d)));
}

function shouldMerge(
  a: FusionCandidate,
  b: FusionCandidate,
  sameThreshold: number,
  crossThreshold: number
): boolean {
  if (a.evidenceId === b.evidenceId) return true;

  if (a.selector && b.selector && a.selector === b.selector) return true;

  const containment = containmentRatio(a.region, b.region);
  if (containment === null) return false;

  if (a.category === b.category) return containment >= sameThreshold;
  return containment >= crossThreshold;
}

/** Overlap area divided by the SMALLER box area (0..1), or null if unusable. */
export function containmentRatio(
  a: [number, number, number, number] | null,
  b: [number, number, number, number] | null
): number | null {
  if (!a || !b) return null;
  const [, , aw, ah] = a;
  const [, , bw, bh] = b;
  const areaA = aw * ah;
  const areaB = bw * bh;
  const minArea = Math.min(areaA, areaB);
  if (!Number.isFinite(minArea) || minArea <= 0) return null;

  const xOverlap = Math.max(0, Math.min(a[0] + aw, b[0] + bw) - Math.max(a[0], b[0]));
  const yOverlap = Math.max(0, Math.min(a[1] + ah, b[1] + bh) - Math.max(a[1], b[1]));
  return (xOverlap * yOverlap) / minArea;
}

function buildFinding(group: FusionCandidate[], index: number): PrivacyFinding {
  const first = group[0]!;

  const categories = unique(group.map((c) => c.category));
  // Strongest category wins: highest severity, then highest confidence.
  const category = categories.reduce((best, current) => {
    const bestRank = severityRank(severityForCategory(best));
    const currentRank = severityRank(severityForCategory(current));
    if (currentRank !== bestRank) return currentRank > bestRank ? current : best;
    const bestConf = maxConfidenceFor(group, best);
    const currentConf = maxConfidenceFor(group, current);
    return currentConf > bestConf ? current : best;
  }, first.category);

  // Strongest evidence wins — a low-confidence signal never lowers the verdict.
  const confidence = group.reduce((max, c) => Math.max(max, c.confidence), 0);
  const sources = unique(group.map((c) => c.source));
  const detectionSources = unique(group.map((c) => c.detectionSource));
  const evidenceIds = unique(group.map((c) => c.evidenceId));
  const selector = group.find((c) => c.selector)?.selector ?? null;
  const length = group.reduce<number | null>(
    (max, c) => (c.length === null ? max : Math.max(max ?? 0, c.length)),
    null
  );
  const isPartiallyVisible = group.some((c) => c.isPartiallyVisible);
  const region = unionRegion(group.map((c) => c.region));

  const evidence = unique([
    ...group.flatMap((c) => c.evidence),
    ...(group.length > 1 ? ['fused:multi_source'] : []),
  ]);

  const decision = decideTransmission({ category, confidence, sources });

  // Phase 15 fail-closed escalation. A finding that MUST be redacted but has no
  // region and no selector cannot be masked reliably. Under-reporting it is the
  // worse failure, so it is escalated rather than dropped: `unmappable` is set,
  // `exportable` is forced false, and the audit trail records why.
  const unmappable = decision.mustRedact && region === null && !selector;
  if (unmappable) {
    evidence.push('fail_closed:unmappable');
  }

  const finding: PrivacyFinding = {
    id: `finding-${category}-${index + 1}`,
    category,
    categories,
    severity: decision.severity,
    confidence: Number(confidence.toFixed(4)),
    sources,
    detectionSources,
    evidenceIds,
    region,
    selector,
    length,
    isPartiallyVisible,
    unmappable,
    fusedFrom: group.length,
    multiSource: sources.length > 1,
    evidence,
    decision,
    mustRedact: decision.mustRedact,
    exportable: unmappable ? false : decision.exportableMetadata,
  };

  return finding;
}

function maxConfidenceFor(group: FusionCandidate[], category: PrivacyCategory): number {
  return group
    .filter((c) => c.category === category)
    .reduce((max, c) => Math.max(max, c.confidence), 0);
}

function unionRegion(
  regions: Array<[number, number, number, number] | null>
): [number, number, number, number] | null {
  const boxes = regions.filter((r): r is [number, number, number, number] => r !== null);
  if (boxes.length === 0) return null;
  if (boxes.length === 1) return boxes[0]!;

  const x0 = Math.min(...boxes.map((b) => b[0]));
  const y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[0] + b[2]));
  const y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

/** Converts a fused region back into the M4 payload bbox shape. */
export function findingRegionToBoundingBox(
  region: [number, number, number, number] | null
): AgentBoundingBox | null {
  if (!region) return null;
  return { x: region[0], y: region[1], width: region[2], height: region[3] };
}

/**
 * Phase 15: the findings that must be redacted but cannot be located.
 *
 * A caller responsible for redaction should treat a non-empty result as
 * "coverage is incomplete" rather than assuming every must-redact finding has a
 * region to act on.
 */
export function unmappableMustRedactFindings(findings: PrivacyFinding[]): PrivacyFinding[] {
  return findings.filter((f) => f.unmappable);
}
