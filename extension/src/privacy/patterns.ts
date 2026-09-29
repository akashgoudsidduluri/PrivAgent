export const PATTERNS = {
  // Standard RFC 5322 compliant email regex
  EMAIL: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,

  // Credit card: 13-19 digits, optional dashes/spaces
  CREDIT_CARD: /\b(?:\d[ -]*?){13,19}\b/,

  // Phone: Indian (+91 or without, 10 digits with optional 5-5 split) and international / US formats (requires separators or valid 10-digit mobile)
  PHONE: /(?:\+\d{1,3}[-.\s])?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b|(?:(?:\+91|0)?[\s.-]?)?[6-9]\d{4}[\s.-]?\d{5}\b|\+\d{1,3}[-.\s]\d{1,4}[-.\s]\d{3,4}[-.\s]\d{3,4}\b/,

  // Account number: 9 to 18 contiguous digits with banking context
  ACCOUNT_NUMBER: /\b\d{9,18}\b/,

  // Indian PAN (Permanent Account Number): 5 letters + 4 digits + 1 letter (e.g., ABCDE1234F)
  PAN: /\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/,

  // OTP: 4 to 8 digits
  OTP: /\b\d{4,8}\b/,

  // CVV / CVC: 3 or 4 digits
  CVV: /\b\d{3,4}\b/,

  // Address: Street/Road/Flat/Postal pattern with 6-digit Indian PIN or standard street suffix
  ADDRESS: /\b(?:flat|plot|road|street|lane|nagar|sector|residency|avenue|colony|cross)\b.*?\b\d{6}\b|\b\d{1,5}\s+[a-zA-Z0-9\s.,-]+\b(?:street|road|avenue|drive|lane)\b/i,
};

export const KEYWORDS = {
  PASSWORD: ['password', 'passwd', 'pwd', 'secret', 'passcode', 'pin', 'cvv', 'login-pin'],
  EMAIL: ['email', 'e-mail', 'mail_id', 'user_email'],
  PHONE: ['phone', 'mobile', 'cellphone', 'telephone', 'contact_number', 'phone_number', 'mobile_no', 'phone_no', 'cell', 'tel'],
  CREDIT_CARD: ['card', 'cc-number', 'credit_card', 'debit_card', 'cardnumber', 'card-no', 'credit card', 'payment card'],
  ACCOUNT_NUMBER: ['account', 'account_no', 'account_number', 'acc_no', 'acc_num', 'acct', 'a/c', 'beneficiary account', 'checking account'],
  PERSON_NAME: [
    'fullname', 'full_name', 'cardholder', 'holder_name', 'beneficiary', 'recipient_name',
    'legal_name', 'account holder', 'applicant', 'signatory', 'applicant name', 'authorized signatory',
    'customer name', 'client name', 'cardholder name'
  ],
  PAN: ['pan', 'pan_card', 'pan_no', 'pan_number', 'pan-no', 'pancard', 'permanent account number', 'pan card'],
  OTP: ['otp', 'one-time', 'one-time passcode', 'verification code', 'verification_code', 'security code', 'verification', 'one-time password'],
  CVV: ['cvv', 'cvc', 'cvv2', 'security code', 'card verification', 'security-code', 'cvc code'],
  ADDRESS: ['address', 'billing address', 'shipping address', 'residential address', 'registered address', 'residency', 'street', 'locality'],
};

/**
 * Validates Indian PAN format strictly.
 */
export function isValidPAN(text: string): boolean {
  return /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(text.trim());
}

/**
 * Validates potential CVV: must be 3-4 digits AND have nearby CVV/security keywords.
 */
export function isPotentialCVV(text: string, surroundingContext?: string): boolean {
  const trimmed = text.trim();
  if (!/^\d{3,4}$/.test(trimmed)) return false;
  if (!surroundingContext) return false;
  return matchesKeyword(surroundingContext, KEYWORDS.CVV);
}

/**
 * Validates potential OTP: must be 4-8 digits AND have nearby OTP/verification keywords.
 */
export function isPotentialOTP(text: string, surroundingContext?: string): boolean {
  const trimmed = text.trim();
  if (!/^\d{4,8}$/.test(trimmed)) return false;
  if (!surroundingContext) return false;
  return matchesKeyword(surroundingContext, KEYWORDS.OTP);
}

/**
 * Validates potential Bank Account Number: 9-18 digits AND has nearby account context.
 */
export function isPotentialAccountNumber(text: string, surroundingContext?: string): boolean {
  const cleaned = text.replace(/[\s-]/g, '');
  if (!/^\d{9,18}$/.test(cleaned)) return false;
  // If Luhn valid, it's more likely a credit card, not an account number
  if (isValidLuhn(cleaned)) return false;
  if (!surroundingContext) return false;
  return matchesKeyword(surroundingContext, KEYWORDS.ACCOUNT_NUMBER);
}

