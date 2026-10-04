/**
 * PrivAgent 2.0 — World Model Privacy Sanitizer & Context Minimizer (Phase 1)
 *
 * Enforces PrivAgent's zero-leak invariant over the Browser World Model.
 *
 * Security Invariants:
 *  1. Zero raw credentials: Passwords, OTPs, CVVs, card numbers, account numbers,
 *     and secret tokens are STRICTLY FORBIDDEN.
 *  2. Recursive validation: Scans all strings and structures in the world model.
 *  3. Context Minimization: Converts rich local model to a compact, safe summary
 *     for downstream reasoning gateways without exposing raw DOM text.
 */

import { BrowserWorldModel, SanitizedWorldModelSummary } from './types';
import { scanForRawSensitiveValues, FORBIDDEN_PAYLOAD_KEYS } from '../privacy/rawValueScanner';

const FORBIDDEN_OBJECT_KEYS = new Set([
  ...Array.from(FORBIDDEN_PAYLOAD_KEYS),
  'value', 'password', 'passwd', 'secret', 'token', 'cvv', 'cvc',
  'card', 'cardnumber', 'card_number', 'pan', 'otp', 'pin',
  'accountnumber', 'account_number', 'rawtext', 'rawocr', 'ocrtext',
  'textcontent', 'innertext',
]);

/**
 * Thrown when an illegal sensitive key or raw credential is found in a world model.
 */
export class WorldModelPrivacyViolation extends Error {
  constructor(public readonly violationKey: string, message: string) {
    super(`[PrivAgent WorldModel Security Violation] ${message} (key: "${violationKey}")`);
    this.name = 'WorldModelPrivacyViolation';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE I-7 — THE AUTHORITATIVE WORLD-MODEL SANITIZATION CHOKE POINT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PHASE I-7 — WHY THIS EXISTS.
 *
 * THE DEFECT CLASS. Every extractor that copies page text into the world model
 * screened it with its OWN, narrower detector, while the authoritative check
 * (`assertWorldModelSafe`) used the full `scanForRawSensitiveValues`. Any
 * string could therefore pass its producer and then fail the assertion — and
 * because the assertion is all-or-nothing, ONE unsafe string destroyed an
 * otherwise valid ~96-region world model.
 *
 * This was observed twice on the same real page:
 *
 *   root.accessibilityTree[314].name   rule=phone
 *   root.entities[14].attributes.col_2 rule=credential_token
 *
 * Patching each extractor in turn only relocates the bug. This module is the
 * single boundary through which the COMPLETE assembled world model passes
 * immediately before the assertion, so every current AND future extractor
 * inherits the guarantee by construction:
 *
 *   extractor(s) → buildWorldModel → sanitizeWorldModel → assertWorldModelSafe
 *
 * THE INVARIANT
 *
 *   No data can reach the world model without having been screened by the
 *   authoritative detector at this boundary.
 *
 * FAIL-CLOSED POSTURE. `assertWorldModelSafe` is UNCHANGED and remains the
 * final gate. This runs BEFORE it, so in the normal case the assertion passes
 * on an already-clean model. If anything still fails, the assertion still
 * throws and the caller still discards the model — it is never downgraded to
 * advisory, and no unsafe value is ever retained.
 */

/**
 * Keys whose values are MACHINE-GENERATED structural metadata and cannot
 * carry page text: ids we mint, geometry, enums, roles, booleans, counts.
 *
 * These are deliberately narrow. Anything not listed here is treated as
 * UNTRUSTED page-derived text and is screened — including free-form
 * `attributes` maps, table cell values, titles, names and semantic hints. That
 * is the fail-closed direction: unknown keys are screened, not skipped.
 */
const STRUCTURAL_KEYS = new Set([
  'id', 'elementId', 'parentId', 'childrenIds', 'associatedElementId',
  'associatedElementIds', 'role', 'type', 'source', 'bbox',
  'pageGeneration', 'confidence', 'visible', 'disabled', 'checked',
  'selected', 'expanded', 'focused', 'modal', 'length',
  'timestamp', 'regionCount', 'elementCount', 'detectionCount',
  'requiresAuthentication', 'fieldCount', 'hasSubmitAction',
  'width', 'height', 'count',
]);

/** The fixed replacement written in place of any unsafe string. */
export const PROTECTED_PLACEHOLDER = 'Protected Credential Field';

export interface WorldModelSanitizationStats {
  /** Fields/strings inspected. */
  scanned: number;
  /** Values replaced because they tripped the authoritative detector. */
  redacted: number;
  /** Attribute keys dropped entirely rather than replaced. */
  dropped: number;
  /** Rule names that triggered redaction. NAMES ONLY — never matched text. */
  byRule: Record<string, number>;
}

/**
 * The authoritative choke point. Returns a NEW sanitized model plus safe
 * diagnostics. The input is never mutated.
 */
export function sanitizeWorldModel<T>(model: T): { model: T; stats: WorldModelSanitizationStats } {
  const stats: WorldModelSanitizationStats = {
    scanned: 0, redacted: 0, dropped: 0, byRule: {},
  };

  const walk = (value: unknown, key: string): unknown => {
    if (typeof value === 'string') {
      // Machine-generated structural metadata cannot carry page text.
      if (STRUCTURAL_KEYS.has(key)) return value;

      stats.scanned += 1;
      const findings = scanForRawSensitiveValues(value);
      if (findings.length === 0) return value;

      stats.redacted += 1;
      const rule = findings[0]?.rule ?? 'unknown';
      stats.byRule[rule] = (stats.byRule[rule] ?? 0) + 1;
      // The offending string is DISCARDED here. It is not returned, not
      // logged, and not retained anywhere in the resulting model.
      return PROTECTED_PLACEHOLDER;
    }

    if (Array.isArray(value)) {
      return value.map((item) => walk(item, key));
    }

    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        out[childKey] = walk(childValue, childKey);
      }
      return out;
    }

    return value;
  };

