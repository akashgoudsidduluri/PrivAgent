import { AgentLoop, TaskState } from '../agent/agentLoop';
import type { AgentTaskState } from '../agent/agentState';
import { createAgentProvider } from '../agent/providerRegistry';
import { ModelRouter } from '../agent/modelRouter';
import { buildAgentPayload, PrivacyScanReport, AgentContextPayload, VisualCaptureReport } from '../privacy/types';
import { minimizeAgentContext } from '../privacy/contextMinimizer';
import { BrowserAction } from '../agent/actionTypes';
import { resolveTargetWebTab, isEligibleWebTab, isDashboardUrl } from './targetResolver';
import { classifyIntent, refusalUserMessage } from '../agent/intentBoundary';
import { EvidenceLedger } from '../evidence/evidenceLedger';
import {
  establishContainmentScope,
  evaluateContainment,
  verifyNavigationContainment,
} from '../agent/containment';
import { AgentHarness } from '../agent/harness';
// PHASE 17.4 D5. Long-horizon RELIABILITY state, persisted so an MV3 service-
// worker eviction cannot reset the task bounds. `chrome.storage.session` is
// browser-memory only and is never written to disk. The `storage` permission
// was added to the manifest for this (see LONG_HORIZON_AUDIT_D5.md); without
// it the API is absent in the shipped build. Availability is still probed, and
// a genuinely unavailable store degrades explicitly (persistenceAvailable:
// false) rather than silently. Never falls back to chrome.storage.local, which
// would put task state on disk.
import { createSessionStore } from '../agent/longHorizonPersistence';
import { projectAgentOutput, screenAgentOutput, describeOutputScreen } from '../agent/agentOutput';
import { BrowserWorldModel, ActiveWorldModelRef } from '../worldModel/types';
import { assertWorldModelSafe } from '../worldModel/worldModelSanitizer';
import { buildSemanticUnderstanding, SemanticUnderstandingOutput, SanitizedSemanticContext } from '../semanticUnderstanding';
import { buildSemanticObservation, toSanitizedFacts } from '../semanticObservation';
import { scanForRawSensitiveValues } from '../privacy/rawValueScanner';
import { coordinateMultimodalPerception, enrichWorldModelWithMultimodalPerception } from '../visualPerception/multimodalCoordinator';
import { OffscreenOCREngine } from '../ocr/offscreenOcrClient';
import type { OCRObservation } from '../ocr/ocrObservationContract';
import { observedSnapshotFields, tabOnlySnapshotFields } from '../agent/effectVerifier';
import type { ObservationState } from '../agent/effectVerifier';
import type { ViewportGeometry } from '../capture/coordinateMapper';
import {
  nextConversationId,
  isUsableContext,
  eligibleCandidates,
  type ConversationContext,
} from '../agent/conversationContext';
import { createConversationStore } from '../agent/conversationPersistence';
import { planConversation, detectReference } from '../agent/referenceResolver';

/**
 * PHASE 18.8 / B2 + A13 — MAY A CONVERSATIONAL TURN PAST THE INTENT BOUNDARY?
 *
 * The intent boundary is deterministic, local and runs before any provider
 * call, so it cannot know what "it" or "the third one" points at. For the ONE
 * refusal a conversation can genuinely settle (`AMBIGUOUS_NO_GUESS`), the
 * active conversation is consulted — still locally, still with no model:
 *
 *   admitted  ⇔ the turn carries a conversational reference AND the active
 *               conversation is usable AND it holds something a reference
 *               could point at — a SELECTED entity, or observed candidates.
 *
 * Admitting a candidate set is not admitting a guess: the resolver in the loop
 * still decides, deterministically, between RESOLVED and NEEDS_CLARIFICATION,
 * and revalidates the anchor against the freshly perceived page BEFORE anything
 * is planned. A pronoun over four candidates therefore still ends in a typed
 * clarification — it just ends there, with the reason, instead of being
 * refused earlier with no context at all.
 *
 * Nothing else is admitted: no selection, no usable context, no reference in
 * the turn, or any other refusal code all stop at the boundary with zero
 * provider calls and zero tabs. Because the check is keyed on the refusal CODE,
 * it cannot touch a consequential intent (a purchase classifies as a
 * transaction, never as ambiguity), so Risk/Confirmation is unaffected.
 */
function conversationSettlesAmbiguity(
  task: string,
  context: ConversationContext | null,
  now: number
): boolean {
  if (!context || typeof task !== 'string' || task.length === 0) return false;
  if (!detectReference(task)) return false;
  const hasAnchor =
    context.selection !== null ||
    context.selection !== undefined ||
    eligibleCandidates(context).length > 0;
  if (!hasAnchor) return false;
  return isUsableContext(context, { conversationId: context.conversationId, now });
}

// PrivAgent Background Service Worker (Manifest V3)
let activeLoop: AgentLoop | null = null;
let activeTaskRunId = 0;
let currentDashboardTabId: number | null = null;
//
// PHASE 18.8 / B2 — the ONE active conversation, owned by the worker.
//
// The worker is the only place that decides whether a turn continues a
// conversation: the loop never re-derives it, and the dashboard never asserts
// it. Persistence is `chrome.storage.session` (in-memory), degrading explicitly
// to in-memory when the area is absent.
//
let activeConversation: ConversationContext | null = null;
const conversationStore = createConversationStore();
let conversationCounter = 0;

const sharedOffscreenOcrEngine = new OffscreenOCREngine({ timeoutMs: 15_000 });

chrome.runtime.onInstalled.addListener(() => {
  console.info('[PrivAgent] Background Service Worker installed successfully.');
  chrome.action.setBadgeText({ text: 'ON' });
  chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
});

const withTimeout = <T>(promise: Promise<T>, ms: number, timeoutMsg: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(timeoutMsg)), ms);
    promise
      .then((res) => {
        clearTimeout(t);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(t);
        reject(err);
      });
  });

async function sendToDashboard(payload: any, preferredTabId?: number | null): Promise<boolean> {
  // ── Phase 14 — the SINGLE output-privacy enforcement point ───────────────
  // Everything the user can ever receive from this worker passes through here:
  // per-step progress, the final task state, and every hand-built early-failure
  // payload. Screening here rather than at each call site is deliberate — it
  // makes "screened before crossing the SW → dashboard boundary" true by
  // construction instead of by remembering to add it at every future call site.
  //
  // `projectAgentOutput` is a narrowing, read-only translation with no write
  // path back into the loop, the Harness, containment or any security gate, and
  // `screenAgentOutput` fails closed. Neither can change what the agent does;
  // they only shape and filter what the user is shown.
  const rawPayload = payload && typeof payload === 'object' ? payload : {};
  const runId = typeof rawPayload.runId === 'number' ? rawPayload.runId : activeTaskRunId;
  const screened = screenAgentOutput(projectAgentOutput(rawPayload as AgentTaskState));
  const outbound = { ...rawPayload, runId, interaction: screened.output };
  console.info('[AgentTrace] output screen', {
    verdict: screened.verdict,
    audit: describeOutputScreen(screened),
    outcome: screened.output.outcome,
    phase: screened.output.activity.phase,
    resultKind: screened.output.result.kind,
  });
  payload = outbound;

  console.info('[ServiceWorker] response forwarded', {
    status: payload?.status,
    currentStep: payload?.currentStep,
    reason: payload?.reason,
  });

  const MAX_RETRIES = 3;
  let sent = false;

  // 1. Try preferred tab first with bounded retries
  const targetId = preferredTabId || currentDashboardTabId;
  if (targetId) {
    for (let attempt = 0; attempt < MAX_RETRIES && !sent; attempt++) {
      try {
        await withTimeout(
          chrome.tabs.sendMessage(targetId, {
            type: 'PRIVAGENT_DASHBOARD_PROGRESS',
            payload,
          }),
          1500,
          'Dashboard progress send timed out'
        );
        sent = true;
        currentDashboardTabId = targetId;
        break;
      } catch (err) {
        console.warn(`[PrivAgent SW] Delivery to tab ${targetId} attempt ${attempt + 1} failed:`, err);
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
        }
      }
    }
  }

  // 2. Fallback: Locate any open dashboard tab (port 5173)
  if (!sent) {
    try {
      const allTabs = await chrome.tabs.query({});
      const dashTabs = allTabs.filter((t) => {
        const url = t.url || (t as any).pendingUrl || '';
        return Boolean(t.id && (url.includes(':5173') || url.includes('5173')));
      });

      for (const dTab of dashTabs) {
        if (!dTab.id) continue;
        try {
          await withTimeout(
            chrome.tabs.sendMessage(dTab.id, {
              type: 'PRIVAGENT_DASHBOARD_PROGRESS',
              payload,
            }),
            1500,
            'Dashboard tab fallback send timed out'
          );
          sent = true;
          currentDashboardTabId = dTab.id;
          break;
        } catch {
          // Attempt injection and retry once
          try {
            const reconnected = await ensureTargetTabReady(dTab.id);
            if (reconnected) {
              await chrome.tabs.sendMessage(dTab.id, {
                type: 'PRIVAGENT_DASHBOARD_PROGRESS',
                payload,
              });
              sent = true;
              currentDashboardTabId = dTab.id;
              break;
            }
          } catch (reconnectErr) {
            console.warn(`[PrivAgent SW] Failed to reconnect dashboard tab ${dTab.id}:`, reconnectErr);
          }
        }
      }
    } catch (queryErr) {
      console.warn('[PrivAgent SW] Failed to query dashboard tabs:', queryErr);
    }
  }

  if (!sent) {
    console.warn('[PrivAgent SW] Could not deliver TASK_PROGRESS to any dashboard tab. AgentLoop state remains authoritative.');
  }

  return sent;
}

