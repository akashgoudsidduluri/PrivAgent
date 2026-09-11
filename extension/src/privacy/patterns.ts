export const PATTERNS = {
  // Standard RFC 5322 compliant email regex
  EMAIL: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,

  // Credit card: 13-19 digits, optional dashes/spaces
  CREDIT_CARD: /\b(?:\d[ -]*?){13,19}\b/,

  // Phone: Indian (+91 or without, 10 digits with optional 5-5 split) and international formats
  PHONE: /(?:(?:\+91|0)?[\s.-]?)?[6-9]\d{4}[\s.-]?\d{5}\b|\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/,

  // Account number: 9 to 18 contiguous digits with banking context
  ACCOUNT_NUMBER: /\b\d{9,18}\b/,

  // Indian PAN (Permanent Account Number): 5 letters + 4 digits + 1 letter (e.g., ABCDE1234F)
  PAN: /\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/,

  // OTP: 4 to 8 digits
  OTP: /\b\d{4,8}\b/,

  // CVV / CVC: 3 or 4 digits
  CVV: /\b\d{3,4}\b/,
};

export const KEYWORDS = {
  PASSWORD: ['password', 'passwd', 'pwd', 'secret', 'passcode', 'pin', 'cvv', 'cvc', 'security-code'],
  EMAIL: ['email', 'e-mail', 'mail_id', 'user_email'],
  PHONE: ['phone', 'mobile', 'cellphone', 'telephone', 'contact_number', 'phone_number', 'mobile_no', 'phone_no', 'cell', 'tel'],
  CREDIT_CARD: ['card', 'cc-number', 'credit_card', 'debit_card', 'cardnumber', 'card-no'],
  ACCOUNT_NUMBER: ['account', 'account_no', 'account_number', 'acc_no', 'acc_num', 'acct', 'a/c'],
  PERSON_NAME: ['fullname', 'full_name', 'cardholder', 'holder_name', 'beneficiary', 'recipient_name', 'legal_name'],
  PAN: ['pan', 'pan_card', 'pan_no', 'pan_number', 'pan-no', 'pancard', 'permanent account number'],
  OTP: ['otp', 'one-time', 'passcode', 'verification code', 'verification_code', 'security code'],
  CVV: ['cvv', 'cvc', 'cvv2', 'security code', 'card verification', 'security-code'],
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
