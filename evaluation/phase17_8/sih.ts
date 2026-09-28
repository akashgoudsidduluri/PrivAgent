/**
 * PrivAgent — PHASE 17.8 BENCHMARK: the existing PII corpus, re-measured.
 *
 * The perception and redaction pipeline already has a curated, versioned
 * ground-truth dataset — 50 positive PII samples and 25 hard negative controls
 * (`evaluation/datasets/pii_benchmark_dataset.json`) — and a recorded report
 * with micro-averaged precision / recall / F1
 * (`evaluation/reports/sih_evaluation_report.json`).
 *
 * Phase 17.8 does not need new privacy-detection cases; it needs to know whether
 * the pipeline those cases were written against is still where it was. So this
 * module re-runs the identical measurement and compares it to the recorded
 * baseline. The measurement itself is the same DOM-construct → `scanDOM` →
 * `scanForRawSensitiveValues` pipeline the SIH runner uses; it is reproduced
 * here rather than imported because the SIH runner is a standalone script, and
 * importing a script's internals would couple the benchmark to its reporting.
 *
 * `leaked` is the number that matters most and the one the SIH report does not
 * express directly: how many of the synthetic raw values in the corpus the
 * pipeline would have passed through untouched.
 */

import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { scanDOM } from '../../extension/src/privacy/domDetector';
import { scanForRawSensitiveValues } from '../../extension/src/privacy/rawValueScanner';
import { calculatePrecisionRecall, type ConfusionMatrix } from '../../extension/src/telemetry/sihEvaluation';

interface SihCase {
  id: string;
  expectedCategory: string | null;
  text: string;
  context: string;
  tagName: string;
  typeAttr?: string;
}

interface SihDataset {
  positive_cases: SihCase[];
  negative_cases: SihCase[];
}

const CATEGORIES = [
  'password',
  'otp',
  'cvv',
  'pan',
  'account_number',
  'credit_card',
  'email',
  'phone',
  'name',
  'address',
] as const;

export interface SihCorpusResult {
  total: number;
  positives: number;
  negatives: number;
  precision: number;
  recall: number;
  f1: number;
  /**
   * How many raw corpus values the redaction pipeline would NOT have stopped.
   * A non-zero value here is a privacy defect, not a metric trade-off.
   */
  leaked: number;
  /** Values from the recorded SIH report this run must not fall below. */
  baselineRecall: number;
  baselineF1: number;
  perCategory: Array<{ category: string; tp: number; fp: number; fn: number; precision: number; recall: number; f1: number }>;
}

const DATASET = path.resolve(__dirname, '../datasets/pii_benchmark_dataset.json');
const REPORT = path.resolve(__dirname, '../reports/sih_evaluation_report.json');

export function runSihCorpus(): SihCorpusResult {
  const dataset = JSON.parse(fs.readFileSync(DATASET, 'utf8')) as SihDataset;
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8')) as {
    piiBenchmark: { microAverages: { recall: number; f1Score: number } };
  };

  const counts = new Map<string, ConfusionMatrix>(
    CATEGORIES.map((c) => [
      c,
      { truePositives: 0, falsePositives: 0, falseNegatives: 0, trueNegatives: 0 },
    ]),
  );

  let leaked = 0;
  const all: SihCase[] = [...dataset.positive_cases, ...dataset.negative_cases];

  for (const testCase of all) {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    const document = dom.window.document;

    const el = document.createElement(testCase.tagName);
    if (testCase.typeAttr) el.setAttribute('type', testCase.typeAttr);
    if (testCase.context) {
      el.setAttribute('aria-label', testCase.context);
      el.id = testCase.id;
    }
    if (el instanceof dom.window.HTMLInputElement) el.value = testCase.text;
    else el.textContent = testCase.text;
    document.body.appendChild(el);

    const domReport = scanDOM(document);
    const rawViolations = scanForRawSensitiveValues({ field: testCase.text });

    // A positive case whose raw value the structured scanner does not flag is a
    // value that would have travelled onward. Counted, never tolerated.
    if (testCase.expectedCategory && rawViolations.length === 0 && domReport.detections.length === 0) {
      leaked++;
    }

    const detectedTypes = new Set<string>();
    for (const d of domReport.detections) {
      if (d.type === 'person_name') detectedTypes.add('name');
      else detectedTypes.add(d.type);
    }
    for (const v of rawViolations) {
      if (['credit_card', 'email', 'phone', 'pan', 'account_number', 'password', 'otp', 'cvv'].includes(v.rule)) {
        detectedTypes.add(v.rule);
      }
    }

    for (const cat of CATEGORIES) {
      const isDetected = detectedTypes.has(cat);
      const isExpected = testCase.expectedCategory === cat;
      const cell = counts.get(cat)!;
      if (isExpected && isDetected) cell.truePositives++;
      else if (!isExpected && isDetected) cell.falsePositives++;
      else if (isExpected && !isDetected) cell.falseNegatives++;
      else cell.trueNegatives = (cell.trueNegatives ?? 0) + 1;
    }
  }

  let tp = 0;
  let fp = 0;
  let fn = 0;
  const perCategory = CATEGORIES.map((cat) => {
    const cell = counts.get(cat)!;
    tp += cell.truePositives;
    fp += cell.falsePositives;
    fn += cell.falseNegatives;
    const pr = calculatePrecisionRecall(cell);
    return {
      category: cat,
      tp: cell.truePositives,
      fp: cell.falsePositives,
      fn: cell.falseNegatives,
      precision: pr.precision,
      recall: pr.recall,
      f1: pr.f1Score,
    };
  });

  const micro = calculatePrecisionRecall({ truePositives: tp, falsePositives: fp, falseNegatives: fn });

  return {
    total: all.length,
    positives: dataset.positive_cases.length,
    negatives: dataset.negative_cases.length,
    precision: micro.precision,
    recall: micro.recall,
    f1: micro.f1Score,
    leaked,
    baselineRecall: report.piiBenchmark.microAverages.recall,
    baselineF1: report.piiBenchmark.microAverages.f1Score,
    perCategory,
  };
}
