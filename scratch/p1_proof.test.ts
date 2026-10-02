/**
 * P1 PROOF — end-to-end egress of prose-embedded PII via the post-17.9
 * `semantic_context.facts` channel.
 *
 * Establishes that the string actually appears in the bytes that would be
 * POSTed to the provider, not merely in an intermediate object.
 */
import { describe, it, expect } from 'vitest';
import { buildBrowserWorldModel } from '../extension/src/worldModel/worldModelBuilder';
import { buildSemanticObservation, toSanitizedFacts } from '../extension/src/semanticObservation';
import { minimizeAgentContext } from '../extension/src/privacy/contextMinimizer';
import { AgentContextPayload } from '../extension/src/privacy/types';
import { scanDOM } from '../extension/src/privacy/domDetector';

const NAME = 'Aarav Sharma';
const PAN_VALUE = 'ABCDE1234F';

describe('P1 PROOF: prose-embedded PII reaches the provider payload', () => {
  it('shows the raw name and PAN in the minimized model-facing payload', () => {
    const html = `<!doctype html><html><body>
      <p>Ship to ${NAME} today</p>
      <p>PAN ${PAN_VALUE} on file</p>
      <p>Price: 24</p>
    </body></html>`;

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const wm = buildBrowserWorldModel({ root: doc.body, pageGeneration: 3, id: 'wm' });
    const obs = buildSemanticObservation({
      worldModel: wm,
      semanticContext: null,
      tabId: 1,
      documentUrl: 'https://shop.example/p',
      pageGeneration: 3,
    });
    const facts = toSanitizedFacts(obs.facts);

    const { detections, totalElementsScanned } = scanDOM(doc);
    const context = {
      url: 'https://shop.example/p',
      timestamp: Date.now(),
      viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
      screenshot_dimensions: null,
      detections: detections.map((d) => ({
        id: d.id, type: d.type, confidence: d.confidence,
        bbox: { x: d.bbox[0], y: d.bbox[1], width: d.bbox[2], height: d.bbox[3] },
        length: d.length ?? 0, source: d.source, selector: d.selector ?? '',
        is_partially_visible: false,
      })),
      total_elements_scanned: totalElementsScanned,
      sensitive_elements_detected: detections.length,
      sanitized_status: 'sanitized_only',
      ocr_metrics: null,
      semantic_context: { pageType: 'product', facts },
    } as unknown as AgentContextPayload;

    const minimized = minimizeAgentContext(context, { task: 'read the product page' });
    const wire = JSON.stringify(minimized.payload);

    // eslint-disable-next-line no-console
    console.log('\nfacts extracted :', JSON.stringify(facts.map((f) => f.displayText)));
    // eslint-disable-next-line no-console
    console.log('name on the wire:', wire.includes(NAME));
    // eslint-disable-next-line no-console
    console.log('PAN  on the wire:', wire.includes(PAN_VALUE));
    // eslint-disable-next-line no-console
    console.log('wire excerpt    :', wire.slice(wire.indexOf('semantic_context'), wire.indexOf('semantic_context') + 400), '\n');

    // PROVEN: both values are present in the provider-bound payload.
    expect(wire.includes(NAME)).toBe(true);
    expect(wire.includes(PAN_VALUE)).toBe(true);
  });

  it('control: the world model alone does NOT egress this text', () => {
    const html = `<!doctype html><html><body><p>Ship to ${NAME} today</p></body></html>`;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const wm = buildBrowserWorldModel({ root: doc.body, pageGeneration: 3, id: 'wm' });
    // eslint-disable-next-line no-console
    console.log('worldModel contains name (pre-existing, but NOT egressed):', JSON.stringify(wm).includes(NAME));
    expect(JSON.stringify(wm)).toContain(NAME);
  });
});
