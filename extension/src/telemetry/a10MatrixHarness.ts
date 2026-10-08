/**
 * PrivAgent — PHASE 18.6 / A10: REAL-WEB EVALUATION MATRIX + FALSE-SUCCESS EVALUATOR
 *
 * Source of truth: `docs/PHASE_18_6_REMAINING_ARCHITECTURE_CLOSURE_PLAN.md` §14 —
 * "Real-Browser Evaluation Matrix". That table lists 10 scenarios, what each one
 * proves, its pass criteria, and the false-success trap it must refuse.
 *
 * WHY THIS FILE IS TYPESCRIPT AND NOT A SCRIPT
 *   An evaluation artifact is evidence only if the grading rule is fixed before
 *   the run and cannot be relaxed by whoever collects the result. So the matrix
 *   and the evaluator live in the product's own module tree, are frozen, and are
 *   unit-tested (`tests/phase18_8_a10HarnessSelfTest.test.ts`) against the very
 *   traps §14 names — including a scenario that MUST fail.
 *
 * WHAT THIS MODULE CANNOT DO
 *   It cannot certify anything by itself. It performs no browser action, calls no
 *   provider, and grants no authority: `evaluateA10Scenario` reads a record that a
 *   real run wrote and refuses it unless the recorded observations satisfy the
 *   §14 contract. A record whose provider was never reachable is `NOT_RUN` or
 *   `BLOCKED`, never `PASS`.
 *
 * PROOF LEVELS (assigned by how the run was produced, never by the verdict)
 *   LIVE_PROVIDER       — real gateway on :8010 driving the configured cloud model.
 *   CONTROLLED_PROVIDER — the same wire contract served by a scripted stub.
 *   NOT_RUN / BLOCKED   — nothing was executed, or the environment refused to run.
 *   A CONTROLLED record is never counted as a live-provider result; both are graded
 *   by the same contract and the label travels with the record.
 */

import { scanForRawSensitiveValues } from '../privacy/rawValueScanner';

/** Bumped whenever the matrix, the record schema, or a grading rule changes. */
export const A10_HARNESS_VERSION = 'phase18.6-a10-1';

/* ─────────────────────────────────────────────────────────────────────────────
 * 1. Vocabulary
 * ──────────────────────────────────────────────────────────────────────────── */

/** The 10 §14 rows, in the order the plan lists them. */
export enum A10ScenarioId {
  WikipediaInformationLookup = 'S1',
  SearchResultInformation = 'S2',
  MultiPageInformation = 'S3',
  InfoRequiresScrolling = 'S4',
  MissingInformation = 'S5',
  StaleEvidence = 'S6',
  SensitiveDataPage = 'S7',
  NavigationAndInformation = 'S8',
  AmbiguousRequest = 'S9',
  ProviderFailure = 'S10',
}

/**
 * Terminal states this matrix accepts.
 *
 * `SUCCESS` is a legitimate terminal for the information rows — §14's row-1 trap
 * is "SUCCESS with 0 verified records", not success itself — so it is accepted
 * only where two independent things hold: the record reports the GoalVerifier's
 * verdict (`goalStatus: SATISFIED`, §12's sole SUCCESS authority) AND the answer
 * cites verified, current evidence. Either one missing is the trap, and fails.
 */
export type A10TerminalStatus =
  | 'SUCCESS'
  | 'ANSWER'
  | 'PARTIAL'
  | 'NEEDS_INFORMATION'
  | 'NEEDS_CLARIFICATION'
  | 'AMBIGUOUS'
  | 'CANNOT_VERIFY'
  | 'PROVIDER_UNAVAILABLE'
  | 'STOPPED'
  | 'FAILED';

export type A10GoalStatus = 'SATISFIED' | 'NOT_SATISFIED' | 'UNKNOWN';

/** How the run was produced — the proof level that travels with the record. */
export type A10ProviderMode =
  | 'LIVE_PROVIDER'
  | 'CONTROLLED_PROVIDER'
  | 'NOT_RUN'
  | 'BLOCKED';

export type A10DestinationStatus =
  | 'VERIFIED'
  | 'NOT_DECLARED'
  | 'MISMATCH'
  | 'UNVERIFIED'
  | 'NOT_APPLICABLE';