// ─────────────────────────────────────────────────────────────────────────────
// Contextual phone detection (M8 phone-gap remediation)
//
// WHY THIS EXISTS. `PATTERNS.PHONE` only matches a bare 10-digit run when it
// begins with [6-9] — the Indian mobile numbering plan — or when it carries
// separators. A real number in prose such as "Support line 5551234567" starts
// with 5 and has no separators, so it matched nothing. The leading-digit
// restriction is deliberate and is NOT relaxed here.
//
// WHY NOT JUST `\d{10}`. A bare 10-digit number is far more often a product ID,
// order ID, invoice number, tracking number, timestamp or reference number. On
// a 22-case corpus, treating every bare 10-digit run as a phone produced 13
// false positives. Recall was not bought with precision.
//
// THE RULE. Three independent gates, ALL of which must hold, so no single gate
// is load-bearing on its own:
//
//   G1 SHAPE   exactly 10 digits, not adjacent to another digit or a dash, so a
//              longer numeric token is never split into a "phone".
//   G2 CONTEXT a phone-intent word within a bounded window before or after the
//              run. This is what separates "Support line 5551234567" from
//              "Product ID 1234567890".
//   G3 GUARD   an explicit non-phone identifier label immediately preceding the
//              run wins over a generic intent word.
//
// Generic words (notably a bare "number") are deliberately NOT intent tokens:
// "The number 1234567890 appears in the report" must not become a phone.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Words that introduce a phone number. Multi-word forms are listed as regex
 * alternations because `matchesKeyword` does a plain substring test and
 * KEYWORDS.PHONE's underscored entries ("contact_number") do not match the
 * space-separated labels found in real markup ("Contact Number").
 */
const PHONE_INTENT_WORD =
  /\b(?:phone|telephone|tel|mobile|cellphone|contact(?:\s+number|\s+no)?|support(?:\s+line)?|line|hotline|helpline|call(?:\s+us)?|dial|reach(?:\s+us)?|ring|sms|whatsapp|enquir(?:y|ies)|inquir(?:y|ies))\b/i;

/**
 * Labels that positively identify a number as something OTHER than a phone.
 * Checked against the label immediately before the run, and it overrides G2.
 */
const NON_PHONE_LABEL_WORD =
  /\b(?:id|ids|identifier|no|nos|num|code|zip|zipcode|postal|pin|invoice|inv|order|ord|tracking|track|reference|ref|acct|account|serial|ser|timestamp|time|epoch|sku|ean|isbn|upc|ssn|pan|aadhar|aadhaar|uid|utr|neft|ifsc|hash|uuid|guid|token|otp|mmid|trans|transaction|txn|doc|document|policy|passport|license|licence|lic|permit|reg|registration)\b/i;

/** How far either side of the run a context word may sit. */
const PHONE_CONTEXT_WINDOW_CHARS = 48;

/**
 * Detects an unformatted 10-digit phone number that `PATTERNS.PHONE` cannot
 * see, but only when its surrounding text says it is a phone.
 *
 * Local and deterministic; no I/O, no network, no model. Returns a boolean so
 * callers keep their existing confidence/source metadata.
 */
export function hasContextualPhone(text: string | null | undefined): boolean {
  if (!text) return false;
  // Cheap reject first: the rule needs a 10-digit run to exist at all.
  if (!/\d/.test(text)) return false;

  for (const match of text.matchAll(/(?<![\d-])(\d{10})(?![\d-])/g)) {
    const at = match.index ?? 0;
    const before = text.slice(Math.max(0, at - PHONE_CONTEXT_WINDOW_CHARS), at);
    const after = text.slice(at + 10, Math.min(text.length, at + 10 + PHONE_CONTEXT_WINDOW_CHARS));

    // G2 — phone intent nearby, on either side.
    if (!PHONE_INTENT_WORD.test(before) && !PHONE_INTENT_WORD.test(after)) continue;

    // G3 — an explicit non-phone label immediately before the run wins.
    const label = before.match(/([A-Za-z][A-Za-z\s._-]{0,24})\s*[:=#-]?\s*$/)?.[1] ?? '';
    if (label && NON_PHONE_LABEL_WORD.test(label)) continue;

    return true;
  }
  return false;
}

/**
 * Validates a potential credit card number using the standard Luhn algorithm (mod 10).
 */
export function isValidLuhn(cardNumberStr: string): boolean {
  const sanitized = cardNumberStr.replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(sanitized)) {
    return false;
  }

  let sum = 0;
  let shouldDouble = false;

  for (let i = sanitized.length - 1; i >= 0; i--) {
    const charCode = sanitized.charCodeAt(i);
    let digit = charCode - 48;

    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

/**
 * Checks if a string contains any of the target keywords.
 * For short tokens (<= 4 characters, e.g. 'tel', 'cell', 'pin'), requires
 * delimiter/token boundaries to prevent substring collisions (e.g. 'tell' or 'intel' matching 'tel').
 */
export function matchesKeyword(text: string | null | undefined, keywords: string[]): boolean {
  if (!text) return false;
  // Separate camelCase boundaries (e.g. txtCurrentPin -> txt Current Pin)
  const normalized = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().trim();

  return keywords.some(kw => {
    const kwLower = kw.toLowerCase();
    // Short keywords require word or delimiter boundaries
    if (kwLower.length <= 4) {
      const escaped = kwLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(^|[^a-zA-Z0-9])${escaped}([^a-zA-Z0-9]|$)`, 'i');
      return pattern.test(normalized);
    }
    return normalized.includes(kwLower);
  });
}
