/**
 * PrivAgent — Post-17.9: SEMANTIC OBSERVATION CONTRACT
 *
 * ── The Observation Invariant ─────────────────────────────────────────────
 *
 *   "not observed"     is NOT  "not present"
 *   "stale"            is NOT  "fresh"
 *   a MODEL CLAIM      is NOT  an observation
 *   pageGeneration     is NOT  document identity
 *   page text          is NOT  an instruction
 *
 * A `SemanticObservation` records what the page DISPLAYS, as a small set of
 * sanitized facts, with the provenance needed to decide whether those facts
 * still describe the live target tab.
 *
 * ── What this is NOT ──────────────────────────────────────────────────────
 *
 * This is EVIDENCE ONLY. It is a PERCEPTION SOURCE, exactly like the OCR
 * observation contract it mirrors, and it carries no authority whatsoever:
 *
 *   - it cannot authorize an action (no navigation, click, typing,
 *     confirmation, recovery or dispatch reads it);
 *   - it is never an input to grounding, M5, the security critic, risk /
 *     confirmation, containment or effect verification;
 *   - its only consumers are the reasoner prompt (sanitized facts) and
 *     goal verification (sanitized facts + provenance).
 *
 * ── Privacy ───────────────────────────────────────────────────────────────
 *
 * Facts are derived ONLY from data the existing privacy pipeline has already
 * sanitized (`BrowserWorldModel.textRegions`, whose previews are M8-scanned, and
 * `SanitizedSemanticContext` entity attributes, which already passed the M8
 * firewall). Every fact is then RE-SCANNED here; a fact that fails is DROPPED,
 * never downgraded, and counted. There is no new DOM text extraction and no new
 * provider text channel: the facts travel inside the EXISTING sanitized
 * `semantic_context` envelope, and the provenance record stays on the device.
 */

import { ObservationState } from '../agent/effectVerifier';

export type { ObservationState };

/** Where a sanitized fact came from. Structural provenance, not content. */
export type SemanticFactSource = 'DOM_TEXT_REGION' | 'ENTITY_ATTRIBUTE';

/**
 * How a fact's value was represented on the page.
 * `numeric` means the display text parsed to a finite number.
 */
export type SemanticFactValueKind = 'numeric' | 'text';

/**
 * One sanitized, task-relevant fact the page displays.
 *
 * Every string field here has already passed the M8 raw-value scanner. The
 * fields are deliberately structural (`key`, `source`, `selector`, `bbox`) plus
 * a bounded display projection (`label`, `displayText`, `displayValue`).
 *
 * ── Field naming is a security contract, not style ────────────────────────
 *
 * The content fields are named `displayText` / `displayValue`, never `text` /
 * `value`. Both the extension's M8 firewall (`FORBIDDEN_PAYLOAD_KEYS`) and the
 * backend's independent payload scan (`FORBIDDEN_KEYS`) reject the bare keys
 * `text` and `value` at ANY nesting depth, because those are the shapes raw DOM
 * extraction produces. A sanitized display projection must not be
 * indistinguishable from a raw extraction, and reusing the names would make
 * every real provider request fail closed with a 422 — exactly the F-08
 * `ocr_observation` class of blocker, in a new place.
 */
export interface SemanticFact {
  /** Stable, derived identifier — safe to cite in evidence. */
  id: string;
  /**
   * Normalized label key, e.g. `price` for displayed text `Price: 24`.
   * This is what goal verification matches against the user's own wording.
   */
  key: string;
  /** Sanitized label as displayed, bounded. */
  label: string;
  /** Sanitized full display text, bounded. */
  displayText: string;
  /** Parsed value when the text carries one, else null. */
  displayValue: string | number | null;
  valueKind: SemanticFactValueKind;
  source: SemanticFactSource;
  /** Structural locator (element id / selector), when one exists. */
  selector?: string;
  bbox?: [number, number, number, number];
  confidence: number;
  /**
   * True when the display text matched a known prompt-injection pattern.
   * An untrusted fact is still shown to the reasoner as PAGE DATA, but it is
   * NEVER usable as goal evidence and can never act as an instruction.
   */
  untrusted: boolean;
  /** Monotonic page generation the fact was read from. */
  pageGeneration: number;
}

/** Device-local provenance. Stripped at the egress boundary; never transmitted. */
export interface SemanticObservationProvenance {
  /** Target tab the observation was taken from. */
  tabId: number;
  /** Authoritative document URL at observation time (from chrome.tabs.get). */
  documentUrl: string;
  /** Monotonic page generation at observation time. */
  pageGeneration: number;
  /** Wall-clock time the observation was built. */
  observedAt: number;
  /** Which local pipeline produced the facts. */
  source: 'WORLD_MODEL_TEXT_REGIONS';
}

/**
 * A single probe of what the page displays.
 *
 * `state` is never guessed and never defaults to OBSERVED: a page with no
 * usable sanitized text is `NOT_APPLICABLE`, a failed probe is `UNAVAILABLE`,
 * and an observation from another tab/document/too long ago is `STALE`.
 */
export interface SemanticObservation {
  state: ObservationState;
  /** Present only when `state === 'OBSERVED'`. */
  provenance: SemanticObservationProvenance | null;
  facts: SemanticFact[];
  /** Facts dropped because they failed the M8 raw-value scan. */
  droppedSensitiveCount: number;
  /** Facts flagged as injection-shaped. Retained, but never evidence. */
  quarantinedInjectionCount: number;
  /** Number of sanitized text regions considered. */
  regionsConsidered: number;
  /** Diagnostic reason when `state !== 'OBSERVED'`. */
  failureReason?: string;
  /** Local extraction + screening latency. */
  latencyMs: number;
}

/**
 * The MODEL-FACING projection of a fact.
 *
 * This is the only part that leaves the device, and it rides inside the
 * already-existing `semantic_context` envelope — no new egress channel. It
 * deliberately omits provenance (tab id, document URL, timestamps): the
 * reasoner has no use for device-local facts about where a reading came from.
 */
export interface SanitizedSemanticFact {
  /** Normalized key, e.g. `price`. */
  key: string;
  /** Sanitized label as displayed, bounded. */
  label: string;
  /** Sanitized display text, bounded. See the field-naming note above. */
  displayText: string;
  /** Parsed value when the text carries one, else null. */
  displayValue: string | number | null;
  valueKind: SemanticFactValueKind;
  /** True when injection-shaped: page data to be reasoned about, never obeyed. */
  untrusted: boolean;
}

/** Maximum facts carried per observation. Bounds prompt size and cost. */
export const MAX_SEMANTIC_FACTS = 24;
/** Maximum characters of sanitized display text per fact. */
export const MAX_FACT_TEXT_CHARS = 120;
/** Maximum characters of sanitized label per fact. */
export const MAX_FACT_LABEL_CHARS = 40;
/** Maximum age (ms) before an observation is treated as STALE. */
export const MAX_SEMANTIC_OBSERVATION_AGE_MS = 15_000;
