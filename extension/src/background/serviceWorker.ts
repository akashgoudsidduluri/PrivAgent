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

async function sendToDashboard(payload: any, preferredTabId?: number | null): Promise<void> {
  console.info('[ServiceWorker] response forwarded', {
    status: payload?.status,
    currentStep: payload?.currentStep,
    reason: payload?.reason,
  });

  let sent = false;
  let targetId = preferredTabId || currentDashboardTabId;

  if (targetId) {
    try {
      await chrome.tabs.sendMessage(targetId, {
        type: 'PRIVAGENT_DASHBOARD_PROGRESS',
        payload,
      });
      sent = true;
    } catch {
      // Preferred tab failed, fallback to querying all dashboard tabs
    }
  }

  if (!sent) {
    try {
      const tabs = await chrome.tabs.query({});
      const dashTabs = tabs.filter(
        (t) => t.id && t.url && (t.url.includes(':5173') || t.url.includes('5173'))
      );
      for (const dTab of dashTabs) {
        if (dTab.id) {
          try {
            await chrome.tabs.sendMessage(dTab.id, {
              type: 'PRIVAGENT_DASHBOARD_PROGRESS',
              payload,
            });
            currentDashboardTabId = dTab.id;
            sent = true;
          } catch {
            try {
              await ensureTargetTabReady(dTab.id);
              await chrome.tabs.sendMessage(dTab.id, {
                type: 'PRIVAGENT_DASHBOARD_PROGRESS',
                payload,
              });
              currentDashboardTabId = dTab.id;
              sent = true;
            } catch {
              // Ignore single tab attempt failure
            }
          }
        }
      }
    } catch {
      // Query error
    }
  }
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
          if (!t.url) return false;
          try {
            const u = new URL(t.url);
            return u.port === '4173' || (u.hostname === 'localhost' && u.port === '4173');
          } catch {
            return false;
          }
        }) || allTabs.find((t) => isEligibleWebTab(t));

        const targetFound = Boolean(candidate?.id);
        let csResponsive = false;
        const urlOrigin = candidate?.url ? new URL(candidate.url).origin : 'http://localhost:4173';

        if (candidate?.id) {
          csResponsive = await ensureTargetTabReady(candidate.id);
        }

        sendResponse({
          connected: true,
          version: '0.4.0',
          serviceWorker: 'REACHABLE',
          targetTab: targetFound ? 'FOUND' : 'NOT_FOUND',
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
    console.info('[AgentTrace] dashboard START_TASK received');
    const task = message.task as string;
    const dashboardTabId = sender.tab?.id || currentDashboardTabId;
    if (sender.tab?.id) currentDashboardTabId = sender.tab.id;

    // Send immediate acknowledgement
    sendResponse({ started: true });

    (async () => {
      try {
        console.info('[Adapter] target resolution started');
        const allTabs = await chrome.tabs.query({});
        const resolution = resolveTargetWebTab(allTabs, task, message.originUrl || 'http://localhost:5173');

        // Safe diagnostics: strictly tab IDs & origins only
        console.info('[Adapter] candidate tab IDs:', resolution.discoveredTabs.map((t) => t.id));
        console.info('[Adapter] candidate origins:', resolution.discoveredTabs.map((t) => t.origin));
        console.info('[Adapter] target tab selected', {
          tabId: resolution.selectedTab?.id,
          origin: resolution.selectedTab?.url ? new URL(resolution.selectedTab.url).origin : null,
          reason: resolution.reason,
        });

        const targetTab = resolution.selectedTab;
        if (!targetTab || !targetTab.id) {
          await sendToDashboard(
            {
              status: 'FAILED',
              currentStep: 0,
              maxSteps: 10,
              task,
              steps: [],
              reason: resolution.reason || 'No browser tab is available for this task. Open the webpage you want PrivAgent to work with and try again.',
            },
            dashboardTabId
          );
          return;
        }

        const targetTabId = targetTab.id;
        console.info('[AgentTrace] target tab resolved', {
          tabId: targetTabId,
          origin: targetTab.url ? new URL(targetTab.url).origin : null,
        });

        // Ensure content script is active and responsive in the target tab
        const isReady = await ensureTargetTabReady(targetTabId);
        if (!isReady) {
          console.warn('[AgentTrace] target tab unresponsive');
          await sendToDashboard(
            {
              status: 'FAILED',
              currentStep: 0,
              maxSteps: 10,
              task,
              steps: [],
              reason: 'Target web tab content script is absent or cannot be scripted. Please refresh the target tab and try again.',
            },
            dashboardTabId
          );
          return;
        }
        console.info('[AgentTrace] target tab ready');

        // Initial progress update to dashboard: discovery verified, perception starting
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
              console.info('[ServiceWorker] message received: perceivePage');
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

        console.info('[AgentTrace] M6 loop started');
        const finalState = await activeLoop.runTask(task);
        if (finalState.status === 'SUCCESS') {
          console.info('[AgentTrace] M6 completed');
        } else if (finalState.status === 'FAILED') {
          console.info('[AgentTrace] M6 failed', { reason: finalState.reason });
        }
        await sendToDashboard(finalState, dashboardTabId);
      } catch (err) {
        const errReason = err instanceof Error ? err.message : String(err);
        console.info('[AgentTrace] M6 failed', { reason: errReason });
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

    return false;
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
