/**
 * Merges the end-to-end production record (Test D) and the unit-scenario table
 * into bfcache_navigation_evidence.json, alongside the raw real-Chrome
 * observation the probe already wrote. Nothing here judges anything: it only
 * puts the three sources side by side.
 */

import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DIR = path.join(REPO_ROOT, 'docs', 'evidence', 'phase16-remediation');
const BFC = path.join(DIR, 'bfcache_navigation_evidence.json');
const REAL = path.join(DIR, 'real_chrome_evidence.json');

const bfc = JSON.parse(fs.readFileSync(BFC, 'utf8'));
const real = JSON.parse(fs.readFileSync(REAL, 'utf8'));
const d = (real.tests || []).find((t) => t.key === 'D');

bfc.endToEndProductionRecord = d
  ? {
      test: 'D — a real agent navigation through the production path',
      task: d.task,
      startUrl: d.startUrl,
      fixtureClass: d.fixtureClass,
      terminalStatus: d.terminalStatus,
      goalStatus: d.goalStatus,
      terminalReason: d.terminalReason,
      reasoner: 'REAL (groq)',
      steps: d.actions,
      tabUrlBefore: d.observedBefore?.href ?? null,
      tabUrlAfter: d.observedAfter?.href ?? null,
      observedPageBodyAfter: String(d.observedAfter?.bodyText ?? '').slice(0, 300),
      effectVerification: d.consistency,
      goalVerification: d.goalVerification,
      note:
        'The navigate action crossed a real document swap. The content script was torn down for that window; the post-action snapshot was still produced, from chrome.tabs, and the effect verifier reported URL_NAVIGATION_OBSERVED with the real URL transition instead of ACTION_NO_EFFECT. The run did NOT claim SUCCESS from the URL change — goal verification still refused to call the task done, and the run ended on an unrelated reasoner outage.',
    }
  : { error: 'Test D record not present in real_chrome_evidence.json' };

bfc.unitScenarios = {
  suite: 'tests/phase16-remediation/navigationObservation.test.ts',
  note: 'These drive the production effect verifier and the production snapshot contract over simulated chrome.tabs / content-script states. They are listed with the behaviour they pin, not as a substitute for the real-Chrome record above.',
  scenarios: [
    'normal navigation',
    'navigation where the content script is unavailable during the transition',
    'bfcache-like lifecycle',
    'authoritative chrome.tabs URL differs from a stale content-script URL',
    'genuine navigation failure',
    'cross-origin navigation',
    'containment remains enforced',
    'ACTION_NO_EFFECT is still emitted when navigation genuinely did not happen',
  ],
};

bfc.securityInvariants = [
  'A URL change establishes an OBSERVED EFFECT only. It never establishes task SUCCESS — goal verification still decides.',
  'When neither chrome.tabs nor the page yields a URL, the snapshot is null and the loop fails closed. No value is invented.',
  'Page-side geometry (scroll, DOM counts, modal counts) is NOT fabricated when the page cannot be read; pageStateObservable: false marks the reading as tab-only, and the effect verifier refuses to derive a DOM effect from it.',
  'No second target-state system was introduced. chrome.tabs plus the content script remain the only two sources, exactly as before.',
  'Cross-origin navigation and containment are untouched: containment still evaluates at the dispatch boundary and still refuses off-scope targets.',
];

fs.writeFileSync(BFC, JSON.stringify(bfc, null, 2));
console.log('merged →', path.relative(REPO_ROOT, BFC));
console.log(JSON.stringify({
  contentScriptUnavailableObserved: bfc.observedContentScriptUnavailableAtAnyPoint,
  endToEndNavigationObserved: bfc.endToEndProductionRecord?.effectVerification?.navigationObserved,
  actionNoEffectReported: bfc.endToEndProductionRecord?.effectVerification?.actionNoEffectReported,
  consistencyPasses: bfc.endToEndProductionRecord?.effectVerification?.passes,
}, null, 1));