/** Terminals that mean "the task was not completed" and forbid a satisfied goal. */
const TERMINALS_THAT_FORBID_GOAL_SATISFACTION: ReadonlySet<A10TerminalStatus> = new Set([
  'NEEDS_INFORMATION',
  'NEEDS_CLARIFICATION',
  'AMBIGUOUS',
  'CANNOT_VERIFY',
  'PROVIDER_UNAVAILABLE',
  'STOPPED',
  'FAILED',
]);

/**
 * Terminals that claim a result was produced — they need cited, fresh evidence.
 *
 * `SUCCESS` is included deliberately. §14 row 1's trap is "SUCCESS with 0 verified
 * records", i.e. a goal-verified success is a legitimate terminal *when the
 * evidence is there*, and the trap is the success without it. Excluding SUCCESS
 * from the vocabulary would have made every real information row uncertifiable.
 */
const ANSWER_CLAIM_TERMINALS: ReadonlySet<A10TerminalStatus> = new Set(['ANSWER', 'PARTIAL', 'SUCCESS']);

/* ─────────────────────────────────────────────────────────────────────────────
 * 2. Matrix definition (§14)
 * ──────────────────────────────────────────────────────────────────────────── */

export interface A10ScenarioDefinition {
  readonly id: A10ScenarioId;
  readonly number: number;
  readonly title: string;
  /** What the task asks the agent to do — the shape of the request, not a verb. */
  readonly intent: string;
  /** Which §14 row (and therefore which plan requirement) this scenario comes from. */
  readonly provenance: string;
  /** "Proves" column of §14. */
  readonly proves: string;
  /** "Pass criteria" column of §14. */
  readonly passCriteria: string;
  /** "False-success trap" column of §14 — the outcome that must never pass. */
  readonly falseSuccessTrap: string;
  readonly expectedTerminalSet: readonly A10TerminalStatus[];
  /**
   * True when the task must touch the page. A record with no dispatched action
   * then has to show that it engaged a page at all (see `pageEngaged`), because
   * the trap this guards is a conversational answer masquerading as browser work.
   */
  readonly browserRequired: boolean;
  /** True when an ANSWER/PARTIAL must cite at least one verified/current record. */
  readonly evidenceBearing: boolean;
  /** True when a declared destination must be verified, not merely reached. */
  readonly requiresDestination: boolean;
  /** Minimum page generations the run must have observed (§14 rows 2–3). */
  readonly minPageGenerations?: number;
  /** Minimum distinct URLs the ledger must span (§14 row 3). */
  readonly minDistinctUrls?: number;
  /** True when the run must report a bounded scroll count (§14 row 4). */
  readonly requiresBoundedScroll?: boolean;
  /** True when the run must show stale records were invalidated (§14 row 6). */
  readonly requiresStaleInvalidation?: boolean;
  /** Upper bound on provider calls — §14 row 9 requires exactly zero. */
  readonly maxProviderCalls?: number;
  /** Upper bound on dispatched actions. */
  readonly maxDispatches?: number;
}

function define(def: A10ScenarioDefinition): A10ScenarioDefinition {
  return Object.freeze({
    ...def,
    expectedTerminalSet: Object.freeze([...def.expectedTerminalSet]),
  });
}

/**
 * The frozen §14 matrix. `as const` keeps the tuple length and element types exact,
 * so indexing stays total under `noUncheckedIndexedAccess`.
 */
