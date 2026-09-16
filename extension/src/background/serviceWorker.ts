import { AgentLoop, TaskState } from '../agent/agentLoop';
import { createAgentProvider } from '../agent/providerRegistry';
import { buildAgentPayload, PrivacyScanReport, AgentContextPayload } from '../privacy/types';
import { minimizeAgentContext } from '../privacy/contextMinimizer';
import { BrowserAction } from '../agent/actionTypes';
import { resolveTargetWebTab, isEligibleWebTab } from './targetResolver';

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
 * Message handler — routes messages from content scripts, popup, and dashboard.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ── Handshake from dashboard or popup ──────────────────────────────────────
  if (message.type === 'PRIVAGENT_DASHBOARD_PING') {
    (async () => {
      try {
        const allTabs = await chrome.tabs.query({});
        const candidate = allTabs.find((t) => {
          const uStr = t.url || (t as any).pendingUrl;
          if (!uStr) return false;
          try {
            const u = new URL(uStr);
            return u.port === '4173' || (u.hostname === 'localhost' && u.port === '4173');
          } catch {
            return false;
          }
        }) || allTabs.find((t) => isEligibleWebTab(t));

        const targetFound = Boolean(candidate?.id);
        let csResponsive = false;
        const candidateUrl = candidate?.url || (candidate as any)?.pendingUrl;
        const urlOrigin = candidateUrl ? new URL(candidateUrl).origin : 'http://localhost:4173';

        if (candidate?.id) {
          csResponsive = await ensureTargetTabReady(candidate.id);
        }

        sendResponse({
          connected: true,
          version: '0.4.0',
          serviceWorker: 'REACHABLE',
          targetTab: targetFound ? (csResponsive ? 'FOUND' : 'NOT_READY') : 'NOT_FOUND',
          contentScript: csResponsive ? 'REACHABLE' : 'NOT_INJECTED',
          urlOrigin,
          pageReady: csResponsive,
        });
      } catch (e) {
        sendResponse({
          connected: true,
          version: '0.4.0',
          serviceWorker: 'REACHABLE',
          targetTab: 'NOT_FOUND',
          contentScript: 'NOT_INJECTED',
          urlOrigin: 'http://localhost:4173',
          pageReady: false,
        });
      }
    })();
    return true; // Keep message channel open for async response
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
        const resolution = resolveTargetWebTab(allTabs, task, message.originUrl || 'http://localhost:5173');

        // Safe diagnostics: strictly tab IDs & origins only
        console.info('TARGET_TAB_CANDIDATES', resolution.discoveredTabs.map((t) => ({ id: t.id, origin: t.origin })));

        const targetTab = resolution.selectedTab;
        if (!targetTab || !targetTab.id) {
          console.info('TARGET_TAB_FAILED: no eligible tab found');
          console.info('[AgentTrace] terminal progress emitted', { status: 'FAILED' });
          const failReason = resolution.reason || 'No target web tab found. Please open http://localhost:4173.';
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

        const targetTabId = targetTab.id;
        console.info('TARGET_TAB_SELECTED', {
          tabId: targetTabId,
          origin: targetTab.url ? new URL(targetTab.url).origin : null,
          reason: resolution.reason,
        });
        console.info('[AgentTrace] target resolved', { tabId: targetTabId });

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
            steps: [],
            reason: 'Target tab discovered and ready. Starting visual privacy perception...',
          },
          dashboardTabId
        );

        const loopCallbacks = {
          perceivePage: async (): Promise<AgentContextPayload | null> => {
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
              )) as { report?: PrivacyScanReport } | null;

              if (!scanRes?.report) return null;
              console.info('[ServiceWorker] response forwarded');
              const built = buildAgentPayload(scanRes.report, null);
              if (!built) return null;
              return minimizeAgentContext(built, { task }).payload;
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

          onStepProgress: (state: TaskState) => {
            sendToDashboard(state, dashboardTabId);
          },
        };

        // Real provider: backend Gemma (or fallback to configured provider)
        const provider = createAgentProvider({ provider: 'backend' });

        activeLoop = new AgentLoop(provider, loopCallbacks, {
          maxSteps: 10,
          maxRetries: 2,
          delayBetweenStepsMs: 500,
          providerRetries: 0,
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
