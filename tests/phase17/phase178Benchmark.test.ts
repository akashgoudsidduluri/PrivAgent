/**
 * PrivAgent — PHASE 17.8 BENCHMARK.
 *
 * WHAT THIS FILE IS
 * ─────────────────
 * A deterministic, labelled benchmark over the agent's decision AUTHORITIES.
 * It answers seven questions:
 *
 *   1. Does each security authority make the expected decision?
 *   2. Does the system fail closed on malformed, stale, ambiguous, unreadable,
 *      unsafe or unverifiable state?
 *   3. Can any action reach dispatch when an earlier authority should have
 *      rejected it?
 *   4. Can an action, subgoal or goal become SUCCESS without observation-backed
 *      evidence?
 *   5. Are privacy and egress guarantees preserved?
 *   6. Are recovery and self-healing still bounded and safe?
 *   7. What is genuinely proven versus NOT_PROVEN?
 *
 * HOW IT IS BUILT
 * ───────────────
 * Existing infrastructure, reused rather than replaced: vitest as the runner,
 * the real production authorities as the things under test, and the existing
 * `evaluation/` tree as the home for datasets and harnesses. The corpus
 * (`evaluation/phase17_8/corpusA.ts`, `corpusB.ts`) is data; the adapter
 * (`authorities.ts`) only calls production functions. No gate logic is
 * reimplemented here, so the benchmark cannot agree with itself by accident.
 *
 * WHAT IS ASSERTED, AND WHY IT IS NOT ALL THE SAME ASSERTION
 * ──────────────────────────────────────────────────────────
 * A benchmark that simply refused everything would score 100% and be worthless,
 * so the suite is built to FAIL in both directions:
 *
 *   • a single FALSE ALLOW fails the suite outright — an authority permitting
 *     something the corpus says must be refused is a security event;
 *   • a single FALSE BLOCK on a CONTROL case also fails the suite — a system
 *     that cannot act is not safe, it is broken, and a benchmark unable to
 *     tell those apart is measuring nothing.
 *
 * The gates below are ordered so the most serious class of failure is reported
 * first and the least serious never masks it.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { BENCHMARK_CORPUS } from '../../evaluation/phase17_8/corpus';
import { runCase, aggregate, confusionOf } from '../../evaluation/phase17_8/authorities';
import { runDispatchReachabilityProbes, type ReachabilityProbe } from '../../evaluation/phase17_8/reachability';
import { AUTHORITY_IDS, CATEGORY_TITLES } from '../../evaluation/phase17_8/types';
import { ctx, det, ocrObs } from '../../evaluation/phase17_8/fixtures';
import type { AggregateResult, CaseOutcome } from '../../evaluation/phase17_8/types';
import { calculateLatencyDistribution } from '../../extension/src/telemetry/sihEvaluation';
import { runAttackLab } from '../../evaluation/phase17_8/attacklab';
import { runSihCorpus } from '../../evaluation/phase17_8/sih';
import { measureEgress } from '../../evaluation/phase17_8/egress';

const OUT_DIR = path.resolve(__dirname, '../../docs/evidence/phase17/17.8-benchmark');

let outcomes: CaseOutcome[] = [];
let agg: AggregateResult = {} as AggregateResult;
let probes: ReachabilityProbe[] = [];
let attack: ReturnType<typeof runAttackLab>;
let sih: ReturnType<typeof runSihCorpus>;

let egress: Awaited<ReturnType<typeof measureEgress>>;
let benchmarkRuntimeMs = 0;

const byId = (id: string) => outcomes.find((o) => o.id === id)!;
const failures = () => outcomes.filter((o) => !o.pass);

beforeAll(async () => {
  const t0 = performance.now();
  outcomes = BENCHMARK_CORPUS.map(runCase);
  agg = aggregate(BENCHMARK_CORPUS, outcomes);
  // The reachability probes drive a real AgentLoop, so they are async. They
  // run exactly once here; every assertion below reads that single execution.
  probes = await runDispatchReachabilityProbes();
  attack = runAttackLab();
  sih = runSihCorpus();
  // The F-08 egress regression is a property of the serialized request body,
  // which means an intercepted `fetch` and therefore an async measurement. It
  // runs against the REAL `BackendAgentProvider`, not against a copy of the
  // line that strips the field.
  egress = await measureEgress(
    ctx({
      url: 'https://shop.example/checkout',
      detections: [det('btn-help', 'button', { label: 'Help centre' })],
      total_elements_scanned: 1,
      ocr_observation: ocrObs(),
      viewportObservable: true,
      viewportSource: 'CONTENT_SCRIPT',
    }),
  );
  benchmarkRuntimeMs = Number((performance.now() - t0).toFixed(1));
});

/**
 * Latency, reported per AUTHORITY rather than as one blended number.
 *
 * A single aggregate would be meaningless here: the authorities are pure
 * in-process functions with wildly different costs, and averaging them would
 * hide both. The distributions come from the per-case timings the adapter
 * already records, so no new instrumentation was added for this.
 */
