/**
 * G7 design validation — does a COMPOUND goal produce extra verifiable
 * subgoals? If yes, a destination-success branch must require that no other
 * subgoal with a verification condition is outstanding.
 */
import { describe, it } from 'vitest';
import { decomposeTask } from '../extension/src/hierarchicalPlanning';

const TASKS = [
  'open the store catalog',
  'open the store catalog and buy the first item',
  'go to the account settings page',
  'find my profile page and update my address',
];

describe('G7 destination-branch design validation', () => {
  it('shows verification conditions per subgoal for each goal shape', () => {
    for (const t of TASKS) {
      const d = decomposeTask(t, { currentUrl: 'http://localhost:4174/' });
      console.info(
        `[design] "${t}" =>`,
        JSON.stringify(
          d.subgoals.map((s) => ({
            id: s.id.split('-').pop(),
            cat: s.category,
            cond: (s as any).verificationCondition?.type ?? null,
            dest: (s as any).destination?.kind ?? null,
          })),
        ),
      );
    }
  });
});
