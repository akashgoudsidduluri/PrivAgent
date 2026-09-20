/**
 * PrivAgent — Context Minimization (M8)
 *
 * Turns a fused privacy picture into the MINIMUM safe information a reasoning
 * model needs for the CURRENT task, and produces an inspectable report of every
 * decision it made.
 *
 *   TASK + fused findings + policy verdicts
 *              ↓
 *   minimized sanitized context  →  AgentProvider  →  LLM
 *
 * What minimization does here (all deterministic, all explainable):
 *   1. FUSION      — duplicate signals for the same element collapse into one
 *                    entry (a DOM field and the OCR read of the same number
 *                    become one finding, not two unrelated detections).
 *   2. POLICY      — every finding receives a centralized transmission verdict.
 *   3. FAIL CLOSED — findings that may not enter context are DROPPED, never
 *                    downgraded. Categories the M4 contract cannot represent
 *                    (unknown / face) are dropped too — the only possible
 *                    direction is stricter.
 *   4. BOUNDING    — the exported list is capped, ranked by severity, then task
 *                    relevance, then confidence (deterministic).
 *   5. PRECISION   — confidence is quantized and only fields the action contract
 *                    needs are exported.
 *   6. FIREWALL    — the result is scanned for forbidden keys and PII-shaped
 *                    values before it is returned. A violation fails closed.
 *
 * Explicit non-goals (deliberate, to keep the boundary small):
 *   - No semantic retrieval, no embeddings, no LLM, no ML for minimization.
 *   - No new raw-text extraction from the page. Minimization only ever REMOVES
 *     information from data the privacy pipeline already sanitized; it never
 *     introduces a new text channel toward a provider.
 */

import { AgentBoundingBox, AgentContextPayload, AgentDetection, DetectionSource, isSensitiveEntityType, SensitiveEntityType } from './types';
import {
  FindingSource,
  PrivacyCategory,
  PrivacyFinding,
  PrivacySeverity,
  candidateFromAgentDetection,
  fusePrivacyFindings,
} from './fusion';
import { PolicyDecisionRecord, PolicySummary, policyForCategory, severityForCategory, severityRank, summarizeDecisions } from './privacyDecision';
import { assertNoKnownRawValues, assertNoRawSensitiveValues } from './rawValueScanner';

/** Default ceiling on exported detections (bounds prompt size and model cost). */
export const DEFAULT_MAX_CONTEXT_DETECTIONS = 40;

export interface MinimizationOptions {
  /** The user task. Used for deterministic, explainable relevance ranking. */
  task?: string;
  /** Maximum exported detections. Defaults to DEFAULT_MAX_CONTEXT_DETECTIONS. */
  maxDetections?: number;
  /**
   * Extra known raw sensitive values that must not appear in the result
   * (synthetic fixtures / regression tests). Never logged or echoed.
   */
  knownRawValues?: string[];
}

export interface ModelFacingElement {
  id: string;
  category: PrivacyCategory;
  severity: PrivacySeverity;
  confidence: number;
  bbox: AgentBoundingBox | null;
  /** True when the region is redacted on-device (the model must not expect a value). */
  redacted: boolean;
  sources: FindingSource[];
}

/**
 * The MINIMAL context a reasoning provider may serialize into a prompt.
 * Deliberately excludes: raw counters, selectors/page structure, character
 * lengths, viewport detail, OCR text, images, and every sensitive value.
 */
export interface ModelFacingContext {
  url: string;
  task: string;
  task_terms: string[];
  elements: ModelFacingElement[];
  sanitization: 'minimized_sanitized_only';
}

export interface MinimizationDecisionView {
  category: PrivacyCategory;
  decision: PolicyDecisionRecord['decision'];
  severity: PrivacySeverity;
  code: PolicyDecisionRecord['code'];
  failClosed: boolean;
  sources: FindingSource[];
  exported: boolean;
}

export interface MinimizationReport {
  sanitized_only: true;
  task_terms: string[];
  task_relevant_ids: string[];
  findings_detected: number;
  findings_exported: number;
  exported_detections: number;
  fused_groups: number;
  collapsed_duplicates: number;
  never_transmit: number;
  must_redact: number;
  minimized: number;
  fail_closed_dropped: number;
  dropped_ids: string[];
  dropped_reasons: string[];
  bounded: boolean;
  max_detections: number;
  sources: Record<FindingSource, number>;
  decision_summary: PolicySummary;
  decisions: MinimizationDecisionView[];
  limitations: string[];
}

export interface MinimizationResult {
  /** Minimized payload — still a valid M4 `AgentContextPayload`. */
  payload: AgentContextPayload;
  /** Minimal model-facing view for prompt construction. */
  modelView: ModelFacingContext;
  /** Inspectable minimization telemetry (metadata only, never raw values). */
  report: MinimizationReport;
}

