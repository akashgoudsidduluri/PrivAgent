/**
 * PrivAgent — START_TASK localhost-port target regression (Phase 17.10 D1)
 *
 * Production symptom this file pins:
 *
 *   Dashboard  http://localhost:5173
 *   Target     http://localhost:4174
 *   → START_TASK received
 *   → status FAILED / currentStep 0 / hasInteraction false
 *   → TERMINAL FAILED, Step Budget 0/10, Target Tab: —
 *
 * Root cause: `resolveTargetWebTab()` branch 1 refused to provision any target
 * reference that carried a port (`if (targetRef.isOpenIntent && !targetRef.port)`),
 * so a task naming the literal URL `http://localhost:4174` produced
 * `selectedTab: null` + `failureCode: 'DESTINATION_REQUIRED'`, and the service
 * worker emitted a step-0 terminal FAILED with no target tab.
 *
 * The dashboard/content-script handshake reported `targetTab: FOUND` at the same
 * time because the heartbeat PING handler (serviceWorker.ts ~:400) uses a
 * completely different, non-authoritative heuristic (prefers port 4173, else any
 * `isEligibleWebTab` with the DEFAULT dashboard origin and no dashboardTabId).
 * It is asserted here as a control so the two can never be conflated again.
 *
 * No reasoner is required anywhere in this file: resolution, provisioning and
 * containment establishment are all deterministic.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveTargetWebTab,
  isEligibleWebTab,
  isDashboardUrl,
  MinimalTab,
} from '../extension/src/background/targetResolver';
import { establishContainmentScope } from '../extension/src/agent/containment';

const DASHBOARD_ORIGIN = 'http://localhost:5173';
const DASHBOARD: MinimalTab = { id: 10, url: 'http://localhost:5173/', active: true };
const UNRELATED: MinimalTab = { id: 31, url: 'https://freebuff.com/', active: false };
const TARGET_4174: MinimalTab = { id: 22, url: 'http://localhost:4174/', active: false };

const DASHBOARD_ID = 10;
const TARGET_4174_ID = 22;

/** The literal URL the user asked the agent to work on. */
const EXPLICIT_TARGET_TASK = 'open http://localhost:4174 and fill the contact form';

