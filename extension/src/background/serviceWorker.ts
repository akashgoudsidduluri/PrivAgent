import { AgentLoop, TaskState } from '../agent/agentLoop';
import { createAgentProvider } from '../agent/providerRegistry';
import { ModelRouter } from '../agent/modelRouter';
import { buildAgentPayload, PrivacyScanReport, AgentContextPayload, VisualCaptureReport } from '../privacy/types';
import { minimizeAgentContext } from '../privacy/contextMinimizer';
import { BrowserAction } from '../agent/actionTypes';
import { resolveTargetWebTab, isEligibleWebTab, isDashboardUrl } from './targetResolver';
import { BrowserWorldModel, ActiveWorldModelRef } from '../worldModel/types';
import { assertWorldModelSafe } from '../worldModel/worldModelSanitizer';
import { buildSemanticUnderstanding, SemanticUnderstandingOutput, SanitizedSemanticContext } from '../semanticUnderstanding';
import { scanForRawSensitiveValues } from '../privacy/rawValueScanner';
import { coordinateMultimodalPerception, enrichWorldModelWithMultimodalPerception } from '../visualPerception/multimodalCoordinator';

// PrivAgent Background Service Worker (Manifest V3)
let activeLoop: AgentLoop | null = null;
let currentDashboardTabId: number | null = null;

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
    if (sender.tab?.id) currentDashboardTabId = sender.tab.id;

    (async () => {
      try {
        console.info('TARGET_RESOLUTION_STARTED');
        const allTabs = await chrome.tabs.query({});
        const resolution = resolveTargetWebTab(
          allTabs,
          task,
          message.originUrl || 'http://localhost:5173',
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
          if (provisioned) {
            targetTab = provisioned;
          } else {
            console.info('TARGET_TAB_FAILED: provisioning did not yield a ready tab');
          }
        }

        if (dashboardTabId && targetTab?.id === dashboardTabId) {
          targetTab = null;
        }

        if (!targetTab || !targetTab.id) {
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
            },
            dashboardTabId
          );
          return;
        }

        // Stable target: pinned here and never re-resolved for the life of the task.
        const targetTabId = targetTab.id;
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

              // Fallback / calibration: If semantic understanding was not provided by scan, build directly from live world model
              if (!semanticUnderstanding && worldModel) {
                try {
                  semanticUnderstanding = buildSemanticUnderstanding({
                    worldModel,
                    pageGeneration: worldModel.page.pageGeneration,
                    userGoal: task,
                  });
                  semanticContext = semanticUnderstanding.sanitizedContext;
                } catch (semErr) {
                  console.warn('[PrivAgent SW] local semantic understanding build failed:', semErr instanceof Error ? semErr.message : String(semErr));
                  semanticUnderstanding = undefined;
                  semanticContext = undefined;
                }
              }

              // Multimodal Perception Coordination (Stage 3)
              let visualReport: VisualCaptureReport | null = null;
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
                  scanReport: scanRes.report,
                  pageGeneration: worldModel?.page.pageGeneration ?? 1,
                });
                visualReport = coordination.visualReport;
                if (worldModel) {
                  enrichWorldModelWithMultimodalPerception(worldModel, coordination);
                }
                console.info('[AgentTrace] multimodal perception complete', {
                  visualDetections: visualReport.visualDetections.length,
                  screenshotWidth: visualReport.captureMetadata.screenshotWidth,
                  screenshotHeight: visualReport.captureMetadata.screenshotHeight,
                  ocrRegions: coordination.ocrRegions.length,
                  privacyFindings: coordination.privacyFindings.length,
                });
              } catch (multiErr) {
                console.warn('[PrivAgent SW] multimodal coordination skipped:', multiErr);
              }

              console.info('[ServiceWorker] response forwarded');
              const built = buildAgentPayload(scanRes.report, visualReport, semanticContext);
              if (!built) return null;

              const minimized = minimizeAgentContext(built, { task });
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
            try {
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

          onStepProgress: (state: TaskState) => {
            sendToDashboard(state, dashboardTabId);
          },
        };

        // Real provider: backend Gemma (or fallback to configured provider)
        const provider = new ModelRouter(createAgentProvider({ provider: 'backend' }));

        activeLoop = new AgentLoop(provider, loopCallbacks, {
          maxSteps: 10,
          maxRetries: 2,
          delayBetweenStepsMs: 500,
          providerRetries: 0,
          targetTabId,
        });

        console.info('[AgentTrace] agent loop started');
        const finalState = await activeLoop.runTask(task);
        console.info('[AgentTrace] terminal progress emitted', { status: finalState.status });
        await sendToDashboard(finalState, dashboardTabId);
      } catch (err) {
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
          },
          dashboardTabId
        );
      }
    })();

    return true; // Keep message channel open for async response
  }

  // ── Stop real task execution ─────────────────────────────────────────────
  if (message.type === 'PRIVAGENT_DASHBOARD_STOP_TASK') {
    if (activeLoop) {
      activeLoop.stop();
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
