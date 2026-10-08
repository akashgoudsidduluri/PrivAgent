/**
 * PRIVAGENT — PHASE 18.6 / A10: false-success evaluator self-tests.
 *
 * Deterministic, unit-level, fixture-only. No browser, no provider, no model.
 * These tests prove the evaluator itself refuses the §14 false-success traps.
 */

import { describe, it, expect } from 'vitest';

import {
  A10ScenarioId,
  A10_SCENARIO_MATRIX,
  A10ScenarioRecord,
  buildEmptyArtifact,
  evaluateA10Scenario,
  evaluateA10Artifact,
  scanA10ArtifactPrivacy,
} from '../extension/src/telemetry/a10MatrixHarness';

function baseRecord(over: Partial<A10ScenarioRecord> = {}): A10ScenarioRecord {
  return {
    scenarioId: A10ScenarioId.WikipediaInformationLookup,
    number: 1,
    task: 'Tell me about Charminar.',
    providerMode: 'CONTROLLED_PROVIDER',
    environmentBlocked: false,
    executed: true,
    terminalStatus: 'ANSWER',
    goalStatus: 'NOT_SATISFIED',
    actionCount: 2,
    dispatchCount: 2,
    lateActionCount: 0,
    effectVerifiedCount: 1,
    effectNoEffectCount: 0,
    effectUnverifiableCount: 0,
    destinationStatus: 'VERIFIED',
    evidenceLedgerCount: 3,
    evidenceLedgerVerifiedCurrentCount: 2,
    citedEvidenceIds: ['ev-1', 'ev-2'],
    privacySelfCheck: { clean: true, rawValueFindings: 0, scannerLines: 1 },
    artifactPath: '/tmp/a10_s1.json',
    notes: null,
    ...over,
  };
}

function blockedRecord(over: Partial<A10ScenarioRecord> = {}): A10ScenarioRecord {
  return baseRecord({
    executed: false,
    providerMode: 'BLOCKED',
    environmentBlocked: true,
    ...over,
  });
}