const perfFor = (authority: string) =>
  calculateLatencyDistribution(outcomes.filter((o) => o.authority === authority).map((o) => o.latencyMs));

// ═══════════════════════════════════════════════════════════════════════════
// 1 — CORPUS INTEGRITY
//
// A benchmark that is quietly drifting into "test whatever the code does" is
// the failure mode this project has already paid for once, in mutation testing.
// These checks make that failure loud.
// ═══════════════════════════════════════════════════════════════════════════

describe('17.8 · corpus integrity', () => {
  it('every case id is unique and every category A–J is populated', () => {
    const ids = outcomes.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const cat of Object.keys(CATEGORY_TITLES)) {
      const inCat = outcomes.filter((o) => o.category === cat);
      expect(inCat.length, `category ${cat} has no cases`).toBeGreaterThan(0);
    }
  });

  it('every authority in the taxonomy is exercised by at least one case', () => {
    const exercised = new Set(outcomes.map((o) => o.authority));
    for (const a of AUTHORITY_IDS) {
      expect(exercised.has(a), `authority ${a} is declared but never exercised`).toBe(true);
    }
  });

  it('every blocking rule has a control, so the benchmark cannot pass by refusing everything', () => {
    const controls = outcomes.filter((o) => !o.adversarial);
    // A corpus with fewer than a third controls would be scoring refusals, not
    // decisions. The precise number matters less than it being substantial.
    expect(controls.length / outcomes.length).toBeGreaterThan(0.3);
  });

  it('carries no case whose expectation is unspecified', () => {
    for (const c of BENCHMARK_CORPUS) {
      expect(c.expectation.verdict, `${c.id} has no expected verdict`).toBeTruthy();
      expect(c.rationale.length, `${c.id} has no rationale`).toBeGreaterThan(20);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 — THE SECURITY ASSERTION
//
// Deliberately first and deliberately singular. Everything below it is
// commentary on top of this number.
// ═══════════════════════════════════════════════════════════════════════════

describe('17.8 · security assertion', () => {
  it('ZERO false allows: no authority permits anything the corpus says must be refused', () => {
    const falseAllows = outcomes.filter((o) => o.falseAllow);
    expect(
      falseAllows.map((o) => `${o.id} (${o.authority}) expected ${o.expectedVerdict}, got ${o.actualVerdict}`),
      'FALSE ALLOW — an authority permitted something that must be refused',
    ).toEqual([]);
  });

  it('no fabricated goal SUCCESS: category J never produced SUCCESS from a non-authoritative signal', () => {
    const fabricated = outcomes.filter(
      (o) => o.category === 'J' && o.actualVerdict === 'SUCCESS' && !o.adversarial === false,
    );
    expect(fabricated.map((o) => o.id)).toEqual([]);
  });

  it('no fabricated effect: no effect case reported an observed effect it could not have observed', () => {
    const fabricated = agg.effectSuccessFabricationCount;
    expect(fabricated).toBe(0);
  });

  it('no privacy leakage, no containment bypass, no recovery gate bypass', () => {
    expect(agg.privacyLeakageCount).toBe(0);
    expect(agg.containmentBypassCount).toBe(0);
    expect(agg.recoveryGateBypassCount).toBe(0);
    expect(agg.goalSuccessFabricationCount).toBe(0);
  });

  it('every adversarial proposal was withheld in a real AgentLoop, and only the documented cases dispatched', () => {
    // Asserting "nothing dispatched" would also be satisfied by a loop that
    // dispatches nothing at all. Each probe therefore declares what the
    // documented design expects, and the benchmark checks dispatch against
    // THAT. Two probes are expected to dispatch: R8 (no scope configured, a
    // documented delegation to the host) and R9 (the benign in-scope control).
    const wrong =
      probes
        .filter((p) => p.dispatched !== p.expectedDispatch)
        .map(
          (p) =>
            `${p.id} (${p.authority}) dispatched=${p.dispatched}, design expects ${p.expectedDispatch} — ${p.title}`,
        );
    expect(wrong, 'A proposal reached executeAction against the documented design').toEqual([]);
    expect(probes.length).toBeGreaterThan(0);
  });

  it('a successful dispatch completed no subgoal', () => {
    // The loop-level subgoal gate. This is a separate assertion from dispatch
    // because the two are independent: a loop that dispatched nothing would
    // trivially complete no subgoal. The precondition is that this action DID
    // dispatch, which the probe declares.
    const p = probes.find((x) => x.id === 'R14');
    expect(p, 'R14 subgoal probe is missing').toBeDefined();
    expect(p!.expectedCompletedSubgoals).toBe(0);
    expect(
      p!.completedSubgoals,
      'a subgoal was completed from dispatch state, with no observation-backed evidence',
    ).toBe(0);
  });

  it('CONTROL: the in-scope benign action really did dispatch, so the probes are not vacuous', () => {
    const control = probes.find((p) => p.id === 'R9');
    expect(control, 'R9 control probe is missing').toBeDefined();
    expect(control!.dispatched, 'the control probe never dispatched — the probe set proves nothing').toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 — THE USABILITY ASSERTION
//
// Symmetric with the above, and just as load-bearing. A privacy agent that
// cannot complete an ordinary checkout has not solved the problem.
// ═══════════════════════════════════════════════════════════════════════════

describe('17.8 · every case matches its expected verdict', () => {
  it('no case failed at all', () => {
    expect(
      failures().map(
        (o) => `${o.id} (${o.authority}) expected ${o.expectedVerdict}, got ${o.actualVerdict} — ${o.title}`,
      ),
    ).toEqual([]);
  });

  it('every control case was genuinely allowed through, not accidentally passed', () => {
    const wronglyBlocked = outcomes.filter((o) => o.falseBlock);
    expect(wronglyBlocked.map((o) => `${o.id} (${o.authority}) blocked a legitimate case`)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 — PER-AUTHORITY RESULTS
// ═══════════════════════════════════════════════════════════════════════════

describe('17.8 · per-authority results', () => {
  it('reports one row per authority with the full decision breakdown', () => {
    expect(agg.byAuthority.length).toBeGreaterThan(0);
    for (const a of agg.byAuthority) {
      expect(a.casesExercised).toBeGreaterThan(0);
      expect(a.correctDecisions + a.incorrectDecisions).toBe(a.casesExercised);
      expect(a.falseAllows).toBe(0);
      expect(a.confusion.tp + a.confusion.tn + a.confusion.fp + a.confusion.fn).toBe(a.casesExercised);
    }
  });

  it('every fail-closed case failed closed', () => {
    const bad = outcomes.filter((o) => o.failClosedCorrect === false);
    expect(bad.map((o) => `${o.id} (${o.authority}) refused without failing closed`)).toEqual([]);
  });

  it('does not report a perfect precision on an empty positive set', () => {
    // A metric that reads 1.0 because nothing was tested is worse than no
    // metric. Where the denominator is zero the value must be null.
    for (const a of agg.byAuthority) {
      const c = a.confusion;
      if (c.tp + c.fp === 0) expect(c.precision, `${a.authority} precision on an empty set`).toBeNull();
      if (c.tp + c.fn === 0) expect(c.recall, `${a.authority} recall on an empty set`).toBeNull();
    }
    expect(confusionOf(0, 5, 0, 0).precision).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 — REUSED INFRASTRUCTURE
//
// The privacy pipeline already has a curated 75-case corpus and an attack lab.
// Re-running them is the measurement; re-authoring equivalent cases would be
// duplication dressed up as rigour.
// ═══════════════════════════════════════════════════════════════════════════

describe('17.8 · existing infrastructure, re-measured', () => {
  it('the security attack lab neutralized every curated attack vector', () => {
    expect(attack.totalAttacksTested).toBeGreaterThan(0);
    expect(attack.attacksBreached, `breached: ${attack.breachedIds.join(', ')}`).toBe(0);
    expect(attack.attacksNeutralized).toBe(attack.totalAttacksTested);
  });

  it('the SIH PII corpus is re-measured with no regression against its recorded baseline', () => {
    expect(sih.total).toBe(75);
    expect(sih.leaked).toBe(0);
    // Recall must not silently drop. The corpus is 50 positives.
    expect(sih.recall).toBeGreaterThanOrEqual(sih.baselineRecall);
  });

  it('the wire payload is still USEFUL, not merely empty', () => {
    // A privacy check that is satisfied by sending nothing would be trivially
    // passing. The sanitized metadata the reasoner needs must still be there,
    // and no raw value may have ridden along with it.
    expect(egress.body, 'the wire body was empty — the check below would be vacuous').not.toBe('');
    expect(egress.body).toContain('"detections"');
    expect(egress.body).toContain('btn-help');
    expect(egress.body).not.toContain('4111111111111111');
  });

  it('F-08: no local-only observation block crosses the egress boundary', () => {
    // The Phase 17.6 F-08 condition. A payload carrying `ocr_observation` was
    // rejected by the backend's extra="forbid" schema with HTTP 422, so the
    // loop failed closed at step 1 and the real reasoner was unreachable
    // through the product path. The measurement is on the serialized bytes the
    // provider actually builds.
    expect(egress.captured, 'the provider request was never intercepted — nothing was measured').toBe(true);
    expect(
      egress.present,
      'a local-only field crossed the wire: ' + egress.present.join(', '),
    ).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 — THE ARTIFACT
//
// Written from the same objects the assertions above consumed, so the published
// JSON cannot disagree with the test run that produced it.
// ═══════════════════════════════════════════════════════════════════════════

describe('17.8 · evidence artifact', () => {
  it('writes benchmark_results.json from the run that just passed', () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const payload = {
      phase: '17.8',
      title: 'Benchmark / Evaluation — authority benchmark',
      deterministic: true,
      producedBy: 'tests/phase17/phase178Benchmark.test.ts',
      corpus: {
        totalCases: agg.totalCases,
        byCategory: agg.byCategory,
        controls: outcomes.filter((o) => !o.adversarial).length,
        adversarial: outcomes.filter((o) => o.adversarial).length,
      },
      aggregate: agg,
      performance: {
        benchmarkRuntimeMs,
        note:
          'Per-case wall-clock for the local decision path, measured with performance.now() around the real authority call. No artificial delay is used anywhere: the whole corpus is synchronous in-process evaluation.',
        byAuthority: Object.fromEntries(AUTHORITY_IDS.map((a) => [a, perfFor(a)])),
        overall: calculateLatencyDistribution(outcomes.map((o) => o.latencyMs)),
      },
      authorityResults: agg.byAuthority,
      dispatchReachability: probes,
      securityAttackLab: attack,
      sihPiiCorpus: sih,
      egressBoundary: {
        captured: egress.captured,
        localOnlyFieldsPresent: egress.present,
        verdict: egress.present.length === 0 ? 'NO_LEAK' : 'EGRESS_LEAK',
      },
      cases: outcomes,
    };
    fs.writeFileSync(
      path.join(OUT_DIR, 'benchmark_results.json'),
      `${JSON.stringify(payload, null, 2)}\n`,
      'utf8',
    );
    expect(fs.existsSync(path.join(OUT_DIR, 'benchmark_results.json'))).toBe(true);
  });

  it('records latency for every decision it made', () => {
    // A benchmark that reports no timings cannot be reproduced or compared, and
    // a latency that silently failed to record would read as a fast gate.
    expect(outcomes.every((o) => typeof o.latencyMs === 'number' && o.latencyMs >= 0)).toBe(true);
    expect(benchmarkRuntimeMs).toBeGreaterThan(0);
  });

  it('keeps spot-checked per-case records for the security-critical authorities', () => {
    // The evidence must be legible enough to audit, not just a number.
    for (const id of ['A3', 'B2', 'C5', 'E3', 'F4', 'G3', 'J1', 'I5', 'H2']) {
      const o = byId(id);
      expect(o, `${id} missing`).toBeDefined();
      expect(o.expectedVerdict).toBeTruthy();
      expect(o.actualVerdict).toBeTruthy();
      expect(o.rationale.length).toBeGreaterThan(20);
    }
  });
});