/** Categories representable in the frozen M4 payload contract. */
const EXPORTABLE_TYPES: ReadonlySet<string> = new Set<SensitiveEntityType>([
  'password', 'email', 'phone', 'credit_card', 'account_number',
  'person_name', 'pan', 'otp', 'cvv', 'address',
]);

/** Deterministic stopword list for task-term extraction. */
const TASK_STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'then', 'for', 'with', 'from', 'into', 'onto', 'this', 'that',
  'these', 'those', 'find', 'please', 'open', 'show', 'showme', 'go', 'goto',
  'navigate', 'click', 'on', 'in', 'at', 'to', 'of', 'a', 'an', 'is', 'are',
  'recent', 'all', 'my', 'me', 'it', 'its', 'page', 'section', 'field',
]);

/**
 * Deterministic task-term extraction.
 * Lowercased alphanumeric tokens, stopwords and very short tokens removed.
 */
export function extractTaskTerms(task: string | undefined): string[] {
  if (!task) return [];
  const tokens = task
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !TASK_STOPWORDS.has(t));
  return Array.from(new Set(tokens));
}

/**
 * Minimizes a sanitized context for a task.
 *
 * @throws PrivacyBoundaryError if the minimized result fails the raw-value
 *         firewall (fail closed — no context is returned at all).
 */
export function minimizeAgentContext(
  payload: AgentContextPayload,
  options: MinimizationOptions = {}
): MinimizationResult {
  const task = options.task ?? '';
  const maxDetections = options.maxDetections ?? DEFAULT_MAX_CONTEXT_DETECTIONS;
  const taskTerms = extractTaskTerms(task);

  const fusion = fusePrivacyFindings(
    payload.detections.map((d) => candidateFromAgentDetection(d))
  );

  const decisions: MinimizationDecisionView[] = [];
  const exported: AgentDetection[] = [];
  const exportedFindings: PrivacyFinding[] = [];
  const droppedIds: string[] = [];
  const droppedReasons: string[] = [];
  const taskRelevantIds: string[] = [];

  for (const finding of fusion.findings) {
    const relevant = isTaskRelevant(finding, taskTerms);
    if (relevant) taskRelevantIds.push(finding.id);

    let exportedThis = false;
    let dropReason = '';

    if (!finding.exportable) {
      dropReason = 'policy_fail_closed';
    } else if (!EXPORTABLE_TYPES.has(finding.category)) {
      // Categories the frozen M4 contract cannot express are dropped rather than
      // coerced — dropping can only ever tighten the boundary.
      dropReason = 'category_not_representable';
    }

    if (dropReason) {
      droppedIds.push(finding.id);
      droppedReasons.push(`${finding.id}:${dropReason}`);
    } else {
      exportedThis = true;
      exportedFindings.push(finding);
      exported.push(toExportedDetection(finding));
    }

    decisions.push({
      category: finding.category,
      decision: finding.decision.decision,
      severity: finding.decision.severity,
      code: finding.decision.code,
      failClosed: finding.decision.failClosed,
      sources: finding.sources,
      exported: exportedThis,
    });
  }

  // Deterministic ranking: severity → task relevance → confidence → category → id.
  const ranked = exportedFindings
    .map((finding, index) => ({
      finding,
      detection: exported[index]!,
      relevant: taskRelevantIds.includes(finding.id),
    }))
    .sort((a, b) => {
      const bySeverity = severityRank(b.finding.severity) - severityRank(a.finding.severity);
      if (bySeverity !== 0) return bySeverity;
      if (a.relevant !== b.relevant) return a.relevant ? -1 : 1;
      const byConfidence = b.finding.confidence - a.finding.confidence;
      if (byConfidence !== 0) return byConfidence;
      return a.detection.id.localeCompare(b.detection.id);
    });

  const bounded = ranked.length > maxDetections;
  const limited = ranked.slice(0, Math.max(0, maxDetections));

  if (bounded) {
    for (const entry of ranked.slice(Math.max(0, maxDetections))) {
      droppedIds.push(entry.finding.id);
      droppedReasons.push(`${entry.finding.id}:bounded_by_max_detections`);
    }
  }

  const minimizedPayload: AgentContextPayload = {
    url: payload.url,
    timestamp: payload.timestamp,
    viewport: { ...payload.viewport },
    screenshot_dimensions: payload.screenshot_dimensions
      ? { ...payload.screenshot_dimensions }
      : null,
    detections: limited.map((entry) => entry.detection),
    total_elements_scanned: payload.total_elements_scanned,
    sensitive_elements_detected: payload.sensitive_elements_detected,
    sanitized_status: 'sanitized_only',
    ocr_metrics: payload.ocr_metrics ? { ...payload.ocr_metrics } : null,
  };

  // ── Privacy firewall: refuse to hand out anything that fails the scan ──────
  assertNoRawSensitiveValues(minimizedPayload);
  if (options.knownRawValues && options.knownRawValues.length > 0) {
    assertNoKnownRawValues(minimizedPayload, options.knownRawValues);
  }

  const findingDecisions = fusion.findings.map((f) => f.decision);
  const decisionSummary = summarizeDecisions(findingDecisions);

  const report: MinimizationReport = {
    sanitized_only: true,
    task_terms: taskTerms,
    task_relevant_ids: taskRelevantIds,
    findings_detected: fusion.findings.length,
    findings_exported: exportedFindings.length,
    exported_detections: minimizedPayload.detections.length,
    fused_groups: fusion.fusedGroupCount,
    collapsed_duplicates: fusion.collapsedCount,
    never_transmit: decisionSummary.neverTransmit,
    must_redact: decisionSummary.redacted,
    minimized: decisionSummary.minimized,
    fail_closed_dropped: decisionSummary.failClosed,
    dropped_ids: droppedIds,
    dropped_reasons: droppedReasons,
    bounded,
    max_detections: maxDetections,
    sources: { ...fusion.sourceCounts },
    decision_summary: decisionSummary,
    decisions,
    limitations: [
      'Minimization ranks and bounds the exported element set; it does not infer intent beyond task terms.',
      'Redaction verdicts are region-level (mustRedact); the exact pixel policy stays in the M2 redaction layer.',
      'No face detector exists in M1-M3; the face policy is reserved and dormant.',
    ],
  };

  return {
    payload: minimizedPayload,
    modelView: buildModelFacingContext(minimizedPayload, task),
    report,
  };
}

