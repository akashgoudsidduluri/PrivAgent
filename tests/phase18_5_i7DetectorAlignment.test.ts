/**
 * PHASE I-7 — WORLD-MODEL PRIVACY DETECTOR ALIGNMENT.
 *
 * Regression coverage for the confirmed defect:
 *
 *   [ContentScript] world model build/sanitization failed:
 *   [PrivAgent WorldModel Security Violation] Raw sensitive credential
 *   detected at root.accessibilityTree[314].name: rule=phone
 *
 * reproduced 4/4 times on https://en.wikipedia.org/wiki/Charminar.
 *
 * THE DEFECT. Accessibility extraction screened names with `isSensitiveText`,
 * a narrow keyword list. The authoritative world-model assertion
 * (`assertWorldModelSafe`) screens with `scanForRawSensitiveValues`, which is
 * strictly wider — it includes `hasContextualPhone`. A name could therefore
 * pass extraction and then fail the assertion, and the all-or-nothing catch
 * around `buildCurrentWorldModel` discarded an otherwise valid ~96-region
 * world model, losing every entity, affordance and fact for the page.
 *
 * THE INVARIANT these tests pin:
 *
 *   any accessibility name that would fail `assertWorldModelSafe` must be
 *   replaced BEFORE it enters the world model.
 *
 * These tests also pin what must NOT change: the assertion still rejects an
 * unsafe model, and no raw value is ever retained.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  sanitizeAccessibleName,
  extractAccessibilityTree,
  accessibilitySanitizationStats,
  resetAccessibilitySanitizationStats,
} from '../extension/src/worldModel/accessibilityTree';
import { assertWorldModelSafe } from '../extension/src/worldModel/worldModelSanitizer';
import { scanForRawSensitiveValues } from '../extension/src/privacy/rawValueScanner';

const PHONE = '9876543210';

/** A name shaped like the real Wikipedia citation that broke production. */
function wikipediaStyleContextualPhone(): string {
  return `Contact telephone ${PHONE} for details`;
}

beforeEach(() => {
  resetAccessibilitySanitizationStats();
});