describe('START_TASK regression — dashboard 5173 vs target 4174', () => {
  // ── Localhost origin hygiene (phase 3 of the report) ──────────────────────
  describe('localhost port identity is preserved, not conflated', () => {
    it('5173 and 4174 are distinct origins', () => {
      expect(new URL('http://localhost:5173').origin).not.toBe(new URL('http://localhost:4174').origin);
    });

    it('the dashboard tab is never eligible, the 4174 tab always is', () => {
      expect(isEligibleWebTab(DASHBOARD, DASHBOARD_ORIGIN, DASHBOARD.id)).toBe(false);
      expect(isEligibleWebTab(TARGET_4174, DASHBOARD_ORIGIN, DASHBOARD.id)).toBe(true);
    });

    it('4174 is not treated as the dashboard merely because the dashboard is 5173', () => {
      expect(isDashboardUrl('http://localhost:4174/', DASHBOARD_ORIGIN)).toBe(false);
      expect(isDashboardUrl('http://localhost:5173/', DASHBOARD_ORIGIN)).toBe(true);
    });

    it('a 4174 target establishes a real containment scope with the dashboard origin respected', () => {
      const scope = establishContainmentScope({
        targetUrl: TARGET_4174.url,
        targetTabId: TARGET_4174_ID,
        dashboardOrigin: DASHBOARD_ORIGIN,
      });
      expect(scope).not.toBeNull();
      expect(scope!.rootHost).toBe('localhost');
      expect(scope!.origin).toBe('http://localhost:4174');
      expect(scope!.tabId).toBe(22);
      expect(scope!.dashboardOrigin).toBe(DASHBOARD_ORIGIN);
    });

    it('the dashboard itself is still refused by containment (fail closed)', () => {
      expect(
        establishContainmentScope({
          targetUrl: DASHBOARD.url,
          targetTabId: DASHBOARD_ID,
          dashboardOrigin: DASHBOARD_ORIGIN,
        })
      ).toBeNull();
    });
  });

  // ── THE REGRESSION ────────────────────────────────────────────────────────
  it('REGRESSION: an explicit localhost:4174 URL is not left with Target Tab: —', () => {
    const res = resolveTargetWebTab([DASHBOARD, UNRELATED], EXPLICIT_TARGET_TASK, DASHBOARD_ORIGIN, DASHBOARD.id);

    // Must NOT be the step-0 terminal FAILED shape any more.
    expect(res.failureCode).toBeUndefined();

    // Either branch is acceptable, but the task must land on 4174 — never on the
    // dashboard, never on freebuff.com, and never on nothing.
    if (res.selectedTab) {
      expect(res.selectedTab.id).toBe(22);
      expect(new URL(res.selectedTab.url!).port).toBe('4174');
    } else {
      expect(res.provisioning).toEqual({ url: 'http://localhost:4174/', source: 'explicit-url' });
    }

    // The selected/provisioned destination is never the dashboard origin.
    const landed = res.selectedTab?.url ?? res.provisioning?.url ?? '';
    expect(isDashboardUrl(landed, DASHBOARD_ORIGIN)).toBe(false);
    expect(landed).not.toContain('5173');
    expect(landed).not.toContain('freebuff.com');
  });

  it('REGRESSION: the two provisioning extractors in the module agree for 4174', () => {
    // extractProvisioningDestination() already treated a literal local URL as a
    // provisionable destination; branch 1 did not. They must not disagree.
    const viaBranch1 = resolveTargetWebTab([DASHBOARD], EXPLICIT_TARGET_TASK, DASHBOARD_ORIGIN, DASHBOARD.id);
    expect(viaBranch1.provisioning?.url).toBe('http://localhost:4174/');
  });

  // ── PAIRED NEGATIVE 1: must not hijack an unrelated tab ────────────────────
  it('NEGATIVE 1: unrelated existing target is NOT hijacked', () => {
    const res = resolveTargetWebTab([DASHBOARD, UNRELATED], EXPLICIT_TARGET_TASK, DASHBOARD_ORIGIN, DASHBOARD.id);

    expect(res.selectedTab?.id).not.toBe(31);
    expect(res.selectedTab?.url ?? null).not.toBe(UNRELATED.url);
    expect(res.selectedTab?.id).not.toBe(DASHBOARD.id);
  });

  // ── PAIRED NEGATIVE 2: refuse when opening is not authorised ──────────────
  it('NEGATIVE 2: a target that is unavailable and NOT authorised for opening still fails closed', () => {
    // "already opened" is the opposite of authority to open a destination.
    const alreadyOpen = resolveTargetWebTab(
      [DASHBOARD, UNRELATED],
      'I already opened http://localhost:4174 and it shows a leak',
      DASHBOARD_ORIGIN,
      DASHBOARD.id
    );
    expect(alreadyOpen.provisioning).toBeUndefined();
    expect(alreadyOpen.selectedTab).toBeNull();
    expect(alreadyOpen.failureCode).toBe('DESTINATION_REQUIRED');

    // Bare host:port with no literal URL and no open verb — unchanged refusal.
    const bareNoVerb = resolveTargetWebTab(
      [DASHBOARD],
      'report any phone number exposed on localhost:4174',
      DASHBOARD_ORIGIN,
      DASHBOARD.id
    );
    expect(bareNoVerb.provisioning).toBeUndefined();
    expect(bareNoVerb.failureCode).toBe('DESTINATION_REQUIRED');

    // Bare host:port WITH an open verb keeps the historical pinned refusal.
    const bareWithVerb = resolveTargetWebTab(
      [DASHBOARD],
      'Open the localhost 4174 and get my account number',
      DASHBOARD_ORIGIN,
      DASHBOARD.id
    );
    expect(bareWithVerb.provisioning).toBeUndefined();
    expect(bareWithVerb.selectedTab).toBeNull();
    expect(bareWithVerb.failureCode).toBe('DESTINATION_REQUIRED');
    expect(bareWithVerb.reason).toBe('No target web tab found. Please open http://localhost:4174.');
  });

  // ── PAIRED NEGATIVE 3: explicit open intent MAY provision ──────────────────
  it('NEGATIVE 3: explicit open intent for 4174 provisions exactly 4174', () => {
    const res = resolveTargetWebTab([DASHBOARD], EXPLICIT_TARGET_TASK, DASHBOARD_ORIGIN, DASHBOARD.id);

    expect(res.provisioning).toEqual({ url: 'http://localhost:4174/', source: 'explicit-url' });
    expect(res.selectedTab).toBeNull();
    expect(res.failureCode).toBeUndefined();
    // Destination only — never an executable action.
    expect(Object.keys(res.provisioning!).sort()).toEqual(['source', 'url']);
  });

  it('NEGATIVE 3b: the dashboard is still never provisioned, even with open intent', () => {
    const res = resolveTargetWebTab(
      [DASHBOARD],
      'open http://localhost:5173 and click run',
      DASHBOARD_ORIGIN,
      DASHBOARD.id
    );
    expect(res.provisioning).toBeUndefined();
    expect(res.selectedTab).toBeNull();
    expect(res.failureCode).toBe('DESTINATION_REQUIRED');
  });

  // ── PAIRED NEGATIVE 4: reuse the correct existing tab ──────────────────────
  it('NEGATIVE 4: an existing 4174 tab is reused, not the dashboard or an unrelated tab', () => {
    const res = resolveTargetWebTab([DASHBOARD, UNRELATED, TARGET_4174], EXPLICIT_TARGET_TASK, DASHBOARD_ORIGIN, DASHBOARD.id);

    expect(res.selectedTab?.id).toBe(22);
    expect(res.provisioning).toBeUndefined();
    expect(res.failureCode).toBeUndefined();
  });

  it('NEGATIVE 4b: an existing 4174 tab is reused even with no open verb', () => {
    const res = resolveTargetWebTab(
      [DASHBOARD, TARGET_4174],
      'summarise the page at http://localhost:4174',
      DASHBOARD_ORIGIN,
      DASHBOARD.id
    );

    expect(res.selectedTab?.id).toBe(22);
    expect(res.provisioning).toBeUndefined();
  });

  // ── CONTROL: the handshake heuristic is NOT the authoritative resolver ─────
  it('CONTROL: the heartbeat PING heuristic would have picked freebuff.com — it is not authoritative', () => {
    // Mirrors serviceWorker.ts ~:412-420: prefer port 4173, else the first
    // isEligibleWebTab() with the DEFAULT dashboard origin and no dashboardTabId.
    const tabs = [DASHBOARD, UNRELATED];
    const pingCandidate =
      tabs.find((t) => {
        try {
          return new URL(t.url || '').port === '4173';
        } catch {
          return false;
        }
      }) || tabs.find((t) => isEligibleWebTab(t));

    // The handshake says FOUND at freebuff.com ...
    expect(pingCandidate?.id).toBe(31);
    // ... while the authoritative resolver for the same task never selects it.
    const res = resolveTargetWebTab(tabs, EXPLICIT_TARGET_TASK, DASHBOARD_ORIGIN, DASHBOARD.id);
    expect(res.selectedTab?.id).not.toBe(31);
  });
});