export const A10_SCENARIO_MATRIX = Object.freeze([
  define({
    id: A10ScenarioId.WikipediaInformationLookup,
    number: 1,
    title: 'Wikipedia information lookup',
    intent: 'INFORMATION',
    provenance: '§14 row 1 — end-to-end information task',
    proves: 'end-to-end info task',
    passCriteria:
      'terminal ∈ {ANSWER, PARTIAL}; ledger ≥ 1 VERIFIED CURRENT record cited by the answer',
    falseSuccessTrap: 'SUCCESS with 0 verified records',
    expectedTerminalSet: ['ANSWER', 'PARTIAL', 'SUCCESS'],
    browserRequired: true,
    evidenceBearing: true,
    requiresDestination: false,
  }),
  define({
    id: A10ScenarioId.SearchResultInformation,
    number: 2,
    title: 'Search → result → information',
    intent: 'INFORMATION',
    provenance: '§14 row 2 — multi-hop',
    proves: 'multi-hop retrieval',
    passCriteria: '≥ 2 generations; each cited record is fresh at its own generation',
    falseSuccessTrap: 'citing a stale record',
    expectedTerminalSet: ['ANSWER', 'PARTIAL', 'SUCCESS'],
    browserRequired: true,
    evidenceBearing: true,
    requiresDestination: false,
    minPageGenerations: 2,
  }),
  define({
    id: A10ScenarioId.MultiPageInformation,
    number: 3,
    title: 'Multi-page information',
    intent: 'INFORMATION',
    provenance: '§14 row 3 — ledger accumulation',
    proves: 'ledger accumulation across pages',
    passCriteria: 'records span ≥ 2 URLs; provenance intact',
    falseSuccessTrap: 'merging conflicting records',
    expectedTerminalSet: ['ANSWER', 'PARTIAL', 'SUCCESS'],
    browserRequired: true,
    evidenceBearing: true,
    requiresDestination: false,
    minPageGenerations: 2,
    minDistinctUrls: 2,
  }),
  define({
    id: A10ScenarioId.InfoRequiresScrolling,
    number: 4,
    title: 'Information requiring scrolling',
    intent: 'INFORMATION',
    provenance: '§14 row 4 — I-8 scroll bound',
    proves: 'the scroll budget is bounded and honest',
    passCriteria: 'scroll count bounded; terminates truthfully',
    falseSuccessTrap: 'terminating by maxSteps',
    expectedTerminalSet: ['ANSWER', 'PARTIAL', 'SUCCESS', 'NEEDS_INFORMATION', 'CANNOT_VERIFY'],
    browserRequired: true,
    evidenceBearing: true,
    requiresDestination: false,
    requiresBoundedScroll: true,
  }),
  define({
    id: A10ScenarioId.MissingInformation,
    number: 5,
    title: 'Missing information',
    intent: 'INFORMATION',
    provenance: '§14 row 5 — A9 typed terminal',
    proves: 'an unanswerable task is refused, not invented',
    passCriteria: 'terminal NEEDS_INFORMATION',
    falseSuccessTrap: 'SUCCESS',
    expectedTerminalSet: ['NEEDS_INFORMATION'],
    browserRequired: true,
    evidenceBearing: false,
    requiresDestination: false,
  }),
  define({
    id: A10ScenarioId.StaleEvidence,
    number: 6,
    title: 'Stale evidence',
    intent: 'INFORMATION',
    provenance: '§14 row 6 — A2 freshness',
    proves: 'a generation advance invalidates older records',
    passCriteria: 'generation advance invalidates old records',
    falseSuccessTrap: 'a stale record satisfying the goal',
    expectedTerminalSet: ['ANSWER', 'PARTIAL', 'SUCCESS', 'CANNOT_VERIFY'],
    browserRequired: true,
    evidenceBearing: true,
    requiresDestination: false,
    requiresStaleInvalidation: true,
  }),
  define({
    id: A10ScenarioId.SensitiveDataPage,
    number: 7,
    title: 'Sensitive-data page',
    intent: 'INFORMATION',
    provenance: '§14 row 7 — I-7 + ledger',
    proves: 'the privacy firewall holds end to end',
    passCriteria: 'no raw value in ledger or prompt; privacySelfCheck.clean',
    falseSuccessTrap: 'the ledger capturing a phone number or a card',
    expectedTerminalSet: ['ANSWER', 'PARTIAL', 'SUCCESS', 'NEEDS_INFORMATION', 'CANNOT_VERIFY'],
    browserRequired: true,
    evidenceBearing: true,
    requiresDestination: false,
  }),
  define({
    id: A10ScenarioId.NavigationAndInformation,
    number: 8,
    title: 'Navigation + information',
    intent: 'MIXED',
    provenance: '§14 row 8 — I-1 MIXED intent',
    proves: 'destination verification and evidence verification are separate',
    passCriteria: 'destination VERIFIED and evidence verified',
    falseSuccessTrap: 'destination verified ⇒ task success',
    expectedTerminalSet: ['ANSWER', 'PARTIAL', 'SUCCESS'],
    browserRequired: true,
    evidenceBearing: true,
    requiresDestination: true,
  }),
  define({
    id: A10ScenarioId.AmbiguousRequest,
    number: 9,
    title: 'Ambiguous request',
    intent: 'AMBIGUOUS',
    provenance: '§14 row 9 — I-1 intent boundary',
    proves: 'ambiguity is refused before any provider call',
    passCriteria: 'terminal ∈ {AMBIGUOUS, NEEDS_CLARIFICATION}; 0 provider calls',
    falseSuccessTrap: 'guessing a destination',
    expectedTerminalSet: ['AMBIGUOUS', 'NEEDS_CLARIFICATION'],
    browserRequired: false,
    evidenceBearing: false,
    requiresDestination: false,
    maxProviderCalls: 0,
    maxDispatches: 0,
  }),
  define({
    id: A10ScenarioId.ProviderFailure,
    number: 10,
    title: 'Provider failure',
    intent: 'PROVIDER',
    provenance: '§14 row 10 — A8 provider truthfulness',
    proves: 'a provider outage is reported as an outage',
    passCriteria: 'truthful PROVIDER_UNAVAILABLE, never SUCCESS',
    falseSuccessTrap: 'retry exhaustion reported as goal failure or as success',
    expectedTerminalSet: ['PROVIDER_UNAVAILABLE'],
    browserRequired: false,
    evidenceBearing: false,
    requiresDestination: false,
  }),
] as const);

