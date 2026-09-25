/**
 * PrivAgent — Raw Value Scanner (M8 privacy firewall)
 *
 * The LAST line of defense before anything is handed to a reasoning provider:
 * an independent scan of an outgoing sanitized-context object for
 *   (a) forbidden keys (`value`, `text`, `password`, `rawOCR`, `cvv`, ...) and
 *   (b) VALUES that look like raw sensitive data (email, phone, Luhn-valid card,
 *       Indian PAN, labelled credentials, API-key-shaped tokens, raw media).
 *
 * Why a second scanner when M4 already uses an allowlist?
 *   The allowlist guarantees which FIELDS exist. This scanner independently
 *   verifies that no field carries a PII-shaped VALUE — it catches regressions
 *   where a future detector, adapter, or refactor starts copying raw content into
 *   an allowlisted field. It is defense in depth, mirroring the backend's
 *   independent `security.py` / `text_safety.py` boundary.
 *
 * Key classes (deterministic, no guessing):
 *   - STRUCTURAL keys (`id`, `selector`, `url`, `path`, `href`, `src`) hold
 *     machine-generated identifiers. They are checked with STRONG rules only,
 *     because bare digit runs legitimately occur inside generated ids
 *     (e.g. the OCR id format `ocr-det-1-1720000000000` embeds a timestamp).
 *     Applying the generic digit-run rules there would fail closed randomly.
 *   - Every other string value is checked with the FULL rule set.
 *
 * This scanner NEVER logs or returns raw values — violations carry only a path
 * and a rule code.
 */

import { PATTERNS, isValidLuhn, isValidPAN } from './patterns';
import { assertZeroLeakageInPayload } from '../ocr/ocrSecurityBoundary';

export type RawValueRule =
  | 'forbidden_key'
  | 'email'
  | 'phone'
  | 'credit_card'
  | 'account_number'
  | 'pan'
  | 'labelled_credential'
  | 'credential_token'
  | 'raw_media';

export interface RawValueViolation {
  /** Dotted path to the offending property. Contains no values. */
  path: string;
  rule: RawValueRule;
}

/** Keys that must never appear anywhere in an outgoing agent payload. */
export const FORBIDDEN_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'value', 'text', 'textContent', 'innerText', 'rawText', 'rawOCR', 'ocrText',
  'password', 'words', 'lines', 'token', 'secret', 'card', 'cardNumber',
  'card_number', 'cvv', 'pan', 'accountNumber', 'account_number', 'raw',
  'input', 'sensitiveValue', 'sensitive_value', 'pii', 'val', 'fulltext',
]);

const FORBIDDEN_PAYLOAD_KEYS_NORMALIZED: ReadonlySet<string> = new Set(
  Array.from(FORBIDDEN_PAYLOAD_KEYS).map((k) => k.toLowerCase().replace(/_/g, ''))
);

/** Machine-generated identifier keys — strong rules only. */
export const STRUCTURAL_VALUE_KEYS: ReadonlySet<string> = new Set([
  'id', 'selector', 'url', 'path', 'href', 'src', 'sanitized_status',
  'goalid', 'subgoalid', 'taskid', 'worldmodelid', 'pagegeneration',
]);

// ── Patterns (reused from the project's single pattern source) ───────────────

const EMAIL_RULE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const INDIAN_PHONE_RULE = /(?:^|[\s(+])(?:\+?91[-\s]?)?[6-9]\d{9}(?=$|[\s).,-])/;
const LABELLED_CREDENTIAL_RULE = /(?:password|passcode|cvv|otp|pin|api[_-]?key|bearer)\s*[:=]\s*\S+/i;
const CREDENTIAL_TOKEN_RULE = /\b(?=[^\s]*[A-Z])(?=[^\s]*[a-z])(?=[^\s]*\d)[^\s]{8,}\b/;
const RAW_MEDIA_RULE = /data:image\/|base64,[A-Za-z0-9+/]{40,}/i;
/** A string that is nothing but a digit run is a raw account-number shape. */
const BARE_DIGIT_RUN_RULE = /^[\d\s-]{9,}$/;

/**
 * Unambiguous PII shapes — applied to EVERY string value, including structural
 * identifier fields (an email or PAN inside an id is never legitimate).
 */
function strongRuleViolations(text: string): RawValueRule[] {
  const hits: RawValueRule[] = [];
  if (EMAIL_RULE.test(text)) hits.push('email');
  if (isValidPAN(text)) hits.push('pan');
  if (LABELLED_CREDENTIAL_RULE.test(text)) hits.push('labelled_credential');
  if (RAW_MEDIA_RULE.test(text)) hits.push('raw_media');
  return hits;
}

/**
 * Bare digit-run heuristics — applied to value-bearing (non-structural) fields
 * only. Machine-generated identifiers legitimately embed digit runs (the OCR id
 * format is `ocr-det-{n}-{epochMillis}`), so applying these there would fail
 * closed randomly.
 */
