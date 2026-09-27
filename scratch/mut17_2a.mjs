/**
 * PHASE 17.2A — mutation harness.
 *
 * Reintroduces each fabrication the remediation removed, one at a time, so the
 * regression tests can be shown to actually CATCH it. Every anchor must match
 * EXACTLY ONCE or the script aborts rather than corrupting a file. `restore`
 * puts every touched file back byte-for-byte and deletes the backups.
 *
 *   node scratch/mut17_2a.mjs apply  M1|M2|M3|M4
 *   node scratch/mut17_2a.mjs restore M1|M2|M3|M4
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';

const GV = 'extension/src/agent/goalVerifier.ts';
const LOOP = 'extension/src/agent/agentLoop.ts';
const SM = 'extension/src/hierarchicalPlanning/planStateMachine.ts';

const MUTATIONS = {
  // M1 — the original banking fabrication: >=3 dispatched actions including a
  // click and a scroll were reported as verification of transaction history.
  M1: [
    {
      file: GV,
      find: '    const observedLedger = (context.detections ?? []).some((d) => {',
      replace: `    const hasClicked = state.previousActions.some((a) => a.action === 'click');
    const hasScrolled = state.previousActions.some((a) => a.action === 'scroll');
    if (state.previousActions.length >= 3 && hasClicked && hasScrolled) {
      return {
        satisfied: true,
        status: 'SUCCESS',
        reason: 'Navigated to and verified recent account transaction history.',
      };
    }
    const observedLedger = (context.detections ?? []).some((d) => {`,
    },
  ],

  // M2 — the requested destination written back into the observed tab URL at
  // the post-navigation settle site.
  M2: [
    {
      file: LOOP,
      find: '          advancePageGeneration(this.state);\n        }\n      }\n\n      // Check immediate completion',
      replace: '          advancePageGeneration(this.state, action.url);\n        }\n      }\n\n      // Check immediate completion',
    },
  ],

  // M3 — dispatch success treated as goal evidence in the research branch.
  M3: [
    {
      file: GV,
      find: '      if (step.url) observedUrls.add(step.url);\n    }',
      replace: `      if (step.url) observedUrls.add(step.url);
    }
    if (state.steps.length > 0 && state.steps.every((s) => s.executionSuccess)) {
      return {
        satisfied: true,
        status: 'SUCCESS',
        reason: 'All requested navigation steps executed successfully.',
      };
    }`,
    },
  ],

  // M4 — the second DISPATCH SUCCESS != GOAL SUCCESS location, restored as it
  // originally existed across BOTH sites: the loop ORs the subgoal DAG's
  // dispatch-derived completion into goal verification, and the state machine
  // announces either cause as 'Goal verified and satisfied'.
  M4: [
    {
      file: LOOP,
      find:
        '        if (goalVerified) {\n' +
        '          this.planStateMachine.registerGoalVerification(true, true);\n' +
        '          this.state.planningEngineState = this.planStateMachine.getState();\n' +
        '        } else if (allDone) {',
      replace:
        '        if (allDone || goalVerified) {\n' +
        '          this.planStateMachine.registerGoalVerification(true, true);\n' +
        '          this.state.planningEngineState = this.planStateMachine.getState();\n' +
        '        } else if (false) {',
    },
    {
      file: SM,
      find: `    if (goalSatisfied) {
      this.transitionTo('COMPLETED', 'Goal verified from observed state and satisfied');
    } else if (allSubgoalsDone) {
      this.transitionTo('COMPLETED', 'All subgoals dispatched; goal NOT verified by observation');
    } else {`,
      replace: `    if (goalSatisfied || allSubgoalsDone) {
      this.transitionTo('COMPLETED', 'Goal verified and satisfied');
    } else {`,
    },
  ],
};

const [, , mode, id] = process.argv;
const edits = MUTATIONS[id];
if (!edits) {
  console.error('usage: mut17_2a.mjs apply|restore M1|M2|M3|M4');
  process.exit(2);
}

const bakOf = (f) => `${f}.mutbak`;

if (mode === 'apply') {
  // Verify every anchor BEFORE touching anything.
  for (const e of edits) {
    if (existsSync(bakOf(e.file))) {
      console.error(`ABORT: ${bakOf(e.file)} already exists; restore first`);
      process.exit(1);
    }
    const hits = readFileSync(e.file, 'utf8').split(e.find).length - 1;
    if (hits !== 1) {
      console.error(`ABORT: anchor for ${id} in ${e.file} matched ${hits} times, expected exactly 1`);
      process.exit(1);
    }
  }
  for (const e of edits) {
    const src = readFileSync(e.file, 'utf8');
    writeFileSync(bakOf(e.file), src);
    writeFileSync(e.file, src.replace(e.find, e.replace));
    console.log(`APPLIED ${id} -> ${e.file}`);
  }
} else if (mode === 'restore') {
  for (const e of edits) {
    const bak = bakOf(e.file);
    if (!existsSync(bak)) {
      console.error(`ABORT: ${bak} missing`);
      process.exit(1);
    }
    writeFileSync(e.file, readFileSync(bak, 'utf8'));
    unlinkSync(bak);
    console.log(`RESTORED ${e.file}`);
  }
} else {
  console.error('usage: mut17_2a.mjs apply|restore M1|M2|M3|M4');
  process.exit(2);
}
