/**
 * PrivAgent 2.0 — Local Accessibility Tree Extractor (Phase 1)
 *
 * Constructs a privacy-safe on-device accessibility hierarchy from the live DOM.
 *
 * Security & Privacy Invariants:
 *  1. Zero raw PII in accessible names: All labels and accessible names are scanned
 *     against sensitive keyword patterns and sanitized.
 *  2. Passwords, OTPs, CVVs, card numbers, and auth tokens are scrubbed to
 *     'Protected Credential Field' before entering the accessibility node.
 *  3. Structural attributes (role, states, geometry) are preserved for reasoning.
 */

import { AccessibilityNode } from './types';
import { scanForRawSensitiveValues } from '../privacy/rawValueScanner';

const SENSITIVE_KEYWORDS = [
  'password', 'passwd', 'secret', 'pin', 'cvv', 'cvc',
  'token', 'card number', 'card_number', 'pan', 'otp',
  'ssn', 'account number', 'routing number'
];

function isSensitiveText(text: string): boolean {
  const lower = text.toLowerCase();
  return SENSITIVE_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * PHASE I-7 — DETECTOR ALIGNMENT DIAGNOSTICS.
 *
 * Counts accessibility names this module replaced, and the RULE that caused
 * each replacement. COUNTS AND RULE NAMES ONLY — never the name itself, never
 * the matched substring, never the offending value. This is diagnostic
 * metadata, not page content.
 *
 * A non-zero count means accessible names are being withheld. That is correct
 * behaviour when a name really is sensitive, but on ordinary content it is a
 * signal that the extractor is over-matching and the model is losing useful
 * labels — which is exactly the failure that went unnoticed here.
 */
export const accessibilitySanitizationStats = {
  scanned: 0,
  withheld: 0,
  byRule: {} as Record<string, number>,
};

/** Reset the counters. Called per page scan so counts are per-perception. */
export function resetAccessibilitySanitizationStats(): void {
  accessibilitySanitizationStats.scanned = 0;
  accessibilitySanitizationStats.withheld = 0;
  accessibilitySanitizationStats.byRule = {};
}

/**
 * PHASE I-7 — THE REPAIR.
 *
 * THE ASYMMETRY. Extraction screened names with `isSensitiveText`, a
 * keyword list. The authoritative world-model assertion
 * (`assertWorldModelSafe`) screens with `scanForRawSensitiveValues`, which is
 * strictly wider — notably it includes `hasContextualPhone`. A name could
 * therefore pass extraction and then fail the assertion.
 *
 * On a real Wikipedia article this happened on every perception:
 *
 *   [PrivAgent WorldModel Security Violation] Raw sensitive credential
 *   detected at root.accessibilityTree[314].name: rule=phone
 *
 * `assertWorldModelSafe` was behaving correctly. This extractor was
 * under-sanitizing, and the all-or-nothing `catch` around
 * `buildCurrentWorldModel` then discarded an otherwise valid ~96-region world
 * model — losing every entity, affordance and fact for the whole page.
 *
 * THE FIX. Extraction now applies the SAME authoritative scanner before the
 * name can enter the world model. The invariant this establishes:
 *
 *   any name that would fail `assertWorldModelSafe` is replaced BEFORE it
 *   reaches the world model.
 *
 * `assertWorldModelSafe` is NOT weakened, bypassed or removed. It remains the
 * final fail-closed gate, and it still rejects any model that somehow carries
 * an unsafe string. This only stops the extractor from handing it one.
 *
 * Fail-closed is preserved: when a name IS sensitive it is REPLACED by a fixed
 * safe marker. The original string is never retained, never returned and never
 * logged.
 */
export function sanitizeAccessibleName(name: string): string {
  if (!name || !name.trim()) return '';
  const trimmed = name.trim().replace(/\s+/g, ' ');
  accessibilitySanitizationStats.scanned += 1;

  // Keyword screen retained: it catches label-shaped credentials that the
  // value-shaped scanner is not designed to match (e.g. a field literally
  // labelled "Password").
  if (isSensitiveText(trimmed)) {
    accessibilitySanitizationStats.withheld += 1;
    accessibilitySanitizationStats.byRule.keyword = (accessibilitySanitizationStats.byRule.keyword ?? 0) + 1;
    return 'Protected Credential Field';
  }

  // Authoritative screen: identical detector to the world-model assertion.
  const findings = scanForRawSensitiveValues(trimmed);
  if (findings.length > 0) {
    accessibilitySanitizationStats.withheld += 1;
    const rule = findings[0]?.rule ?? 'unknown';
    accessibilitySanitizationStats.byRule[rule] = (accessibilitySanitizationStats.byRule[rule] ?? 0) + 1;
    return 'Protected Credential Field';
  }

  return trimmed.slice(0, 80);
}

function getImplicitRole(el: HTMLElement): string {
  const tag = el.tagName.toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a' && el.hasAttribute('href')) return 'link';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'dialog') return 'dialog';
  if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') return 'heading';
  if (tag === 'ul' || tag === 'ol') return 'list';
  if (tag === 'li') return 'listitem';
  if (tag === 'table') return 'table';
  if (tag === 'tr') return 'row';
  if (tag === 'td' || tag === 'th') return 'cell';
  if (tag === 'nav') return 'navigation';
  if (tag === 'header') return 'banner';
  if (tag === 'footer') return 'contentinfo';
  if (tag === 'main') return 'main';
  if (tag === 'form') return 'form';

  if (tag === 'input') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
    if (type === 'search') return 'searchbox';
    return 'textbox';
  }

  return 'generic';
}

