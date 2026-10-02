/**
 * STEP 11 — verify the CORRECTED characterisation of the backend/extension
 * reason-rule divergence, by executing BOTH real code paths.
 *
 * Earlier (Step 10.4) this was recorded as a false NEGATIVE in the extension.
 * The source shows otherwise: `containsSensitiveReasonContent` calls
 * `containsSensitiveContent` first, and that helper applies
 * `FULL_NAME_PATTERN` unconditionally, making the verb gate dead for names.
 * The extension is therefore strictly MORE blocking — a false POSITIVE.
 *
 * This probe prints the two verdicts side by side. Read-only.
 */
import { describe, expect, it } from 'vitest';

import { validateAction } from '../extension/src/agent/actionValidator';

const CTX = {
  url: 'http://localhost:4174/',
  timestamp: 1720000000000,
  viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
  screenshot_dimensions: null,
  detections: [
    {
      id: 'btn-shop-now', type: 'button', confidence: 0.95,
      bbox: { x: 100, y: 100, width: 120, height: 40 }, length: 14,
      source: 'dom_attribute', selector: '#btn-shop-now',
      is_partially_visible: false,
    },
  ],
  total_elements_scanned: 5,
  sensitive_elements_detected: 0,
  sanitized_status: 'sanitized_only',
  ocr_metrics: null,
} as any;

/** Reasons the BACKEND verdict is asserted against in the Python suite. */
const CASES = [
  'Clicked Account Details',
  'The Browse Catalog link leads to the product listing.',
  'Click Shop Now button to open the store catalog',
  'Clicking Account Details for Rahul Sharma',
  'Navigate to Order History for John Smith',
  'Account holder Rahul Sharma requires service',
  'rahul.sharma@example.com is registered',
];

describe('backend/extension reason-rule divergence — executed', () => {
  it('extension refuses EVERY TitleCase-bigram reason (verb gate is dead)', () => {
    const verdicts: Record<string, boolean> = {};
    for (const reason of CASES) {
      const res: any = validateAction(
        { action: 'click', target: 'btn-shop-now', reason } as any, CTX);
      verdicts[reason] = res.allowed;
      console.log(`[ext] allowed=${res.allowed}  ${JSON.stringify(reason)}`);
    }
    console.log('[ext] ---');
    console.log('[ext] Every case refused:', Object.values(verdicts).every((v) => v === false));
    // The point of the correction: the extension blocks all of them.
    expect(Object.values(verdicts).every((v) => v === false)).toBe(true);
  });

  it('a lowercase-only reason passes, confirming the name bigram is the trigger', () => {
    const res: any = validateAction(
      { action: 'click', target: 'btn-shop-now',
        reason: 'click the shop button to reach the catalog' } as any, CTX);
    console.log(`[ext] lowercase reason allowed=${res.allowed}`);
    expect(res.allowed).toBe(true);
  });
});
