export const PATTERNS = {
  // Standard RFC 5322 compliant email regex
  EMAIL: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,

  // Credit card: 13-19 digits, optional dashes/spaces
  CREDIT_CARD: /\b(?:\d[ -]*?){13,19}\b/,

  // Phone: Indian (+91 or without, 10 digits starting with 6-9) and international formats
  PHONE: /(?:(?:\+91|0)?[\s.-]?)?[6-9]\d{9}\b|\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/,

  // Account number: 9 to 18 contiguous digits with banking context
  ACCOUNT_NUMBER: /\b\d{9,18}\b/,
};

export const KEYWORDS = {
  PASSWORD: ['password', 'passwd', 'pwd', 'secret', 'passcode', 'pin', 'cvv', 'cvc', 'security-code'],
  EMAIL: ['email', 'e-mail', 'mail_id', 'user_email'],
  PHONE: ['phone', 'mobile', 'cell', 'tel', 'contact_number', 'telephone'],
  CREDIT_CARD: ['card', 'cc-number', 'credit_card', 'debit_card', 'cardnumber', 'card-no', 'pan_card'],
  ACCOUNT_NUMBER: ['account', 'account_no', 'account_number', 'acc_no', 'acc_num', 'acct'],
  PERSON_NAME: ['fullname', 'full_name', 'cardholder', 'holder_name', 'beneficiary', 'recipient_name', 'legal_name'],
};

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
 * Checks if a string contains any of the target keywords (case-insensitive).
 */
export function matchesKeyword(text: string | null | undefined, keywords: string[]): boolean {
  if (!text) return false;
  const lower = text.toLowerCase().trim();
  return keywords.some(kw => lower.includes(kw));
}
