import { describe, it, expect } from 'vitest';
import {
  resolveContextualIntent,
  TaskExecutionState,
} from '../extension/src/agent/contextualIntentResolver';

describe('contextualIntentResolver', () => {
  const basePreviousState: TaskExecutionState = {
    conversationId: 'conv-123',
    runId: 1,
    originalTask: 'open google.com',
    effectiveTask: 'open google.com',
    targetTabId: 42,
    targetUrl: 'https://www.google.com/',
    status: 'PROVIDER_UNAVAILABLE',
    stepsCount: 1,
    completedActions: [],
    timestamp: Date.now() - 5000,
  };

  it('resolves "continue" against previous unfinished task after provider failure', () => {
    const res = resolveContextualIntent('continue', basePreviousState, 'conv-123');
    expect(res.category).toBe('CONTINUATION');
    expect(res.effectiveTask).toBe('open google.com');
    expect(res.shouldReuseTargetTab).toBe(true);
  });

  it('resolves natural unseen continuation phrases without hardcoding', () => {
    const phrases = [
      'pick up where you stopped',
      'finish what you were doing',
      'go ahead',
      'do it',
      'complete it',
      'try again',
    ];

    for (const phrase of phrases) {
      const res = resolveContextualIntent(phrase, basePreviousState, 'conv-123');
      expect(res.category === 'CONTINUATION' || res.category === 'RETRY').toBe(true);
      expect(res.effectiveTask).toBe('open google.com');
      expect(res.shouldReuseTargetTab).toBe(true);
    }
  });

  it('detects inspection requests ("check now", "did you finish?", "what happened?")', () => {
    const checkRes = resolveContextualIntent('check now', basePreviousState, 'conv-123');
    expect(checkRes.category).toBe('INSPECTION');

    const whatRes = resolveContextualIntent('what happened?', basePreviousState, 'conv-123');
    expect(whatRes.category).toBe('INSPECTION');

    const finishedRes = resolveContextualIntent('did you finish?', basePreviousState, 'conv-123');
    expect(finishedRes.category).toBe('INSPECTION');
  });

  it('recognizes modification ("open leetcode.com instead") and does not resume old task', () => {
    const res = resolveContextualIntent('open leetcode.com instead', basePreviousState, 'conv-123');
    expect(res.category).toBe('MODIFICATION');
    expect(res.effectiveTask).toBe('open leetcode.com');
    expect(res.shouldReuseTargetTab).toBe(false);
  });

  it('protects cancelled task from accidental resumption', () => {
    const cancelledState: TaskExecutionState = {
      ...basePreviousState,
      cancelled: true,
      status: 'STOPPED',
    };

    const res = resolveContextualIntent('continue', cancelledState, 'conv-123');
    expect(res.category).toBe('CANCELLED_REFUSAL');
    expect(res.explanation).toContain('cancelled');
  });

  it('treats brand new tasks as NEW_TASK', () => {
    const res = resolveContextualIntent('open flipkart.com', basePreviousState, 'conv-123');
    expect(res.category).toBe('NEW_TASK');
    expect(res.effectiveTask).toBe('open flipkart.com');
  });

  it('does not conflate tasks from different conversations', () => {
    const res = resolveContextualIntent('continue', basePreviousState, 'conv-different');
    expect(res.category).toBe('NEW_TASK');
  });
});
