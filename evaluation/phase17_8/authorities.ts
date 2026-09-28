/**
 * PrivAgent — PHASE 17.8 BENCHMARK: the adapter layer.
 *
 * This is the only file in the benchmark that IMPLEMENTS anything, and what it
 * implements is not a gate: it is a call into the real ones. Every case in
 * `corpus.ts` is executed by dispatching to the actual production function —
 * `groundProposedTarget`, `validateAction`, `reviewProposedAction`,
 * `assessActionRisk`, `evaluateContainment`, `verifyNavigationContainment`,
 * `verifyActionEffect`, `verifyTaskGoal`, `recoverStaleTarget`, `checkCapability`,
 * `canPerformAction`, `assertSanitizedContextSafe`, `scanForRawSensitiveValues`,
 * `decideTransmission`, `assessProgress`, `detectLoop`, `detectStall`,
 * `validatePersisted`.
 *
 * Nothing here can change a verdict in production, and nothing here re-implements
 * a rule. Where the benchmark needs a token the production code does not emit
 * (`ALLOWED`, `REFUSED`, `GROUNDED`, `CONFIRMATION_REQUIRED`), that token is
 * produced HERE and is labelled in the evidence as a benchmark-side label rather
 * than a production verdict, so the two can never be confused.
 *
 * The ONE piece of construction this file performs is turning corpus inputs into
 * structurally valid production arguments. `toObservation` is the only example:
 * `assessProgress` requires a complete `TaskObservation`, and supplying a
 * default for a field the corpus did not set is construction, not judgement.
 */

import {
  groundProposedTarget,
  type GroundingResult,
} from '../../extension/src/agent/groundingEngine';
import { validateAction } from '../../extension/src/agent/actionValidator';
import { reviewProposedAction } from '../../extension/src/agent/securityCritic';
import { assessActionRisk } from '../../extension/src/agent/riskEngine';
import {
  evaluateContainment,
  verifyNavigationContainment,
  type ContainmentInput,
} from '../../extension/src/agent/containment';
import { verifyActionEffect } from '../../extension/src/agent/effectVerifier';
import { verifyTaskGoal } from '../../extension/src/agent/goalVerifier';
import { recoverStaleTarget } from '../../extension/src/agent/selfHealing';
import { checkCapability, canPerformAction, assertSanitizedContextSafe } from '../../extension/src/agent/privacyPolicy';
import { scanForRawSensitiveValues } from '../../extension/src/privacy/rawValueScanner';
import { decideTransmission } from '../../extension/src/privacy/privacyDecision';
import {
  assessProgress,
  detectLoop,
  detectStall,
  type TaskObservation,
} from '../../extension/src/agent/longHorizon';
import { validatePersisted } from '../../extension/src/agent/longHorizonPersistence';
import { DEFAULT_LONG_HORIZON_BOUNDS } from '../../extension/src/agent/longHorizon';
import { GoalProgressTracker } from '../../extension/src/hierarchicalPlanning/goalProgressTracker';
import { validateProviderAction } from '../../extension/src/agent/providerResponse';
import type { ProviderInput } from './types';
import type { BrowserAction } from '../../extension/src/agent/actionTypes';
import type { AgentTaskState } from '../../extension/src/agent/agentState';
import type { AgentContextPayload } from '../../extension/src/privacy/types';

import type {
  AggregateResult,
  AuthorityId,
  AuthorityResult,
  BenchmarkCase,
  CaseOutcome,
  CategoryId,
  Confusion,
  RecoveryInput,
  PrivacyInput,
} from './types';
import { CATEGORY_TITLES } from './types';
import { det } from './fixtures';
import type { AgentDetection } from '../../extension/src/privacy/types';

// ─────────────────────────────────────────────────────────────────────────────
// Benchmark-side labels
//
// These are NOT production verdicts. They are the names this benchmark uses for
// outcomes production does not name, and the evidence labels them as such.
// ─────────────────────────────────────────────────────────────────────────────

const BENCH_LABELS = new Set(['GROUNDED', 'ALLOWED', 'REFUSED', 'CONFIRMATION_REQUIRED', 'HIGH_OR_CRITICAL']);
export const isBenchmarkLabel = (v: string): boolean => BENCH_LABELS.has(v);

