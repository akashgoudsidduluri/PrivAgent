/**
 * PHASE 18.7 / A4 — SEMANTIC PERCEPTION QUALITY.
 *
 * Four defects, all observed on the real Wikipedia Charminar article, all of
 * which degraded what the reasoner was able to know:
 *
 *   1. Entity labels were `Table Row 1`..`Table Row 5` — a positional counter
 *      carrying no information, so the model could not tell one was
 *      "Religion: Islam".
 *   2. Fact text was cut mid-word ("The fifth ruler of the Qutb Shahi dynast"),
 *      which is neither quotable nor matchable against the task and therefore
 *      could never satisfy an evidence-based completion rule.
 *   3. Affordances referenced `wm-elem-2-144/145/146` while only three
 *      detections were offered, so the prompt told the model to use ids that
 *      were not in its valid-target list.
 *   4. The loaded article classified as `search` because three "this page has a
 *      search box" signals outvoted a single body-text signal. Every site has a
 *      search box; that is chrome, not identity.
 */
import { describe, it, expect } from 'vitest';
import {
  truncateAtWordBoundary,
  MAX_FACT_LABEL_CHARS,
  MAX_FACT_TEXT_CHARS,
} from '../extension/src/semanticObservation/types';
import { describeTableRow, extractGenericEntities } from '../extension/src/agent/candidateEntities';
import { buildModelFacingContext, minimizeAgentContext } from '../extension/src/privacy/contextMinimizer';
import { buildSemanticUnderstanding } from '../extension/src/semanticUnderstanding';
import { buildBrowserWorldModel } from '../extension/src/worldModel/worldModelBuilder';
import type { AgentContextPayload } from '../extension/src/privacy/types';

describe('A4 — word-boundary truncation', () => {
  it('never cuts a word in half', () => {
    // The exact strings the real run produced.
    const cases = [
      'The fifth ruler of the Qutb Shahi dynasty established the capital',
      'The construction began in 1589 and was completed in 1596 by Ibrahim',
    ];
    for (const input of cases) {
      const out = truncateAtWordBoundary(input, MAX_FACT_LABEL_CHARS);
      expect(out.length).toBeLessThanOrEqual(MAX_FACT_LABEL_CHARS);
      // Every token in the output must be a complete token of the input.
      for (const token of out.split(/\s+/).filter(Boolean)) {
        expect(input.split(/\s+/), `token "${token}" was cut`).toContain(token);
      }
    }
  });

  it('leaves short text untouched', () => {
    expect(truncateAtWordBoundary('Charminar', MAX_FACT_LABEL_CHARS)).toBe('Charminar');
    expect(truncateAtWordBoundary('  History  ', MAX_FACT_LABEL_CHARS)).toBe('History');
  });

  it('keeps a single over-long word intact rather than mangling it', () => {
    const out = truncateAtWordBoundary('A'.repeat(120), MAX_FACT_LABEL_CHARS);
    expect(out.length).toBeLessThanOrEqual(MAX_FACT_LABEL_CHARS);
    expect(out).toMatch(/^A+$/); // not sliced into "AAAA...");
  });

  it('strips a trailing partial word left by a hard cut', () => {
    const out = truncateAtWordBoundary('alpha beta gamma-delta epsilon', 16);
    expect(out.endsWith('-')).toBe(false);
  });
});

