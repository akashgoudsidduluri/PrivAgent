import { DetectionResult, DetectionSource, SensitiveEntityType } from './types';
import { KEYWORDS, PATTERNS, isValidLuhn, isValidPAN, isPotentialCVV, isPotentialOTP, isPotentialAccountNumber, matchesKeyword } from './patterns';

/**
 * Safe CSS selector escaping compatible with all browser and JSDOM environments.
 */
function escapeCss(str: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(str);
  }
  return str.replace(/([ #;?%&,.+*~':"!^$[\]()=>|/@\\])/g, '\\$1');
}

/**
 * Generates a unique CSS selector for a given element.
 */
function getUniqueSelector(el: HTMLElement): string {
  if (el.id) {
    return `#${escapeCss(el.id)}`;
  }
  
  if (el instanceof HTMLInputElement && el.name) {
    return `input[name="${escapeCss(el.name)}"]`;
  }

  const parts: string[] = [];
  let current: HTMLElement | null = el;

  while (current && current !== document.body && current !== document.documentElement) {
    let selector = current.tagName.toLowerCase();
    if (current.className && typeof current.className === 'string') {
      const firstClass = current.className.trim().split(/\s+/)[0];
      if (firstClass && !firstClass.startsWith('privagent-')) {
        selector += `.${escapeCss(firstClass)}`;
      }
    }

    if (current.parentElement) {
      const siblings = Array.from(current.parentElement.children).filter(c => c.tagName === current?.tagName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${index})`;
      }
    }

    parts.unshift(selector);
    current = current.parentElement;
    if (parts.length >= 3) break;
  }

  return parts.join(' > ');
}

/**
 * Calculates the bounding box coordinates [x, y, width, height] for an element.
 */
function getBoundingBox(el: HTMLElement): [number, number, number, number] {
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
 * Finds associated label text for an input control.
 */
function getAssociatedLabelText(input: HTMLElement): string {
  // 1. Explicit <label for="...">
  if (input.id) {
    const doc = input.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const label = doc ? doc.querySelector(`label[for="${escapeCss(input.id)}"]`) : null;
    if (label && label.textContent) {
      return label.textContent.trim();
    }
  }

  // 2. Parent <label>
  const parentLabel = input.closest('label');
  if (parentLabel && parentLabel.textContent) {
    return parentLabel.textContent.trim();
  }

  // 3. Preceding sibling label or sibling text
  let prev = input.previousElementSibling;
  while (prev) {
    if (prev.tagName.toLowerCase() === 'label' && prev.textContent) {
      return prev.textContent.trim();
    }
    prev = prev.previousElementSibling;
  }

  return '';
}

/**
 * Checks if an element represents a generic chat prompt, search bar, or message composer
 * that should not be classified as a phone field when empty.
 */
function isGenericComposerOrSearch(el: HTMLElement): boolean {
  const tagName = el.tagName.toLowerCase();
  const id = (el.id || '').toLowerCase();
  const name = (el.getAttribute('name') || '').toLowerCase();
  const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
  const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();

  const chatKeywords = ['prompt', 'composer', 'chat', 'search', 'query', 'comment', 'message', 'ask', 'discussion'];

  // Check if placeholder or aria-label clearly indicates chat/search/prompt
  if (chatKeywords.some(kw => placeholder.includes(kw) || ariaLabel.includes(kw))) {
    return true;
  }

  // Check if id or name indicates prompt/composer/chat/search
  if (chatKeywords.some(kw => id.includes(kw) || name.includes(kw))) {
    return true;
  }

  // Multi-line <textarea> without explicit phone identifiers
  if (tagName === 'textarea' && !id.includes('phone') && !name.includes('phone')) {
    return true;
  }

  return false;
}

export interface ScanResult {
  detections: DetectionResult[];
  scanLatencyMs: number;
  totalElementsScanned: number;
}

/**
 * Local DOM-based Sensitive Data Detector.
 * Analyzes form controls, labels, and text nodes purely on-device.
 * Guarantees zero raw PII values in the returned DetectionResult.
 */
export function scanDOM(root?: Document | HTMLElement): ScanResult {
  const targetRoot = root || (typeof document !== 'undefined' ? document : null);
  if (!targetRoot) {
    return { detections: [], scanLatencyMs: 0, totalElementsScanned: 0 };
  }
  const startTime = performance.now();
  const detections: DetectionResult[] = [];
  const detectedElements = new Set<HTMLElement>();
  let elementCount = 0;

  // 1. Scan Form Inputs & Controls (<input>, <textarea>, <select>)
  const formControls = Array.from(targetRoot.querySelectorAll<HTMLElement>('input, textarea, select'));
  elementCount += formControls.length;

  for (const el of formControls) {
    const input = el as HTMLInputElement;
    const typeAttr = (input.getAttribute('type') || input.type || '').toLowerCase();
    const autocomplete = (input.getAttribute('autocomplete') || '').toLowerCase();
    const name = (input.getAttribute('name') || input.name || '').toLowerCase();
    const id = (input.getAttribute('id') || input.id || '').toLowerCase();
    const placeholder = (input.getAttribute('placeholder') || '').toLowerCase();
    const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase();
    const labelText = getAssociatedLabelText(input).toLowerCase();
    const rawValue = input.value || '';
    const length = rawValue.length;

    let detectedType: SensitiveEntityType | null = null;
    let confidence = 0.0;
    let source: DetectionSource = 'dom_attribute';

    const inputContext = `${name} ${id} ${labelText} ${ariaLabel} ${placeholder}`.trim().toLowerCase();

    // A. CVV / Security Code Checks (can be type="password" or type="text" with CVV context)
    if (autocomplete === 'cc-csc' || matchesKeyword(inputContext, KEYWORDS.CVV) || isPotentialCVV(rawValue, inputContext)) {
      detectedType = 'cvv';
      confidence = 0.98;
      source = 'dom_label';
    }

    // B. OTP / Verification Code Checks
    else if (autocomplete === 'one-time-code' || matchesKeyword(inputContext, KEYWORDS.OTP) || isPotentialOTP(rawValue, inputContext)) {
      detectedType = 'otp';
      confidence = 0.98;
      source = 'dom_label';
    }

    // C. Password Checks
    else if (typeAttr === 'password') {
      detectedType = 'password';
      confidence = 1.0;
      source = 'dom_input_type';
    } else if (autocomplete.includes('password') || autocomplete.includes('current-password') || autocomplete.includes('new-password')) {
      detectedType = 'password';
      confidence = 0.99;
      source = 'dom_autocomplete';
    } else if (matchesKeyword(inputContext, KEYWORDS.PASSWORD)) {
      detectedType = 'password';
      confidence = 0.95;
      source = 'dom_label';
    }

    // D. Credit / Debit Card Checks
    else if (autocomplete.includes('cc-number')) {
      detectedType = 'credit_card';
      confidence = 0.98;
      source = 'dom_autocomplete';
    } else if (matchesKeyword(inputContext, KEYWORDS.CREDIT_CARD)) {
      detectedType = 'credit_card';
      confidence = 0.95;
      source = 'dom_label';
    } else if (rawValue && isValidLuhn(rawValue)) {
      detectedType = 'credit_card';
      confidence = 0.98;
      source = 'text_pattern';
    }

    // E. Indian PAN Checks
    else if (matchesKeyword(inputContext, KEYWORDS.PAN) || (rawValue && isValidPAN(rawValue))) {
      detectedType = 'pan';
      confidence = 0.98;
      source = 'text_pattern';
    }

    // F. Email Checks
    else if (typeAttr === 'email' || autocomplete === 'email') {
      detectedType = 'email';
      confidence = 0.99;
      source = typeAttr === 'email' ? 'dom_input_type' : 'dom_autocomplete';
    } else if (matchesKeyword(inputContext, KEYWORDS.EMAIL)) {
      detectedType = 'email';
      confidence = 0.92;
      source = 'dom_label';
    } else if (rawValue && PATTERNS.EMAIL.test(rawValue)) {
      detectedType = 'email';
      confidence = 0.97;
      source = 'text_pattern';
    }

    // G. Phone Number Checks
    else if (typeAttr === 'tel') {
      detectedType = 'phone';
      confidence = 0.98;
      source = 'dom_input_type';
    } else if (autocomplete === 'tel' || autocomplete.startsWith('tel-')) {
      detectedType = 'phone';
      confidence = 0.98;
      source = 'dom_autocomplete';
    } else if (rawValue && PATTERNS.PHONE.test(rawValue)) {
      detectedType = 'phone';
      confidence = 0.95;
      source = 'text_pattern';
    } else if (!rawValue && !isGenericComposerOrSearch(el) && matchesKeyword(inputContext, KEYWORDS.PHONE)) {
      detectedType = 'phone';
      confidence = 0.90;
      source = 'dom_label';
    }

    // H. Bank Account Number Checks
    else if (matchesKeyword(inputContext, KEYWORDS.ACCOUNT_NUMBER) || (rawValue && isPotentialAccountNumber(rawValue, inputContext))) {
      detectedType = 'account_number';
      confidence = 0.94;
      source = 'dom_label';
    }

    // I. Personal Legal Name Checks
    else if (autocomplete === 'name' || autocomplete === 'given-name' || autocomplete === 'family-name') {
      detectedType = 'person_name';
      confidence = 0.90;
      source = 'dom_autocomplete';
    } else if (matchesKeyword(inputContext, KEYWORDS.PERSON_NAME)) {
      detectedType = 'person_name';
      confidence = 0.88;
      source = 'dom_label';
    }

    // J. Address Checks
    else if (autocomplete.includes('address') || matchesKeyword(inputContext, KEYWORDS.ADDRESS)) {
      detectedType = 'address';
      confidence = 0.90;
      source = 'dom_label';
    }

    if (detectedType) {
      detectedElements.add(el);
      detections.push({
        id: `privagent-det-${detections.length + 1}`,
        type: detectedType,
        confidence,
        selector: getUniqueSelector(el),
        bbox: getBoundingBox(el),
        length,
        source,
      });
    }
  }

  // 2. Scan Rendered Non-Input Content (Headings, Spans, Paragraphs, Card visuals, Table cells)
  const candidateSelectors = 'span, p, h1, h2, h3, h4, div, td, th';
  const textCandidates = Array.from(targetRoot.querySelectorAll<HTMLElement>(candidateSelectors));
  elementCount += textCandidates.length;

  for (const el of textCandidates) {
    // Skip if already detected as an input or is a PrivAgent UI element or contains child tags that will be scanned
    if (detectedElements.has(el) || el.closest('#privagent-redaction-root') || el.closest('#privagent-floating-panel')) {
      continue;
    }

    // Only inspect leaf nodes or elements whose children don't contain other element nodes
    if (el.children.length > 0) {
      continue;
    }

    const text = (el.textContent || '').trim();
    if (!text || text.length < 3) continue;

    const id = (el.id || '').toLowerCase();
    const className = (typeof el.className === 'string' ? el.className : '').toLowerCase();
    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
    const parentText = (el.parentElement?.textContent || '').slice(0, 100).toLowerCase();
    const prevSiblingText = (el.previousElementSibling?.textContent || '').slice(0, 60).toLowerCase();
    const context = [id, className, ariaLabel, prevSiblingText, parentText].join(' ');
    const length = text.length;

    let detectedType: SensitiveEntityType | null = null;
    let confidence = 0.0;
    let source: DetectionSource = 'text_pattern';

    // 1. PAN / National ID
    if (isValidPAN(text)) {
      detectedType = 'pan';
      confidence = 0.98;
      source = 'text_pattern';
    }
    // 2. Credit Card in text (Luhn valid or card keyword + card format)
    else if (isValidLuhn(text) || (matchesKeyword(context, KEYWORDS.CREDIT_CARD) && PATTERNS.CREDIT_CARD.test(text))) {
      detectedType = 'credit_card';
      confidence = 0.98;
      source = 'text_pattern';
    }
    // 3. Card CVV / Security Code
    else if (isPotentialCVV(text, context)) {
      detectedType = 'cvv';
      confidence = 0.96;
      source = 'dom_label';
    }
    // 4. One-Time Password / 2FA Token
    else if (isPotentialOTP(text, context)) {
      detectedType = 'otp';
      confidence = 0.96;
      source = 'dom_label';
    }
    // 5. Email address in text
    else if (PATTERNS.EMAIL.test(text)) {
      detectedType = 'email';
      confidence = 0.97;
      source = 'text_pattern';
    }
    // 6. Phone number in text (strict phone pattern + length limits)
    else if (PATTERNS.PHONE.test(text) && text.length <= 60) {
      detectedType = 'phone';
      confidence = 0.94;
      source = 'text_pattern';
    }
    // 7. Bank Account Number in text
    else if (isPotentialAccountNumber(text, context)) {
      detectedType = 'account_number';
      confidence = 0.94;
      source = 'dom_label';
    }
    // 8. Cardholder / Legal Name
    else if (
      matchesKeyword(context, KEYWORDS.PERSON_NAME) &&
      text.length >= 3 && text.length <= 40 && /^[a-zA-Z\s.']+$/.test(text)
    ) {
      detectedType = 'person_name';
      confidence = 0.90;
      source = 'dom_attribute';
    }
    // 9. Physical Postal Address
    else if (PATTERNS.ADDRESS.test(text) || (matchesKeyword(context, KEYWORDS.ADDRESS) && text.length >= 10 && text.length <= 150)) {
      detectedType = 'address';
      confidence = 0.90;
      source = 'text_pattern';
    }

    if (detectedType) {
      detectedElements.add(el);
      detections.push({
        id: `privagent-det-${detections.length + 1}`,
        type: detectedType,
        confidence,
        selector: getUniqueSelector(el),
        bbox: getBoundingBox(el),
        length,
        source,
      });
    }
  }

  const endTime = performance.now();
  const scanLatencyMs = Number((endTime - startTime).toFixed(2));

  return {
    detections,
    scanLatencyMs,
    totalElementsScanned: elementCount,
  };
}
