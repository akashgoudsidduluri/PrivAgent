/**
 * PHASE 18.7 / I-1 — THE INTENT BOUNDARY.
 *
 * THE DEFECT: `serviceWorker.ts` accepted any string from the dashboard and
 * handed it straight to `AgentLoop.runTask()`, which ran `parseUserGoal` and
 * `decomposeTask` and then began provider calls and target-tab resolution.
 * There was no gate between the raw user string and browser automation, so
 * typing "hi" launched a full autonomous session ending in a terminal FAILED.
 *
 * THE INVARIANT under test: no task reaches browser automation unless a
 * deterministic, local, model-free classifier admits it — and anything the
 * classifier cannot resolve is refused rather than guessed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  classifyIntent,
  refusalUserMessage,
  type IntentDecision,
} from '../extension/src/agent/intentBoundary';
import { parseUserGoal } from '../extension/src/agent/goalParser';

const REPO = resolvePath(__dirname, '..');

describe('I-1 — all seven intent classes are reachable', () => {
  it.each([
    ['INFORMATION_REQUEST', 'what is the capital of India?'],
    ['NAVIGATION_REQUEST', 'open wikipedia'],
    ['ACTION_REQUEST', 'buy a blue shirt'],
    ['MIXED_TASK', 'open wikipedia and find information about charminar'],
    ['GREETING_CASUAL', 'hi'],
    ['AMBIGUOUS', 'find it'],
    ['UNSUPPORTED', 'send an email to bob'],
  ] as const)('classifies %s', (expected, task) => {
    expect(classifyIntent(task).intent).toBe(expected);
  });

  it('classifies the real Wikipedia task as MIXED_TASK with BOTH requirements retained', () => {
    // This is the task that fails end-to-end today. It needs a destination AND
    // verified evidence, so both requirements must survive classification — a
    // collapsed intent here would silently break the I-5 completion path later.
    const d = classifyIntent('open wikipedia and find information about charminar');
    expect(d.intent).toBe('MIXED_TASK');
    expect(d.requiresDestination).toBe(true);
    expect(d.requiresEvidence).toBe(true);
    expect(d.admitsBrowserAutomation).toBe(true);
  });
});

describe('I-1 — casual input never reaches browser automation', () => {
  it.each(['hi', 'hello', 'hey there', 'hello there', 'thanks!', 'ok', 'good morning'])(
    'refuses %s with zero automation',
    (task) => {
      const d = classifyIntent(task);
      expect(d.intent).toBe('GREETING_CASUAL');
      expect(d.admitsBrowserAutomation).toBe(false);
      expect(d.refusal).toBe('GREETING_NO_AUTOMATION');
    }
  );

  it('does NOT treat a real command containing a greeting as a greeting', () => {
    // The length bound is what separates these. Without it, "hi, open
    // wikipedia" would be smalltalk and a real task would be dropped.
    expect(classifyIntent('hi, open wikipedia').admitsBrowserAutomation).toBe(true);
  });

  it('produces a truthful refusal message that is neither success nor failure', () => {
    const msg = refusalUserMessage(classifyIntent('hi'));
    expect(msg.length).toBeGreaterThan(0);
    expect(msg.toLowerCase()).not.toContain('success');
    expect(msg.toLowerCase()).not.toContain('failed');
  });
});

describe('I-1 — ambiguity and unsupported capability fail closed', () => {
  it.each(['find it', 'do the thing', 'charminar', 'click it', '', '   ', 'the page'])(
    'refuses the unresolvable request %j',
    (task) => {
      const d = classifyIntent(task);
      expect(['AMBIGUOUS', 'UNSUPPORTED']).toContain(d.intent);
      expect(d.admitsBrowserAutomation).toBe(false);
    }
  );

  it('never guesses a destination for an ambiguous request', () => {
    const d = classifyIntent('find it');
    expect(d.requiresDestination).toBe(false);
    expect(d.requiresEvidence).toBe(false);
  });

  it('refuses capabilities the agent genuinely lacks', () => {
    for (const task of ['send an email to bob', 'call me now', 'run this script']) {
      const d = classifyIntent(task);
      expect(d.intent, task).toBe('UNSUPPORTED');
      expect(d.admitsBrowserAutomation, task).toBe(false);
    }
  });

  it('handles non-string and empty input without throwing', () => {
    for (const bad of [undefined, null, 42, {}, []]) {
      const d = classifyIntent(bad as unknown as string);
      expect(d.admitsBrowserAutomation).toBe(false);
    }
  });
});

describe('I-1 — determinism and immutability', () => {
  it('returns an identical decision across repeated classification', () => {
    const task = 'open wikipedia and find information about charminar';
    const first = JSON.stringify(classifyIntent(task));
    for (let i = 0; i < 200; i += 1) {
      expect(JSON.stringify(classifyIntent(task))).toBe(first);
    }
  });

  it('is insensitive to case, spacing and surrounding punctuation', () => {
    const canonical = classifyIntent('open wikipedia and find information about charminar');
    for (const variant of [
      'Open Wikipedia And Find Information About Charminar',
      '  open wikipedia and find information about charminar  ',
      'open wikipedia and find information about charminar.',
    ]) {
      expect(classifyIntent(variant).intent, variant).toBe(canonical.intent);
    }
  });

  it('exposes NO mutation path: the decision is frozen at admission', () => {
    const d: IntentDecision = classifyIntent('open wikipedia');
    // `readonly` is erased by the compiler, so the runtime freeze is what
    // actually makes "the model can never modify intent" true rather than
    // merely typed. This test caught that gap: without `Object.freeze` every
    // field was silently writable.
    expect(Object.isFrozen(d)).toBe(true);
    for (const key of Object.keys(d)) {
      const before = (d as unknown as Record<string, unknown>)[key];
      let threw = false;
      try {
        (d as unknown as Record<string, unknown>)[key] = 'TAMPERED_BY_MODEL';
      } catch {
        threw = true;
      }
      expect((d as unknown as Record<string, unknown>)[key], `field ${key} was mutable`).toBe(before);
      expect(threw || true).toBe(true); // strict-mode throws; frozen data is invariant either way
    }
  });

  it('does not mutate a caller-owned task string', () => {
    const task = 'open wikipedia and find information about charminar';
    classifyIntent(task);
    expect(task).toBe('open wikipedia and find information about charminar');
  });
});

describe('I-1 — backward compatibility', () => {
  it('preserves goalParser.actionIntent for existing decomposition', () => {
    // actionIntent shapes decomposition and is deliberately NOT repurposed as
    // an admission gate. It must keep behaving exactly as before.
    expect(parseUserGoal('Search google for cats').actionIntent).toBe('search');
    expect(parseUserGoal('buy a product').actionIntent).toBe('shopping');
    expect(parseUserGoal('please login to the account').actionIntent).toBe('login');
  });
});

describe('I-1 — the gate is placed where the acceptance criteria require', () => {
  // These two structural assertions are the regression protection for the two
  // placement reasons that make the acceptance criteria true at all. A future
  // refactor that moves the gate later would silently reopen both defects while
  // every behavioural test above still passed.
  const sw = readFileSync(
    resolvePath(REPO, 'extension/src/background/serviceWorker.ts'),
    'utf8'
  );

  it('gates BEFORE target resolution, so a refused task provisions no tab', () => {
    const gate = sw.indexOf('classifyIntent(task)');
    // Search the CALL SITES, not the first textual occurrence: `provisionTargetTab`
    // is *declared* far above the handler, so indexOf() would find the
    // declaration and produce a meaningless comparison.
    const resolution = sw.indexOf('const resolution = resolveTargetWebTab(');
    const provisioning = sw.indexOf('await provisionTargetTab(');
    expect(gate).toBeGreaterThan(-1);
    expect(resolution).toBeGreaterThan(-1);
    expect(provisioning).toBeGreaterThan(-1);
    expect(gate, 'intent gate must precede target resolution').toBeLessThan(resolution);
    expect(gate, 'intent gate must precede tab provisioning').toBeLessThan(provisioning);
  });

  it('gates BEFORE active-task supersession, so "hi" cannot halt a running task', () => {
    const gate = sw.indexOf('classifyIntent(task)');
    const supersede = sw.indexOf('activeTaskRunId++');
    expect(supersede).toBeGreaterThan(-1);
    expect(gate, 'intent gate must precede task supersession').toBeLessThan(supersede);
  });

  it('reports a refusal as NEEDS_CLARIFICATION, never as SUCCESS or FAILED', () => {
    expect(sw).toContain("status: 'NEEDS_CLARIFICATION'");
    const gateBlock = sw.slice(sw.indexOf('classifyIntent(task)'), sw.indexOf('resolveTargetWebTab('));
    expect(gateBlock).not.toContain("status: 'SUCCESS'");
  });
});