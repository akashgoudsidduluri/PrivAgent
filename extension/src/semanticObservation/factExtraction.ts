/**
 * PrivAgent — Post-17.9: sanitized fact extraction.
 *
 * Turns the data the privacy pipeline ALREADY sanitized into a bounded set of
 * task-usable facts. There is deliberately no new DOM traversal and no new text
 * extraction here: the two sources are
 *
 *   1. `BrowserWorldModel.textRegions` — built by `buildBrowserWorldModel`,
 *      whose previews are M8-scanned and replaced with `'Protected Text'` when
 *      a raw sensitive value is present.
 *   2. `SanitizedSemanticContext` entity `safeAttributes` — already filtered by
 *      `filterSafeAttributes`, which drops credential keys and M8-scans every
 *      string value.
 *
 * Every candidate is then RE-SCANNED by the same M8 `rawValueScanner`. A
 * candidate that fails is DROPPED and counted — never downgraded, never
 * truncated into safety — so the only possible direction is stricter.
 *
 * Injection-shaped display text is retained but flagged `untrusted`. It is
 * still reasoned about as PAGE DATA; it is never usable as goal evidence and
 * never an instruction.
 */

import { scanForRawSensitiveValues } from '../privacy/rawValueScanner';
import { BrowserWorldModel, SafeTextRegion } from '../worldModel/types';
import { SanitizedSemanticContext } from '../semanticUnderstanding/semanticTypes';
import { isInjectionShapedText } from '../semanticUnderstanding/semanticContext';
import {
  MAX_FACT_LABEL_CHARS,
  MAX_FACT_TEXT_CHARS,
  MAX_SEMANTIC_FACTS,
  SemanticFact,
  SemanticFactValueKind,
} from './types';

/** Structural/computed attribute names that are not displayed facts. */
const NON_DISPLAY_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  'id',
  'type',
  'fieldcount',
  'optioncount',
  'imagecount',
  'linkcount',
  'rowcount',
  'itemcount',
  'requiresauthentication',
  'hassubmitaction',
  'hasmodal',
  'isenabled',
  'isvisible',
  'confidence',
  'pagegeneration',
  'index',
  'position',
]);

/**
 * Normalizes a displayed label into the key goal verification matches against
 * the user's own wording. `Price:` -> `price`, `Sub-total` -> `subtotal`.
 */
export function normalizeFactKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .join(' ');
}

/** Parses a displayed value into a finite number when one is present. */
export function parseDisplayedValue(raw: string): { value: string | number | null; kind: SemanticFactValueKind } {
  const trimmed = raw.trim();
  if (!trimmed) return { value: null, kind: 'text' };
  // Currency symbols, thousands separators and trailing units are presentation.
  const numeric = trimmed.replace(/[^0-9.,-]/g, '').replace(/,/g, '');
  if (numeric && /^-?\d+(\.\d+)?$/.test(numeric)) {
    const parsed = Number(numeric);
    if (Number.isFinite(parsed)) return { value: parsed, kind: 'numeric' };
  }
  return { value: trimmed.slice(0, MAX_FACT_TEXT_CHARS), kind: 'text' };
}