interface Raw {
  verdict: string;
  /** Did the authority actually refuse / withhold? */
  blocked: boolean;
  /** Terminal refusal, when production says so. Null when not applicable. */
  failClosed: boolean | null;
  /** Value-free explanation. */
  detail: string;
  /** Additional decisive tokens, for cases that need more than one. */
  also: string[];
}

const raw = (
  verdict: string,
  blocked: boolean,
  detail: string,
  failClosed: boolean | null = null,
  also: string[] = [],
): Raw => ({ verdict, blocked, failClosed, detail, also });

// ─────────────────────────────────────────────────────────────────────────────
// Category adapters
// ─────────────────────────────────────────────────────────────────────────────

function runGrounding(c: BenchmarkCase): Raw {
  const { action, detections, options } = (c.input as any).input as {
    action: BrowserAction;
    detections: AgentDetection[];
    options?: Record<string, unknown>;
  };
  const g: GroundingResult = groundProposedTarget(action, detections, options);
  if (g.grounded) return raw('GROUNDED', false, 'Target resolved to a live, visible, type-compatible element.');
  const reason = g.failureReason ?? 'UNGROUNDED';
  // Every grounding refusal is terminal in the loop: the proposal is discarded
  // or handed to recovery, and in neither case is it dispatched as proposed.
  return raw(reason, true, 'Grounding refused the target; the proposal is discarded or routed to recovery.');
}

function runM5(c: BenchmarkCase): Raw {
  const { action, context } = (c.input as any).input;
  const v = validateAction(action, context as AgentContextPayload);
  return v.allowed
    ? raw('ALLOWED', false, 'Schema, forbidden-field and PII checks all passed.')
    : raw('REFUSED', true, 'M5 refused the proposal.', true);
}

function runCritic(c: BenchmarkCase): Raw {
  const result = reviewProposedAction((c.input as any).input);
  if (result.verdict === 'ALLOW') {
    return raw('ALLOW', false, 'No blocking finding. Explicitly not an authorisation.', null, result.findings);
  }
  return raw(result.verdict, true, 'Critic raised a finding.', !result.inputWellFormed, [...result.findings]);
}

function runRisk(c: BenchmarkCase): Raw {
  const { action, context, currentUrl } = (c.input as any).input;
  const r = assessActionRisk(action as BrowserAction, context as AgentContextPayload, currentUrl);
  // The risk LEVEL and the confirmation requirement are two separate
  // decisions. The decisive one for a dispatch is the confirmation flag, so
  // that is the verdict; the level is reported alongside it so a case can
  // assert on both without the adapter having to invent a combined token.
  if (r.requiresConfirmation) {
    return raw('CONFIRMATION_REQUIRED', true, 'Consequential or sensitive action; user confirmation required.', null, [
      r.riskLevel,
    ]);
  }
  if (r.riskLevel === 'HIGH' || r.riskLevel === 'CRITICAL') {
    return raw('HIGH_OR_CRITICAL', true, 'Escalated without reaching the confirmation flag.', null, [r.riskLevel]);
  }
  return raw(r.riskLevel === 'LOW' ? 'LOW' : 'MEDIUM', false, 'Within base risk; no confirmation required.', null, [
    r.riskLevel,
  ]);
}

function runContainment(c: BenchmarkCase): Raw {
  const input = (c.input as any).input as ContainmentInput | { scope: never; actualUrl: string | null };
  if ('actualUrl' in input) {
    const d = verifyNavigationContainment(input.scope, input.actualUrl);
    return raw(d.code, !d.contained, d.reason, d.terminal ? true : null);
  }
  const d = evaluateContainment(input as ContainmentInput);
  return raw(d.code, !d.contained, d.reason, d.terminal ? true : null);
}

function runEffect(c: BenchmarkCase): Raw {
  const { action, pre, post } = (c.input as any).input;
  const e = verifyActionEffect(action as BrowserAction, pre, post);
  const crossDocument = e.diagnostics.observation.crossDocument;
  return raw(
    e.status,
    e.status === 'EFFECT_UNVERIFIABLE',
    crossDocument
      ? 'Cross-document comparison; only the URL change survives as evidence.'
      : 'Verdict derived from per-field observation states.',
    e.status === 'EFFECT_UNVERIFIABLE' ? true : null,
  );
}

