/**
 * PrivAgent — Post-17.9: semantic observation freshness & provenance validation.
 *
 * Mirrors the Phase 17.3 OCR observation contract, deliberately: the invariants
 * that made an OCR reading trustworthy are the same ones that make a sanitized
 * text fact trustworthy.
 *
 *   "stale"         is NOT  "fresh"
 *   an OCR GUESS    is NOT  an observation
 *   pageGeneration  is NOT  document identity
 *
 * Fail CLOSED: every check that cannot be positively established returns false.
 */

import { isSameDocumentIdentity } from '../ocr/ocrObservationContract';
import { MAX_SEMANTIC_OBSERVATION_AGE_MS, SemanticObservation, SemanticFact } from './types';

/**
 * Verifies that a semantic observation still describes the live target tab, the
 * same document, and is recent enough to be evidence.
 *
 * A caller that cannot supply an authoritative tab id or document URL gets
 * `false` — an observation one cannot place is not evidence.
 */
export function isSemanticObservationFresh(
  observation: SemanticObservation | null | undefined,
  currentTargetTabId: number | null | undefined,
  currentDocumentUrl: string | null | undefined,
  currentPageGeneration: number,
  options: { now?: number; maxAgeMs?: number; requireFacts?: boolean } = {}
): boolean {
  if (!observation || observation.state !== 'OBSERVED') return false;
  if (options.requireFacts !== false && observation.facts.length === 0) return false;

  const provenance = observation.provenance;
  if (!provenance) return false;

  // 1. Target tab identity. Both sides must be real tab ids.
  if (typeof currentTargetTabId !== 'number' || !Number.isFinite(currentTargetTabId)) return false;
  if (provenance.tabId !== currentTargetTabId) return false;

  // 2. Document identity — pageGeneration is NOT document identity.
  if (!isSameDocumentIdentity(provenance.documentUrl, currentDocumentUrl ?? null)) return false;

  //
  // 3. Page-generation identity — STRICT.
  //
  // This is deliberately stricter than the Phase 17.3 OCR contract, and for a
  // reason that does not apply to a screenshot: an OCR reading is a claim about
  // what was RENDERED at capture time, so a later reading of the same document
  // leaves it meaningful. A text fact is a claim about the document's CONTENT,
  // and content can change in place — a re-render, a lazy-loaded price, a cart
  // update — without any navigation and therefore without changing document
  // identity. Accepting an older generation would let last cycle's content
  // certify this cycle's goal.
  //
  // The product's normal shape satisfies this exactly: the observation is built
  // during perception from the world model of THAT cycle, and the loop anchors
  // `currentPageGeneration` to that same world model before goal verification
  // runs, so the two are equal. Anything else fails closed.
  if (provenance.pageGeneration !== currentPageGeneration) return false;

  // 4. Age.
  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? MAX_SEMANTIC_OBSERVATION_AGE_MS;
  if (!Number.isFinite(provenance.observedAt)) return false;
  if (now - provenance.observedAt > maxAge) return false;
  // A timestamp in the future is a broken clock, not a fresh reading.
  if (provenance.observedAt - now > maxAge) return false;

  return true;
}

/**
 * The facts of an observation that may be used as EVIDENCE.
 *
 * Excludes injection-shaped facts, which are page content to reason about but
 * never a fact the agent may certify a goal from.
 */
export function evidenceFacts(observation: SemanticObservation | null | undefined): SemanticFact[] {
  if (!observation || observation.state !== 'OBSERVED') return [];
  return observation.facts.filter((fact) => !fact.untrusted);
}

/**
 * True when the goal's own wording names a fact the observation carries.
 *
 * Matching is on the fact's normalized key appearing as a whole word in the
 * user's task text, so `price` matches "report the price" and never matches a
 * substring like "priceless". Deterministic; reads the user's task only.
 */
export function factMatchesTaskWording(fact: SemanticFact, task: string): boolean {
  const key = fact.key.trim().toLowerCase();
  if (!key) return false;
  const words = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const keyWords = key.split(' ').filter(Boolean);
  if (keyWords.length === 0) return false;
  // Single-word keys must appear as a whole word.
  if (keyWords.length === 1) return words.includes(keyWords[0]!);
  // Multi-word keys must appear as a contiguous run.
  return words.join(' ').includes(keyWords.join(' '));
}