describe('I-7 detector alignment', () => {
  // ── A. Contextual phone inside an accessibility name ──────────────────────
  it('A. sanitizes a contextual phone name that previously caused destruction', () => {
    const offending = wikipediaStyleContextualPhone();
    // Precondition: this string IS what trips the authoritative scanner.
    expect(scanForRawSensitiveValues(offending).length).toBeGreaterThan(0);

    const safe = sanitizeAccessibleName(offending);

    // Raw value NOT retained.
    expect(safe).not.toContain(PHONE);
    expect(safe).not.toContain(offending);
    expect(safe).toBe('Protected Credential Field');
  });

  it('A2. the sanitized result itself passes the authoritative assertion', () => {
    const safe = sanitizeAccessibleName(wikipediaStyleContextualPhone());
    expect(scanForRawSensitiveValues(safe)).toHaveLength(0);
    // And the node shape the world model actually carries is safe.
    expect(() => assertWorldModelSafe({ accessibilityTree: [{ name: safe }] })).not.toThrow();
  });

  // ── B. Genuine sensitive data ─────────────────────────────────────────────
  it('B. still sanitizes a genuine phone number', () => {
    const safe = sanitizeAccessibleName(`Phone: ${PHONE}`);
    expect(safe).not.toContain(PHONE);
    expect(scanForRawSensitiveValues(safe)).toHaveLength(0);
  });

  it('B2. still sanitizes credential-shaped labels', () => {
    expect(sanitizeAccessibleName('Password')).toBe('Protected Credential Field');
    expect(sanitizeAccessibleName('Enter your CVV')).toBe('Protected Credential Field');
    expect(sanitizeAccessibleName('API token')).toBe('Protected Credential Field');
  });

  // ── C. Ordinary Wikipedia-style content survives ──────────────────────────
  it('C. preserves ordinary article and citation content', () => {
    const ordinary = [
      'Charminar',
      'History',
      'Mughal rule',
      'Structure',
      'Edit',
      'View source',
      'Talk',
      'Coordinates',
    ];
    for (const text of ordinary) {
      expect(sanitizeAccessibleName(text)).toBe(text);
    }
  });

  it('C2. counts show withholding only where it is genuinely warranted', () => {
    sanitizeAccessibleName('History');
    sanitizeAccessibleName('Charminar');
    expect(accessibilitySanitizationStats.scanned).toBe(2);
    expect(accessibilitySanitizationStats.withheld).toBe(0);

    resetAccessibilitySanitizationStats();
    sanitizeAccessibleName(wikipediaStyleContextualPhone());
    expect(accessibilitySanitizationStats.withheld).toBe(1);
    expect(Object.keys(accessibilitySanitizationStats.byRule)).toContain('phone');
  });

  // ── D. Detector alignment (the core invariant) ────────────────────────────
  it('D. no name can pass extraction then fail assertWorldModelSafe', () => {
    const corpus = [
      wikipediaStyleContextualPhone(),
      `Phone: ${PHONE}`,
      'Password',
      'CVV 123',
      'Charminar',
      'History',
      'a'.repeat(300),
      '',
      '   ',
      'Contact us at 9876543210',
      'Tel 020-7946-0958',
      'token=abcdef123456',
      '4111111111111111',
      'user@example.com',
    ];
    for (const name of corpus) {
      const out = sanitizeAccessibleName(name);
      expect(
        scanForRawSensitiveValues(out),
        `sanitized output for ${JSON.stringify(name.slice(0, 24))} still fails the assertion`,
      ).toHaveLength(0);
    }
  });

  // ── E. Fail-closed assertion is NOT weakened ───────────────────────────────
  it('E. assertWorldModelSafe still rejects an unsafe model', () => {
    expect(() =>
      assertWorldModelSafe({ accessibilityTree: [{ name: wikipediaStyleContextualPhone() }] })
    ).toThrow();
  });

  it('E2. the assertion still rejects a forbidden property key', () => {
    expect(() => assertWorldModelSafe({ node: { value: 'secret' } })).toThrow();
  });

  it('E3. the assertion was not removed or made permissive', () => {
    // A clean model must pass — proving the guard still exists as a guard.
    expect(() =>
      assertWorldModelSafe({ accessibilityTree: [{ name: 'Protected Credential Field' }] })
    ).not.toThrow();
  });

  // ── F. Raw-value non-retention ────────────────────────────────────────────
  it('F. no sanitized output retains any original sensitive substring', () => {
    const secrets = [
      wikipediaStyleContextualPhone(),
      `Password: hunter2`,
      '4111111111111111',
      'user@example.com',
    ];
    for (const secret of secrets) {
      const out = sanitizeAccessibleName(secret);
      expect(out).not.toContain(secret);
      // Every alphanumeric run from the original must be absent.
      for (const token of secret.split(/\s+/).filter((t) => t.length >= 4)) {
        expect(out).not.toContain(token);
      }
    }
  });

  // ── G. Proportional failure at node level ─────────────────────────────────
  it('G. a document with one unsafe label still yields a populated tree', () => {
    document.body.innerHTML = `
      <h1>Charminar</h1>
      <a href="/wiki/History">History</a>
      <a href="/wiki/Structure">Structure</a>
      <button>Edit</button>
      <input aria-label="Contact telephone ${PHONE}" />
    `;
    const nodes = extractAccessibilityTree(document);

    // The tree built at all — this is what previously came back empty.
    expect(nodes.length).toBeGreaterThan(0);
    // And nothing in it carries the raw phone number.
    const blob = JSON.stringify(nodes);
    expect(blob).not.toContain(PHONE);
    // The safe sibling content is still present and usable.
    expect(blob).toContain('History');
  });

  it('G2. a wholly clean document is unaffected by the guard', () => {
    document.body.innerHTML = `
      <h1>Charminar</h1>
      <a href="/wiki/History">History</a>
      <button>Edit</button>
    `;
    const nodes = extractAccessibilityTree(document);
    expect(nodes.length).toBeGreaterThan(0);
    expect(JSON.stringify(nodes)).toContain('Charminar');
  });
});