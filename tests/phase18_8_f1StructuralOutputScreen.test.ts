/**
 * PrivAgent — PHASE 18.6 / A10-F1: REPRODUCTION.
 *
 * A real-Chrome A10 run (§14 row 4) recorded this, and the F1 diagnostic added in
 * the same phase named the offender:
 *
 *   [AgentTrace] output screen {"verdict":"BLOCKED","audit":"OUTPUT_SCREEN_BLOCKED (1 finding(s))",
 *     "outcome":"FAILED","phase":"TERMINAL","resultKind":"NONE",
 *     "structuralViolations":[{"field":"artifacts[0]","rule":"credential_token"}]}
 *
 * `artifacts[0]` is the CONTAINMENT artifact. Its label is built as
 * `${code}:${scope}` from a closed-vocabulary code and a machine-generated scope
 * summary, and `containmentSummary()` produces `contained:<rootHost>` — so for a
 * local IP fixture the label is `WITHIN_SCOPE:contained:0.1`.
 *
 * `structureIsClean` scans the joined `kind:label` string with the FULL rule set,
 * and `CREDENTIAL_TOKEN_RULE`
 *   /\b(?=[^\s]*[A-Z])(?=[^\s]*[a-z])(?=[^\s]*\d)[^\s]{8,}\b/
 * matches any whitespace-delimited token that mixes upper case, lower case and a
 * digit. The label supplies the upper case (`WITHIN_SCOPE`), the scope supplies
 * the lower case and the digit (`contained:0.1`) — so the concatenation trips a
 * rule neither half trips alone, and the whole user-facing payload is replaced by
 * `safeBlockedProjection('UNKNOWN')`.
 *
 * This file first had to PASS with that behaviour (reproduction), and then had to
 * pass with the fix: the containment label no longer concatenates the two halves
 * into one token, so the trip is gone and every genuine sensitive-value case still
 * blocks exactly as before.
 */

import { describe, it, expect } from 'vitest';

import {
  projectAgentOutput,
  screenAgentOutput,
  describeOutputScreen,
  type AgentInteractionState,
} from '../extension/src/agent/agentOutput';
import { createAgentTaskState, type AgentTaskState } from '../extension/src/agent/agentState';

const TASK = 'scroll down to find more products';
const IN_SCOPE = 'http://127.0.0.1:4174/lazy-scroll.html';

function baseState(over: Partial<AgentTaskState> = {}): AgentTaskState {
  const s = createAgentTaskState(TASK, { maxSteps: 12, maxRetries: 2, targetTabId: 7 });
  s.currentUrl = IN_SCOPE;
  s.perceptionGeneration = 9;
  s.currentPageGeneration = 2;
  s.planningEngineState = 'CHROME_EXECUTION';
  return { ...s, ...over };
}

/** The state a real run reached: an action-bearing task that ended FAILED. */
function failedRunState(): AgentTaskState {
  return baseState({
    status: 'FAILED',
    reason: 'Recovery limit exceeded for NO_EFFECT after 2 bounded attempts.',
    containmentDecision: {
      code: 'WITHIN_SCOPE',
      contained: true,
      reason: 'Action stays within the containment scope for this task.',
      scope: 'contained:0.1',
    },
  });
}

describe('F1 — the containment diagnostic must not discard unrelated terminal output', () => {
  it('1. the containment label carries the decision code and the scope summary', () => {
    const projected = projectAgentOutput(failedRunState());
    const containment = projected.artifacts.find((a) => a.kind === 'CONTAINMENT');
    expect(containment).toBeDefined();
    // Both pieces of information survive the fix — only the token shape changed.
    expect(containment?.label).toContain('WITHIN_SCOPE');
    expect(containment?.label).toContain('contained:0.1');
  });

  it('2. the projection no longer forms a mixed-case+digit token that the credential-token heuristic matches', () => {
    const projected = projectAgentOutput(failedRunState());
    const joined = projected.artifacts
      .filter((a) => a.kind === 'CONTAINMENT')
      .map((a) => `${a.kind}:${a.label}`)
      .join(' ');
    // The exact shape CREDENTIAL_TOKEN_RULE matches: upper + lower + digit, no whitespace.
    expect(/\b(?=[^\s]*[A-Z])(?=[^\s]*[a-z])(?=[^\s]*\d)[^\s]{8,}\b/.test(joined)).toBe(false);
  });

  it('3. the terminal projection survives screening (no dropped payload)', () => {
    const projected = projectAgentOutput(failedRunState());
    const screened = screenAgentOutput(projected);
    expect(screened.verdict).toBe('CLEAR');
    expect(screened.findings).toBe(0);
    expect(screened.structuralViolations ?? []).toHaveLength(0);
    expect(describeOutputScreen(screened)).toBe('OUTPUT_SCREEN_CLEAR (0 finding(s))');
    // The user-facing payload IS the projection — not the safe empty one.
    expect(screened.output).toEqual(projected);
    expect(screened.output.terminal?.outcome).toBe('FAILED');
  });

  it('4. a genuine credential-shaped value in the same label still blocks', () => {
    const withSecret = baseState({
      status: 'FAILED',
      containmentDecision: {
        code: 'WITHIN_SCOPE',
        contained: true,
        reason: 'x',
        scope: 'contained:password=hunter2',
      },
    });
    const screened = screenAgentOutput(projectAgentOutput(withSecret));
    expect(screened.verdict).toBe('BLOCKED');
    expect(screened.output.terminal?.reason).not.toBe(withSecret.reason);
  });

  it('5. a credential-token shape in a page-derived field still blocks', () => {
    const withToken = baseState({
      status: 'FAILED',
      containmentDecision: { code: 'WITHIN_SCOPE', contained: true, reason: 'x', scope: 'contained:0.1' },
      steps: [
        {
          step: 1,
          action: { action: 'scroll', direction: 'down', amount: 400 },
          executionSuccess: false,
          validationAllowed: true,
          reason: 'sk_live_51H8xAbCdEf012345',
        } as never,
      ],
    });
    const projected = projectAgentOutput(withToken);
    // The step reason must not reach the projection at all (Phase 14 rule)…
    expect(JSON.stringify(projected)).not.toContain('sk_live');
    // …and if it did, screening would fail closed.
    const poisoned: AgentInteractionState = { ...projected, activity: { ...projected.activity, summary: 'sk_live_51H8xAbCdEf012345' } };
    const screened = screenAgentOutput(poisoned);
    expect(screened.verdict).toBe('BLOCKED');
    expect(screened.structuralViolations?.some((v) => v.rule === 'credential_token')).toBe(true);
  });

  it('6. screening stays fail-closed for a malformed projection', () => {
    const screened = screenAgentOutput(undefined as unknown as AgentInteractionState);
    expect(screened.verdict).toBe('BLOCKED');
    expect(describeOutputScreen(screened)).toBe('OUTPUT_SCREEN_BLOCKED (0 finding(s))');
    expect(screened.output.outcome).toBe('FAILED');
  });

  it('7. a raw-value shape inside a structural field blocks and is attributable', () => {
    const projected = projectAgentOutput(failedRunState());
    const poisoned: AgentInteractionState = {
      ...projected,
      artifacts: [...projected.artifacts, { kind: 'FAILURE', label: 'card 4111111111111111' }],
    };
    const screened = screenAgentOutput(poisoned);
    expect(screened.verdict).toBe('BLOCKED');
    expect(screened.structuralViolations?.some((v) => v.field.startsWith('artifacts['))).toBe(true);
  });
});