/** Splits displayed text into its label and value halves, when it has both. */
function splitLabelAndValue(preview: string): { label: string; valueText: string } {
  const match = preview.match(/^([A-Za-z][A-Za-z0-9 _\-/']{0,40}?)\s*[:=]\s*(.+)$/);
  if (match) {
    return { label: (match[1] ?? '').trim(), valueText: (match[2] ?? '').trim() };
  }
  // A bare numeric/currency display ("24", "£24.00") is a value with no label.
  if (/^[^A-Za-z]*[0-9]/.test(preview)) {
    return { label: '', valueText: preview.trim() };
  }
  return { label: preview.trim(), valueText: '' };
}

/**
 * Screens one candidate fact. Returns the sanitized fact, or null when the M8
 * scanner rejects it (the caller counts the drop).
 */
function screenFact(candidate: {
  id: string;
  key: string;
  label: string;
  displayText: string;
  displayValue: string | number | null;
  valueKind: SemanticFactValueKind;
  source: SemanticFact['source'];
  selector?: string;
  bbox?: [number, number, number, number];
  confidence: number;
  pageGeneration: number;
}): SemanticFact | null {
  if (!candidate.key) return null;
  if (candidate.displayText.length < 1) return null;

  const label = candidate.label.slice(0, MAX_FACT_LABEL_CHARS);
  const displayText = candidate.displayText.slice(0, MAX_FACT_TEXT_CHARS);

  // M8 raw-value screen over the CONTENT fields only. `id`, `selector` and
  // `key` are structural and are already validated as part of the world model.
  const violations = scanForRawSensitiveValues({
    label,
    displayText,
    displayValue: candidate.displayValue,
  });
  if (violations.length > 0) return null;

  return {
    ...candidate,
    label,
    displayText,
    untrusted: isInjectionShapedText(displayText) || isInjectionShapedText(label),
  };
}

export interface SemanticFactExtractionResult {
  facts: SemanticFact[];
  droppedSensitiveCount: number;
  quarantinedInjectionCount: number;
  regionsConsidered: number;
}

/**
 * Extracts the bounded, sanitized fact set for a page.
 *
 * Deterministic: same page model in, same facts out. No model, no network, no
 * new DOM read.
 */
export function extractSemanticFacts(
  worldModel: BrowserWorldModel | undefined,
  semanticContext?: SanitizedSemanticContext | null
): SemanticFactExtractionResult {
  const facts: SemanticFact[] = [];
  let droppedSensitiveCount = 0;
  let regionsConsidered = 0;

  const push = (
    candidate: Parameters<typeof screenFact>[0]
  ): void => {
    if (facts.length >= MAX_SEMANTIC_FACTS) return;
    const fact = screenFact(candidate);
    if (fact) {
      facts.push(fact);
    } else {
      droppedSensitiveCount++;
    }
  };

  // ── Source 1: sanitized world-model text regions ──────────────────────────
  const regions: SafeTextRegion[] = worldModel?.textRegions ?? [];
  const pageGeneration = worldModel?.page?.pageGeneration ?? 0;

  for (const region of regions.slice(0, 60)) {
    const preview = (region.sanitizedPreview ?? '').trim();
    // `'Protected Text'` is the world-model builder's fail-closed marker for a
    // region whose raw text failed the M8 scan. It is not a fact.
    if (!preview || preview === 'Protected Text') continue;
    if (preview.length < 2) continue;
    regionsConsidered++;

    const { label, valueText } = splitLabelAndValue(preview);
    const key = normalizeFactKey(label || valueText);
    if (!key) continue;
    const parsed = valueText
      ? parseDisplayedValue(valueText)
      : { value: null as string | number | null, kind: 'text' as SemanticFactValueKind };

    push({
      id: `fact-${region.id}`,
      key,
      label: label || preview,
      displayText: preview,
      displayValue: parsed.value,
      valueKind: parsed.kind,
      source: 'DOM_TEXT_REGION',
      selector: region.id,
      bbox: region.bbox,
      // A visible, sanitized text region is a direct reading of the DOM.
      confidence: region.isHeading ? 0.95 : 0.9,
      pageGeneration,
    });
  }

  // ── Source 2: already-sanitized entity attributes ─────────────────────────
  for (const entity of semanticContext?.entities ?? []) {
    for (const [attrKey, attrValue] of Object.entries(entity.safeAttributes ?? {})) {
      const normalized = normalizeFactKey(attrKey);
      if (!normalized || NON_DISPLAY_ATTRIBUTE_KEYS.has(normalized.replace(/ /g, ''))) continue;
      if (typeof attrValue === 'boolean') continue;
      if (attrValue === null || attrValue === undefined) continue;
      // A duplicate of a region-derived fact adds nothing.
      if (facts.some((f) => f.key === normalized)) continue;
      regionsConsidered++;

      const displayText = `${attrKey.replace(/([a-z])([A-Z])/g, '$1 $2')}: ${String(attrValue)}`;
      const parsed = parseDisplayedValue(String(attrValue));
      push({
        id: `fact-entity-${entity.id}-${normalized}`,
        key: normalized,
        label: attrKey,
        displayText,
        displayValue: parsed.value,
        valueKind: parsed.kind,
        source: 'ENTITY_ATTRIBUTE',
        confidence: typeof attrValue === 'number' ? 0.9 : 0.8,
        pageGeneration,
      });
    }
  }

  return {
    facts,
    droppedSensitiveCount,
    quarantinedInjectionCount: facts.filter((f) => f.untrusted).length,
    regionsConsidered,
  };
}