describe('A4 — content-derived entity labels', () => {
  it('labels a definition row from its own content', () => {
    // The real Wikipedia infobox shape.
    expect(describeTableRow(['Religion', 'Islam'], 5)).toBe('Religion: Islam');
  });

  it('labels a data row from its single value', () => {
    expect(describeTableRow(['Charminar'], 1)).toBe('Charminar');
  });

  it('falls back to a structural label ONLY when the row has no text', () => {
    expect(describeTableRow([], 3)).toBe('Table Row 3');
    expect(describeTableRow(['', '  '], 3)).toBe('Table Row 3');
  });

  it('never emits a bare positional label for a row that HAS content', () => {
    for (const cells of [['A'], ['A', 'B'], ['A', 'B', 'C'], ['Mughal rule', '1858–1947']]) {
      expect(describeTableRow(cells, 7), JSON.stringify(cells)).not.toMatch(/^Table Row \d+$/);
    }
  });

  it('END-TO-END: the real extractor produces content-derived labels', () => {
    // Testing `describeTableRow` alone left the CALL SITE unproven: reverting
    // the call site to `Table Row ${n}` killed zero tests. This drives the real
    // extraction path over a real DOM table.
    document.body.innerHTML = `
      <table><tbody>
        <tr><th>Religion</th><td>Islam</td></tr>
        <tr><th>Affiliation</th><td>Qutb Shahi dynasty</td></tr>
        <tr><td>Charminar</td></tr>
      </tbody></table>`;
    const entities = extractGenericEntities(document);
    const rows = entities.filter((e) => e.type === 'TableRow');
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.title, `positional label for ${row.id}`).not.toMatch(/^Table Row \d+$/);
    }
    expect(rows.map((r) => r.title)).toEqual([
      'Religion: Islam',
      'Affiliation: Qutb Shahi dynasty',
      'Charminar',
    ]);
  });
});

describe('A4 — affordance targets must be offered to the model', () => {
  const payload = (affordances: Array<{ id: string; type: string; targetElementId?: string; description: string; requiresConfirmation: boolean }>) =>
    ({
      url: 'https://en.wikipedia.org/wiki/Charminar',
      timestamp: Date.now(),
      viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
      screenshot_dimensions: null,
      detections: [
        { id: 'searchInput', type: 'search', confidence: 0.95, bbox: { x: 1, y: 1, width: 10, height: 10 }, length: 4, source: 'dom_attribute', selector: '#s', is_partially_visible: false },
        { id: 'inter-button-3', type: 'button', confidence: 0.95, bbox: { x: 1, y: 1, width: 10, height: 10 }, length: 2, source: 'dom_attribute', selector: '#b', is_partially_visible: false },
      ],
      total_elements_scanned: 10,
      sensitive_elements_detected: 2,
      sanitized_status: 'sanitized_only',
      ocr_metrics: null,
      semantic_context: {
        pageType: 'ARTICLE', confidence: 0.9, pageState: 'populated', pageGeneration: 2,
        entities: [], affordances, promptInjectionDetected: false,
      },
    }) as unknown as AgentContextPayload;

  it('drops an affordance whose target is not an offered detection id', () => {
    // The real defect: `wm-elem-2-144` was never in the detection list.
    const ctx = buildModelFacingContext(payload([
      { id: 'a1', type: 'FILL_FIELD', targetElementId: 'wm-elem-2-144', description: 'x', requiresConfirmation: false },
    ]));
    expect(ctx.semantic_context?.affordances).toHaveLength(0);
  });

  it('keeps an affordance whose target IS offered', () => {
    const ctx = buildModelFacingContext(payload([
      { id: 'a1', type: 'FILL_FIELD', targetElementId: 'searchInput', description: 'x', requiresConfirmation: false },
    ]));
    expect(ctx.semantic_context?.affordances).toHaveLength(1);
  });

  it('keeps page-level affordances that name no element', () => {
    const ctx = buildModelFacingContext(payload([
      { id: 'a1', type: 'ENTER_QUERY', description: 'page level', requiresConfirmation: false },
    ]));
    expect(ctx.semantic_context?.affordances).toHaveLength(1);
  });

  it('INVARIANT: every offered affordance target is in the detection id list', () => {
    const ctx = buildModelFacingContext(payload([
      { id: 'ok', type: 'FILL_FIELD', targetElementId: 'searchInput', description: 'x', requiresConfirmation: false },
      { id: 'bad1', type: 'FILL_FIELD', targetElementId: 'wm-elem-2-144', description: 'x', requiresConfirmation: false },
      { id: 'bad2', type: 'SUBMIT_SEARCH', targetElementId: 'wm-elem-2-1075', description: 'x', requiresConfirmation: false },
    ]));
    const offered = new Set(ctx.elements.map((e) => e.id));
    for (const a of ctx.semantic_context?.affordances ?? []) {
      if (a.targetElementId) expect(offered.has(a.targetElementId), `dangling ${a.targetElementId}`).toBe(true);
    }
  });

  it('APPLIES ON THE SERVICE WORKER EGRESS PATH, not just the OpenRouter view', () => {
    // This is the path the real run actually uses. The first version of the A4
    // fix patched `buildModelFacingContext` only — which the OpenRouter provider
    // calls and the service worker does NOT — so real Chrome kept receiving
    // dangling affordance ids while every unit test passed. This test drives
    // `minimizeAgentContext` so that gap cannot come back.
    const result = minimizeAgentContext(payload([
      { id: 'ok', type: 'FILL_FIELD', targetElementId: 'searchInput', description: 'x', requiresConfirmation: false },
      { id: 'bad', type: 'FILL_FIELD', targetElementId: 'wm-elem-2-144', description: 'x', requiresConfirmation: false },
    ]) as unknown as Parameters<typeof minimizeAgentContext>[0], {
      task: 'find information about charminar',
    });

    const ids = (result.payload.semantic_context?.affordances ?? []).map((a) => a.targetElementId);
    expect(ids).not.toContain('wm-elem-2-144');
    expect(ids).toContain('searchInput');
  });

  it('filters against the BOUNDED offered set, not the pre-bounding list', () => {
    // Real evidence: 37 privacy findings were bounded down to 3 exported
    // detections, so an affordance naming a bounded-out id survived a filter
    // written against `payload.detections` and reached the prompt as a decoy.
    // Every offered affordance target must be in the FINAL detections list.
    const raw = payload([
      { id: 'kept', type: 'FILL_FIELD', targetElementId: 'kept', description: 'x', requiresConfirmation: false },
      { id: 'bounded-out', type: 'FILL_FIELD', targetElementId: 'wm-elem-2-144', description: 'x', requiresConfirmation: false },
    ]) as unknown as Parameters<typeof minimizeAgentContext>[0];

    const result = minimizeAgentContext(raw, { task: 'find information about charminar', maxDetections: 1 });
    const offeredIds = new Set(result.payload.detections.map((d) => d.id));
    for (const a of result.payload.semantic_context?.affordances ?? []) {
      if (a.targetElementId) {
        expect(offeredIds.has(a.targetElementId), `dangling ${a.targetElementId}`).toBe(true);
      }
    }
  });
});