describe('A10 false-success evaluator — scenario level', () => {
  it('1. valid passing record -> PASS', () => {
    const verdict = evaluateA10Scenario(baseRecord(), A10_SCENARIO_MATRIX[0]);
    expect(verdict.kind).toBe('PASS');
    expect(verdict.reason).toContain('§14 contract satisfied');
  });

  it('2. missing goal/information evidence -> FAIL', () => {
    const verdict = evaluateA10Scenario(
      baseRecord({ evidenceLedgerVerifiedCurrentCount: 0, citedEvidenceIds: [] }),
      A10_SCENARIO_MATRIX[0],
    );
    expect(verdict.kind).toBe('FAIL');
    expect(verdict.reason).toContain('no verified/current evidence is cited');
  });

  //
  // §14 row 1's trap is "SUCCESS with 0 verified records", so SUCCESS itself is a
  // legitimate terminal for the information rows and the trap is the success that
  // is not backed by the two independent things that authorise it: the
  // GoalVerifier's verdict, and cited verified/current evidence.
  //
  it('3a. SUCCESS without a GoalVerifier verdict -> FAIL', () => {
    const verdict = evaluateA10Scenario(baseRecord({ terminalStatus: 'SUCCESS' }), A10_SCENARIO_MATRIX[0]);
    expect(verdict.kind).toBe('FAIL');
    expect(verdict.reason).toContain('requires goalStatus SATISFIED');
  });

  it('3b. goal-verified SUCCESS with 0 verified/cited records -> FAIL (the §14 trap)', () => {
    const verdict = evaluateA10Scenario(
      baseRecord({
        terminalStatus: 'SUCCESS',
        goalStatus: 'SATISFIED',
        evidenceLedgerVerifiedCurrentCount: 0,
        citedEvidenceIds: [],
      }),
      A10_SCENARIO_MATRIX[0],
    );
    expect(verdict.kind).toBe('FAIL');
    expect(verdict.reason).toContain('no verified/current evidence is cited');
  });

  it('3c. goal-verified SUCCESS with cited, verified, current evidence -> PASS', () => {
    const verdict = evaluateA10Scenario(
      baseRecord({ terminalStatus: 'SUCCESS', goalStatus: 'SATISFIED' }),
      A10_SCENARIO_MATRIX[0],
    );
    expect(verdict.kind).toBe('PASS');
  });

  it('3d. a terminal outside the row set -> FAIL', () => {
    const verdict = evaluateA10Scenario(
      baseRecord({ terminalStatus: 'FAILED', goalStatus: 'NOT_SATISFIED' }),
      A10_SCENARIO_MATRIX[0],
    );
    expect(verdict.kind).toBe('FAIL');
    expect(verdict.reason).toContain('not in expected set');
  });

  it('3e. a count-based citation with no named source -> FAIL', () => {
    const verdict = evaluateA10Scenario(
      baseRecord({ citedEvidenceIds: [], citedEvidenceRefs: 2 }),
      A10_SCENARIO_MATRIX[0],
    );
    expect(verdict.kind).toBe('FAIL');
    expect(verdict.reason).toContain('names no citation source');
  });

  it('3f. a count-based citation with a named source -> PASS', () => {
    const verdict = evaluateA10Scenario(
      baseRecord({
        citedEvidenceIds: [],
        citedEvidenceRefs: 2,
        citationSource: 'terminal proposal received {supportedRecords}',
      }),
      A10_SCENARIO_MATRIX[0],
    );
    expect(verdict.kind).toBe('PASS');
  });

  it('4. provider failure incorrectly marked success -> FAIL', () => {
    const verdict = evaluateA10Scenario(
      baseRecord({
        scenarioId: A10ScenarioId.ProviderFailure,
        terminalStatus: 'SUCCESS',
        goalStatus: 'SATISFIED',
      }),
      A10_SCENARIO_MATRIX[9],
    );
    expect(verdict.kind).toBe('FAIL');
    expect(verdict.reason).toContain('provider-failure scenario must end PROVIDER_UNAVAILABLE');
  });

  it('5. raw sensitive value present -> FAIL (independent privacy scan)', () => {
    // Execution-side privacy self-check not clean => FAIL.
    const withFinding = baseRecord({
      scenarioId: A10ScenarioId.SensitiveDataPage,
      task: 'My card number is 4111111111111111.',
      privacySelfCheck: { clean: false, rawValueFindings: 1, scannerLines: 1 },
      artifactPath: null,
    });
    const privacyVerdict = evaluateA10Scenario(withFinding, A10_SCENARIO_MATRIX[6]);
    expect(privacyVerdict.kind).toBe('FAIL');
    expect(privacyVerdict.reason).toContain('independent privacy self-check.clean === true');

    // Harness-side privacy scan also detects raw value in artifact text.
    const artifact = buildEmptyArtifact('scan', 'pending');
    artifact.scenarios.length = 0;
    artifact.scenarios.push(withFinding);
    const scanned = scanA10ArtifactPrivacy(artifact);
    expect(scanned.clean).toBe(false);
    expect(scanned.findings.length).toBeGreaterThanOrEqual(1);
    expect(
      scanned.findings.some((f) => f.category === 'rawValue' || f.category === 'privacySelfCheck')
    ).toBe(true);
  });

  it('6. missing required browser evidence -> FAIL', () => {
    const verdict = evaluateA10Scenario(
      baseRecord({ scenarioId: A10ScenarioId.WikipediaInformationLookup, actionCount: 0 }),
      A10_SCENARIO_MATRIX[0],
    );
    expect(verdict.kind).toBe('FAIL');
    expect(verdict.reason).toContain('browser-required scenario has zero actions');
  });

  it('7. missing mandatory valid provider mode -> FAIL (NOT_RUN)', () => {
    // An unknown provider mode must not be treated as executable.
    const bad = baseRecord({
      providerMode: 'UNKNOWN' as A10ScenarioRecord['providerMode'],
      executed: false,
    });
    const verdict = evaluateA10Scenario(bad, A10_SCENARIO_MATRIX[0]);
    // providerMode 'UNKNOWN' is not executable; verdict must not be PASS.
    expect(verdict.kind).not.toBe('PASS');
  });

  it('8. contradictory terminal/result -> FAIL', () => {
    const verdict = evaluateA10Scenario(
      baseRecord({ terminalStatus: 'NEEDS_INFORMATION', goalStatus: 'SATISFIED' }),
      A10_SCENARIO_MATRIX[0],
    );
    expect(verdict.kind).toBe('FAIL');
    expect(verdict.reason).toContain('terminal NEEDS_INFORMATION cannot coexist with goal SATISFIED');
  });

  it('9. correct BLOCKED record -> BLOCKED, not PASS', () => {
    const verdict = evaluateA10Scenario(blockedRecord(), A10_SCENARIO_MATRIX[0]);
    expect(verdict.kind).toBe('BLOCKED');
    expect(verdict.reason).toContain('provider/environment marked BLOCKED — cannot certify PASS');
  });

  it('10. controlled-provider record labelled correctly by contract, not by verdict', () => {
    const rec = baseRecord({ providerMode: 'CONTROLLED_PROVIDER' });
    expect(rec.providerMode).toBe('CONTROLLED_PROVIDER');
    // Verdict should still be PASS when contract satisfied.
    expect(evaluateA10Scenario(rec, A10_SCENARIO_MATRIX[0]).kind).toBe('PASS');
  });

  it('11. live-provider record labelled correctly by contract, not by verdict', () => {
    const rec = baseRecord({ providerMode: 'LIVE_PROVIDER' });
    expect(rec.providerMode).toBe('LIVE_PROVIDER');
    expect(evaluateA10Scenario(rec, A10_SCENARIO_MATRIX[0]).kind).toBe('PASS');
  });

  it('12. no provider/browser claim when not actually run -> NOT_RUN / BLOCKED', () => {
    const rec = blockedRecord({ providerMode: 'NOT_RUN', environmentBlocked: false, executed: false });
    expect(evaluateA10Scenario(rec, A10_SCENARIO_MATRIX[0]).kind).toBe('NOT_RUN');
  });
});

