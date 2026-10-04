/**
 * PHASE I-7 — THE WORLD-MODEL SANITIZATION CHOKE POINT (central invariant).
 *
 * The defect class: every extractor copied page text into the world model
 * screened with its OWN narrower detector, while the authoritative check
 * (`assertWorldModelSafe`) used the full `scanForRawSensitiveValues`. A string
 * could pass its producer then fail the assertion — and because the assertion
 * is all-or-nothing, one unsafe string destroyed an otherwise valid
 * ~96-region world model. Observed twice on the same real Wikipedia page:
 *
 *   root.accessibilityTree[314].name   rule=phone
 *   root.entities[14].attributes.col_2 rule=credential_token
 *
 * THE INVARIANT under test:
 *
 *   No data reaches the world model without passing the authoritative
 *   detector at the single choke point, so every current AND future extractor
 *   inherits the guarantee by construction.
 *
 * These tests also pin what must NOT change: `assertWorldModelSafe` stays the
 * final fail-closed gate, and no raw value is ever retained or logged.
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeWorldModel,
  assertWorldModelSafe,
  PROTECTED_PLACEHOLDER,
} from '../extension/src/worldModel/worldModelSanitizer';

const PHONE = '9876543210';
const CARD = '4111111111111111';
// Matches the PRODUCTION `credential_token` rule: mixed case + digit, 8+ chars.
// (A lowercase `sk-...` token is deliberately NOT used — the real scanner does
// not flag it, so asserting on it would have tested nothing.)
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig';
// Matches the production `labelled_credential` rule — the shape of a table
// cell carrying an API key.
const LABELLED_SECRET = 'api_key=abc123def456ghi';

/** Build a model shaped like the real failure. */
function modelWith(entities: unknown[], accessibilityTree: unknown[]) {
  return {
    id: 'wm-1',
    pageGeneration: 1,
    accessibilityTree,
    entities,
    visualRegions: [{ id: 'vr-1', type: 'container', bbox: [0, 0, 800, 600], confidence: 0.9 }],
    ocrRegions: [],
    privacyFindings: [],
  };
}

