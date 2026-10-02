/**
 * AUDIT PROBE (scratch, not production) — static/deterministic half of the
 * "wasted reasoning cycles after a navigation" audit.
 *
 * Answers, with no provider budget spent:
 *   Q3  what subgoals does the task actually decompose into?
 *   Q14 does the reasoner receive page identity (url/title/headings)?
 *   Q7  is the reasoner given a semantically ambiguous page representation?
 *
 * No network, no mocks of the reasoner, no browser.
 */
import { parseUserGoal } from '../extension/src/agent/goalParser';

const TASK = 'open the store catalog at http://localhost:4174 and open the first product listed';

const parsed = parseUserGoal(TASK);
console.log('=== parseUserGoal ===');
console.log('normalizedGoal :', JSON.stringify(parsed.normalizedGoal));
console.log('subgoals       :', JSON.stringify(parsed.subgoals, null, 1));
console.log('constraints    :', JSON.stringify(parsed.constraints));
console.log('keys           :', Object.keys(parsed).join(', '));

// What the loop would hand the provider as `task`.
console.log('\n=== task string the provider receives ===');
console.log(JSON.stringify(TASK));
