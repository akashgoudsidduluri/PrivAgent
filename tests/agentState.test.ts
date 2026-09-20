import { describe, it, expect } from 'vitest';
import {
  createAgentTaskState,
  advancePageGeneration,
  AgentTaskState,
  CandidateProductItem,
} from '../extension/src/agent/agentState';
import { assertNoSensitiveDataInState } from '../extension/src/agent/agentLoop';

describe('PrivAgent Phase 1 — AgentTaskState Foundation', () => {
  it('creates clean AgentTaskState with default parameters and safe bounds', () => {
    const state = createAgentTaskState('Open the shopping site and find black bag', {
      targetTabId: 42,
      windowId: 1,
      currentUrl: 'http://localhost:4174',
    });

    expect(state.taskGoal).toBe('Open the shopping site and find black bag');
    expect(state.targetTabId).toBe(42);
    expect(state.windowId).toBe(1);
    expect(state.currentUrl).toBe('http://localhost:4174');
    expect(state.currentPageGeneration).toBe(0);
    expect(state.pageType).toBe('unknown');
    expect(state.candidateItems).toEqual([]);
    expect(state.completedSteps).toEqual([]);
    expect(state.failureCount).toBe(0);
    expect(state.retryCount).toBe(0);
    expect(state.status).toBe('IN_PROGRESS');
    expect(state.goalStatus).toBe('IN_PROGRESS');
    expect(state.confirmationState).toBe('NONE');
  });

  it('increments page generation and clears stale element IDs on navigation', () => {
    const state = createAgentTaskState('Test task', { currentUrl: 'http://localhost:4174/' });
    state.visitedElementIds = ['btn-login', 'input-search', 'card-item-1'];

    expect(state.currentPageGeneration).toBe(0);
    expect(state.visitedElementIds.length).toBe(3);

    advancePageGeneration(state, 'http://localhost:4174/login.html', 'login');

    expect(state.currentPageGeneration).toBe(1);
    expect(state.perceptionGeneration).toBe(1);
    expect(state.currentUrl).toBe('http://localhost:4174/login.html');
    expect(state.pageType).toBe('login');
    // Stale DOM element IDs are invalidated
    expect(state.visitedElementIds).toEqual([]);
  });

  it('survives multi-page transitions while preserving stable target tab and accumulated candidate items', () => {
    const state = createAgentTaskState('Find XXL black bag', { targetTabId: 100 });

    // Transition 1: Landing -> Login
    advancePageGeneration(state, 'http://localhost:4174/login.html', 'login');
    state.completedSteps.push('Navigated to login');

    // Transition 2: Login -> Search
    advancePageGeneration(state, 'http://localhost:4174/search.html', 'search');
    state.completedSteps.push('Authenticated and opened search');

    // Transition 3: Search -> Results
    advancePageGeneration(state, 'http://localhost:4174/results.html', 'results');
    const candidate: CandidateProductItem = {
      id: 'item-1',
      title: 'XXL Black Baggy Bag',
      price: 899,
      currency: '₹',
      size: 'XXL',
      color: 'black',
      targetId: 'btn-view-qualifying-bag',
      matchesConstraints: true,
      constraintNotes: 'All constraints verified',
      confidence: 0.95,
    };
    state.candidateItems.push(candidate);

    expect(state.targetTabId).toBe(100); // Stable across all pages
    expect(state.currentPageGeneration).toBe(3);
    expect(state.completedSteps.length).toBe(2);
    expect(state.candidateItems.length).toBe(1);
    expect(state.candidateItems[0]?.price).toBe(899);
  });

  it('strictly passes assertNoSensitiveDataInState without throwing on valid state', () => {
    const state = createAgentTaskState('Find bag under 1000', {
      constraints: {
        category: 'bag',
        color: 'black',
        size: 'XXL',
        maxPrice: 1000,
        currency: '₹',
      },
    });

    state.candidateItems.push({
      id: 'det-1',
      title: 'Sample Product',
      price: 799,
      currency: '₹',
      size: 'XXL',
      color: 'black',
      matchesConstraints: true,
      constraintNotes: 'Verified',
      confidence: 0.9,
    });

    expect(() => assertNoSensitiveDataInState(state)).not.toThrow();
  });
});