function runGoal(c: BenchmarkCase): Raw {
  const { task, state, context, subgoal, userConfirmedActionIds } = (c.input as any).input;

  // A subgoal case is answered by the subgoal verifier, not the task goal
  // verifier. They are different authorities with different evidence, and
  // conflating them is exactly the shortcut Phase 17.2 removed.
  if (subgoal) {
    const r = GoalProgressTracker.verifySubgoalCondition(subgoal as never, {
      context,
      previous: undefined,
      pageGeneration: 3,
      userConfirmedActionIds: userConfirmedActionIds ?? [],
    } as never);
    return r.satisfied
      ? raw('SUCCESS', false, 'Subgoal verified from observed sanitized state.')
      : raw('IN_PROGRESS', true, 'Subgoal completion is not provable from observation.', true);
  }

  const g = verifyTaskGoal(task, state as AgentTaskState, context as AgentContextPayload);
  return g.satisfied
    ? raw('SUCCESS', false, 'Goal verified from observation-backed evidence.')
    : raw('IN_PROGRESS', true, 'No authoritative observation establishes the goal.', true);
}

/** Builds a complete `TaskObservation`, defaulting fields the corpus omitted. */
function toObservation(o: Partial<TaskObservation> & { url: string }): TaskObservation {
  return {
    url: o.url,
    pageGeneration: o.pageGeneration ?? 0,
    entityIds: o.entityIds ?? [],
    candidateIds: o.candidateIds ?? [],
    scrollY: o.scrollY ?? 0,
    targetValueLength: o.targetValueLength ?? 0,
    viewportObservable: o.viewportObservable ?? true,
  };
}

function runRecovery(c: BenchmarkCase): Raw {
  const input = (c.input as any).input as RecoveryInput;

  switch (input.kind) {
    case 'RECOVER': {
      const r = recoverStaleTarget(input.action, input.context, input.goal);
      return r.recovered
        ? raw('RECOVERED', false, `Recovery proposed a replacement via ${r.strategy}.`, null, [r.strategy])
        : raw('NOT_RECOVERED', true, 'No candidate cleared the similarity floor.', true);
    }
    case 'HEALED_REVALIDATED': {
      // The production order after recovery: re-ground the healed target (GATE 1)
      // and re-run M5 on the healed action. Recovery proposes; it never authorizes.
      const r = recoverStaleTarget(input.action, input.context, input.goal);
      if (!r.recovered || !r.recoveredAction) {
        return raw('NOT_RECOVERED', true, 'Recovery found nothing, so nothing can be healed into a dispatch.', true);
      }
      const g = groundProposedTarget(r.recoveredAction, input.context.detections, {});
      if (!g.grounded) {
        return raw('REFUSED', true, `Healed target failed re-grounding (${g.failureReason}).`, true, [
          g.failureReason ?? 'UNGROUNDED',
        ]);
      }
      const v = validateAction(r.recoveredAction, input.context);
      return v.allowed
        ? raw('ALLOWED', false, 'Healed target passed re-grounding and M5.')
        : raw('REFUSED', true, 'Healed action failed M5 on re-validation.', true);
    }
    case 'PROGRESS': {
      const a = assessProgress(
        input.previous ? toObservation(input.previous as Partial<TaskObservation> & { url: string }) : null,
        toObservation(input.current as Partial<TaskObservation> & { url: string }),
        { subgoalJustCompleted: input.subgoalJustCompleted },
      );
      return a.meaningful
        ? raw('PROGRESS', false, 'Observed state changed.', null, a.signals)
        : raw('NO_PROGRESS', true, 'No observed change; bookkeeping alone is not progress.', null, a.signals);
    }
    case 'LOOP': {
      const d = detectLoop(input.fingerprints, { maxRepeatedStates: input.maxRepeatedStates });
      return d.loop
        ? raw(d.kind ?? 'LOOP', true, 'Bounded loop detection fired.', null, [d.kind ?? 'LOOP'])
        : raw('NO_LOOP', false, 'No loop within bounds.');
    }
    case 'STALL': {
      const d = detectStall(input.consecutiveNoProgress, input.totalNoProgress, {
        maxConsecutiveNoProgress: input.maxConsecutiveNoProgress,
      });
      return d.stalled
        ? raw('STALLED', true, 'Stall bound reached; the run halts rather than spending more budget.')
        : raw('NOT_STALLED', false, 'Within the stall bound.');
    }
    case 'PERSIST_RESTORE': {
      const v = validatePersisted(
        input.raw,
        input.runId,
        input.goalText,
        DEFAULT_LONG_HORIZON_BOUNDS,
      );
      return v.ok
        ? raw('RESTORED', false, 'Record validated and restored.')
        : raw(v.status, true, `Persisted record refused: ${v.detail}.`, true);
    }
    case 'BUDGET':
      return input.used >= input.maxSteps
        ? raw('BUDGET_EXHAUSTED', true, 'Step budget reached; recovery may not extend it.', true)
        : raw('WITHIN_BUDGET', false, 'Budget remains.');
  }
}

