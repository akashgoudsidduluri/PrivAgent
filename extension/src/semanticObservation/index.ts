/**
 * PrivAgent — Post-17.9: SEMANTIC OBSERVATION
 *
 * The smallest reusable path from "what the page displays" to "a fact the agent
 * may certify a read-only goal from".
 *
 *   world model text regions (already M8-sanitized)
 *        ↓
 *   sanitized fact extraction + re-screen (drop on violation)
 *        ↓
 *   tab / document / page-generation / timestamp provenance
 *        ↓
 *   SemanticObservation  ──(device-local, stripped at egress)──▶ goal verification
 *                        └──(sanitized facts only)─────────────▶ reasoner prompt
 *
 * EVIDENCE ONLY. Nothing here authorizes an action, and nothing outside goal
 * verification and prompt assembly may read it.
 */

import { BrowserWorldModel } from '../worldModel/types';
import { SanitizedSemanticContext } from '../semanticUnderstanding/semanticTypes';
import { extractSemanticFacts } from './factExtraction';
import {
  MAX_SEMANTIC_FACTS,
  SanitizedSemanticFact,
  SemanticFact,
  SemanticObservation,
} from './types';

export * from './types';
export * from './factExtraction';
export * from './freshness';

export interface BuildSemanticObservationOptions {
  worldModel?: BrowserWorldModel;
  semanticContext?: SanitizedSemanticContext | null;
  /** Authoritative target tab id, from the service worker. */
  tabId: number | null | undefined;
  /** Authoritative document URL at observation time. */
  documentUrl: string | null | undefined;
  /** Monotonic page generation the world model was built at. */
  pageGeneration: number;
  observedAt?: number;
}

/**
 * Builds one semantic observation for the current target tab.
 *
 * `state` is never guessed:
 *   - no target tab or no document URL  → UNAVAILABLE (an unplaceable reading)
 *   - no world model                    → UNAVAILABLE
 *   - a model with no sanitized text    → NOT_APPLICABLE (nothing to read)
 *   - otherwise                         → OBSERVED, with full provenance
 */
export function buildSemanticObservation(
  options: BuildSemanticObservationOptions
): SemanticObservation {
  const startedAt = Date.now();
  const observedAt = options.observedAt ?? startedAt;

  const unavailable = (reason: string): SemanticObservation => ({
    state: 'UNAVAILABLE',
    provenance: null,
    facts: [],
    droppedSensitiveCount: 0,
    quarantinedInjectionCount: 0,
    regionsConsidered: 0,
    failureReason: reason,
    latencyMs: Date.now() - startedAt,
  });

  if (typeof options.tabId !== 'number' || !Number.isFinite(options.tabId)) {
    return unavailable('No target tab id: a semantic observation must be placed on a tab.');
  }
  if (!options.documentUrl) {
    return unavailable('No authoritative document URL for the target tab.');
  }
  if (!options.worldModel) {
    return unavailable('No world model was attached for this perception cycle.');
  }

  const extraction = extractSemanticFacts(options.worldModel, options.semanticContext);

  if (extraction.regionsConsidered === 0 || extraction.facts.length === 0) {
    return {
      state: 'NOT_APPLICABLE',
      provenance: null,
      facts: [],
      droppedSensitiveCount: extraction.droppedSensitiveCount,
      quarantinedInjectionCount: 0,
      regionsConsidered: extraction.regionsConsidered,
      failureReason:
        extraction.droppedSensitiveCount > 0
          ? 'Every candidate fact failed the M8 raw-value screen.'
          : 'The page exposes no sanitized text regions to read.',
      latencyMs: Date.now() - startedAt,
    };
  }

  return {
    state: 'OBSERVED',
    provenance: {
      tabId: options.tabId,
      documentUrl: options.documentUrl,
      pageGeneration: options.pageGeneration,
      observedAt,
      source: 'WORLD_MODEL_TEXT_REGIONS',
    },
    facts: extraction.facts,
    droppedSensitiveCount: extraction.droppedSensitiveCount,
    quarantinedInjectionCount: extraction.quarantinedInjectionCount,
    regionsConsidered: extraction.regionsConsidered,
    latencyMs: Date.now() - startedAt,
  };
}

/**
 * The MODEL-FACING projection: sanitized content only, no provenance.
 *
 * Bounded, and deliberately excludes tab id, document URL, timestamps and
 * generation — device-local facts the reasoner has no use for.
 */
export function toSanitizedFacts(facts: readonly SemanticFact[]): SanitizedSemanticFact[] {
  return facts.slice(0, MAX_SEMANTIC_FACTS).map((fact) => ({
    key: fact.key,
    label: fact.label,
    displayText: fact.displayText,
    displayValue: fact.displayValue,
    valueKind: fact.valueKind,
    untrusted: fact.untrusted,
  }));
}