  const sanitized = walk(model, 'root') as T;
  return { model: sanitized, stats };
}

/**
 * Recursively scans any object for forbidden credential keys or PII patterns.
 */
export function assertWorldModelSafe(obj: unknown, path: string = 'root'): void {
  if (!obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    obj.forEach((item, idx) => assertWorldModelSafe(item, `${path}[${idx}]`));
    return;
  }

  const record = obj as Record<string, unknown>;
  for (const [key, val] of Object.entries(record)) {
    const normKey = key.toLowerCase().replace(/[-_]/g, '');
    if (FORBIDDEN_OBJECT_KEYS.has(key) || FORBIDDEN_OBJECT_KEYS.has(normKey)) {
      throw new WorldModelPrivacyViolation(key, `Forbidden sensitive property detected at ${path}.${key}`);
    }

    if (typeof val === 'string') {
      // Check for raw sensitive credentials
      const findings = scanForRawSensitiveValues(val);
      if (findings.length > 0 && findings[0]) {
        throw new WorldModelPrivacyViolation(
          key,
          `Raw sensitive credential detected in string at ${path}.${key}: rule=${findings[0].rule}`
        );
      }
    } else if (typeof val === 'object' && val !== null) {
      assertWorldModelSafe(val, `${path}.${key}`);
    }
  }
}

/**
 * Produces a minimized, strictly sanitized world model summary suitable
 * for downstream reasoning models without leaking raw page text.
 */
export function createSanitizedWorldModelSummary(
  model: BrowserWorldModel
): SanitizedWorldModelSummary {
  // Enforce recursive privacy assertion
  assertWorldModelSafe(model);

  const keyEntities = model.entities.slice(0, 15).map(e => {
    // Locate the first interactive action element inside this entity
    const actionRel = model.semanticRelationships.find(
      r => r.sourceId === e.id && r.relation === 'HAS_ACTION'
    );
    return {
      id: e.id,
      type: e.type,
      title: e.title.slice(0, 40),
      actionElementId: actionRel?.targetId,
      bbox: e.bbox,
    };
  });

  const spatialHighlights = model.spatialRelationships
    .filter(r => r.relation === 'CONTAINS' || r.relation === 'ADJACENT_TO' || r.relation === 'ABOVE')
    .slice(0, 30)
    .map(r => ({
      sourceId: r.sourceId,
      relation: r.relation,
      targetId: r.targetId,
    }));

  return {
    pageType: model.page.pageType,
    url: model.page.url,
    pageGeneration: model.page.pageGeneration,
    viewport: {
      width: model.viewport.width,
      height: model.viewport.height,
    },
    elementCount: model.elements.length,
    interactiveCount: model.elements.filter(e => e.isEnabled).length,
    entityCount: model.entities.length,
    visualRegionCount: model.visualRegions?.length ?? 0,
    canvasCount: model.canvasFindings?.length ?? 0,
    videoCount: model.videoFindings?.length ?? 0,
    hasModal: model.page.hasActiveModal,
    keyEntities,
    visualCandidates: (model.interactiveCandidates || []).slice(0, 10).map(c => ({
      id: c.id,
      type: c.type,
      bbox: c.bbox,
      label: c.label,
    })),
    spatialHighlights,
  };
}