/**
 * Reads the LIVE viewport geometry from the target tab's content script.
 *
 * Phase 16 P0 remediation. The service worker has no `window`, so the
 * multimodal coordinator's own geometry fallback always produced scrollX=0
 * and scrollY=0 here. That made the sanitized context report a viewport
 * position of zero no matter where the page actually was, which left the
 * DEFECT 2 scroll goal verifier with no observed state to decide from.
 *
 * This asks the content script — the component that can actually see the page
 * — using the message it already answers. It is a READ: nothing is invented,
 * no value is derived, and a page that cannot be read yields `null` so the
 * caller keeps the previous fail-closed behaviour.
 */
async function readLiveViewportGeometry(tabId: number): Promise<ViewportGeometry | null> {
  try {
    const res = await withTimeout(
      chrome.tabs.sendMessage(tabId, { type: 'PRIVAGENT_GET_VIEWPORT_GEOMETRY' }),
      1500,
      'Live viewport geometry query timed out'
    ) as {
      type?: string; viewportWidth?: number; viewportHeight?: number;
      scrollX?: number; scrollY?: number; devicePixelRatio?: number;
    } | null;
    if (!res || res.type !== 'PRIVAGENT_GET_VIEWPORT_GEOMETRY_RESPONSE') return null;
    if (typeof res.viewportWidth !== 'number' || typeof res.viewportHeight !== 'number') return null;
    return {
      viewportWidth: res.viewportWidth,
      viewportHeight: res.viewportHeight,
      scrollX: typeof res.scrollX === 'number' ? res.scrollX : 0,
      scrollY: typeof res.scrollY === 'number' ? res.scrollY : 0,
      devicePixelRatio: typeof res.devicePixelRatio === 'number' ? res.devicePixelRatio : 1,
    };
  } catch {
    return null;
  }
}

/**
 * PHASE 17.1 (C8). Resolves the dashboard's ACTUAL origin.
 *
 * The default is kept for compatibility, but a caller that knows the real
 * origin (the dashboard always sends it as `originUrl`) now gets a truthful
 * answer instead of a hard-coded guess. This only ever makes the existing
 * "the agent must never drive its own control surface" guard fire correctly.
 */
function resolveDashboardOrigin(originFromMessage?: string | null): string {
  if (typeof originFromMessage === 'string' && originFromMessage.trim()) {
    try {
      return new URL(originFromMessage).origin;
    } catch {
      /* fall through to the default */
    }
  }
  return 'http://localhost:5173';
}

/**
 * Ensures the target tab has the content script injected and responsive.
 * If the tab was opened prior to extension reload, dynamically injects contentScript.
 */
async function ensureTargetTabReady(tabId: number): Promise<boolean> {
  // 1. Check if already responsive
  try {
    const res = await withTimeout(
      chrome.tabs.sendMessage(tabId, { type: 'PRIVAGENT_GET_VIEWPORT_GEOMETRY' }),
      1500,
      'Viewport geometry query timed out'
    );
    if (res) return true;
  } catch {
    // Not responsive; proceed to injection
  }

  // 2. Content script not yet attached or invalidated; inject dynamically
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['contentScript.js'],
    });
    try {
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['contentStyles.css'],
      });
    } catch {
      // CSS insert error non-fatal
    }
    await new Promise((resolve) => setTimeout(resolve, 200));

    // 3. Verify newly injected script responds
    const verifyRes = await withTimeout(
      chrome.tabs.sendMessage(tabId, { type: 'PRIVAGENT_GET_VIEWPORT_GEOMETRY' }),
      2000,
      'Target tab verification timed out'
    );
    return Boolean(verifyRes);
  } catch (e) {
    console.warn('[PrivAgent SW] Target tab content script auto-injection failed:', e);
    return false;
  }
}

/**
 * Target Tab Provisioning.
 *
 * Opens a DEDICATED new Chrome tab for a deterministically extracted destination so
 * the agent has something to perceive when the user has only the dashboard open.
 *
 * Invariants (deliberately narrow):
 *  - The dashboard is NEVER provisioned or targeted.
 *  - Provisioning supplies a DESTINATION only. It proposes no action, so nothing here
 *    can bypass Target Grounding, M5, the Security Critic, the Privacy Policy or the
 *    Risk/Confirmation gate — the AgentLoop still performs every step in the new tab.
 *  - No default/blank landing page is ever invented: the caller supplies an explicit
 *    URL that was extracted from the user's own task text.
 *  - The returned tab id is pinned by the caller as the stable targetTabId.
 */
async function provisionTargetTab(url: string): Promise<{ id: number; url: string } | null> {
  // Fail closed: never provision a non-http(s) or dashboard URL.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.warn('[PrivAgent SW] provisionTargetTab: refusing non-http(s) destination');
    return null;
  }
  if (isDashboardUrl(parsed.toString())) {
    console.warn('[PrivAgent SW] provisionTargetTab: refusing dashboard destination');
    return null;
  }

  try {
    const created = await chrome.tabs.create({ url: parsed.toString(), active: true });
    const newTabId = created?.id;
    if (typeof newTabId !== 'number') {
      console.warn('[PrivAgent SW] provisionTargetTab: chrome.tabs.create returned no tab id');
      return null;
    }

    console.info('TARGET_TAB_PROVISIONED', { tabId: newTabId, origin: parsed.origin });
    console.info('[AgentTrace] target tab provisioned', { tabId: newTabId, origin: parsed.origin });

    // Wait for the page to finish loading before attaching the content script.
    const loaded = await waitForTabLoad(newTabId, 15000);

    // Attach the content script / world model. A fresh tab starts at pageGeneration 1
    // on both sides because the content script is injected into a page that has never
    // been controlled before, keeping the generations in sync.
    const ready = await ensureTargetTabReady(newTabId);
    if (!ready) {
      console.warn('[PrivAgent SW] provisionTargetTab: content script not responsive in new tab', {
        tabId: newTabId,
        loaded,
      });
      return null;
    }

    console.info('TARGET_TAB_READY', { tabId: newTabId, provisioned: true });
    return { id: newTabId, url: parsed.toString() };
  } catch (e) {
    console.warn('[PrivAgent SW] provisionTargetTab failed:', e);
    return null;
  }
}