function computeAccessibleName(el: HTMLElement, doc: Document): string {
  // 1. aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const ids = labelledBy.split(/\s+/);
    const parts = ids
      .map(id => doc.getElementById(id)?.textContent?.trim() || '')
      .filter(Boolean);
    if (parts.length > 0) {
      return sanitizeAccessibleName(parts.join(' '));
    }
  }

  // 2. aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) {
    return sanitizeAccessibleName(ariaLabel);
  }

  // 3. Native label association (for inputs)
  if (el.id) {
    const labelEl = doc.querySelector(`label[for="${el.id}"]`);
    if (labelEl && labelEl.textContent?.trim()) {
      return sanitizeAccessibleName(labelEl.textContent);
    }
  }

  // 4. Closest label ancestor
  const parentLabel = el.closest('label');
  if (parentLabel && parentLabel.textContent?.trim()) {
    return sanitizeAccessibleName(parentLabel.textContent);
  }

  // 5. Placeholder
  const placeholder = el.getAttribute('placeholder') || (el as any).placeholder;
  if (placeholder && typeof placeholder === 'string' && placeholder.trim()) {
    return sanitizeAccessibleName(placeholder.trim());
  }

  // 6. Title attribute
  const title = el.getAttribute('title');
  if (title && title.trim()) {
    return sanitizeAccessibleName(title);
  }

  const tag = el.tagName.toLowerCase();

  // 7. Value attribute on buttons/submits
  if (tag === 'input' && (el.getAttribute('type') === 'submit' || el.getAttribute('type') === 'button')) {
    const val = (el as any).value || el.getAttribute('value');
    if (val && typeof val === 'string' && val.trim()) {
      return sanitizeAccessibleName(val);
    }
  }

  // 8. Text content for buttons, links, headings
  if (['button', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'summary'].includes(tag)) {
    const text = (el.innerText || el.textContent || '').trim();
    if (text) {
      return sanitizeAccessibleName(text);
    }
  }

  return '';
}

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

/**
 * Extracts a local accessibility tree representing semantic and interactive elements.
 */
