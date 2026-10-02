/**
 * STEP 10.4/10.5 documented finding — the extension-side mirror divergence.
 *
 * During Step 10.4 the backend's `scan_reason_text` was remediated so that a
 * person name embedded anywhere in a verb-initial reason is BLOCKED. The
 * extension's mirror (`actionValidator.ts`) still carries the OLD whole-reason
 * gate, so the same string is ACCEPTED there. The backend is stricter; the
 * extension is not.
 *
 * This probe demonstrates the hole on the real extension code path before it
 * is closed. It is a probe, not a regression test.
 */
import { describe, expect, it } from 'vitest';

import { validateAction } from '../extension/src/agent/actionValidator';

const CONTEXT = {
  url: 'http://localhost:4174/',
  timestamp: 1720000000000,
  viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
  screenshot_dimensions: null,
  detections: [
    {
      id: 'btn-shop-now',
      type: 'button',
      confidence: 0.95,
      bbox: { x: 100, y: 100, width: 120, height: 40 },
      length: 14,
      source: 'dom_attribute',
      selector: '#btn-shop-now',
      is_partially_visible: false,
    },
  ],
  total_elements_scanned: 5,
  sensitive_elements_detected: 0,
  sanitized_status: 'sanitized_only' as const,
  ocr_metrics: null,
} as any;

const cases = [
  'Clicking Account Details for Rahul Sharma',
  'Navigate to Order History for John Smith',
  'Opened the account details section for Priya Reddy',
  'Opened Rahul Sharma’s profile.',
  'Account holder Rahul Sharma requires service',
  // Legitimate UI reasons that MUST keep working.
  'Clicked Account Details',
  'The Browse Catalog link leads to the product listing.',
  'Click Shop Now button to open the store catalog',
];

describe('extension reason-rule mirror', () => {
  for (const reason of cases) {
    it(`${reason}`, () => {
      const res: any = validateAction(
        { action: 'click', target: 'btn-shop-now', reason } as any,
        CONTEXT,
      );
      console.log(`[mirror] allowed=${res.allowed}  reason=${JSON.stringify(reason)}  ${res.reason ?? ''}`);
      expect(res).toBeDefined();
    });
  }
});