/**
 * Wait for a tab to reach loading status 'complete', with a bounded timeout.
 *
 * Race-condition fix: checks the CURRENT tab state first before registering the
 * onUpdated listener. If the navigation already finished before we registered
 * the listener we would otherwise wait the full timeout and incorrectly return false.
 *
 * Timeline:
 *   executeAction(navigate) → tab starts loading
 *   ... (some ms) ...
 *   waitForTabLoad() called
 *     └─ chrome.tabs.get(tabId) → status already 'complete'? return true immediately.
 *     └─ otherwise register chrome.tabs.onUpdated listener + start timer.
 */
async function waitForTabLoad(tabId: number, timeoutMs: number): Promise<boolean> {
  // Fast-path: tab may have already finished loading before we registered the listener.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') {
      console.info('[PrivAgent SW] waitForTabLoad: tab already complete', { tabId });
      return true;
    }
  } catch (e) {
    // Tab may have been closed or is transitioning; fall through to the listener.
    console.warn('[PrivAgent SW] waitForTabLoad: tabs.get failed', { tabId, err: String(e) });
  }

  // Slow-path: listen for the completion event with a timeout.
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      console.warn('[PrivAgent SW] waitForTabLoad: timed out', { tabId, timeoutMs });
      resolve(false);
    }, timeoutMs);

    function listener(id: number, info: chrome.tabs.TabChangeInfo) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        console.info('[PrivAgent SW] waitForTabLoad: complete event received', { tabId });
        resolve(true);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * Message handler — routes messages from content scripts, popup, and dashboard.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ── Handshake from dashboard or popup ──────────────────────────────────────
  //
  // IMPORTANT: This handler must NOT call ensureTargetTabReady() — that
  // operation takes up to 3700ms and would block the heartbeat response beyond
  // any reasonable timeout. Extension connectivity (SW alive?) must be
  // completely decoupled from target-tab preparation (done at task start only).
  if (message.type === 'PRIVAGENT_DASHBOARD_PING') {
    const pingId = message.pingId || `sw-${Date.now()}`;
    console.info('[SW][PING] SERVICE_WORKER_RECEIVED_PING', { pingId });

    (async () => {
      try {
        console.info('[SW][PING] TARGET_RESOLUTION_STARTED', { pingId });
        const allTabs = await chrome.tabs.query({});

        // Fast tab discovery — no scripting, no injection, no waiting.
        // Priority: explicit 4173 first, then any eligible web tab.
        const candidate =
          allTabs.find((t) => {
            const uStr = t.url || (t as any).pendingUrl;
            if (!uStr) return false;
            try {
              const u = new URL(uStr);
              return u.port === '4173';
            } catch {
              return false;
            }
          }) || allTabs.find((t) => isEligibleWebTab(t));

        const targetFound = Boolean(candidate?.id);
        const candidateUrl = candidate?.url || (candidate as any)?.pendingUrl;
        const urlOrigin = candidateUrl
          ? (() => { try { return new URL(candidateUrl).origin; } catch { return candidateUrl; } })()
          : '';

        console.info('[SW][PING] TARGET_RESOLUTION_RESULT', {
          pingId,
          targetFound,
          tabId: candidate?.id,
          urlOrigin,
        });

        // Do NOT probe the target tab here — that is ensureTargetTabReady's job
        // and it is called at task-start time, not during a heartbeat ping.
        // Report targetTab as FOUND if a tab exists; content script readiness
        // is probed lazily at task time.
        const resp = {
          pingId,
          connected: true,
          version: '0.4.0',
          serviceWorker: 'REACHABLE',
          targetTab: targetFound ? 'FOUND' : 'NOT_FOUND',
          contentScript: targetFound ? 'REACHABLE' : 'NOT_INJECTED',
          urlOrigin,
          pageReady: targetFound, // optimistic — verified at task start
        };
        console.info('[SW][PING] SERVICE_WORKER_RESPONSE_SENT', { pingId, targetFound });
        sendResponse(resp);
      } catch (e) {
        console.warn('[SW][PING] TARGET_RESOLUTION_FAILED', { pingId, error: String(e) });
        sendResponse({
          pingId,
          connected: true,
          version: '0.4.0',
          serviceWorker: 'REACHABLE',
          targetTab: 'NOT_FOUND',
          contentScript: 'NOT_INJECTED',
          urlOrigin: '',
          pageReady: false,
        });
      }
    })();
    return true; // keep message channel open for async response
  }

  // ── Badge update from content script scan ────────────────────────────────
  if (message.type === 'PRIVAGENT_SCAN_RESPONSE' && message.report && sender.tab?.id) {
    const count = message.report.sensitiveElementsDetected;
    chrome.action.setBadgeText({
      tabId: sender.tab.id,
      text: count > 0 ? String(count) : '✓',
    });
    chrome.action.setBadgeBackgroundColor({
      tabId: sender.tab.id,
      color: count > 0 ? '#ef4444' : '#10b981',
    });
    return false;
  }

  // ── Screenshot capture request ───────────────────────────────────────────
  if (message.type === 'PRIVAGENT_CAPTURE_SCREENSHOT') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id || tab.id === chrome.tabs.TAB_ID_NONE) {
        sendResponse({
          type: 'PRIVAGENT_CAPTURE_SCREENSHOT_RESPONSE',
          error: 'No active tab found.',
        });
        return;
      }

      chrome.tabs.captureVisibleTab(
        tab.windowId!,
        { format: 'png' },
        (dataUrl) => {
          if (chrome.runtime.lastError) {
            sendResponse({
              type: 'PRIVAGENT_CAPTURE_SCREENSHOT_RESPONSE',
              error: chrome.runtime.lastError.message ?? 'captureVisibleTab failed.',
            });
          } else {
            sendResponse({
              type: 'PRIVAGENT_CAPTURE_SCREENSHOT_RESPONSE',
              dataUrl,
            });
          }
        }
      );
    });

    return true; // async response
  }

  // ── Real M6 Agent Loop from Web Dashboard ────────────────────────────────
  if (message.type === 'PRIVAGENT_DASHBOARD_START_TASK') {
    console.info('[ServiceWorker] message received', { type: message.type });
    console.info('[AgentTrace] service worker START_TASK received', { taskLength: (message.task as string)?.length });
    const task = message.task as string;
    const dashboardTabId = sender.tab?.id || currentDashboardTabId;

    // ── PHASE 18.7 / I-1: THE INTENT BOUNDARY ────────────────────────────
    //
    // Deterministic, local, no model call. It is placed HERE, before target
    // resolution and before the active-task-ownership block, for two reasons
    // that are both acceptance criteria rather than style:
    //
    //   * Target-tab provisioning runs in resolveTargetWebTab /
    //     provisionTargetTab below. A gate placed inside AgentLoop would
    //     therefore still have OPENED A TAB for "hi".
    //   * Sitting before the ownership block means a casual message does not
    //     supersede and halt a task that is genuinely running.
    //
    // A refusal costs zero provider calls and zero tab provisioning, and is
    // reported truthfully as NEEDS_CLARIFICATION rather than as a failure.
    const intentDecision = classifyIntent(task);
    console.info('[AgentTrace] intent classified', {
      intent: intentDecision.intent,
      confidence: intentDecision.confidence,
      requiresDestination: intentDecision.requiresDestination,
      requiresEvidence: intentDecision.requiresEvidence,
      admitsBrowserAutomation: intentDecision.admitsBrowserAutomation,
      refusal: intentDecision.refusal ?? null,
    });

    if (
      !intentDecision.admitsBrowserAutomation &&
      !(intentDecision.refusal === 'AMBIGUOUS_NO_GUESS' &&
        conversationSettlesAmbiguity(task, activeConversation, Date.now()))
    ) {
      console.info('[AgentTrace] task not admitted by the intent boundary', {
        intent: intentDecision.intent,
        refusal: intentDecision.refusal ?? null,
      });
      const refusalReason = refusalUserMessage(intentDecision);
      const refusalPayload = {
        started: false,
        success: false,
        status: 'NEEDS_CLARIFICATION' as const,
        intent: intentDecision.intent,
        refusalCode: intentDecision.refusal ?? null,
        reason: refusalReason,
      };
      // The message port MUST be answered before returning.
      //
      // This was found by REAL BROWSER testing, not by the unit suite: an early
      // `return` without `sendResponse` leaves the port to close, and the
      // dashboard — which is awaiting a reply — reports the task as FAILED with
      // "The message port closed before a response was received." The gate was
      // working (zero provider calls, zero tabs) while still telling the user a
      // lie. A refusal has to be reported truthfully, not merely enforced.
      try {
        sendResponse(refusalPayload);
      } catch {
        /* port already closed */
      }
      // Fire-and-forget: this handler section is synchronous (the async task body
      // begins later, after the ownership block), so `await` is not available
      // here. `sendToDashboard` is a one-way push to the dashboard tab.
      void sendToDashboard(
        {
          status: 'NEEDS_CLARIFICATION',
          currentStep: 0,
          maxSteps: 0,
          task: typeof task === 'string' ? task : '',
          steps: [],
          intent: intentDecision.intent,
          refusalCode: intentDecision.refusal ?? null,
          reason: refusalReason,
        },
        dashboardTabId
      );
      return;
    }
    if (!intentDecision.admitsBrowserAutomation) {
      console.info('[AgentTrace] conversational turn admitted past the intent boundary', {
        intent: intentDecision.intent,
        refusal: intentDecision.refusal ?? null,
        conversationId: activeConversation?.conversationId ?? null,
        selection: activeConversation?.selection?.identity?.entityType ?? null,
      });
    }
    if (sender.tab?.id) currentDashboardTabId = sender.tab.id;

    // ── Phase 18.1: Single Active Task Ownership ───────────────────────────
    activeTaskRunId++;
    const currentRunId = typeof message.runId === 'number' ? message.runId : activeTaskRunId;
    activeTaskRunId = currentRunId;
    const taskOwnershipToken = currentRunId;

    // PHASE 18.7 / A2 — a FRESH ledger per task. Reusing the previous task's
    // ledger would let evidence from a different page and a different
    // generation be cited for this one, which is exactly the cross-task
    // contamination the ledger's provenance exists to prevent.
    const activeEvidenceLedger = new EvidenceLedger();

    // ── PHASE 18.8 / B2: THE CONVERSATION ─────────────────────────────────
    //
    // Deterministic and local — no provider call, no tab, no gate. It answers
    // one question: does this turn CONTINUE the active conversation, or start
    // a new one?
    //
    // A follow-up inherits context only when it carries a conversational
    // reference AND that conversation has something the reference could point
    // at. Everything else — a new task, a reset, a turn with no reference, a
    // context that is stale, foreign or too old — starts a NEW, empty context.
    // Isolation is the default, so a previous run's candidates can never leak
    // into an unrelated task.
    conversationCounter += 1;
    const conversationPlan = planConversation({
      task,
      current: activeConversation,
      conversationId: nextConversationId(`${taskOwnershipToken}:${conversationCounter}:${Date.now()}`),
      now: Date.now(),
    });
    activeConversation = conversationPlan.context;
    const turnConversation = activeConversation;
    if (activeConversation) void conversationStore.save(activeConversation);
    console.info('[AgentTrace] conversation planned', {
      mode: conversationPlan.mode,
      reason: conversationPlan.reason,
      conversationId: activeConversation?.conversationId ?? null,
      contextGeneration: activeConversation?.contextGeneration ?? null,
      persistenceAvailable: conversationStore.persistenceAvailable,
    });

    if (activeLoop) {
      console.info('[PrivAgent SW] Halting and superseding previous active loop for new task run', {
        supersededRunId: activeLoop.getRunId?.(),
        newRunId: taskOwnershipToken,
      });
      activeLoop.stop(true); // silent stop: suppresses stale event emission
      activeLoop = null;
    }

    (async () => {
      try {
        if (taskOwnershipToken !== activeTaskRunId) {
          console.info('[PrivAgent SW] Task aborted before target resolution (superseded)', { taskOwnershipToken, activeTaskRunId });
          return;
        }
        console.info('TARGET_RESOLUTION_STARTED');
        const allTabs = await chrome.tabs.query({});
        if (taskOwnershipToken !== activeTaskRunId) {
          console.info('[PrivAgent SW] Task aborted after tabs query (superseded)', { taskOwnershipToken, activeTaskRunId });
          return;
        }
        const resolution = resolveTargetWebTab(
          allTabs,
          task,
          resolveDashboardOrigin(message.originUrl),
          dashboardTabId ?? undefined
        );

        // Safe diagnostics: strictly tab IDs & origins only
        console.info('TARGET_TAB_CANDIDATES', resolution.discoveredTabs.map((t) => ({ id: t.id, origin: t.origin })));

        // Target Tab Provisioning: only when resolution found NO eligible tab AND
        // extracted a deterministic destination from the task. An existing eligible
        // tab always wins (the resolver returns it above, so this never runs).
        let targetTab = resolution.selectedTab;
        if (dashboardTabId && targetTab?.id === dashboardTabId) {
          console.warn('[PrivAgent SW] Target tab resolved to dashboardTabId; rejecting', { dashboardTabId });
          targetTab = null;
        }

        if ((!targetTab || !targetTab.id) && resolution.provisioning) {
          const provisioned = await provisionTargetTab(resolution.provisioning.url);
          if (taskOwnershipToken !== activeTaskRunId) {
            console.info('[PrivAgent SW] Task aborted after provisioning (superseded)', { taskOwnershipToken, activeTaskRunId });
            return;
          }
          if (provisioned) {
            targetTab = provisioned;
          } else {
            console.info('TARGET_TAB_FAILED: provisioning did not yield a ready tab');
          }
        }

        if (dashboardTabId && targetTab?.id === dashboardTabId) {
          targetTab = null;
        }

        if (taskOwnershipToken !== activeTaskRunId) {
          console.info('[PrivAgent SW] Task aborted before target check (superseded)', { taskOwnershipToken, activeTaskRunId });
          return;
        }

        if (!targetTab || !targetTab.id) {
          if (taskOwnershipToken !== activeTaskRunId) return;
          console.info('TARGET_TAB_FAILED: no eligible tab found', {
            failureCode: resolution.failureCode || null,
          });
          console.info('[AgentTrace] terminal progress emitted', { status: 'FAILED' });
          const failReason =
            resolution.failureCode === 'DESTINATION_REQUIRED'
              ? 'No target web tab is open and no destination could be determined from the task. Name a site explicitly (for example "open https://example.com" or "open google and search for cats"), or open the page you want PrivAgent to work with.'
              : resolution.reason || 'No target web tab found. Please open http://localhost:4173.';
          try {
            sendResponse({
              started: false,
              success: false,
              status: 'FAILED',
              reason: failReason,
            });
          } catch {
            // Port might have closed
          }
          await sendToDashboard(
            {
              status: 'FAILED',
              currentStep: 0,
              maxSteps: 10,
              task,
              steps: [],
              reason: failReason,
              runId: taskOwnershipToken,
            },
            dashboardTabId
          );
          return;
        }

        // Stable target: pinned here and never re-resolved for the life of the task.
        const targetTabId = targetTab.id;

        // ── Phase 12 Containment ────────────────────────────────────────────
        // Establish the ENVIRONMENTAL boundary for this task from the origin
        // the task actually resolved. This bounds WHERE the agent may act; it
        // does not decide whether an action is allowed (M5 and the rest of the
        // pipeline still do). A null scope is the FAIL-CLOSED state: the loop
        // then refuses every action with CONTAINMENT_UNINITIALIZED rather than
        // running unbounded.
        //
        // PHASE 17.1 (C8). This was the literal 'http://localhost:5173', which
        // isDashboardUrl() only ever matched on port 5173. The real dashboard
        // origin arrives on the message and is already used for target
        // resolution a few lines above; containment was simply never told.
        // On any other port the agent's own control surface was not recognised
        // as such. This is an OBSERVATION fix: the guard already existed, it
        // was just being asked about the wrong origin.
        const dashboardOrigin = resolveDashboardOrigin(message?.originUrl);
        const containmentScope = establishContainmentScope({
          targetUrl: targetTab.url || null,
          targetTabId,
          dashboardOrigin,
        });
        console.info('[AgentTrace] containment scope established', {
          established: containmentScope !== null,
          rootHost: containmentScope?.rootHost ?? null,
          tabId: containmentScope ? containmentScope.tabId : null,
        });

        // FAIL CLOSED: the agent is never run without an environmental
        // boundary. A target whose origin cannot be contained (a non-web URL,
        // or the dashboard itself) must not produce a task at all.
        if (!containmentScope) {
          const reason =
            'Refusing to start the task: the resolved target has no containable environment ' +
            '(Phase 12 containment). The agent is never run unbounded.';
          console.error('[PrivAgent SW] containment scope could not be established', {
            failureCode: 'CONTAINMENT_UNINITIALIZED',
          });
          console.info('[AgentTrace] terminal progress emitted', { status: 'FAILED' });
          try {
            sendResponse({ started: false, success: false, status: 'FAILED', reason });
          } catch {
            /* port closed */
          }
          await sendToDashboard(
            { status: 'FAILED', currentStep: 0, maxSteps: 10, task, steps: [], reason },
            dashboardTabId
          );
          return;
        }
        console.info('TARGET_TAB_SELECTED', {
          tabId: targetTabId,
          origin: targetTab.url ? new URL(targetTab.url).origin : null,
          reason: targetTab === resolution.selectedTab ? resolution.reason : `Provisioned from task destination: ${resolution.provisioning?.url}`,
        });
        console.info('[AgentTrace] target resolved', { tabId: targetTabId });

        // Ensure target tab is active in its window
        try {
          await chrome.tabs.update(targetTabId, { active: true });
        } catch (actErr) {
          console.warn('[PrivAgent SW] Failed to activate target tab at start:', actErr);
        }

        // Ensure content script is active and responsive in the target tab
        const isReady = await ensureTargetTabReady(targetTabId);
        if (!isReady) {
          console.info('TARGET_TAB_FAILED: content script unreachable');
          console.info('[AgentTrace] terminal progress emitted', { status: 'FAILED' });
          const notReadyReason = 'Target web tab is open but not responding. Please refresh it.';
          try {
            sendResponse({
              started: false,
              success: false,
              status: 'FAILED',
              reason: notReadyReason,
            });
          } catch {
            // Port might have closed
          }
          await sendToDashboard(
            {
              status: 'FAILED',
              currentStep: 0,
              maxSteps: 10,
              task,
              steps: [],
              reason: notReadyReason,
            },
            dashboardTabId
          );
          return;
        }

        console.info('TARGET_TAB_READY', { tabId: targetTabId });
        console.info('[AgentTrace] target content script ready', { tabId: targetTabId });

        // Immediate direct response indicating task started successfully
        try {
          sendResponse({
            started: true,
            success: true,
            status: 'RUNNING',
            stage: 'PERCEPTION',
            reason: 'Target tab discovered and ready. Starting visual privacy perception...',
          });
        } catch {
          // Port might have closed
        }

        // Initial progress update to dashboard: discovery verified, perception starting
        console.info('[AgentTrace] first progress emitted');
        await sendToDashboard(
          {
            status: 'RUNNING',
            currentStep: 0,
            maxSteps: 10,
            task,
            currentUrl: targetTab.url || '',
            targetTabId,
            steps: [],
            reason: 'Target tab discovered and ready. Starting visual privacy perception...',
          },
          dashboardTabId
        );

        const loopCallbacks = {
          perceivePage: async (): Promise<AgentContextPayload | { context: AgentContextPayload; worldModel?: BrowserWorldModel; activeWorldModelRef?: ActiveWorldModelRef | null; semanticUnderstanding?: SemanticUnderstandingOutput; semanticContext?: SanitizedSemanticContext } | null> => {
            try {
              console.info('[AgentTrace] perception started');
              // Ensure target tab is still ready before perception
              const tabReady = await ensureTargetTabReady(targetTabId);
              if (!tabReady) {
                console.warn('[PrivAgent SW] Target tab not ready before perception, retrying once...');
                const retryReady = await ensureTargetTabReady(targetTabId);
                if (!retryReady) {
                  console.error('[PrivAgent SW] Target tab unresponsive after retry.');
                  return null;
                }
              }

              const scanRes = (await withTimeout(
                chrome.tabs.sendMessage(targetTabId, { type: 'PRIVAGENT_SCAN_REQUEST' }),
                10000,
                'Page perception timed out (10s).'
              )) as {
                report?: PrivacyScanReport;
                worldModel?: BrowserWorldModel;
                activeWorldModelRef?: ActiveWorldModelRef;
                semanticUnderstanding?: SemanticUnderstandingOutput;
                semanticContext?: SanitizedSemanticContext;
              } | null;

              if (!scanRes?.report) return null;

              let worldModel = scanRes.worldModel;
              if (worldModel) {
                try {
                  assertWorldModelSafe(worldModel);
                  const ref = scanRes.activeWorldModelRef ?? { pageGeneration: worldModel.page.pageGeneration, worldModelId: worldModel.id };
                  if (ref.pageGeneration !== worldModel.page.pageGeneration) {
                    throw new Error('World model generation mismatch detected before AgentLoop attachment.');
                  }
                  worldModel = { ...worldModel };
                } catch (err) {
                  console.warn('[PrivAgent SW] rejected stale or unsafe world model before AgentLoop attachment:', err instanceof Error ? err.message : String(err));
                  worldModel = undefined;
                }
              }

              let semanticUnderstanding = scanRes.semanticUnderstanding;
              let semanticContext = scanRes.semanticContext ?? semanticUnderstanding?.sanitizedContext;

              if (semanticUnderstanding && worldModel) {
                try {
                  const semGen = semanticUnderstanding.sanitizedContext.pageGeneration;
                  if (semGen !== worldModel.page.pageGeneration) {
                    throw new Error('Semantic understanding generation mismatch detected before AgentLoop attachment.');
                  }
                  const violations = scanForRawSensitiveValues(semanticUnderstanding.sanitizedContext);
                  if (violations.length > 0) {
                    throw new Error('Semantic context failed M8 privacy firewall.');
                  }
                } catch (semErr) {
                  console.warn('[PrivAgent SW] rejected stale or unsafe semantic context:', semErr instanceof Error ? semErr.message : String(semErr));
                  semanticUnderstanding = undefined;
                  semanticContext = undefined;
                }
              }

              // Fallback / calibration: If semantic understanding was not provided by scan, rebuild it
              //
              // G7 REPAIR 2. Semantic page classification reads LIVE DOM signals
              // (product cards, headings, tables, checkout controls, settings
              // panels). A service worker has no DOM, so `classifyPageSemantics`
              // cannot see any of them here: `root` is absent and `document` is
              // undefined in this context, which collapses page types that rest
              // on those signals to UNKNOWN at the `0.1` no-signal default — even
              // though the very same page classifies correctly through the
              // content-script path.
              //
              // The fix is NOT a second classifier and NOT a threshold change.
              // It is to rebuild the semantic context where the DOM actually
              // lives: ask the content script to run the SAME production
              // `buildSemanticUnderstanding` with the SAME `root: document` the
              // scan path uses. The world-model-only build is retained strictly
              // as a last resort, so a dead content script degrades the
              // classification rather than removing it.
              //
              // The returned context is re-validated below exactly like a
              // scan-provided one: same page generation, same M8 raw-value
              // firewall. Nothing here can weaken the security boundary.
              if (!semanticUnderstanding && worldModel) {
                const fallbackGeneration = worldModel.page.pageGeneration;
                try {
                  const rebuilt = (await withTimeout(
                    chrome.tabs.sendMessage(targetTabId, {
                      type: 'PRIVAGENT_SEMANTIC_REQUEST',
                      pageGeneration: fallbackGeneration,
                    }),
                    10000,
                    'Semantic rebuild timed out (10s).'
                  )) as {
                    semanticUnderstanding?: SemanticUnderstandingOutput;
                    semanticContext?: SanitizedSemanticContext;
                    error?: string;
                  } | null;

                  if (!rebuilt?.semanticUnderstanding || !rebuilt.semanticContext) {
                    throw new Error(
                      `Content-script semantic rebuild unavailable${rebuilt?.error ? `: ${rebuilt.error}` : '.'}`
                    );
                  }
                  if (rebuilt.semanticContext.pageGeneration !== fallbackGeneration) {
                    throw new Error(
                      'Semantic rebuild generation mismatch against the live world model.'
                    );
                  }
                  const violations = scanForRawSensitiveValues(rebuilt.semanticContext);
                  if (violations.length > 0) {
                    throw new Error('Rebuilt semantic context failed M8 privacy firewall.');
                  }

                  semanticUnderstanding = rebuilt.semanticUnderstanding;
                  semanticContext = rebuilt.semanticContext;
                } catch (semErr) {
                  console.warn(
                    '[PrivAgent SW] content-script semantic rebuild unavailable, falling back to world-model-only build:',
                    semErr instanceof Error ? semErr.message : String(semErr)
                  );
                  try {
                    semanticUnderstanding = buildSemanticUnderstanding({
                      worldModel,
                      pageGeneration: fallbackGeneration,
                      userGoal: task,
                    });
                    semanticContext = semanticUnderstanding.sanitizedContext;
                  } catch (semErr2) {
                    console.warn('[PrivAgent SW] local semantic understanding build failed:', semErr2 instanceof Error ? semErr2.message : String(semErr2));
                    semanticUnderstanding = undefined;
                    semanticContext = undefined;
                  }
                }
              }

              // Multimodal Perception Coordination (Stage 3)
              let visualReport: VisualCaptureReport | null = null;
              let latestOcrObservation: OCRObservation | undefined = undefined;
              try {
                const targetTab = await chrome.tabs.get(targetTabId);
                // Ensure target tab is active before captureVisibleTab so the screenshot captures targetTab and not dashboard or background tab!
                if (targetTab?.id && !targetTab.active) {
                  try {
                    await chrome.tabs.update(targetTab.id, { active: true });
                    await new Promise((r) => setTimeout(r, 120));
                  } catch (actErr) {
                    console.warn('[PrivAgent SW] Target tab activation failed before capture:', actErr);
                  }
                }
                const coordination = await coordinateMultimodalPerception({
                  tabId: targetTabId,
                  windowId: targetTab?.windowId,
                  documentUrl: targetTab?.url,
                  taskDescription: task,
                  scanReport: scanRes.report,
                  pageGeneration: worldModel?.page.pageGeneration ?? 1,
                  // Phase 16 P0 remediation: the real, observed viewport
                  // position. Undefined keeps the coordinator's previous
                  // behaviour, so a page that cannot be read is unchanged.
                  geometry: (await readLiveViewportGeometry(targetTabId)) ?? undefined,
                  ocrEngine: sharedOffscreenOcrEngine,
                  isDashboardUrl: (url) => isDashboardUrl(url, dashboardOrigin),
                });
                visualReport = coordination.visualReport;
                latestOcrObservation = coordination.ocrObservation;
                if (worldModel) {
                  enrichWorldModelWithMultimodalPerception(worldModel, coordination);
                }
                console.info('[AgentTrace] multimodal perception complete', {
                  visualDetections: visualReport.visualDetections.length,
                  screenshotWidth: visualReport.captureMetadata.screenshotWidth,
                  screenshotHeight: visualReport.captureMetadata.screenshotHeight,
                  ocrRegions: coordination.ocrRegions.length,
                  privacyFindings: coordination.privacyFindings.length,
                  ocrObservationState: coordination.ocrObservation?.state,
                });
              } catch (multiErr) {
                console.warn('[PrivAgent SW] multimodal coordination skipped:', multiErr);
              }

              //
              // POST-17.9. Semantic observation.
              //
              // Built only from data the privacy pipeline has ALREADY sanitized
              // (the world model's M8-screened text regions), stamped with this
              // tab's authoritative identity, and attached to the context. The
              // sanitized FACTS ride inside the existing `semantic_context`
              // envelope, so the reasoner gains no new text channel; the
              // PROVENANCE stays device-local, is what goal verification needs, and
              // is stripped at the egress boundary.
              //
              // Evidence only: nothing downstream of perception authorizes on it.
              let tabDocumentUrl: string | null = null;
              try {
                const tabForObservation = await chrome.tabs.get(targetTabId);
                tabDocumentUrl =
                  tabForObservation?.url || (tabForObservation as { pendingUrl?: string })?.pendingUrl || null;
              } catch {
                tabDocumentUrl = null;
              }
              const semanticObservation = buildSemanticObservation({
                worldModel,
                semanticContext,
                tabId: targetTabId,
                documentUrl: tabDocumentUrl,
                pageGeneration: worldModel?.page.pageGeneration ?? 1,
              });
              if (semanticContext && semanticObservation.facts.length > 0) {
                semanticContext.facts = toSanitizedFacts(semanticObservation.facts);
              }
              console.info('[AgentTrace] semantic observation', {
                state: semanticObservation.state,
                facts: semanticObservation.facts.length,
                regionsConsidered: semanticObservation.regionsConsidered,
                droppedSensitive: semanticObservation.droppedSensitiveCount,
                quarantinedInjection: semanticObservation.quarantinedInjectionCount,
                latencyMs: semanticObservation.latencyMs,
              });

              // PHASE 18.7 / A2 — ingest into the task's evidence ledger. Counts
              // and rule-free metadata only; no claim text is ever logged.
              const ingested = activeEvidenceLedger.ingestObservation(
                semanticObservation,
                String(semanticObservation.provenance?.documentUrl ?? '')
              );
              console.info('[AgentTrace] evidence ledger updated', {
                ingested,
                ledgerSize: activeEvidenceLedger.size,
                // PHASE 18.8 / A10-F1. Counts only — no claim text is ever
                // logged. This is the number the A5 evidence gate and the
                // terminal ANSWER verifier read from the same ledger.
                verifiedCurrent: activeEvidenceLedger
                  .citable()
                  .filter((r) => r.verificationStatus === 'VERIFIED').length,
                generation: semanticObservation.provenance?.pageGeneration ?? null,
              });

              console.info('[ServiceWorker] response forwarded');
              const built = buildAgentPayload(scanRes.report, visualReport, semanticContext);
              if (!built) return null;
              built.semanticObservation = semanticObservation;

              const minimized = minimizeAgentContext(built, { task });
              //
              // PHASE 17.1 (C6). `built.viewport` is an all-zero DEFAULT when
              // no geometry could be obtained, and the goal verifier reads it.
              // That ambiguity is resolved HERE, locally, after the egress
              // allowlist has run — so the flags describe this device's reading
              // and never travel to the model or the backend.
              //
              (minimized.payload as { viewportObservable?: boolean }).viewportObservable =
                visualReport !== null;
              (minimized.payload as { viewportSource?: string }).viewportSource =
                visualReport !== null ? 'MULTIMODAL_REPORT' : 'UNAVAILABLE';
              (minimized.payload as { ocr_observation?: OCRObservation }).ocr_observation =
                latestOcrObservation;
              return {
                context: minimized.payload,
                worldModel,
                activeWorldModelRef: worldModel ? (scanRes.activeWorldModelRef ?? { pageGeneration: worldModel.page.pageGeneration, worldModelId: worldModel.id }) : undefined,
                semanticUnderstanding,
                semanticContext,
              };
            } catch (err) {
              console.error('[PrivAgent SW] perceivePage error:', err);
              return null;
            }
          },

          executeAction: async (action: BrowserAction) => {
            if (taskOwnershipToken !== activeTaskRunId || activeLoop?.isHalted()) {
              console.warn('[PrivAgent SW] Suppressed action from superseded task loop', {
                taskOwnershipToken,
                activeTaskRunId,
              });
              return { success: false, error: 'TASK_SUPERSEDED' };
            }
            try {
              // ── Phase 12 Containment at the DISPATCH boundary ──────────────
              // Defence in depth: the AgentLoop already evaluated containment
              // before dispatch, but the dispatcher is the last place the agent
              // could touch a real tab, so the boundary is re-checked here
              // against the LIVE tab state. This can only refuse.
              let liveTabUrl: string | null = null;
              try {
                const liveTab = await chrome.tabs.get(targetTabId);
                liveTabUrl = liveTab?.url || (liveTab as any)?.pendingUrl || null;
              } catch {
                liveTabUrl = null;
              }
              const dispatchCheck = evaluateContainment({
                action,
                scope: containmentScope,
                targetTabId,
                liveUrl: liveTabUrl,
              });
              if (!dispatchCheck.contained) {
                console.warn('[PrivAgent SW] ACTION_BLOCKED_BY_CONTAINMENT', {
                  code: dispatchCheck.code,
                  actionType: action.action,
                });
                return {
                  success: false,
                  error: `CONTAINMENT_DENIED: ${dispatchCheck.reason}`,
                  containmentDenied: true,
                  containmentCode: dispatchCheck.code,
                };
              }

              const execRes = (await withTimeout(
                chrome.tabs.sendMessage(targetTabId, { type: 'PRIVAGENT_EXECUTE_ACTION', action }),
                10000,
                'Browser action execution timed out (10s).'
              )) as { result?: { success: boolean; error?: string } } | null;

              if (execRes?.result && execRes.result.success) {
                return { success: true };
              }
              return {
                success: false,
                error: execRes?.result?.error || 'Execution returned false',
              };
            } catch (err) {
              return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          },

          onNavigationComplete: async (destination: string): Promise<boolean> => {
            console.info('[AgentTrace] onNavigationComplete', { destination, targetTabId });

            // Step 1: Wait for the tab to reach loading=complete.
            // Uses race-condition-safe waitForTabLoad that checks current state first.
            const loaded = await waitForTabLoad(targetTabId, 8000);
            if (!loaded) {
              console.error('[PrivAgent SW] onNavigationComplete: tab load timed out', { targetTabId, destination });
              return false;
            }
            console.info('[AgentTrace] POST_NAVIGATION_TAB_LOADED', { targetTabId });

            // Step 2: Verify the tab actually landed on the intended destination.
            // Guards against: redirects, CSP blocks, network errors that left the
            // tab on an error page, or a fast navigation that went somewhere else.
            try {
              const tab = await chrome.tabs.get(targetTabId);
              const actualUrl = tab.url || (tab as any).pendingUrl || '';
              const destOrigin = (() => { try { return new URL(destination).hostname; } catch { return destination; } })();
              const actualOrigin = (() => { try { return new URL(actualUrl).hostname; } catch { return actualUrl; } })();

              // ── Phase 12 Containment holds ACROSS the navigation ────────────
              // A site that redirects the agent to another origin has moved the
              // environment. Containment refuses to let the task continue there.
              const landing = verifyNavigationContainment(containmentScope, actualUrl);
              if (!landing.contained) {
                console.error('[PrivAgent SW] onNavigationComplete: landing left containment scope', {
                  code: landing.code,
                });
                return false;
              }

              // Allow for www. prefix differences and subdomains of the same domain.
              // e.g. google.com and www.google.com are the same destination.
              const destinationMatches =
                actualOrigin === destOrigin ||
                actualOrigin.endsWith('.' + destOrigin) ||
                destOrigin.endsWith('.' + actualOrigin);

              console.info('[AgentTrace] POST_NAVIGATION_URL_VERIFY', {
                destination,
                destOrigin,
                actualOrigin,
                destinationMatches,
              });

              if (!destinationMatches) {
                console.error(
                  '[PrivAgent SW] onNavigationComplete: destination mismatch after load. ' +
                  `Expected: ${destOrigin} | Actual: ${actualOrigin}`
                );
                return false;
              }
            } catch (e) {
              console.warn('[PrivAgent SW] onNavigationComplete: URL verification failed', { err: String(e) });
              // Non-fatal: proceed to content script injection.
            }

            // Step 3: Re-inject content script on the new page.
            // The old content script was torn down when the page unloaded.
            const ready = await ensureTargetTabReady(targetTabId);
            console.info('[AgentTrace] POST_NAVIGATION_CONTENT_SCRIPT_READY', { targetTabId, ready });
            return ready;
          },

          // ── Observed effect snapshots (M10 production path) ──────────────
          //
          // This is the ONLY source of post-dispatch state in the product. It
          // reads the ACTUAL target tab through the content script, so an action
          // that dispatched successfully but changed nothing is observable as
          // unchanged. Returns null (never a guess) whenever the state cannot be
          // observed; the loop then fails closed rather than deriving the
          // post-state from the action that was requested.
          //
          // The URL comes from Chrome's own tab record as well as the page, so a
          // navigation that replaced the content script is still captured.
          getEffectSnapshot: async (target?: string) => {
            try {
              // Phase 16 P1 remediation. Chrome's tab record is AUTHORITATIVE for
              // navigation state. pendingUrl is consulted explicitly: during a
              // navigation tab.url is still the OLD document while pendingUrl
              // holds the destination, and the previous `url || pendingUrl`
              // short-circuited on the stale-but-truthy url and never saw it.
              const tabRecord = (await withTimeout(
                (async () => {
                  const tab = await chrome.tabs.get(targetTabId);
                  return {
                    url: tab?.url ?? null,
                    pendingUrl: (tab as any)?.pendingUrl ?? null,
                    status: tab?.status ?? null,
                    // PHASE 17.1 (C7): observed from Chrome, never inferred.
                    title: tab?.title ?? null,
                  };
                })(),
                2000,
                'Tab URL read timed out'
              )) as { url: string | null; pendingUrl: string | null; status: string | null; title: string | null };

              const chromeUrl = tabRecord.pendingUrl || tabRecord.url || null;

              // Phase 16 P1 remediation. A navigation tears the content script down:
              // Chrome reports the page moved into the back/forward cache and
              // closed the message port. That is EXPECTED mid-navigation and is
              // NOT evidence that the action failed. Previously this rejection
              // propagated to the outer catch, the whole snapshot was discarded,
              // and a navigation that demonstrably happened was reported
              // ACTION_NO_EFFECT. Degrade to "no page-side reading" and use
              // Chrome's authoritative tab record below.
              const res = await withTimeout(
                chrome.tabs.sendMessage(targetTabId, {
                  type: 'PRIVAGENT_GET_EFFECT_SNAPSHOT',
                  target,
                }),
                3000,
                'Effect snapshot timed out (3s).'
              ).catch(() => {
                console.info(
                  '[PrivAgent SW] effect snapshot: content script unavailable (navigation/bfcache); using chrome.tabs'
                );
                return null;
              }) as { snapshot?: Record<string, unknown> } | null;

              const snap = res?.snapshot;
              // Inlined rather than hoisted into a boolean so TypeScript keeps
              // the narrowing of snap.url / snap.scrollY below.
              const pageReadingUsable =
                !!snap &&
                typeof snap.url === 'string' &&
                typeof snap.scrollX === 'number' &&
                typeof snap.scrollY === 'number' &&
                typeof snap.domElementCount === 'number';
              const pageSnap = pageReadingUsable
                ? (snap as {
                    url: string;
                    scrollX: number;
                    scrollY: number;
                    domElementCount: number;
                    openModalsCount?: number;
                    targetValueLength?: number;
                    activeElementSelector?: string;
                    timestamp?: number;
                    pageGeneration?: number;
                  })
                : null;

              // The page could not be read, but Chrome still authoritatively
              // knows where the tab is. Report THAT rather than discarding it.
              // This is an OBSERVATION only: it authorizes nothing, and goal
              // verification still decides whether the user's goal was met.
              // Page-side geometry is NOT invented — only the URL is a real
              // reading, and `pageStateObservable: false` says so.
              if (!pageReadingUsable) {
                if (!chromeUrl) {
                  console.warn(
                    '[PrivAgent SW] effect snapshot unavailable from BOTH chrome.tabs and the page; failing closed'
                  );
                  return null;
                }
                console.info('[AgentTrace] effect snapshot observed (tab-authoritative, page unavailable)', {
                  phase: target ? 'targeted' : 'untargeted',
                  url: chromeUrl,
                  tabStatus: tabRecord.status,
                });
                return {
                  url: chromeUrl,
                  scrollX: 0,
                  scrollY: 0,
                  // PHASE 17.1 (C5): `null`, not 0 — the target's length was
                  // never observed, so it is not an observed zero.
                  targetValueLength: null,
                  openModalsCount: 0,
                  activeElementSelector: undefined,
                  domElementCount: 0,
                  timestamp: Date.now(),
                  pageStateObservable: false,
                  // PHASE 17.1 (C7): the tab title is a real chrome.tabs
                  // reading and was previously discarded.
                  title: tabRecord.title,
                  observation: {
                    observedAt: Date.now(),
                    tabId: targetTabId,
                    pageGeneration: null,
                    tabLifecycleObserved: true,
                    pageReadable: false,
                    fields: tabOnlySnapshotFields(),
                  },
                };
              }

              // Chrome's tab URL wins: it reflects the tab even if the content
              // script was torn down and reinjected mid-navigation.
              const observedUrl = chromeUrl || pageSnap!.url;
              console.info('[AgentTrace] effect snapshot observed', {
                phase: target ? 'targeted' : 'untargeted',
                url: observedUrl,
                scrollY: pageSnap!.scrollY,
                domElementCount: pageSnap!.domElementCount,
                openModalsCount: pageSnap!.openModalsCount,
                targetValueLength: pageSnap!.targetValueLength,
              });

              return {
                url: observedUrl,
                scrollX: pageSnap!.scrollX,
                scrollY: pageSnap!.scrollY,
                // PHASE 17.1 (C5): pass `null` through as `null`. A missing
                // length is not a length of zero.
                targetValueLength:
                  typeof pageSnap!.targetValueLength === 'number' ? pageSnap!.targetValueLength : null,
                openModalsCount:
                  typeof pageSnap!.openModalsCount === 'number' ? pageSnap!.openModalsCount : 0,
                activeElementSelector:
                  typeof pageSnap!.activeElementSelector === 'string'
                    ? pageSnap!.activeElementSelector
                    : undefined,
                domElementCount: pageSnap!.domElementCount,
                timestamp:
                  typeof pageSnap!.timestamp === 'number' ? pageSnap!.timestamp : Date.now(),
                title: tabRecord.title,
                // PHASE 17.1 (C4): the page WAS read, so every page-local field
                // is OBSERVED. `targetValueLength` is the one exception the
                // content script itself resolves: it reports null when the
                // target is not locatable.
                observation: {
                  observedAt:
                    typeof pageSnap!.timestamp === 'number' ? pageSnap!.timestamp : Date.now(),
                  tabId: targetTabId,
                  pageGeneration: pageSnap!.pageGeneration ?? null,
                  tabLifecycleObserved: true,
                  pageReadable: true,
                  fields: {
                    ...observedSnapshotFields(),
                    targetValueLength: (typeof pageSnap!.targetValueLength === 'number'
                      ? 'OBSERVED'
                      : 'UNAVAILABLE') as ObservationState,
                  },
                },
              };
            } catch (err) {
              console.warn(
                '[PrivAgent SW] effect snapshot unavailable:',
                err instanceof Error ? err.message : String(err)
              );
              return null;
            }
          },

          onStepProgress: (state: TaskState) => {
            if (taskOwnershipToken !== activeTaskRunId) {
              console.warn('[PrivAgent SW] Suppressed step progress from superseded task loop', {
                taskOwnershipToken,
                activeTaskRunId,
              });
              return;
            }
            sendToDashboard({ ...state, runId: taskOwnershipToken }, dashboardTabId);
          },
          // PHASE 18.8 / B2. The loop reports its bounded conversation updates;
          // the worker owns the lifetime. A superseded turn can never write one,
          // which is what keeps an old run from overwriting the current
          // conversation.
          onConversationUpdate: (context: ConversationContext) => {
            if (taskOwnershipToken !== activeTaskRunId) return;
            activeConversation = context;
            void conversationStore.save(context);
          },
        };

        if (taskOwnershipToken !== activeTaskRunId) {
          console.info('[PrivAgent SW] Task aborted before loop creation (superseded)', {
            taskOwnershipToken,
            activeTaskRunId,
          });
          return;
        }

        // Real provider: backend Gemma (or fallback to configured provider)
        const provider = new ModelRouter(createAgentProvider({ provider: 'backend' }));

        // Phase 13: arm the Harness. It is the AgentLoop's CYCLE COORDINATION
        // and runtime-state observation layer only — it holds no security
        // authority, grants nothing, and authorizes no action. Arming it here
        // changes no gate: Grounding, M5, the Security Critic, the Privacy
        // Firewall, Risk/Confirmation, Phase 12 Containment, Effect
        // Verification, Goal Verification and the Recovery Engine all remain
        // authoritative and unreordered. The live dispatch-time containment
        // check in executeAction below is likewise untouched.
        const thisLoop = new AgentLoop(provider, loopCallbacks, {
          runId: taskOwnershipToken,
          maxSteps: 10,
          maxRetries: 2,
          delayBetweenStepsMs: 500,
          providerRetries: 2,
          targetTabId,
          containmentScope,
          harness: new AgentHarness(),
          longHorizonStore: createSessionStore(),
          // PHASE 18.7 / A2. One ledger per task, created at task start and
          // ingested on every perception below. It is handed to the loop so the
          // decision state and information completion read the SAME store —
          // there is no parallel evidence store anywhere in the system.
          evidenceLedger: activeEvidenceLedger,
          // PHASE 18.8 / B2. The conversation this turn belongs to, decided above
          // by `planConversation`. `null` for a one-shot task, which leaves every
          // single-turn path exactly as it was.
          conversationContext: turnConversation,
          //
          // PHASE 18.7 (A3). The SAME frozen decision object from the boundary —
          // carried, never re-derived, so the model-facing decision state cannot
          // disagree with what admission actually decided.
          //
          intentDecision,
          initialUrl: targetTab.url || (targetTab as any).pendingUrl || undefined,
        });
        activeLoop = thisLoop;
        (globalThis as any).__privagentActiveLoop = thisLoop;

        console.info('[AgentTrace] agent loop started', { runId: taskOwnershipToken });
        const finalState = await thisLoop.runTask(task);
        (globalThis as any).__privagentLastState = finalState;
        if (taskOwnershipToken !== activeTaskRunId) {
          console.info('[AgentTrace] terminal progress suppressed (task superseded)', {
            taskOwnershipToken,
            activeTaskRunId,
          });
          return;
        }
        console.info('[AgentTrace] terminal progress emitted', { status: finalState.status, runId: taskOwnershipToken });
        await sendToDashboard({ ...finalState, runId: taskOwnershipToken }, dashboardTabId);
      } catch (err) {
        if (taskOwnershipToken !== activeTaskRunId) {
          return;
        }
        const errReason = err instanceof Error ? err.message : String(err);
        console.error('[AgentTrace] M6 failed', { reason: errReason });
        console.info('[AgentTrace] terminal progress emitted', { status: 'FAILED' });
        await sendToDashboard(
          {
            status: 'FAILED',
            currentStep: activeLoop?.getState().currentStep || 0,
            maxSteps: 10,
            task,
            steps: activeLoop?.getState().steps || [],
            reason: errReason,
            runId: taskOwnershipToken,
            conversation: activeLoop?.getState().conversation ?? null,
          },
          dashboardTabId
        );
      }
    })();

    return true; // Keep message channel open for async response
  }

  // ── Stop real task execution ─────────────────────────────────────────────
  if (message.type === 'PRIVAGENT_DASHBOARD_STOP_TASK') {
    activeTaskRunId++;
    if (activeLoop) {
      activeLoop.stop();
      activeLoop = null;
    }
    sendResponse({ stopped: true });
    return false;
  }

  // ── Confirm action ───────────────────────────────────────────────────────
  if (message.type === 'PRIVAGENT_DASHBOARD_CONFIRM_ACTION') {
    if (activeLoop) {
      if (message.allowed) {
        activeLoop.resumeWithConfirmation().catch((err) => {
          console.error('[PrivAgent SW] resume confirmation error:', err);
        });
      } else {
        activeLoop.stop();
      }
    }
    sendResponse({ handled: true });
    return false;
  }

  return false;
});