export function extractAccessibilityTree(
  root: Document | HTMLElement = document
): AccessibilityNode[] {
  // PHASE I-7. Nodes withheld at the proportional-failure guard below. Count
  // only — never the name, never the matched value.
  let nodesWithheldForSafety = 0;
  // Per-scan counters, so diagnostics describe THIS perception.
  resetAccessibilitySanitizationStats();

  const doc = root
    ? 'defaultView' in root
      ? (root as Document)
      : root.ownerDocument || document
    : document;
  const selector = [
    'button',
    'a[href]',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    'dialog',
    '[role]',
    '[aria-modal="true"]',
    'h1, h2, h3',
    'form',
    'table'
  ].join(', ');

  const elements = Array.from((root as HTMLElement).querySelectorAll<HTMLElement>(selector));
  const nodes: AccessibilityNode[] = [];
  const elementToNodeId = new Map<HTMLElement, string>();

  // First pass: create nodes
  elements.forEach((el, index) => {
    // Skip detached or invisible elements
    if (!el.isConnected) return;
    if (typeof window !== 'undefined' && window.getComputedStyle) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;
    }

    const explicitRole = el.getAttribute('role')?.trim();
    const role = explicitRole || getImplicitRole(el);
    const name = computeAccessibleName(el, doc);
    const bbox = getBbox(el);

    // PHASE I-7 — PROPORTIONAL FAILURE.
    //
    // A single unsafe accessible name must not void an otherwise valid world
    // model. This is a last-resort guard for any string that still trips the
    // authoritative scanner AFTER `sanitizeAccessibleName` has run (for
    // example a name assembled from several sources). The node is withheld and
    // the scan continues.
    //
    // This is NOT a bypass of the world-model safety assertion: the resulting
    // model still passes through `assertWorldModelSafe`, which remains the
    // final fail-closed gate. Dropping the node removes the offending string
    // from the model entirely rather than marking it safe, so the raw value is
    // never retained. Diagnostics record the count and rule only.
    if (name && scanForRawSensitiveValues(name).length > 0) {
      accessibilitySanitizationStats.withheld += 1;
      nodesWithheldForSafety += 1;
      return;
    }

    const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
    const isCheckable =
      (el.tagName.toLowerCase() === 'input' &&
        ['checkbox', 'radio'].includes((el.getAttribute('type') || '').toLowerCase())) ||
      el.getAttribute('role') === 'checkbox' ||
      el.getAttribute('role') === 'radio';
    const checked = isCheckable
      ? Boolean((el as any).checked) || el.hasAttribute('checked') || el.getAttribute('aria-checked') === 'true'
      : undefined;

    const selected =
      el.tagName.toLowerCase() === 'option'
        ? Boolean((el as any).selected) || el.hasAttribute('selected')
        : el.getAttribute('aria-selected') === 'true'
        ? true
        : undefined;

    const expanded =
      el.hasAttribute('aria-expanded') ? el.getAttribute('aria-expanded') === 'true' : undefined;

    const focused = doc.activeElement === el;
    const modal = el.getAttribute('aria-modal') === 'true' || el.tagName.toLowerCase() === 'dialog';

    const id = `ax-node-${index + 1}`;
    elementToNodeId.set(el, id);

    nodes.push({
      id,
      elementId: el.id || undefined,
      role,
      name,
      bbox,
      disabled,
      checked,
      selected,
      expanded,
      focused,
      modal: modal ? true : undefined,
      childrenIds: [],
    });
  });

  // Second pass: link parent and children
  nodes.forEach((node, idx) => {
    const el = elements[idx];
    if (!el) return;

    // Find nearest ancestor among our extracted elements
    let parent = el.parentElement;
    while (parent) {
      if (elementToNodeId.has(parent)) {
        const parentId = elementToNodeId.get(parent)!;
        node.parentId = parentId;
        const parentNode = nodes.find(n => n.id === parentId);
        if (parentNode && !parentNode.childrenIds.includes(node.id)) {
          parentNode.childrenIds.push(node.id);
        }
        break;
      }
      parent = parent.parentElement;
    }
  });

  if (nodesWithheldForSafety > 0) {
    console.warn(
      '[AccessibilityTree] withheld nodes that still failed the sensitive-value screen',
      { count: nodesWithheldForSafety },
    );
  }

  return nodes;
}
