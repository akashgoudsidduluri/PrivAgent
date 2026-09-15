import { describe, it, expect } from 'vitest';
import {
  classifyUserIntent,
  extractExplicitTargetFromTask,
} from '../frontend/src/routing/intentClassifier';
import {
  resolveTargetWebTab,
  MinimalTab,
} from '../extension/src/background/targetResolver';

describe('PrivAgent Intent Routing & Target Tab Resolution', () => {
  // -- Test 1: "hi" ? CHAT ----------------------------------------------------
  it('1. classifies "hi" as CHAT', () => {
    const res = classifyUserIntent('hi');
    expect(res.intent).toBe('CHAT');
    expect(res.suggestedResponse).toBeDefined();
  });

  // -- Test 2: "hello" ? CHAT -------------------------------------------------
  it('2. classifies "hello" as CHAT', () => {
    const res = classifyUserIntent('hello');
    expect(res.intent).toBe('CHAT');
    expect(res.suggestedResponse).toBeDefined();
  });

  // -- Test 3: "helo" ? CHAT --------------------------------------------------
  it('3. classifies "helo" as CHAT', () => {
    const res = classifyUserIntent('helo');
    expect(res.intent).toBe('CHAT');
    expect(res.suggestedResponse).toBeDefined();
  });

  // -- Test 4: "what can you do?" ? CHAT --------------------------------------
  it('4. classifies "what can you do?" as CHAT', () => {
    const res = classifyUserIntent('what can you do?');
    expect(res.intent).toBe('CHAT');
    expect(res.reason).toBe('Capability inquiry');
  });

  // -- Test 5: "find my recent transactions" ? BROWSER_TASK -------------------
  it('5. classifies "find my recent transactions" as BROWSER_TASK', () => {
    const res = classifyUserIntent('find my recent transactions');
    expect(res.intent).toBe('BROWSER_TASK');
  });

  // -- Test 6: "click transactions" ? BROWSER_TASK ----------------------------
  it('6. classifies "click transactions" as BROWSER_TASK', () => {
    const res = classifyUserIntent('click transactions');
    expect(res.intent).toBe('BROWSER_TASK');
  });

  // -- Test 7: "open localhost 4173 and get my account number" ? BROWSER_TASK + explicit target
  it('7. classifies "open localhost 4173 and get my account number" as BROWSER_TASK with explicit localhost:4173 target', () => {
    const task = 'open localhost 4173 and get my account number';
    const res = classifyUserIntent(task);
    expect(res.intent).toBe('BROWSER_TASK');
    expect(res.explicitTarget).toEqual({ hostname: 'localhost', port: '4173' });

    const tabs: MinimalTab[] = [
      { id: 1, url: 'http://localhost:5173/', active: true },
      { id: 2, url: 'http://localhost:4173/', active: false },
    ];
    const resolution = resolveTargetWebTab(tabs, task);
    expect(resolution.selectedTab?.id).toBe(2);
    expect(resolution.selectedTab?.url).toBe('http://localhost:4173/');
  });

  // -- Test 8: "find me the gold chain price" ? BROWSER_TASK + no forced localhost:4173
  it('8. classifies "find me the gold chain price" as BROWSER_TASK without forced localhost:4173', () => {
    const task = 'find me the gold chain price';
    const res = classifyUserIntent(task);
    expect(res.intent).toBe('BROWSER_TASK');
    expect(res.explicitTarget).toBeNull();

    // With shopping page active, it MUST pick the shopping page, NEVER force localhost:4173
    const tabs: MinimalTab[] = [
      { id: 1, url: 'http://localhost:5173/', active: false }, // dashboard
      { id: 2, url: 'http://localhost:4173/', active: false }, // demo bank
      { id: 3, url: 'https://www.amazon.in/s?k=gold+chain', active: true }, // active shopping tab
    ];
    const resolution = resolveTargetWebTab(tabs, task);
    expect(resolution.selectedTab?.id).toBe(3);
    expect(resolution.selectedTab?.url).toBe('https://www.amazon.in/s?k=gold+chain');
  });

  // -- Test 9: Dashboard localhost:5173 is never selected as browser target ---
  it('9. strictly excludes dashboard localhost:5173 even if it is the only tab', () => {
    const tabs: MinimalTab[] = [
      { id: 1, url: 'http://localhost:5173/dashboard', active: true },
    ];
    const resolution = resolveTargetWebTab(tabs, 'find my transactions');
    expect(resolution.selectedTab).toBeNull();
  });

  // -- Test 10: Browser task with no eligible tab gives a generic target-tab error
  it('10. gives generic error when no eligible browser tab exists (does not force localhost:4173)', () => {
    const tabs: MinimalTab[] = [
      { id: 1, url: 'http://localhost:5173/', active: true },
      { id: 2, url: 'chrome://extensions', active: false },
    ];
    const resolution = resolveTargetWebTab(tabs, 'find me the gold chain price');
    expect(resolution.selectedTab).toBeNull();
    expect(resolution.reason).toBe(
      'No browser tab is available for this task. Open the webpage you want PrivAgent to work with and try again.'
    );
    // MUST NOT mention localhost:4173
    expect(resolution.reason).not.toContain('4173');
  });

  // -- Test 11: No browser task is started for CHAT messages -------------------
  it('11. verifies that CHAT messages are classified as CHAT and have appropriate responses', () => {
    const chatPrompts = [
      'hi',
      'hello',
      'helo',
      'hey',
      'good morning',
      'what can you do?',
      'explain how PrivAgent works',
      'thank you',
    ];

    for (const prompt of chatPrompts) {
      const classification = classifyUserIntent(prompt);
      expect(classification.intent).toBe('CHAT');
      expect(classification.suggestedResponse).toBeDefined();
      expect(typeof classification.suggestedResponse).toBe('string');
      expect(classification.suggestedResponse!.length).toBeGreaterThan(10);
    }
  });
});