describe('A10 false-success evaluator — artifact level', () => {
  it('artifact with all-PASS scenarios passes', () => {
    const artifact = buildEmptyArtifact();
    artifact.scenarios = [
      baseRecord(),
      baseRecord({
        scenarioId: A10ScenarioId.ProviderFailure,
        terminalStatus: 'PROVIDER_UNAVAILABLE',
        goalStatus: 'NOT_SATISFIED',
      }),
    ];
    const result = evaluateA10Artifact(artifact);
    expect(result.pass).toBe(true);
    expect(result.summary.passed).toBe(2);
    expect(result.summary.failed).toBe(0);
  });

  it('artifact with one false SUCCESS fails', () => {
    const artifact = buildEmptyArtifact();
    artifact.scenarios = [
      baseRecord(),
      baseRecord({
        scenarioId: A10ScenarioId.ProviderFailure,
        terminalStatus: 'SUCCESS',
        goalStatus: 'SATISFIED',
      }),
    ];
    const result = evaluateA10Artifact(artifact);
    expect(result.pass).toBe(false);
    expect(result.summary.failed).toBeGreaterThanOrEqual(1);
  });

  it('artifact with one not-run scenario fails (cannot certify all PASS)', () => {
    const artifact = buildEmptyArtifact();
    artifact.scenarios = [
      baseRecord(),
      { ...baseRecord(), executed: false, providerMode: 'NOT_RUN' },
    ];
    const result = evaluateA10Artifact(artifact);
    expect(result.pass).toBe(false);
    expect(result.summary.notRun).toBeGreaterThanOrEqual(1);
  });

  it('artifact with one blocked scenario fails (cannot certify all PASS)', () => {
    const artifact = buildEmptyArtifact();
    artifact.scenarios = [baseRecord(), blockedRecord()];
    const result = evaluateA10Artifact(artifact);
    expect(result.pass).toBe(false);
    expect(result.summary.blocked).toBeGreaterThanOrEqual(1);
  });
});

describe('A10 scenario matrix contract', () => {
  it('matrix has exactly 10 scenarios', () => {
    expect(A10_SCENARIO_MATRIX).toHaveLength(10);
  });

  it('scenario ids match §14 order', () => {
    const ids = A10_SCENARIO_MATRIX.map((s) => s.id);
    expect(ids).toEqual([
      A10ScenarioId.WikipediaInformationLookup,
      A10ScenarioId.SearchResultInformation,
      A10ScenarioId.MultiPageInformation,
      A10ScenarioId.InfoRequiresScrolling,
      A10ScenarioId.MissingInformation,
      A10ScenarioId.StaleEvidence,
      A10ScenarioId.SensitiveDataPage,
      A10ScenarioId.NavigationAndInformation,
      A10ScenarioId.AmbiguousRequest,
      A10ScenarioId.ProviderFailure,
    ]);
  });

  it('every scenario declares expected terminal set', () => {
    for (const s of A10_SCENARIO_MATRIX) {
      expect(s.expectedTerminalSet.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('provider-failure scenario does not require browser', () => {
    const s = A10_SCENARIO_MATRIX[9];
    expect(s.browserRequired).toBe(false);
  });

  it('cannot mutate the matrix', () => {
    const m = A10_SCENARIO_MATRIX;
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(m[0])).toBe(true);
  });
});

describe('A10 artifact builder', () => {
  it('empty artifact starts all scenarios as NOT_RUN / BLOCKED', () => {
    const artifact = buildEmptyArtifact();
    expect(artifact.scenarios).toHaveLength(10);
    expect(artifact.scenarios.every((s) => s.providerMode === 'NOT_RUN')).toBe(true);
    expect(artifact.scenarios.every((s) => s.environmentBlocked)).toBe(true);
    expect(artifact.scenarios.every((s) => s.executed === false)).toBe(true);
    expect(artifact.summary.notRun).toBe(10);
    expect(artifact.summary.blocked).toBe(0);
  });
});