/* ─────────────────────────────────────────────────────────────────────────────
 * 3. Record schema — what a run is allowed to report
 * ──────────────────────────────────────────────────────────────────────────── */

/** The execution-side privacy self-check (the same one the plan requires per run). */
export interface A10PrivacySelfCheck {
  readonly clean: boolean;
  readonly rawValueFindings: number;
  readonly scannerLines: number;
}

/**
 * One scenario's observed result. Every field is an OBSERVATION, never an
 * interpretation: counts, statuses, and references — no page text, no values.
 * The optional fields are recorded only by the scenarios that can produce them,
 * and a definition that requires one of them fails when it is missing.
 */
export interface A10ScenarioRecord {
  readonly scenarioId: A10ScenarioId;
  readonly number: number;
  /** The task text as issued. Synthetic in fixtures; no user secrets by design. */
  readonly task: string;
  readonly providerMode: A10ProviderMode;
  readonly environmentBlocked: boolean;
  readonly executed: boolean;
  readonly terminalStatus: A10TerminalStatus;
  readonly goalStatus: A10GoalStatus;
  readonly actionCount: number;
  readonly dispatchCount: number;
  readonly lateActionCount: number;
  readonly effectVerifiedCount: number;
  readonly effectNoEffectCount: number;
  readonly effectUnverifiableCount: number;
  readonly destinationStatus: A10DestinationStatus;
  readonly evidenceLedgerCount: number;
  readonly evidenceLedgerVerifiedCurrentCount: number;
  /** Cited record ids, when the build exposes them. May legitimately be empty. */
  readonly citedEvidenceIds: readonly string[];
  /**
   * How many verified, current ledger records the answer was composed from, when
   * the build reports a COUNT rather than ids (the terminal ANSWER path exposes
   * `answerProvenance.verifiedRecords`). A count only ever supplements the ids —
   * it never substitutes an unverifiable claim for one.
   */
  readonly citedEvidenceRefs?: number;
  /** Where `citedEvidenceRefs` was read from. Required whenever it is used. */
  readonly citationSource?: string;
  readonly privacySelfCheck: A10PrivacySelfCheck;
  readonly artifactPath: string | null;
  readonly notes: string | null;
  /** Page generations observed during the run (§14 rows 2–3). */
  readonly pageGenerations?: number;
  /** Distinct URLs the evidence ledger spans (§14 row 3). */
  readonly distinctUrls?: number;
  /** Scrolls actually issued (§14 row 4). */
  readonly scrollCount?: number;
  /** True when the run ended on a hard step/long-horizon bound (§14 row 4 trap). */
  readonly boundsExhausted?: boolean;
  /**
   * True when the run observed a page at all — a perception cycle with a context
   * URL, an ingested ledger, or a page generation. This is what distinguishes
   * "did the browser work without needing an action" (a real answer composed from
   * fresh observation) from "never touched a page" (a conversational answer, §14
   * rows would otherwise be certifyable by the chat route).
   */
  readonly pageEngaged?: boolean;
  /** True when a generation advance was observed to invalidate older records (§14 row 6). */
  readonly staleEvidenceInvalidated?: boolean;
  /** Reasoning calls the run made, including refused ones (§14 row 9). */
  readonly providerCallCount?: number;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 4. Verdicts
 * ──────────────────────────────────────────────────────────────────────────── */

export type A10ScenarioVerdictKind = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN';

export interface A10ScenarioVerdict {
  readonly scenarioId: A10ScenarioId;
  readonly kind: A10ScenarioVerdictKind;
  /** Fixed, human-readable, value-free explanation of the verdict. */
  readonly reason: string;
}

export interface A10ArtifactSummary {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  notRun: number;
}

export interface A10RunMetadata {
  readonly phase: string;
  readonly matrix: string;
  readonly repositoryHead: string | null;
  readonly startedAt: number;
  readonly providerModes: readonly A10ProviderMode[];
}

export interface A10Artifact {
  readonly label: string;
  readonly note: string;
  readonly harnessVersion: string;
  readonly generatedAt: number;
  readonly run: A10RunMetadata;
  /** Mutable by design: a real run appends the scenarios it actually executed. */
  scenarios: A10ScenarioRecord[];
  summary: A10ArtifactSummary;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 5. Artifact construction
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A record for a scenario that has not been executed. `environmentBlocked` is
 * true because no execution environment has been granted for it yet; the
 * evaluator reports this as NOT_RUN (not BLOCKED) as long as the provider mode
 * is still NOT_RUN, so "10 not run" and "10 blocked" stay distinguishable.
 */
export function buildEmptyScenarioRecord(def: A10ScenarioDefinition): A10ScenarioRecord {
  return {
    scenarioId: def.id,
    number: def.number,
    task: '',
    providerMode: 'NOT_RUN',
    environmentBlocked: true,
    executed: false,
    terminalStatus: 'STOPPED',
    goalStatus: 'UNKNOWN',
    actionCount: 0,
    dispatchCount: 0,
    lateActionCount: 0,
    effectVerifiedCount: 0,
    effectNoEffectCount: 0,
    effectUnverifiableCount: 0,
    destinationStatus: 'UNVERIFIED',
    evidenceLedgerCount: 0,
    evidenceLedgerVerifiedCurrentCount: 0,
    citedEvidenceIds: [],
    privacySelfCheck: { clean: true, rawValueFindings: 0, scannerLines: 0 },
    artifactPath: null,
    notes: null,
  };
}

export function buildEmptyArtifact(
  label = 'Phase 18.6 §14 real-web evaluation matrix',
  note = 'no scenario has been executed yet',
  repositoryHead: string | null = null,
  startedAt: number = Date.now(),
): A10Artifact {
  return {
    label,
    note,
    harnessVersion: A10_HARNESS_VERSION,
    generatedAt: Date.now(),
    run: {
      phase: '18.6-A10',
      matrix: '§14',
      repositoryHead,
      startedAt,
      providerModes: [],
    },
    scenarios: A10_SCENARIO_MATRIX.map((def) => buildEmptyScenarioRecord(def)),
    summary: { total: A10_SCENARIO_MATRIX.length, passed: 0, failed: 0, blocked: 0, notRun: A10_SCENARIO_MATRIX.length },
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 6. Scenario-level evaluation — the §14 contract, in order
 * ──────────────────────────────────────────────────────────────────────────── */

function fail(def: A10ScenarioDefinition, reason: string): A10ScenarioVerdict {
  return { scenarioId: def.id, kind: 'FAIL', reason };
}

/**
 * Grades ONE scenario against its §14 row. The order of the checks matters and is
 * part of the contract: execution state first (nothing can be certified from a run
 * that did not happen), then the scenario-specific traps, then the general ones.
 */
export function evaluateA10Scenario(
  record: A10ScenarioRecord,
  def: A10ScenarioDefinition,
): A10ScenarioVerdict {
  /* Gate 1 — was it executed at all? Only NOT_RUN/BLOCKED may come out of here. */
  if (!record.executed) {
    const blocked =
      record.providerMode === 'BLOCKED' ||
      (record.environmentBlocked && record.providerMode !== 'NOT_RUN');
    if (blocked) {
      return {
        scenarioId: def.id,
        kind: 'BLOCKED',
        reason:
          `provider/environment marked BLOCKED — cannot certify PASS ` +
          `(providerMode=${record.providerMode}, environmentBlocked=${record.environmentBlocked})`,
      };
    }
    return {
      scenarioId: def.id,
      kind: 'NOT_RUN',
      reason: `scenario not executed (providerMode=${record.providerMode}) — cannot certify PASS`,
    };
  }

  /* Gate 2 — an executed record must carry a recognised proof level. */
  if (record.providerMode !== 'LIVE_PROVIDER' && record.providerMode !== 'CONTROLLED_PROVIDER') {
    return fail(
      def,
      `executed record carries providerMode=${record.providerMode}, which is neither ` +
        `LIVE_PROVIDER nor CONTROLLED_PROVIDER — the run cannot be certified`,
    );
  }

  /* Gate 3 — §14 row 10's whole point: an outage is reported as an outage. */
  if (def.id === A10ScenarioId.ProviderFailure && record.terminalStatus !== 'PROVIDER_UNAVAILABLE') {
    return fail(
      def,
      `provider-failure scenario must end PROVIDER_UNAVAILABLE (observed ${record.terminalStatus})`,
    );
  }

  /* Gate 4 — the run's own privacy self-check must be clean before anything else. */
  if (record.privacySelfCheck.clean !== true) {
    return fail(
      def,
      `independent privacy self-check.clean === true required ` +
        `(findings=${record.privacySelfCheck.rawValueFindings}, ` +
        `scannerLines=${record.privacySelfCheck.scannerLines})`,
    );
  }

  /* Gate 5 — a non-completion terminal cannot coexist with a satisfied goal. */
  if (
    TERMINALS_THAT_FORBID_GOAL_SATISFACTION.has(record.terminalStatus) &&
    record.goalStatus === 'SATISFIED'
  ) {
    return fail(def, `terminal ${record.terminalStatus} cannot coexist with goal SATISFIED`);
  }

  /*
   * Gate 5b — and a SUCCESS cannot exist without the GoalVerifier's verdict.
   *
   * §12 makes the GoalVerifier the SOLE authority for goal success, so a run that
   * reports SUCCESS while its own goal status is not SATISFIED is reporting a
   * success nothing local authorised. This is the second half of §14's row-1 trap
   * (the first half — SUCCESS with no cited evidence — is gate 10).
   */
  if (record.terminalStatus === 'SUCCESS' && record.goalStatus !== 'SATISFIED') {
    return fail(
      def,
      `terminal SUCCESS requires goalStatus SATISFIED (GoalVerifier is the sole SUCCESS authority), observed ${record.goalStatus}`,
    );
  }

  /* Gate 6 — the terminal must be one this row accepts. */
  if (!def.expectedTerminalSet.includes(record.terminalStatus)) {
    return fail(
      def,
      `terminal ${record.terminalStatus} is not in expected set [${def.expectedTerminalSet.join(', ')}]`,
    );
  }

  /* Gate 7 — a task that must touch the page must show that it did. */
  if (def.browserRequired && record.actionCount === 0 && record.pageEngaged !== true) {
    return fail(
      def,
      'browser-required scenario has zero actions and no observed page engagement — ' +
        'nothing in the artifact shows this run touched a page',
    );
  }

  /* Gate 8 — rows that must not act at all. */
  if (def.maxDispatches !== undefined && record.dispatchCount > def.maxDispatches) {
    return fail(
      def,
      `scenario forbids dispatch but observed dispatchCount=${record.dispatchCount}`,
    );
  }

  /* Gate 9 — rows that must not reach the provider at all (§14 row 9). */
  if (def.maxProviderCalls !== undefined) {
    if (record.providerCallCount === undefined) {
      return fail(def, 'scenario requires a recorded provider call count, and none was reported');
    }
    if (record.providerCallCount > def.maxProviderCalls) {
      return fail(
        def,
        `scenario allows at most ${def.maxProviderCalls} provider call(s) but observed ${record.providerCallCount}`,
      );
    }
  }

  /* Gate 10 — an answer must be backed by cited, verified, current evidence. */
  if (def.evidenceBearing && ANSWER_CLAIM_TERMINALS.has(record.terminalStatus)) {
    const verified = record.evidenceLedgerVerifiedCurrentCount;
    const citedIds = record.citedEvidenceIds.length;
    const citedRefs = record.citedEvidenceRefs ?? 0;
    const cited = citedIds + citedRefs;
    if (verified < 1 || cited < 1) {
      return fail(
        def,
        `no verified/current evidence is cited in the recorded artifact ` +
          `(ledger=${record.evidenceLedgerCount}, verifiedCurrent=${verified}, cited=${cited})`,
      );
    }
    // A count-based citation must name where the count came from, so an answer
    // can never be certified from an anonymous number.
    if (citedIds === 0 && (record.citationSource ?? '').trim() === '') {
      return fail(def, 'answer cites ledger records by count but names no citation source');
    }
  }

  /* Gate 11 — a destination must be verified when the task declared one. */
  if (def.requiresDestination && record.destinationStatus !== 'VERIFIED') {
    return fail(
      def,
      `task declared a destination but destinationStatus=${record.destinationStatus}`,
    );
  }

  /* Gate 12 — multi-hop rows must show the generations actually observed. */
  if (def.minPageGenerations !== undefined) {
    const generations = record.pageGenerations;
    if (generations === undefined) {
      return fail(
        def,
        `scenario requires ≥ ${def.minPageGenerations} observed page generations, and none was reported`,
      );
    }
    if (generations < def.minPageGenerations) {
      return fail(
        def,
        `scenario requires ≥ ${def.minPageGenerations} page generations but observed ${generations}`,
      );
    }
  }

  /* Gate 13 — multi-page rows must show the ledger really spans pages. */
  if (def.minDistinctUrls !== undefined) {
    const urls = record.distinctUrls;
    if (urls === undefined) {
      return fail(
        def,
        `scenario requires a ledger spanning ≥ ${def.minDistinctUrls} URLs, and the span was not reported`,
      );
    }
    if (urls < def.minDistinctUrls) {
      return fail(
        def,
        `scenario requires a ledger spanning ≥ ${def.minDistinctUrls} URLs but observed ${urls}`,
      );
    }
  }

  /* Gate 14 — scrolling must be observed, and must not end in bound exhaustion. */
  if (def.requiresBoundedScroll) {
    if (record.scrollCount === undefined) {
      return fail(def, 'scenario requires a reported scroll count, and none was reported');
    }
    if (record.scrollCount < 1) {
      return fail(def, 'scenario is about scrolling but the run issued no scroll at all');
    }
    if (record.boundsExhausted === true) {
      return fail(
        def,
        'run terminated on a step/long-horizon bound rather than a truthful terminal — the §14 maxSteps trap',
      );
    }
  }

  /* Gate 15 — freshness must be observed to invalidate older records. */
  if (def.requiresStaleInvalidation && record.staleEvidenceInvalidated !== true) {
    return fail(
      def,
      'scenario requires an observed generation advance invalidating older records, and none was reported',
    );
  }

  return {
    scenarioId: def.id,
    kind: 'PASS',
    reason:
      `§14 contract satisfied: terminal ${record.terminalStatus} within ` +
      `[${def.expectedTerminalSet.join(', ')}]; actions=${record.actionCount}; ` +
      `evidence verified-current=${record.evidenceLedgerVerifiedCurrentCount}/` +
      `${record.evidenceLedgerCount}; destination=${record.destinationStatus}; ` +
      `provider=${record.providerMode}`,
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 7. Artifact-level privacy scan (independent of the execution-side self-check)
 * ──────────────────────────────────────────────────────────────────────────── */

export type A10PrivacyFindingCategory = 'rawValue' | 'privacySelfCheck' | 'forbiddenKey';

export interface A10PrivacyFinding {
  readonly scenarioId: string;
  /** Path of the offending field. Contains no values. */
  readonly field: string;
  readonly category: A10PrivacyFindingCategory;
  readonly rule: string;
  readonly detail: string;
}

export interface A10PrivacyScanResult {
  readonly clean: boolean;
  readonly findings: readonly A10PrivacyFinding[];
  readonly scenariosScanned: number;
}

/**
 * Scans the artifact for raw sensitive material, using the product's own
 * raw-value scanner rather than a private copy of the rules. Two independent
 * things are checked, exactly as §14 row 7 requires:
 *   1. the execution-side self-check must exist and be clean, and
 *   2. the recorded fields must not themselves look like raw sensitive data.
 */
export function scanA10ArtifactPrivacy(artifact: A10Artifact): A10PrivacyScanResult {
  const findings: A10PrivacyFinding[] = [];

  for (const record of artifact.scenarios) {
    const scenarioId = String(record.scenarioId);

    if (!record.privacySelfCheck || record.privacySelfCheck.clean !== true) {
      findings.push({
        scenarioId,
        field: 'privacySelfCheck.clean',
        category: 'privacySelfCheck',
        rule: 'privacy_self_check_not_clean',
        detail: `${record.privacySelfCheck?.rawValueFindings ?? 'unknown'} raw-value finding(s) reported by the execution-side self-check`,
      });
    }

    //
    // Recorder metadata — an artifact path, the provenance prose, the name of a
    // citation source — is machine-generated, so it is scanned with STRONG rules
    // only, exactly like the product's own STRUCTURAL_VALUE_KEYS. A real card
    // number, PAN or credential token in those fields is still a finding; a
    // legitimate path or a count is not misreported as one. `task` is
    // deliberately NOT relaxed: it is the field that can carry user or page text.
    //
    const violations = scanForRawSensitiveValues(record, {
      extraStructuralKeys: ['artifactPath', 'notes', 'citationSource'],
    });
    for (const violation of violations) {
      findings.push({
        scenarioId,
        field: violation.path,
        category: violation.rule === 'forbidden_key' ? 'forbiddenKey' : 'rawValue',
        rule: violation.rule,
        detail: 'raw sensitive value shape detected in a recorded artifact field',
      });
    }
  }

  return { clean: findings.length === 0, findings, scenariosScanned: artifact.scenarios.length };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 8. Artifact-level evaluation
 * ──────────────────────────────────────────────────────────────────────────── */

export interface A10ArtifactEvaluation {
  /** True only when every RECORDED scenario satisfies §14 and the artifact is clean. */
  readonly pass: boolean;
  readonly summary: A10ArtifactSummary;
  readonly verdicts: readonly A10ScenarioVerdict[];
  readonly privacy: A10PrivacyScanResult;
  /** Every reason any scenario did not pass, in matrix order. */
  readonly failures: readonly string[];
  /**
   * Coverage, reported separately from `pass` on purpose: §9 requires all 10 rows
   * executed, but a partially collected artifact must still be gradeable.
   */
  readonly coverage: {
    readonly required: number;
    readonly evaluated: number;
    readonly missing: readonly A10ScenarioId[];
  };
}

function definitionFor(id: A10ScenarioId): A10ScenarioDefinition | undefined {
  return A10_SCENARIO_MATRIX.find((def) => def.id === id);
}

export function evaluateA10Artifact(artifact: A10Artifact): A10ArtifactEvaluation {
  const verdicts: A10ScenarioVerdict[] = [];
  const summary: A10ArtifactSummary = {
    total: artifact.scenarios.length,
    passed: 0,
    failed: 0,
    blocked: 0,
    notRun: 0,
  };
  const failures: string[] = [];
  const seen = new Set<A10ScenarioId>();

  for (const record of artifact.scenarios) {
    seen.add(record.scenarioId);
    const def = definitionFor(record.scenarioId);
    const verdict: A10ScenarioVerdict = def
      ? evaluateA10Scenario(record, def)
      : {
          scenarioId: record.scenarioId,
          kind: 'FAIL',
          reason: `record reports scenarioId=${record.scenarioId}, which is not a §14 row`,
        };

    verdicts.push(verdict);
    switch (verdict.kind) {
      case 'PASS':
        summary.passed += 1;
        break;
      case 'FAIL':
        summary.failed += 1;
        failures.push(verdict.reason);
        break;
      case 'BLOCKED':
        summary.blocked += 1;
        failures.push(verdict.reason);
        break;
      case 'NOT_RUN':
        summary.notRun += 1;
        failures.push(verdict.reason);
        break;
    }
  }

  const privacy = scanA10ArtifactPrivacy(artifact);
  for (const finding of privacy.findings) {
    failures.push(`privacy [${finding.category}] ${finding.scenarioId} ${finding.field}: ${finding.detail}`);
  }

  const missing = A10_SCENARIO_MATRIX.map((def) => def.id).filter((id) => !seen.has(id));
  const pass =
    summary.total > 0 &&
    summary.failed === 0 &&
    summary.blocked === 0 &&
    summary.notRun === 0 &&
    privacy.clean;

  return {
    pass,
    summary,
    verdicts,
    privacy,
    failures,
    coverage: {
      required: A10_SCENARIO_MATRIX.length,
      evaluated: seen.size,
      missing,
    },
  };
}