function valueRuleViolations(text: string): RawValueRule[] {
  const hits: RawValueRule[] = [];

  const digitRuns = text.replace(/[-\s]/g, '').match(/\d{13,19}/g);
  if (digitRuns && digitRuns.some((run) => isValidLuhn(run))) hits.push('credit_card');

  if (BARE_DIGIT_RUN_RULE.test(text) && text.replace(/\D/g, '').length >= 9) {
    hits.push('account_number');
  }

  if (INDIAN_PHONE_RULE.test(text) || PATTERNS.PHONE.test(text)) hits.push('phone');

  const isDateOrTimestamp =
    /\b\d{1,2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2,4}\b/i.test(text) ||
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) ||
    /\b\d{4}-\d{2}-\d{2}\b/.test(text);

  if (!isDateOrTimestamp && CREDENTIAL_TOKEN_RULE.test(text)) hits.push('credential_token');

  return hits;
}

export interface RawValueScanOptions {
  /** Override the structural key set (defaults to STRUCTURAL_VALUE_KEYS). */
  structuralKeys?: ReadonlySet<string>;
  /** Extra keys to treat as structural. */
  extraStructuralKeys?: readonly string[];
  /** Keys permitted despite being in FORBIDDEN_PAYLOAD_KEYS (their string values are still scanned for PII). */
  allowedKeyNames?: readonly string[];
}

/**
 * Recursively scans an object for forbidden keys and PII-shaped string values.
 * Returns every violation found (order-stable); an empty array means clean.
 */
export function scanForRawSensitiveValues(
  value: unknown,
  options: RawValueScanOptions = {}
): RawValueViolation[] {
  const structural = new Set<string>(
    Array.from(options.structuralKeys ?? STRUCTURAL_VALUE_KEYS).map((k) => k.toLowerCase())
  );
  for (const key of options.extraStructuralKeys ?? []) {
    structural.add(key.toLowerCase());
  }

  const allowed = new Set<string>(
    (options.allowedKeyNames ?? []).map((k) => k.toLowerCase())
  );

  const violations: RawValueViolation[] = [];
  walk(value, '<root>', structural, allowed, violations);
  return violations;
}

function walk(
  node: unknown,
  path: string,
  structural: Set<string>,
  allowed: Set<string>,
  violations: RawValueViolation[]
): void {
  if (node === null || node === undefined) return;

  if (Array.isArray(node)) {
    node.forEach((item, index) => walk(item, `${path}[${index}]`, structural, allowed, violations));
    return;
  }

  if (typeof node === 'object') {
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      const normalizedKey = lowerKey.replace(/_/g, '');
      const isAllowed = allowed.has(lowerKey) || allowed.has(normalizedKey);
      if (!isAllowed && (FORBIDDEN_PAYLOAD_KEYS.has(key) || FORBIDDEN_PAYLOAD_KEYS_NORMALIZED.has(normalizedKey))) {
        violations.push({ path: `${path}.${key}`, rule: 'forbidden_key' });
      }
      if (typeof child === 'string') {
        scanString(child, `${path}.${key}`, key.toLowerCase(), structural, violations);
      } else {
        walk(child, `${path}.${key}`, structural, allowed, violations);
      }
    }
    return;
  }

  if (typeof node === 'string') {
    scanString(node, path, '', structural, violations);
  }
}

function scanString(
  text: string,
  path: string,
  key: string,
  structural: Set<string>,
  violations: RawValueViolation[]
): void {
  if (!text) return;

  const rules = new Set<RawValueRule>(strongRuleViolations(text));
  if (!structural.has(key)) {
    for (const rule of valueRuleViolations(text)) {
      rules.add(rule);
    }
  }

  for (const rule of rules) {
    violations.push({ path, rule });
  }
}

export class PrivacyBoundaryError extends Error {
  readonly violations: RawValueViolation[];

  constructor(message: string, violations: RawValueViolation[]) {
    super(message);
    this.name = 'PrivacyBoundaryError';
    this.violations = violations;
  }
}

/**
 * Fails closed: throws PrivacyBoundaryError when any forbidden key or
 * PII-shaped value is present. Called before every network/provider hand-off.
 */
export function assertNoRawSensitiveValues(
  value: unknown,
  options: RawValueScanOptions = {}
): void {
  const violations = scanForRawSensitiveValues(value, options);
  if (violations.length > 0) {
    const summary = Array.from(new Set(violations.map((v) => v.rule))).join(', ');
    throw new PrivacyBoundaryError(
      `[PrivAgent Privacy Firewall] Outgoing payload rejected (${violations.length} violation(s): ${summary}). ` +
        'Raw sensitive values must never leave the device.',
      violations
    );
  }
}

/**
 * Asserts that NONE of the supplied known raw sensitive values appear anywhere
 * in the serialized payload. Reused from the OCR security boundary so there is
 * exactly one implementation of the zero-leakage check.
 */
export const assertNoKnownRawValues = assertZeroLeakageInPayload;

/** Convenience: same check as `assertNoKnownRawValues`, but non-throwing. */
export function findKnownRawValueLeaks(payload: unknown, rawValues: string[]): string[] {
  const serialized = JSON.stringify(payload);
  if (!serialized) return [];
  return rawValues.filter((raw) => {
    const clean = raw?.trim();
    return !!clean && clean.length >= 3 && serialized.includes(clean);
  });
}