describe('I-7 central choke point', () => {
  // ── 1. Accessibility contextual phone ─────────────────────────────────────
  it('1. sanitizes an accessibility contextual phone before the assertion', () => {
    const model = modelWith([], [{ id: 'ax-314', role: 'link', name: `Contact telephone ${PHONE}` }]);
    const { model: safe } = sanitizeWorldModel(model);

    expect(() => assertWorldModelSafe(safe)).not.toThrow();
    expect(JSON.stringify(safe)).not.toContain(PHONE);
    expect((safe.accessibilityTree[0] as { name: string }).name).toBe(PROTECTED_PLACEHOLDER);
  });

  // ── 2. Entity table-cell credential token ─────────────────────────────────
  it('2. sanitizes an entity table-cell credential token before the assertion', () => {
    const model = modelWith(
      [{ id: 'ent-14', title: 'Row', attributes: { col_1: 'safe', col_2: TOKEN } }],
      []
    );
    const { model: safe } = sanitizeWorldModel(model);

    expect(() => assertWorldModelSafe(safe)).not.toThrow();
    expect(JSON.stringify(safe)).not.toContain(TOKEN);
    const attrs = (safe.entities[0] as { attributes: Record<string, string> }).attributes;
    expect(attrs.col_1).toBe('safe'); // legitimate neighbour survives
    expect(attrs.col_2).toBe(PROTECTED_PLACEHOLDER);
  });

  it('2b. sanitizes a labelled API key in a table cell (the real col_N shape)', () => {
    const model = modelWith(
      [{ id: 'ent-14', title: 'Row', attributes: { col_2: LABELLED_SECRET } }], []
    );
    const { model: safe } = sanitizeWorldModel(model);
    expect(() => assertWorldModelSafe(safe)).not.toThrow();
    expect(JSON.stringify(safe)).not.toContain(LABELLED_SECRET);
  });

  // ── 3. Deeply nested ──────────────────────────────────────────────────────
  it('3. sanitizes a sensitive value nested several levels deep', () => {
    const model = {
      id: 'wm-1',
      deep: { a: { b: { c: [{ d: { label: `call ${PHONE}` } }] } } },
    };
    const { model: safe } = sanitizeWorldModel(model);
    expect(() => assertWorldModelSafe(safe)).not.toThrow();
    expect(JSON.stringify(safe)).not.toContain(PHONE);
  });

  // ── 4. Multiple producers, multiple rules ─────────────────────────────────
  it('4. sanitizes violations from different producers and rules at once', () => {
    const model = modelWith(
      [
        { id: 'e1', title: 'A', attributes: { col_1: `phone ${PHONE}` } },
        { id: 'e2', title: 'B', attributes: { col_1: CARD } },
        { id: 'e3', title: 'C', attributes: { col_1: TOKEN } },
      ],
      [{ id: 'ax-1', role: 'link', name: 'History' }]
    );
    const { model: safe, stats } = sanitizeWorldModel(model);

    expect(() => assertWorldModelSafe(safe)).not.toThrow();
    const blob = JSON.stringify(safe);
    expect(blob).not.toContain(PHONE);
    expect(blob).not.toContain(CARD);
    expect(blob).not.toContain(TOKEN);
    expect(stats.redacted).toBeGreaterThanOrEqual(3);
    // Rule NAMES only in diagnostics.
    expect(Object.keys(stats.byRule).length).toBeGreaterThan(0);
  });

  // ── 5. Raw values absent from the FINAL model ─────────────────────────────
  it('5. no raw sensitive value survives anywhere in the final model', () => {
    const model = modelWith(
      [{ id: 'e', title: `acct ${CARD}`, attributes: { col_1: `mail a@b.com`, col_2: LABELLED_SECRET } }],
      [{ id: 'ax', role: 'link', name: `tel ${PHONE}` }]
    );
    const { model: safe } = sanitizeWorldModel(model);
    const blob = JSON.stringify(safe);
    for (const secret of [PHONE, CARD, LABELLED_SECRET, 'a@b.com']) {
      expect(blob).not.toContain(secret);
    }
  });

  // ── 6. Diagnostics carry no raw values ────────────────────────────────────
  it('6. diagnostics expose counts and rule names only, never values', () => {
    const model = modelWith([{ id: 'e', title: 'x', attributes: { col_1: TOKEN } }], []);
    const { stats } = sanitizeWorldModel(model);

    const diag = JSON.stringify(stats);
    expect(diag).not.toContain(TOKEN);
    expect(diag).not.toContain(PHONE);
    expect(stats.redacted).toBeGreaterThan(0);
    expect(typeof stats.scanned).toBe('number');
  });

  // ── 7. The assertion remains authoritative and unchanged ──────────────────
  it('7. assertWorldModelSafe still rejects an unsanitized model', () => {
    const raw = modelWith([{ id: 'e', title: 'x', attributes: { col_1: TOKEN } }], []);
    // Deliberately NOT sanitized — this is the choke-point bypass case.
    expect(() => assertWorldModelSafe(raw)).toThrow();
  });

  it('7b. the assertion still rejects an unsafe accessibility name', () => {
    const raw = modelWith([], [{ id: 'ax', role: 'link', name: `Contact telephone ${PHONE}` }]);
    expect(() => assertWorldModelSafe(raw)).toThrow();
  });

  it('7c. a sanitized model still passes — the guard remains a real guard', () => {
    const clean = modelWith([{ id: 'e', title: 'History', attributes: { col_1: 'Charminar' } }], []);
    expect(() => assertWorldModelSafe(clean)).not.toThrow();
  });

  // ── 8. Structural metadata is preserved, not mangled ──────────────────────
  it('8. preserves structural metadata and schema shape', () => {
    const model = modelWith(
      [{ id: 'ent-1', type: 'table', title: 'History', attributes: { col_1: 'Year' },
         bbox: [0, 0, 10, 10], confidence: 0.9, pageGeneration: 3 }],
      [{ id: 'ax-1', role: 'link', name: 'History', bbox: [1, 2, 3, 4], disabled: false }]
    );
    const { model: safe } = sanitizeWorldModel(model);
    const ent = safe.entities[0] as Record<string, unknown>;
    const ax = safe.accessibilityTree[0] as Record<string, unknown>;

    expect(ent.id).toBe('ent-1');
    expect(ent.type).toBe('table');
    expect(ent.bbox).toEqual([0, 0, 10, 10]);
    expect(ent.pageGeneration).toBe(3);
    expect(ax.role).toBe('link');
    expect(ax.bbox).toEqual([1, 2, 3, 4]);
    expect(ax.disabled).toBe(false);
  });

  it('9. leaves a fully safe model completely untouched', () => {
    const model = modelWith(
      [{ id: 'e', title: 'Charminar', attributes: { col_1: 'History' } }],
      [{ id: 'ax', role: 'heading', name: 'History' }]
    );
    const { model: safe, stats } = sanitizeWorldModel(model);
    expect(stats.redacted).toBe(0);
    expect(safe).toEqual(model);
  });

  it('10. does not mutate the caller-owned input', () => {
    const model = modelWith([{ id: 'e', title: 'x', attributes: { col_1: TOKEN } }], []);
    const before = JSON.stringify(model);
    sanitizeWorldModel(model);
    expect(JSON.stringify(model)).toBe(before);
  });
});