describe('A4 — an article is not a search page', () => {
  function classifyArticleBody(): string {
    // Real Wikipedia shape: body in #mw-content-text with many long <p>, NOT an
    // <article> tag, plus the site search chrome every page has.
    document.body.innerHTML = `
      <header><input id="searchInput" type="search" name="q" /></header>
      <div role="search"><input type="search" /></div>
      <div id="mw-content-text">
        <h1>Charminar</h1>
        ${Array.from({ length: 12 }, (_, i) => `<p>${'The monument is a historical structure with considerable architectural significance. '.repeat(2)}${i}</p>`).join('')}
      </div>`;
    const wm = buildBrowserWorldModel({ root: document, pageGeneration: 2 });
    const out = buildSemanticUnderstanding({ worldModel: wm, root: document, pageGeneration: 2 });
    return String((out.pageClassification as { pageType?: string })?.pageType ?? '');
  }

  it('classifies an article body as an article, not a search page', () => {
    expect(classifyArticleBody()).toBe('ARTICLE');
  });

  it('still classifies a portal home page with a query box as SEARCH', () => {
    // The chrome suppression must not break genuine search pages.
    document.body.innerHTML = `
      <input id="q" type="search" name="q" />
      <div role="search"></div>
      <p>${'short'.repeat(30)}</p>`;
    const wm = buildBrowserWorldModel({ root: document, pageGeneration: 1 });
    const out = buildSemanticUnderstanding({ worldModel: wm, root: document, pageGeneration: 1 });
    expect(String((out.pageClassification as { pageType?: string })?.pageType ?? '')).toBe('SEARCH');
  });
});