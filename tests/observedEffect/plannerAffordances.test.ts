/**
 * Regression: the reasoner must receive the page's interactive affordances.
 *
 * `buildAgentPayload` used to REPLACE the DOM detection list with
 * `visualReport.visualDetections` whenever a visual report was present. The
 * multimodal coordinator builds that list by skipping every detection that is
 * not a sensitive entity, so every interactive control — search boxes, buttons,
 * links — was dropped. The agent loop always has a visual report, so the
 * reasoner was routinely handed ZERO targets and could only fall back to
 * something inert such as `scroll`.
 *
 * Proven against a real run: `POST /api/v1/agent/action` carried
 * `detectionCount: 0` on a live google.com page that plainly had a search box.
 */
import { describe, it, expect } from 'vitest';
import { buildAgentPayload } from '../../extension/src/privacy/types';
import type { PrivacyScanReport, VisualCaptureReport } from '../../extension/src/privacy/types';
import { minimizeAgentContext } from '../../extension/src/privacy/contextMinimizer';
import { PlannerContextBuilder } from '../../extension/src/hierarchicalPlanning/plannerContextBuilder';
import { decomposeTask } from '../../extension/src/hierarchicalPlanning/taskDecomposer';

const det = (id: string, type: string, selector: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    type,
    confidence: 0.9,
    selector,
    bbox: [10, 20, 120, 30],
    length: 0,
    source: 'dom',
    label: '',
    ...extra,
  }) as any;

function report(detections: any[]): PrivacyScanReport {
  return {
    timestamp: 1,
    url: 'https://www.google.com/',
    scanLatencyMs: 10,
    redactionLatencyMs: 1,
    totalElementsScanned: 40,
    sensitiveElementsDetected: 0,
    elementsProtected: 0,
    leakageCount: 0,
    categories: {},
    detections,
    status: 'Sanitized Context — Local Privacy Check Passed',
    redactionMode: 'blackout',
    pageType: 'search',
    semanticGroups: [],
  } as unknown as PrivacyScanReport;
}

/** A visual report whose visualDetections hold ONLY sensitive entities. */
function visualReport(): VisualCaptureReport {
  return {
    captureMetadata: {
      viewportWidth: 1280,
      viewportHeight: 800,
      screenshotWidth: 2560,
      screenshotHeight: 1600,
      devicePixelRatio: 2,
      scaleX: 2,
      scaleY: 2,
      scrollX: 0,
      scrollY: 0,
      capturedAt: 1,
    },
    // Sensitive only — exactly what the coordinator produces.
    visualDetections: [
      {
        id: 'pw-1',
        type: 'password',
        confidence: 0.95,
        selector: '#pw',
        viewportBBox: [10, 20, 120, 30],
        screenshotBBox: [20, 40, 240, 60],
        isPartiallyVisible: false,
        source: 'dom',
      },
    ] as any,
    totalDetected: 1,
    totalPartiallyVisible: 0,
    totalOffscreenFiltered: 0,
    ocrRegionsScanned: 0,
    sensitiveOCRDetected: 0,
    ocrLatencyMs: 0,
    domSensitiveDetected: 1,
    status: 'Local Visual Context Prepared',
  } as unknown as VisualCaptureReport;
}

const GOOGLE_DETECTIONS = [
  det('ti6dpd', 'search', '#ti6dpd'),
  det('inter-button-10', 'button', 'input[name="btnK"]', { label: 'Google Search' }),
  det('inter-link-3', 'link', 'a[aria-label="Search for Images "]'),
  det('pw-1', 'password', '#pw'),
];

describe('planner affordances survive into the reasoner context', () => {
  it('1. interactive controls are present even when a visual report exists', () => {
    const payload = buildAgentPayload(report(GOOGLE_DETECTIONS), visualReport(), null);
    expect(payload).not.toBeNull();
    const ids = (payload!.detections || []).map((d) => d.id);

    // The search box and the real Google Search button must be visible to the
    // reasoner. This is the assertion the production run violated.
    expect(ids).toContain('ti6dpd');
    expect(ids).toContain('inter-button-10');
    expect(ids.length).toBeGreaterThan(0);
  });

  it('2. sensitive visual detections are still merged in, not lost', () => {
    const payload = buildAgentPayload(report(GOOGLE_DETECTIONS), visualReport(), null);
    const ids = (payload!.detections || []).map((d) => d.id);
    // The password is both a DOM detection and a visual detection: it must be
    // present exactly once, never duplicated.
    expect(ids.filter((i) => i === 'pw-1')).toHaveLength(1);
  });

  it('3. a visual-only detection (not in the DOM scan) is still added', () => {
    const vr = visualReport();
    vr.visualDetections = [
      ...vr.visualDetections,
      {
        id: 'ocr-only-1',
        type: 'credit_card',
        confidence: 0.8,
        selector: 'canvas:visual-ocr',
        viewportBBox: [0, 0, 10, 10],
        screenshotBBox: [0, 0, 20, 20],
        isPartiallyVisible: false,
        source: 'ocr',
      } as any,
    ];
    const payload = buildAgentPayload(report(GOOGLE_DETECTIONS), vr, null);
    const ids = (payload!.detections || []).map((d) => d.id);
    expect(ids).toContain('ocr-only-1');
  });

  it('4. DOM length and label are preserved (visual level does not know them)', () => {
    const withMeta = [det('field-1', 'text', '#f', { length: 12, label: 'Full name' })];
    const payload = buildAgentPayload(report(withMeta), visualReport(), null);
    const f = (payload!.detections || []).find((d) => d.id === 'field-1');
    expect(f).toBeDefined();
    expect(f!.length).toBe(12);
    expect(f!.label).toBe('Full name');
  });

  it('5. the no-visual-report path is unchanged', () => {
    const payload = buildAgentPayload(report(GOOGLE_DETECTIONS), null, null);
    const ids = (payload!.detections || []).map((d) => d.id);
    expect(ids).toEqual(GOOGLE_DETECTIONS.map((d) => d.id));
  });

  it('6. viewport and screenshot metadata still come from the visual report', () => {
    const payload = buildAgentPayload(report(GOOGLE_DETECTIONS), visualReport(), null);
    expect(payload!.viewport).toEqual({ width: 1280, height: 800, scroll_x: 0, scroll_y: 0 });
    expect(payload!.screenshot_dimensions).toEqual({ width: 2560, height: 1600 });
  });

  it('7. end to end: the planner context for a search goal keeps the search box', () => {
    const payload = buildAgentPayload(report(GOOGLE_DETECTIONS), visualReport(), null)!;
    const minimized = minimizeAgentContext(payload, { task: 'open google and search cats' }).payload;
    const decomp = decomposeTask('open google and search cats', { currentUrl: 'https://www.google.com/' });
    const ctx = PlannerContextBuilder.buildContext(minimized, decomp.goal, decomp.subgoals[0], undefined)
      .contextPayload;
    const kept = (ctx.detections || []).map((d) => d.id);
    expect(kept).toContain('ti6dpd');
    expect(kept.length).toBeGreaterThan(0);
  });

  it('8. the exact production symptom is gone: detections are never empty', () => {
    // The real run sent detectionCount: 0 to /api/v1/agent/action.
    const payload = buildAgentPayload(report(GOOGLE_DETECTIONS), visualReport(), null)!;
    expect((payload.detections || []).length).toBeGreaterThan(0);
  });
});
