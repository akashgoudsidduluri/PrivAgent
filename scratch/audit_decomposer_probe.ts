/**
 * AUDIT PROBE (scratch, not production) — hierarchicalPlanning/taskDecomposer.ts
 * with the EXACT task from the real-browser run.
 *
 * No provider budget, no browser, no network.
 */
import { decomposeTask } from '../extension/src/hierarchicalPlanning/taskDecomposer';

const TASK = 'open the store catalog at http://localhost:4174 and open the first product listed';

function show(label: string, prompt: string) {
  const r = decomposeTask(prompt, { currentUrl: 'http://localhost:4174/' } as any);
  console.log(`\n--- ${label} ---`);
  console.log('  prompt    :', JSON.stringify(prompt));
  console.log('  category  :', (r as any).category ?? r.taskCategory ?? '(see keys)');
  console.log('  entities  :', JSON.stringify((r as any).targetEntities));
  console.log('  constraints:', JSON.stringify((r as any).constraints));
  for (const s of (r as any).subgoals ?? []) {
    console.log(`    ${s.category.padEnd(9)} | ${s.description} | targetEntity=${JSON.stringify(s.targetEntity ?? null)}`);
  }
}

console.log('keys of decomposeTask result:', Object.keys(decomposeTask(TASK, { currentUrl: 'http://localhost:4174/' } as any)).join(', '));
show('REAL TASK', TASK);
show('control: no URL in the prompt', 'open the store catalog and open the first product listed');
show('control: explicit quoted product', 'open the store catalog and open the first product "Alpha Widget" listed');
show('control: unrelated read task', 'report the page title on http://localhost:4174');