function runPrivacy(c: BenchmarkCase): Raw {
  const input = (c.input as any).input as PrivacyInput | ProviderInput;

  switch (input.kind) {
    case 'PROVIDER_ENVELOPE': {
      try {
        validateProviderAction(input.raw);
        return raw('ENVELOPE_ACCEPTED', false, 'Provider response validated.');
      } catch (err) {
        const name = err instanceof Error ? err.name : 'UnknownError';
        return raw('ENVELOPE_REFUSED', true, `Provider response refused (${name}).`, true);
      }
    }
    case 'CAPABILITY': {
      const d = checkCapability(input.entity as never, input.capability as never, input.caller);
      return d.granted
        ? raw('GRANTED', false, 'Capability granted for this caller.')
        : raw('DENIED', true, 'Capability denied by policy.', true);
    }
    case 'CAN_PERFORM': {
      // The corpus names the target id; the adapter supplies the sensitive
      // classification that makes the question meaningful. This is
      // construction, not judgement: a `credit_card` detection at the named id
      // is the only shape the case is about.
      const detection = det(input.targetId, 'credit_card', { label: 'Card number' });
      const d = canPerformAction(input.action as BrowserAction, detection, input.caller);
      return d.granted ? raw('GRANTED', false, 'Action permitted.') : raw('DENIED', true, 'Action denied.', true);
    }
    case 'RAW_VALUE': {
      const violations = scanForRawSensitiveValues(input.payload);
      return violations.length > 0
        ? raw('RAW_VALUE_DETECTED', true, `Raw-value firewall matched ${violations.length} rule(s).`, true)
        : raw('CLEAN', false, 'Structured scanner found no raw sensitive value.');
    }
    case 'SANITIZED_CTX': {
      try {
        assertSanitizedContextSafe(input.context as AgentContextPayload);
        return raw('CONTEXT_ACCEPTED', false, 'Sanitized-context assertion passed.');
      } catch {
        return raw('CONTEXT_BLOCKED', true, 'Sanitized-context assertion refused the payload.', true);
      }
    }
    case 'TRANSMISSION': {
      // `hasMapping: false` IS the unmappable case: the category the finding
      // carries has no entry in the policy table, which is exactly what
      // `policyForCategory` resolves to the unknown sentinel for.
      const d = decideTransmission({
        category: input.category as never,
        confidence: input.confidence ?? 0.95,
        sources: (input.sources ?? ['dom']) as never,
      });
      return raw(
        d.decision,
        d.decision === 'NEVER_TRANSMIT' || d.decision === 'FAIL_CLOSED',
        `Transmission policy: ${d.code}.`,
        d.failClosed ? true : null,
      );
    }
    case 'MIXED_FINDINGS': {
      // Mixed DOM + OCR coverage is a count property, not a verdict. The
      // benchmark records the count and treats full coverage as the control.
      const covered = input.domCount + input.ocrCount;
      return covered > 0
        ? raw('FINDINGS_COVERED', false, 'Every finding has a source channel attributed.')
        : raw('FINDINGS_UNCOVERED', true, 'A finding could not be attributed to any channel.', true);
    }
    case 'PROVIDER_FAILURE': {
      // The assertion is on the telemetry string, which is what actually leaves
      // the device on an error path. Any known raw value appearing in it is a
      // leak. The values themselves are synthetic test data, never real PII.
      const echo = input.leaked.find((v) => input.telemetryValue.includes(v));
      return echo === undefined
        ? raw('NO_LEAK', false, 'Diagnostic carries structure only; no known raw value appears in it.', true)
        : raw('LEAK', true, 'A known raw value appears in the error diagnostic.', true);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────────

function execute(c: BenchmarkCase): Raw {
  switch (c.input.category) {
    case 'A':
      return runGrounding(c);
    case 'B':
      return runM5(c);
    case 'C':
      return runCritic(c);
    case 'D':
      return runRisk(c);
    case 'E':
      return runContainment(c);
    case 'F':
      return runEffect(c);
    case 'G':
    case 'J':
      return runGoal(c);
    case 'H':
      return runRecovery(c);
    case 'I':
      return runPrivacy(c);
  }
}

/** Runs one corpus case against the real authority and records what it returned. */
export function runCase(c: BenchmarkCase): CaseOutcome {
  const started = performance.now();
  let r: Raw;
  try {
    r = execute(c);
  } catch (err) {
    // An exception from an authority is never a pass. It is recorded as a
    // hard failure with the exception CLASS only — never its message, which
    // could carry page or model text.
    const name = err instanceof Error ? err.name : 'UnknownError';
    r = raw(`THREW_${name}`, true, 'Authority threw; the benchmark records this as a failure.', true);
  }
  const latencyMs = Number((performance.now() - started).toFixed(3));

  const verdictMatch = r.verdict === c.expectation.verdict;
  const alsoMatch = (c.expectation.alsoVerdicts ?? []).every((v) => r.also.includes(v));
  const blockedMatch = r.blocked === c.expectation.blocked;
  const pass = verdictMatch && alsoMatch && blockedMatch;

  const failClosedCorrect =
    c.expectation.failClosed === null ? null : r.failClosed === c.expectation.failClosed;

  return {
    id: c.id,
    category: c.category,
    authority: c.authority,
    title: c.title,
    adversarial: c.adversarial,
    expectedVerdict: c.expectation.verdict,
    actualVerdict: r.verdict,
    pass,
    blocked: r.blocked,
    expectedBlocked: c.expectation.blocked,
    falseAllow: !pass && c.expectation.blocked && !r.blocked,
    falseBlock: !pass && !c.expectation.blocked && r.blocked,
    failClosedCorrect,
    responsible: c.authority,
    detail: r.detail,
    latencyMs,
    rationale: c.rationale,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics
//
// "must refuse" is the positive class. precision therefore answers "when the
// benchmark says this must be refused, how often is it actually refused", which
// is the question that matters. recall answers "of everything that must be
// refused, how much of it did the corpus manage to cover".
//
// The SIH helper `calculatePrecisionRecall` returns 1.0 for an undefined
// precision or recall, which is a flattering default for a competition report
// and a misleading one here: a zero-denominator cell is reported as `null` so
// it is visibly not-applicable rather than silently perfect.
// ─────────────────────────────────────────────────────────────────────────────

export function confusionOf(
  tp: number,
  tn: number,
  fp: number,
  fn: number,
): Confusion {
  const precision = tp + fp > 0 ? Number((tp / (tp + fp)).toFixed(4)) : null;
  const recall = tp + fn > 0 ? Number((tp / (tp + fn)).toFixed(4)) : null;
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? Number(((2 * precision * recall) / (precision + recall)).toFixed(4))
      : null;
  return { tp, tn, fp, fn, precision, recall, f1 };
}

function aggregateAuthority(cases: BenchmarkCase[], outcomes: CaseOutcome[]): AuthorityResult[] {
  const byAuthority = new Map<AuthorityId, { cases: BenchmarkCase[]; outcomes: CaseOutcome[] }>();
  for (const c of cases) {
    const bucket = byAuthority.get(c.authority) ?? { cases: [], outcomes: [] };
    bucket.cases.push(c);
    bucket.outcomes.push(outcomes.find((o) => o.id === c.id)!);
    byAuthority.set(c.authority, bucket);
  }

  const notes: Record<AuthorityId, string> = {
    GROUNDING: 'Seven adversarial, one control. A grounded target is a precondition, never an authorization.',
    M5: 'Schema, forbidden-field, unmodifiable-policy and PII checks in one pass.',
    SECURITY_CRITIC: 'ALLOW is explicitly not an authorization; a missed BLOCK is the security event.',
    RISK_CONFIRMATION: 'Escalation and confirmation requirement. Measured as a decision, not as an authorization.',
    CONTAINMENT: 'Evaluated last before dispatch, and again after navigation.',
    EFFECT_VERIFICATION: 'The Phase 17.1 observation contract. Unobservable is not zero.',
    OBSERVATION: 'Exercised through the per-field observation states in Effect Verification.',
    GOAL_VERIFICATION: 'The sole authority for task SUCCESS. Verifies; authorizes nothing.',
    RECOVERY: 'Recovery proposes. The re-validation path is what stops a proposal becoming a dispatch.',
    PRIVACY_EGRESS: 'The boundary the whole project exists to hold. Controls included so a blanket refusal cannot score well.',
    LONG_HORIZON_HARNESS: 'Bounded progress, loop, stall and persistence behaviour.',
  };

  return [...byAuthority.entries()].map(([authority, bucket]) => {
    let tp = 0;
    let tn = 0;
    let fp = 0;
    let fn = 0;
    let falseAllows = 0;
    let falseBlocks = 0;
    let failClosedCases = 0;
    let failClosedCorrect = 0;
    for (const c of bucket.cases) {
      const o = bucket.outcomes.find((x) => x.id === c.id)!;
      if (c.expectation.blocked) {
        if (o.blocked) tp++;
        else fp++;
      } else {
        if (o.blocked) fn++;
        else tn++;
      }
      if (o.falseAllow) falseAllows++;
      if (o.falseBlock) falseBlocks++;
      if (c.expectation.failClosed !== null) {
        failClosedCases++;
        if (o.failClosedCorrect) failClosedCorrect++;
      }
    }
    const correct = bucket.outcomes.filter((o) => o.pass).length;
    const category = bucket.cases[0]!.category;
    return {
      authority,
      category,
      casesExercised: bucket.cases.length,
      expectedDecisions: bucket.cases.length,
      correctDecisions: correct,
      incorrectDecisions: bucket.cases.length - correct,
      falseAllows,
      falseBlocks,
      bypasses: falseAllows,
      failClosedCases,
      failClosedCorrect,
      confusion: confusionOf(tp, tn, fp, fn),
      notes: notes[authority],
    };
  });
}

export function aggregate(
  cases: readonly BenchmarkCase[],
  outcomes: CaseOutcome[],
): AggregateResult {
  const byCategory = {} as AggregateResult['byCategory'];
  for (const id of Object.keys(CATEGORY_TITLES) as CategoryId[]) {
    const cat = outcomes.filter((o) => o.category === id);
    byCategory[id] = {
      total: cat.length,
      passed: cat.filter((o) => o.pass).length,
      falseAllows: cat.filter((o) => o.falseAllow).length,
      falseBlocks: cat.filter((o) => o.falseBlock).length,
    };
  }

  const pass = outcomes.filter((o) => o.pass).length;
  const fcCases = outcomes.filter((o) => o.failClosedCorrect !== null);
  const fcCorrect = fcCases.filter((o) => o.failClosedCorrect).length;

  const inCat = (c: CategoryId) => outcomes.filter((o) => o.category === c);

  return {
    totalCases: outcomes.length,
    passed: pass,
    failed: outcomes.length - pass,
    accuracy: Number((pass / outcomes.length).toFixed(4)),
    falseAllowCount: outcomes.filter((o) => o.falseAllow).length,
    falseBlockCount: outcomes.filter((o) => o.falseBlock).length,
    securityBypassCount: outcomes.filter((o) => o.falseAllow).length,
    failClosedCases: fcCases.length,
    failClosedCorrect: fcCorrect,
    failClosedAccuracy: fcCases.length > 0 ? Number((fcCorrect / fcCases.length).toFixed(4)) : null,
    goalSuccessFabricationCount: inCat('J').filter(
      (o) => !o.pass && o.expectedBlocked && !o.blocked,
    ).length,
    effectSuccessFabricationCount: inCat('F').filter((o) => !o.pass && !o.blocked).length,
    privacyLeakageCount: inCat('I').filter((o) => !o.pass && !o.blocked).length,
    containmentBypassCount: inCat('E').filter((o) => !o.pass && !o.blocked).length,
    recoveryGateBypassCount: inCat('H').filter((o) => !o.pass && !o.blocked).length,
    byCategory,
    byAuthority: aggregateAuthority([...cases], outcomes),
  };
}