function isTaskRelevant(finding: PrivacyFinding, taskTerms: string[]): boolean {
  if (taskTerms.length === 0) return false;
  const haystack = `${finding.selector ?? ''} ${finding.category} ${finding.evidenceIds.join(' ')}`.toLowerCase();
  return taskTerms.some((term) => haystack.includes(term));
}

/**
 * Maps a fused finding back onto the frozen M4 detection contract.
 *
 * The representative id prefers a real DOM detection id over a synthetic
 * `ocr-det-*` id so that local execution/grounding keeps working exactly as
 * before. Only allowlisted metadata fields are copied — never a value.
 */
function toExportedDetection(finding: PrivacyFinding): AgentDetection {
  const domId = finding.evidenceIds.find((id) => !id.startsWith('ocr-det-'));
  const representativeId = domId ?? finding.evidenceIds[0] ?? finding.id;
  const representativeSource: DetectionSource =
    finding.detectionSources.find((s) => s !== 'ocr') ?? 'ocr';

  const bbox: AgentBoundingBox = finding.region
    ? { x: finding.region[0], y: finding.region[1], width: finding.region[2], height: finding.region[3] }
    : { x: 0, y: 0, width: 0, height: 0 };

  return {
    id: representativeId,
    type: finding.category as import('./types').DetectionEntityType,
    confidence: Number(finding.confidence.toFixed(2)),
    bbox,
    length: finding.length ?? 0,
    source: representativeSource,
    selector: finding.selector ?? '',
    is_partially_visible: finding.isPartiallyVisible,
  };
}

/**
 * Builds the minimal model-facing element view for an already-sanitized payload.
 *
 * Used by providers so that prompt construction has exactly ONE minimization
 * code path. Contains ids, categories, severity, confidence, geometry and
 * source tags — never selectors, counters, lengths, values, or media.
 */
export function buildModelFacingContext(
  payload: AgentContextPayload,
  task = ''
): ModelFacingContext {
  const elements: ModelFacingElement[] = payload.detections.map((detection) => {
    const category: PrivacyCategory = EXPORTABLE_TYPES.has(detection.type)
      ? (detection.type as PrivacyCategory)
      : 'unknown';
    const severity = severityForCategory(category);
    return {
      id: detection.id,
      category,
      severity,
      confidence: Number(detection.confidence.toFixed(2)),
      bbox: { ...detection.bbox },
      redacted: policyForCategory(category).mustRedact,
      sources: [detection.source === 'ocr' ? 'ocr' : detection.is_partially_visible ? 'visual' : 'dom'],
    };
  });

  return {
    url: payload.url,
    task,
    task_terms: extractTaskTerms(task),
    elements,
    sanitization: 'minimized_sanitized_only',
  };
}
