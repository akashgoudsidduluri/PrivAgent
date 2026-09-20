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
    hasModal: model.page.hasActiveModal,
    keyEntities,
    spatialHighlights,
  };
}
