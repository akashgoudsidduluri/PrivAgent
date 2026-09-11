import { DetectionResult, DetectionSource, SensitiveEntityType } from './types';
import { KEYWORDS, PATTERNS, isValidLuhn, matchesKeyword } from './patterns';

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
    const label = document.querySelector(`label[for="${escapeCss(input.id)}"]`);
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
export function scanDOM(root: Document | HTMLElement = document): ScanResult {
  const startTime = performance.now();
  const detections: DetectionResult[] = [];
  const detectedElements = new Set<HTMLElement>();
  let elementCount = 0;

  // 1. Scan Form Inputs & Controls (<input>, <textarea>, <select>)
  const formControls = Array.from(root.querySelectorAll<HTMLElement>('input, textarea, select'));
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

    // A. Password Checks
    if (typeAttr === 'password') {
      detectedType = 'password';
      confidence = 1.0;
      source = 'dom_input_type';
    } else if (autocomplete.includes('password') || autocomplete.includes('current-password') || autocomplete.includes('new-password')) {
      detectedType = 'password';
      confidence = 0.99;
      source = 'dom_autocomplete';
    } else if (matchesKeyword(name, KEYWORDS.PASSWORD) || matchesKeyword(id, KEYWORDS.PASSWORD) || matchesKeyword(labelText, KEYWORDS.PASSWORD)) {
      detectedType = 'password';
      confidence = 0.95;
      source = 'dom_label';
    }

    // B. Credit / Debit Card Checks
    else if (autocomplete.includes('cc-number') || autocomplete.includes('cc-csc')) {
      detectedType = 'credit_card';
      confidence = 0.98;
      source = 'dom_autocomplete';
    } else if (matchesKeyword(name, KEYWORDS.CREDIT_CARD) || matchesKeyword(id, KEYWORDS.CREDIT_CARD) || matchesKeyword(labelText, KEYWORDS.CREDIT_CARD)) {
      detectedType = 'credit_card';
      confidence = 0.95;
      source = 'dom_label';
    } else if (rawValue && isValidLuhn(rawValue)) {
      detectedType = 'credit_card';
      confidence = 0.98;
      source = 'text_pattern';
    }

    // C. Email Checks
    else if (typeAttr === 'email' || autocomplete === 'email') {
      detectedType = 'email';
      confidence = 0.99;
      source = typeAttr === 'email' ? 'dom_input_type' : 'dom_autocomplete';
    } else if (matchesKeyword(name, KEYWORDS.EMAIL) || matchesKeyword(id, KEYWORDS.EMAIL) || matchesKeyword(labelText, KEYWORDS.EMAIL)) {
      detectedType = 'email';
      confidence = 0.92;
      source = 'dom_label';
    } else if (rawValue && PATTERNS.EMAIL.test(rawValue)) {
      detectedType = 'email';
      confidence = 0.97;
      source = 'text_pattern';
    }

    // D. Phone Number Checks
    else if (typeAttr === 'tel' || autocomplete.startsWith('tel')) {
      detectedType = 'phone';
      confidence = 0.98;
      source = typeAttr === 'tel' ? 'dom_input_type' : 'dom_autocomplete';
    } else if (matchesKeyword(name, KEYWORDS.PHONE) || matchesKeyword(id, KEYWORDS.PHONE) || matchesKeyword(labelText, KEYWORDS.PHONE)) {
      detectedType = 'phone';
      confidence = 0.93;
      source = 'dom_label';
    }

    // E. Bank Account Number Checks
    else if (matchesKeyword(name, KEYWORDS.ACCOUNT_NUMBER) || matchesKeyword(id, KEYWORDS.ACCOUNT_NUMBER) || matchesKeyword(labelText, KEYWORDS.ACCOUNT_NUMBER)) {
      detectedType = 'account_number';
      confidence = 0.92;
      source = 'dom_label';
    }

    // F. Personal Legal Name Checks
    else if (autocomplete === 'name' || autocomplete === 'given-name' || autocomplete === 'family-name') {
      detectedType = 'person_name';
      confidence = 0.90;
      source = 'dom_autocomplete';
    } else if (matchesKeyword(name, KEYWORDS.PERSON_NAME) || matchesKeyword(id, KEYWORDS.PERSON_NAME) || matchesKeyword(labelText, KEYWORDS.PERSON_NAME)) {
      detectedType = 'person_name';
      confidence = 0.88;
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
  const textCandidates = Array.from(root.querySelectorAll<HTMLElement>(candidateSelectors));
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
    const length = text.length;

    let detectedType: SensitiveEntityType | null = null;
    let confidence = 0.0;
    let source: DetectionSource = 'text_pattern';

    // Credit Card in text (e.g. 4111 1111 1111 1111)
    if (isValidLuhn(text)) {
      detectedType = 'credit_card';
      confidence = 0.98;
      source = 'text_pattern';
    }
    // Card CVV / Security Code
    else if ((matchesKeyword(id, ['cvv', 'cvc']) || matchesKeyword(className, ['cvv', 'cvc'])) && /^\d{3,4}$/.test(text)) {
      detectedType = 'credit_card';
      confidence = 0.95;
      source = 'dom_attribute';
    }
    // Email in text
    else if (PATTERNS.EMAIL.test(text)) {
      detectedType = 'email';
      confidence = 0.97;
      source = 'text_pattern';
    }
    // Phone in text
    else if (PATTERNS.PHONE.test(text)) {
      detectedType = 'phone';
      confidence = 0.92;
      source = 'text_pattern';
    }
    // Bank Account Number in text
    else if (
      /^\d{9,18}$/.test(text) && 
      (matchesKeyword(id, KEYWORDS.ACCOUNT_NUMBER) || matchesKeyword(className, KEYWORDS.ACCOUNT_NUMBER) || 
       matchesKeyword(el.parentElement?.textContent, KEYWORDS.ACCOUNT_NUMBER))
    ) {
      detectedType = 'account_number';
      confidence = 0.94;
      source = 'dom_label';
    }
    // Cardholder / Legal Name
    else if (
      (matchesKeyword(id, KEYWORDS.PERSON_NAME) || matchesKeyword(className, KEYWORDS.PERSON_NAME)) &&
      text.length >= 3 && text.length <= 40 && /^[a-zA-Z\s.]+$/.test(text)
    ) {
      detectedType = 'person_name';
      confidence = 0.90;
      source = 'dom_attribute';
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
