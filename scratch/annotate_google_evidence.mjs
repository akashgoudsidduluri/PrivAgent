/**
 * Annotates the Google record with the two facts the Phase 16 brief asked to be
 * distinguished, and records the superseded earlier attempts rather than
 * dropping them.
 */

import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const F = path.join(REPO_ROOT, 'docs', 'evidence', 'phase16-remediation', 'real_chrome_evidence.json');
const d = JSON.parse(fs.readFileSync(F, 'utf8'));
const b = (d.tests || []).find((t) => t.key === 'B');
if (!b) { console.log('no B record'); process.exit(0); }

const body = String(b.observedAfter?.bodyText ?? '');
const antiBot = /detected unusual traffic|not a robot|\/sorry\/index/i.test(body) || String(b.observedUrl ?? '').includes('/sorry/index');

b.googleInterstitial = {
  observed: antiBot,
  url: b.observedUrl,
  pageText: body.slice(0, 300),
  notBypassed:
    'Google\'s anti-bot interstitial was NOT bypassed, worked around, or retried against. The agent typed the query and submitted; Google served the interstitial; the run stopped there. No proxy, cookie injection, user-agent change, or manual navigation was used.',
  recordedSeparately:
    'This is a property of the OPEN WEB, not of the agent. It is recorded here so it is never mistaken for an agent capability result.',
};

b.distinctionTheBriefAskedFor = {
  searchActionExecuted: true,
  searchActionEvidence: b.actions
    .filter((a) => a.proposedAction?.action === 'type' || a.proposedAction?.action === 'pressKey')
    .map((a) => ({
      action: a.proposedAction.action,
      text: a.proposedAction.text ?? null,
      validationAllowed: a.validationAllowed,
      effectStatus: a.effectStatus,
    })),
  googleResultsSuccessfullyLoaded: false,
  whyNot:
    antiBot
      ? 'Google served its anti-bot interstitial ("Our systems have detected unusual traffic from your computer network"), so no results page was ever rendered. The typed value WAS a real observed effect (VALUE_STATE_CHANGED); the results were NOT.'
      : 'No results page was observed. The typed value was a real observed effect; a search RESULT is not.',
  productionVerdict: { terminalStatus: b.terminalStatus, goalStatus: b.goalStatus, reason: b.terminalReason },
  verdictIsCorrect:
    'The production pipeline refused to call this a success. A typed query that was never submitted into a results page is not a completed search, and the goal verifier said so.',
};

b.earlierAttemptsSuperseded = (d.supersededRecords || [])
  .filter((s) => s.key === 'B')
  .map((s) => ({
    startedAt: s.startedAt,
    terminalStatus: s.terminalStatus,
    terminalReason: s.terminalReason,
    actions: (s.actions || []).map((a) => `${a.proposedAction?.action}:${a.effectStatus}`),
    observedUrl: s.observedUrl,
    supersededBy: s._supersededBy,
  }));

b.alsoRecorded = {
  injectionInfluenceBlocks: b.injectionInfluenceBlocks,
  blockedBecauseModelSaidNavigateTo: b.blockedBecauseModelSaidNavigateTo,
  note: 'DEFECT 1: on a live open-web page, not one action was refused because the model narrated its own plan as page injection.',
};

fs.writeFileSync(F, JSON.stringify(d, null, 2));
console.log(JSON.stringify({
  antiBotObserved: b.googleInterstitial.observed,
  searchActionExecuted: b.distinctionTheBriefAskedFor.searchActionExecuted,
  resultsLoaded: b.distinctionTheBriefAskedFor.googleResultsSuccessfullyLoaded,
  verdict: b.terminalStatus,
  injectionInfluenceBlocks: b.injectionInfluenceBlocks,
}, null, 1));
