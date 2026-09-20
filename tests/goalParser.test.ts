import { describe, it, expect } from 'vitest';
import {
  extractTaskConstraints,
  extractTargetSite,
  parseUserGoal,
} from '../extension/src/agent/goalParser';

describe('PrivAgent Phase 2 — Goal Parser & Constraint Extractor', () => {
  it('extracts structured constraints from natural language shopping request', () => {
    const task = 'Open Flipkart.com, login, then search for an XXL black baggy bag under ₹1000.';
    const constraints = extractTaskConstraints(task);

    expect(constraints.maxPrice).toBe(1000);
    expect(constraints.currency).toBe('₹');
    expect(constraints.size).toBe('XXL');
    expect(constraints.color).toBe('black');
    expect(constraints.style).toBe('baggy');
    expect(constraints.category).toBe('bag');
    expect(constraints.requiresAuth).toBe(true);
  });

  it('handles price formats with various currency symbols and phrasing', () => {
    expect(extractTaskConstraints('Find shoes below 500').maxPrice).toBe(500);
    expect(extractTaskConstraints('Search laptop under $1200').maxPrice).toBe(1200);
    expect(extractTaskConstraints('Search laptop under $1200').currency).toBe('$');
    expect(extractTaskConstraints('Watch for ₹2,500 or less').maxPrice).toBe(2500);
    expect(extractTaskConstraints('Watch for ₹2,500 or less').currency).toBe('₹');
  });

  it('extracts target site domain or URL correctly', () => {
    expect(extractTargetSite('Open flipkart.com and search')).toBe('https://www.flipkart.com');
    expect(extractTargetSite('Go to http://localhost:4174 and login')).toBe('http://localhost:4174');
    expect(extractTargetSite('Open the shopping site and find bags')).toBe('http://localhost:4174');
    expect(extractTargetSite('Search google for cats')).toBe('https://www.google.com');
  });

  it('decomposes shopping goal into ordered logical subgoals', () => {
    const task = 'Open the shopping site, login, search for an XXL black baggy bag under ₹1000.';
    const parsed = parseUserGoal(task);

    expect(parsed.actionIntent).toBe('shopping');
    expect(parsed.constraints.maxPrice).toBe(1000);
    expect(parsed.subgoals.length).toBeGreaterThanOrEqual(4);

    const stepTypes = parsed.subgoals.map((s) => s.expectedActionType);
    expect(stepTypes).toContain('navigate');
    expect(stepTypes).toContain('click');
    expect(stepTypes).toContain('type');
    expect(stepTypes).toContain('verify');
  });

  it('degrades gracefully when constraints are sparse or absent', () => {
    const parsed = parseUserGoal('Browse news articles');
    expect(parsed.constraints.maxPrice).toBeUndefined();
    expect(parsed.constraints.size).toBeUndefined();
    expect(parsed.subgoals.length).toBeGreaterThanOrEqual(1);
  });
});
