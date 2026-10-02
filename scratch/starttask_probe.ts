/**
 * AUDIT PROBE (scratch, not production) — replays the exact START_TASK inputs
 * against the real resolver to identify the branch that yields
 *   status=FAILED, currentStep=0, Target Tab=— .
 *
 * No reasoner, no Chrome: pure deterministic resolver replay.
 */
import {
  resolveTargetWebTab,
  isEligibleWebTab,
  parseTaskTargetReference,
  extractProvisioningDestination,
  isDashboardUrl,
} from '../extension/src/background/targetResolver';

const DASHBOARD_ORIGIN = 'http://localhost:5173';
const DASHBOARD_TAB_ID = 10;

function show(label: string, task: string, tabs: Array<{ id: number; url: string; active?: boolean; title?: string }>) {
  const res = resolveTargetWebTab(tabs, task, DASHBOARD_ORIGIN, DASHBOARD_TAB_ID);
  const ref = parseTaskTargetReference(task);
  console.log('\n=== ' + label + ' ===');
  console.log('task            :', JSON.stringify(task));
  console.log('eligible tabs   :', JSON.stringify(tabs.filter((t) => isEligibleWebTab(t, DASHBOARD_ORIGIN, DASHBOARD_TAB_ID)).map((t) => t.id)));
  console.log('targetRef       :', JSON.stringify(ref));
  console.log('isOpenIntent    :', ref?.isOpenIntent);
  console.log('ref.port        :', ref?.port);
  console.log('ref.fullUrl     :', ref?.fullUrl);
  console.log('provisioning    :', JSON.stringify(res.provisioning ?? null));
  console.log('failureCode     :', res.failureCode ?? null);
  console.log('selectedTab     :', res.selectedTab ? `id=${res.selectedTab.id} url=${res.selectedTab.url}` : 'null  <-- Target Tab: —');
  console.log('reason          :', res.reason);
  return res;
}

console.log('isDashboardUrl(localhost:5174):', isDashboardUrl('http://localhost:4174', DASHBOARD_ORIGIN));
console.log('isDashboardUrl(localhost:5173):', isDashboardUrl('http://localhost:5173', DASHBOARD_ORIGIN));
console.log('isEligibleWebTab(4174 tab)   :', isEligibleWebTab({ id: 22, url: 'http://localhost:4174/' }, DASHBOARD_ORIGIN, DASHBOARD_TAB_ID));
console.log('isEligibleWebTab(5173 tab)   :', isEligibleWebTab({ id: 10, url: 'http://localhost:5173/' }, DASHBOARD_ORIGIN, DASHBOARD_TAB_ID));

// A: Reported production case — dashboard open, target 4174 NOT yet open,
//    task names the target explicitly with an open verb.
show('A explicit-url 4174, tab absent', 'open http://localhost:4174 and fill the contact form', [
  { id: 10, url: 'http://localhost:5173/', active: true },
  { id: 31, url: 'https://freebuff.com/', active: false },
]);

// B: Existing 4174 tab present.
show('B explicit-url 4174, tab present', 'open http://localhost:4174 and fill the contact form', [
  { id: 10, url: 'http://localhost:5173/', active: true },
  { id: 22, url: 'http://localhost:4174/', active: false },
]);

// C: bare localhost:4174 with open verb, tab absent
show('C bare localhost:4174, tab absent', 'open localhost 4174 and fill the contact form', [
  { id: 10, url: 'http://localhost:5173/', active: true },
]);

// D: control — non-local explicit URL, tab absent
show('D explicit remote url, tab absent', 'open https://example.com and read the page', [
  { id: 10, url: 'http://localhost:5173/', active: true },
]);

// E: control — dashboard only, no target reference
show('E no target reference, dashboard only', 'summarise the page', [
  { id: 10, url: 'http://localhost:5173/', active: true },
]);

// F: no target reference but eligible tab present
show('F no target reference, eligible tab present', 'summarise the page', [
  { id: 10, url: 'http://localhost:5173/', active: true },
  { id: 41, url: 'https://freebuff.com/', active: true },
]);

console.log('\nextractProvisioningDestination(A task):', JSON.stringify(extractProvisioningDestination('open http://localhost:4174 and fill the contact form', DASHBOARD_ORIGIN)));
