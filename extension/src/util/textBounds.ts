/**
 * PHASE 18.7 / A4 — shared text bounds.
 *
 * A single implementation, so the truncation rule cannot diverge between the
 * places that bound page text for the model.
 *
 * WHY A SHARED MODULE
 * -------------------
 * The world-model builder bounds `sanitizedPreview` to 40 characters, and the
 * semantic fact extractor bounds `label`/`displayText`. Both were doing a raw
 * `.slice()`, which cuts mid-word. Fixing only the fact extractor changed
 * nothing in practice: the builder had already produced a 40-character string,
 * so there was no mid-word cut left for the downstream helper to remove. Real
 * Chrome kept receiving `"The fifth ruler of the Qutb Shahi dynast"`.
 *
 * The builder is LOWER in the pipeline than the observation layer, so the
 * primitive lives here rather than being imported downward.
 *
 * A half-word is not quotable, not matchable against the user's own wording,
 * and not verifiable — so it can never satisfy an evidence-based completion
 * rule. Cutting cleanly is both correct and strictly more useful.
 */
export function truncateAtWordBoundary(value: string, maxChars: number): string {
  const text = value.trim();
  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, maxChars);
  const lastSpace = clipped.lastIndexOf(' ');
  // Only accept a break that keeps most of the budget; otherwise a single very
  // long word is returned intact rather than mangled to nothing.
  const cut = lastSpace > maxChars * 0.5 ? clipped.slice(0, lastSpace) : clipped;
  return cut.replace(/[\s\-,;:.]+$/, '');
}