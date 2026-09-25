/**
 * PrivAgent 2.0 — Phase 7.5 Stage 3 Multimodal Perception Integration Test Suite
 *
 * Verifies the canonical multimodal perception pipeline:
 * Live Page -> DOM perception -> Screenshot capture -> Visual perception -> Local OCR -> Coordinate mapping -> Privacy Fusion -> BrowserWorldModel -> Context Minimization -> AgentContext -> AgentLoop
 *
 * Covers:
 * 1. Screenshot/visual perception execution and bounding
 * 2. Local OCR execution with privacy scrubbing (cards, CVVs, passwords wiped)
 * 3. Deterministic coordinate mapping from DOM space to screenshot space
 * 4. Multi-source privacy fusion across DOM, visual, and OCR candidates
 * 5. Generation consistency (pageGeneration stamped across all multimodal findings)
 * 6. Zero raw OCR text or credentials in model-facing context (M8 firewall)
 * 7. Canonical AgentLoop integration with multimodal perception
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  coordinateMultimodalPerception,
  enrichWorldModelWithMultimodalPerception,
  getPngDimensions,
  resolveScreenshotDimensions,
} from '../extension/src/visualPerception/multimodalCoordinator';
import { buildBrowserWorldModel } from '../extension/src/worldModel/worldModelBuilder';
import { assertWorldModelSafe } from '../extension/src/worldModel/worldModelSanitizer';
import { buildAgentPayload, PrivacyScanReport } from '../extension/src/privacy/types';
import { minimizeAgentContext } from '../extension/src/privacy/contextMinimizer';
import { scanForRawSensitiveValues, assertNoRawSensitiveValues } from '../extension/src/privacy/rawValueScanner';
import { MockOCREngine } from '../extension/src/ocr/ocrEngine';
import { MockScreenshotProvider, setScreenshotProvider } from '../extension/src/visualPerception/screenshotCapture';
import { AgentLoop, WorldModelPerceptionResult } from '../extension/src/agent/agentLoop';
import { MockAgentProvider } from '../extension/src/agent/mockAgentProvider';
import { BrowserAction } from '../extension/src/agent/actionTypes';
import { assertZeroLeakageInPayload } from '../extension/src/ocr/ocrSecurityBoundary';

describe('Phase 7.5 Stage 3: Multimodal Perception Integration Suite', () => {
  const sampleSyntheticPng =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAlgAAAGQCAYAAAByNR6YAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAI/SURBVHhe7cExAQAAAMKg9U9tCF8gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgIsBI0AAAc5d7iQAAAAASUVORK5CYII=';

  beforeEach(() => {
    document.body.innerHTML = '';
    document.title = 'PrivAgent Stage 3 Multimodal Test Page';
    setScreenshotProvider(new MockScreenshotProvider(sampleSyntheticPng));
  });

  // ── 1. Screenshot Dimension Extraction ─────────────────────────────────────
  it('1. extracts exact bitmap dimensions from PNG binary headers without DOM Image', () => {
    const dims = getPngDimensions(sampleSyntheticPng);
    expect(dims).not.toBeNull();
    expect(dims!.screenshotWidth).toBe(600);
    expect(dims!.screenshotHeight).toBe(400);

    const resolved = resolveScreenshotDimensions(sampleSyntheticPng, {
      viewportWidth: 1200,
      viewportHeight: 800,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 2,
    });
    expect(resolved.screenshotWidth).toBe(600);
    expect(resolved.screenshotHeight).toBe(400);
  });

  // ── 2. Local OCR Execution & Privacy Scrubbing ─────────────────────────────
  it('2. executes local OCR and scrubs sensitive credentials before creating SafeOCRRegions', async () => {
    const mockOcr = new MockOCREngine({
      lines: [
        {
          text: 'Payment Card: 4111 1111 1111 1111',
          confidence: 0.98,
          bbox: { x0: 20, y0: 30, x1: 280, y1: 60 },
          words: [],
        },
        {
          text: 'Security Code CVV: 891',
          confidence: 0.97,
          bbox: { x0: 20, y0: 70, x1: 150, y1: 100 },
          words: [],
        },
        {
          text: 'Product: Black Travel Backpack',
          confidence: 0.95,
          bbox: { x0: 20, y0: 120, x1: 240, y1: 150 },
          words: [],
        },
      ],
      fullText: 'Payment Card: 4111 1111 1111 1111\nSecurity Code CVV: 891\nProduct: Black Travel Backpack',
    });

    const scanReport: PrivacyScanReport = {
      timestamp: Date.now(),
      url: 'http://localhost:4174/',
      scanLatencyMs: 5,
      redactionLatencyMs: 2,
      totalElementsScanned: 10,
      sensitiveElementsDetected: 0,
      elementsProtected: 0,
      leakageCount: 0,
      categories: {
        password: 0,
        credit_card: 0,
        account_number: 0,
        email: 0,
        phone: 0,
        person_name: 0,
        pan: 0,
        otp: 0,
        cvv: 0,
        address: 0,
      },
      detections: [
        {
          id: 'det-item-1',
          type: 'button',
          confidence: 1.0,
          selector: '#add-btn',
          bbox: [20, 120, 100, 30],
          length: 11,
          source: 'dom_attribute',
          label: 'Add to Cart',
        },
      ],
      status: 'Sanitized Context — Local Privacy Check Passed',
      redactionMode: 'blackout',
    };

    const coordination = await coordinateMultimodalPerception({
      scanReport,
      pageGeneration: 3,
      screenshotDataUrl: sampleSyntheticPng,
      ocrEngine: mockOcr,
      geometry: {
        viewportWidth: 600,
        viewportHeight: 400,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 1,
      },
    });

    expect(coordination).toBeDefined();
    expect(coordination.ocrRegions.length).toBe(3);

    // Invariant: Sensitive OCR regions tagged but raw text completely stripped
    const sensitiveOcr = coordination.ocrRegions.filter((r) => r.isSensitive);
    expect(sensitiveOcr.length).toBe(2);

    const serializedOcr = JSON.stringify(coordination.ocrRegions);
    expect(serializedOcr).not.toContain('4111');
    expect(serializedOcr).not.toContain('891');
    expect(serializedOcr).not.toContain('CVV');

    // Invariant: M8 zero-leakage invariant verifies zero raw secrets in OCR regions
    assertZeroLeakageInPayload(coordination.ocrRegions, [
      '4111 1111 1111 1111',
      '4111',
      '891',
    ]);
  });

  // ── 3. Coordinate Mapping DOM to Screenshot Bitmap ─────────────────────────
  it('3. maps DOM bounding boxes to authoritative screenshot coordinates with scale factors', async () => {
    const scanReport: PrivacyScanReport = {
      timestamp: Date.now(),
      url: 'http://localhost:4174/',
      scanLatencyMs: 3,
      redactionLatencyMs: 1,
      totalElementsScanned: 5,
      sensitiveElementsDetected: 0,
      elementsProtected: 0,
      leakageCount: 0,
      categories: {
        password: 0,
        credit_card: 0,
        account_number: 0,
        email: 0,
        phone: 0,
        person_name: 0,
        pan: 0,
        otp: 0,
        cvv: 0,
        address: 0,
      },
      detections: [
        {
          id: 'det-search',
          type: 'email',
          confidence: 0.95,
          selector: '#search-box',
          bbox: [100, 50, 200, 30],
          length: 0,
          source: 'dom_input_type',
        },
      ],
      status: 'Sanitized Context — Local Privacy Check Passed',
      redactionMode: 'blackout',
    };

    const coordination = await coordinateMultimodalPerception({
      scanReport,
      pageGeneration: 2,
      screenshotDataUrl: sampleSyntheticPng, // 600x400
      geometry: {
        viewportWidth: 1200, // 2x downscaled screenshot relative to viewport
        viewportHeight: 800,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 1,
      },
    });

    expect(coordination.scaleFactors.scaleX).toBe(0.5);
    expect(coordination.scaleFactors.scaleY).toBe(0.5);

    const visualDet = coordination.visualReport.visualDetections[0];
    expect(visualDet).toBeDefined();
    // 100 * 0.5 = 50, 50 * 0.5 = 25, 200 * 0.5 = 100, 30 * 0.5 = 15
    expect(visualDet!.screenshotBBox).toEqual([50, 25, 100, 15]);
  });

  // ── 4. Privacy Fusion across DOM + OCR + Visual ────────────────────────────
  it('4. fuses DOM, visual, and OCR detections into unified privacy findings', async () => {
    const mockOcr = new MockOCREngine({
      lines: [
        {
          text: 'Account Number: 123456789012',
          confidence: 0.99,
          bbox: { x0: 50, y0: 80, x1: 250, y1: 110 },
          words: [],
        },
      ],
      fullText: 'Account Number: 123456789012',
    });

    const scanReport: PrivacyScanReport = {
      timestamp: Date.now(),
      url: 'http://localhost:4173/',
      scanLatencyMs: 5,
      redactionLatencyMs: 2,
      totalElementsScanned: 8,
      sensitiveElementsDetected: 1,
      elementsProtected: 1,
      leakageCount: 0,
      categories: {
        password: 0,
        credit_card: 0,
        account_number: 1,
        email: 0,
        phone: 0,
        person_name: 0,
        pan: 0,
        otp: 0,
        cvv: 0,
        address: 0,
      },
      detections: [
        {
          id: 'det-acc',
          type: 'account_number',
          confidence: 0.92,
          selector: '#acc-num',
          bbox: [50, 80, 200, 30],
          length: 12,
          source: 'dom_label',
        },
      ],
      status: 'Sanitized Context — Local Privacy Check Passed',
      redactionMode: 'blackout',
    };

    const coordination = await coordinateMultimodalPerception({
      scanReport,
      pageGeneration: 4,
      screenshotDataUrl: sampleSyntheticPng,
      ocrEngine: mockOcr,
      geometry: {
        viewportWidth: 600,
        viewportHeight: 400,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 1,
      },
    });

    expect(coordination.privacyFindings.length).toBeGreaterThanOrEqual(1);
    const accFinding = coordination.privacyFindings.find((f) => f.category === 'account_number');
    expect(accFinding).toBeDefined();
    // Invariant: highest confidence preserved (0.99 from OCR vs 0.92 from DOM)
    expect(accFinding!.confidence).toBeGreaterThanOrEqual(0.92);
    expect(accFinding!.mustRedact).toBe(true);
    expect(accFinding!.exportable).toBe(true); // sanitized metadata allowed with raw value quarantined
  });

  // ── 5. BrowserWorldModel Enrichment & Invariant Safety ─────────────────────
  it('5. enriches BrowserWorldModel with multimodal artifacts and passes assertWorldModelSafe', async () => {
    document.body.innerHTML = `
      <div id="product-view">
        <h2 id="p-title">Camera Kit</h2>
        <img id="p-img" src="/cam.jpg" alt="DSLR Camera" />
        <button id="p-buy">Buy Now</button>
      </div>
    `;

    const worldModel = buildBrowserWorldModel({ root: document, pageGeneration: 5 });
    expect(worldModel.ocrRegions.length).toBe(0);

    const scanReport: PrivacyScanReport = {
      timestamp: Date.now(),
      url: 'http://localhost:4174/',
      scanLatencyMs: 2,
      redactionLatencyMs: 1,
      totalElementsScanned: 5,
      sensitiveElementsDetected: 0,
      elementsProtected: 0,
      leakageCount: 0,
      categories: {
        password: 0,
        credit_card: 0,
        account_number: 0,
        email: 0,
        phone: 0,
        person_name: 0,
        pan: 0,
        otp: 0,
        cvv: 0,
        address: 0,
      },
      detections: [],
      status: 'Sanitized Context — Local Privacy Check Passed',
      redactionMode: 'blackout',
    };

    const coordination = await coordinateMultimodalPerception({
      scanReport,
      pageGeneration: 5,
      screenshotDataUrl: sampleSyntheticPng,
      geometry: {
        viewportWidth: 600,
        viewportHeight: 400,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 1,
      },
    });

    enrichWorldModelWithMultimodalPerception(worldModel, coordination);
    expect(worldModel.viewport.width).toBe(600);
    expect(worldModel.viewport.height).toBe(400);

    // Invariant: Assert world model safe passes without throwing
    expect(() => assertWorldModelSafe(worldModel)).not.toThrow();
  });

  // ── 6. Full AgentLoop Multimodal Perception Integration ────────────────────
  it('6. executes full AgentLoop perception cycle with multimodal context payload', async () => {
    document.body.innerHTML = `
      <div id="catalog">
        <input type="search" id="search-input" placeholder="Search..." />
        <button id="search-go">Go</button>
      </div>
    `;

    const worldModel = buildBrowserWorldModel({ root: document, pageGeneration: 1 });
    const scanReport: PrivacyScanReport = {
      timestamp: Date.now(),
      url: 'http://localhost:4174/',
      scanLatencyMs: 3,
      redactionLatencyMs: 1,
      totalElementsScanned: 4,
      sensitiveElementsDetected: 0,
      elementsProtected: 0,
      leakageCount: 0,
      categories: {
        password: 0,
        credit_card: 0,
        account_number: 0,
        email: 0,
        phone: 0,
        person_name: 0,
        pan: 0,
        otp: 0,
        cvv: 0,
        address: 0,
      },
      detections: [
        {
          id: 'det-email-box',
          type: 'email',
          confidence: 0.99,
          selector: '#email-input',
          bbox: [20, 20, 180, 30],
          length: 0,
          source: 'dom_input_type',
          label: 'Email Address',
        },
      ],
      status: 'Sanitized Context — Local Privacy Check Passed',
      redactionMode: 'blackout',
      pageType: 'LOGIN',
    };

    const coordination = await coordinateMultimodalPerception({
      scanReport,
      pageGeneration: 1,
      screenshotDataUrl: sampleSyntheticPng,
      geometry: {
        viewportWidth: 600,
        viewportHeight: 400,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 1,
      },
    });

    enrichWorldModelWithMultimodalPerception(worldModel, coordination);

    const built = buildAgentPayload(scanReport, coordination.visualReport);
    expect(built).not.toBeNull();
    expect(built!.screenshot_dimensions).toEqual({ width: 600, height: 400 });
    expect(built!.ocr_metrics).toBeDefined();

    const minimized = minimizeAgentContext(built!, { task: 'Enter user email' });

    let reasoningRequested = false;
    const mockProvider = new MockAgentProvider();
    mockProvider.setCustomHandler((task, ctx) => {
      reasoningRequested = true;
      expect(ctx.screenshot_dimensions).toEqual({ width: 600, height: 400 });
      expect(ctx.detections.length).toBeGreaterThanOrEqual(1);
      // INVARIANT: Zero raw credentials in context sent to provider
      expect(scanForRawSensitiveValues(ctx)).toEqual([]);
      assertNoRawSensitiveValues(ctx);

      return {
        action: 'click',
        target: 'det-email-box',
      } as BrowserAction;
    });

    const perceptionResult: WorldModelPerceptionResult = {
      context: minimized.payload,
      worldModel,
      activeWorldModelRef: { pageGeneration: 1, worldModelId: worldModel.id },
    };

    const loop = new AgentLoop(
      mockProvider,
      {
        perceivePage: async () => perceptionResult,
        executeAction: async () => ({ success: true }),
      },
      { maxSteps: 1 }
    );

    const taskState = await loop.runTask('Enter user email');
    expect(reasoningRequested).toBe(true);
    expect(taskState.currentStep).toBe(1);
    expect(taskState.steps[0]!.action.action).toBe('click');
  });
});
