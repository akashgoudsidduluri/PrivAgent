/**
 * PHASE 18.5 — PROBE: is any progress emitted DURING the provider round trip?
 *
 * Reads the production AgentLoop directly. No mocks of the loop itself: only
 * the provider is stubbed, so the real notifyProgress() call sites decide the
 * answer. Records every onStepProgress emission with a timestamp, and whether
 * the loop was inside the provider await at that moment.
 *
 * The question it answers: while the loop is blocked awaiting reasoning, does
 * anything re-arm the dashboard watchdog? If nothing is emitted for the whole
 * round trip, the watchdog is anchored to the LAST message from BEFORE
 * reasoning started.
 */
import { AgentLoop } from '../extension/src/agent/agentLoop';
import type { AgentContextPayload, BrowserAction } from '../extension/src/agent/agentProvider';

const SLOW_MS = Number(process.env.PROBE_SLOW_MS || 5000);

const events: Array<{ t: number; inProvider: boolean; phase?: string; status?: string }> = [];
let t0 = Date.now();
let inProvider = false;

const context = {
  url: 'https://www.wikipedia.org/wiki/Charminar',
  timestamp: Date.now(),
  viewport: { width: 1280, height: 800 },
  detections: [],
  total_elements_scanned: 200,
  sensitive_elements_detected: 0,
  sanitized_status: 'sanitized_only',
  page_type: 'LISTING',
  semantic_context: { pageType: 'LISTING', confidence: 0.99, url: 'https://www.wikipedia.org/wiki/Charminar' },
} as unknown as AgentContextPayload;

// A provider that is deliberately SLOW but healthy — it returns a valid action.
const slowProvider = {
  async requestAction(_task: string, _ctx: AgentContextPayload, _hist: BrowserAction[]) {
    inProvider = true;
    await new Promise((r) => setTimeout(r, SLOW_MS));
    inProvider = false;
    return { action: 'scroll', direction: 'down', amount: 250 } as BrowserAction;
  },
  registerFailure() {},
  resetEscalation() {},
};

const loop = new AgentLoop(slowProvider as never, {
  onStepProgress: (state) => {
    events.push({
      t: Date.now() - t0,
      inProvider,
      phase: (state as never as { planningEngineState?: string }).planningEngineState,
      status: state.status,
    });
  },
  perceive: async () => context,
}, { maxSteps: 1, delayBetweenStepsMs: 0, providerRetries: 0 });

await loop.runTask('open wikipedia and find information about charminar').catch((e) => {
  console.log('runTask threw:', String(e).slice(0, 200));
});

console.log(JSON.stringify({
  slowProviderMs: SLOW_MS,
  emissionCount: events.length,
  emissions: events,
  duringProvider: events.filter((e) => e.inProvider).length,
  maxGapMs: events.reduce((m, e, i) => (i === 0 ? 0 : Math.max(m, e.t - events[i - 1].t)), 0),
}, null, 2));