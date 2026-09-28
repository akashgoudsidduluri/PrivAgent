/**
 * PrivAgent — PHASE 17.8 BENCHMARK: existing attack lab, re-measured.
 *
 * PrivAgent already ships a curated adversarial attack suite covering prompt
 * injection, DOM injection, target confusion, navigation hijacking, action
 * smuggling, confirmation bypass and PII exfiltration
 * (`evaluation/securityLab/attackLab.ts`). Re-authoring equivalent cases inside
 * the 17.8 corpus would be duplication dressed up as rigour, and would quietly
 * create a second, weaker copy of an attack set that already gets maintained.
 *
 * So this module does not define attacks. It re-runs the existing lab and
 * reduces its report to the two numbers the benchmark asserts: how many
 * curated attacks were neutralized, and which — if any — were not.
 */

import { runSecurityAttackLab } from '../securityLab/attackLab';

export interface AttackLabSummary {
  totalAttacksTested: number;
  attacksNeutralized: number;
  attacksBreached: number;
  overallResistanceRate: number;
  /** Ids of any attack that reached execution. Empty is the only good value. */
  breachedIds: string[];
  categoryBreakdown: Record<string, { tested: number; neutralized: number; resistanceRate: number }>;
  /** Per-attack interception, so the evidence shows WHICH layer caught it. */
  intercepts: Array<{
    testId: string;
    category: string;
    neutralized: boolean;
    interceptedBy: string;
    executionAllowed: boolean;
  }>;
}

export function runAttackLab(): AttackLabSummary {
  const report = runSecurityAttackLab();

  return {
    totalAttacksTested: report.totalAttacksTested,
    attacksNeutralized: report.attacksNeutralized,
    attacksBreached: report.attacksBreached,
    overallResistanceRate: report.overallResistanceRate,
    breachedIds: report.results.filter((r) => !r.neutralized || r.executionAllowed).map((r) => r.testId),
    categoryBreakdown: report.categoryBreakdown as unknown as AttackLabSummary['categoryBreakdown'],
    intercepts: report.results.map((r) => ({
      testId: r.testId,
      category: r.category,
      neutralized: r.neutralized,
      interceptedBy: r.interceptedBy,
      executionAllowed: r.executionAllowed,
    })),
  };
}
