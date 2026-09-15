import { AgentLoop, TaskState } from '../agent/agentLoop';
import { createAgentProvider } from '../agent/providerRegistry';
import { buildAgentPayload, PrivacyScanReport, AgentContextPayload } from '../privacy/types';
import { minimizeAgentContext } from '../privacy/contextMinimizer';
import { BrowserAction } from '../agent/actionTypes';
import { resolveTargetWebTab } from './targetResolver';

// PrivAgent Background Service Worker (Manifest V3)
let activeLoop: AgentLoop | null = null;
let currentDashboardTabId: number | null = null;

chrome.runtime.onInstalled.addListener(() => {
  console.info('[PrivAgent] Background Service Worker installed successfully.');
  chrome.action.setBadgeText({ text: 'ON' });
  chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
});

/**
 * Ensures the target tab has the content script injected and responsive.
 * If the tab was opened prior to extension reload, dynamically injects contentScript.
 */
async function ensureTargetTabReady(tabId: number): Promise<boolean> {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'PRIVAGENT_GET_VIEWPORT_GEOMETRY' });
    if (res) return true;
  } catch {
    // Content script not yet attached; inject dynamically
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['contentScript.js'],
      });
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['contentStyles.css'],
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      return true;
    } catch (e) {
      console.warn('[PrivAgent SW] Content script auto-injection warning:', e);
      return false;
    }
  }
  return true;
}

/**
 * Message handler — routes messages from content scripts, popup, and dashboard.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ── Handshake from dashboard or popup ──────────────────────────────────────
  if (message.type === 'PRIVAGENT_DASHBOARD_PING') {
    sendResponse({ connected: true, version: '0.4.0' });
    return false;
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
    console.info('[AgentTrace] dashboard START_TASK received');
    const task = message.task as string;
    const dashboardTabId = sender.tab?.id || currentDashboardTabId;
    if (sender.tab?.id) currentDashboardTabId = sender.tab.id;

    // Send immediate acknowledgement
    sendResponse({ started: true });

    (async () => {
      // Query all tabs with no restrictive URL pattern so all localhost ports & schemes are returned
      const allTabs = await chrome.tabs.query({});
      const resolution = resolveTargetWebTab(allTabs, task, message.originUrl || 'http://localhost:5173');

      // Development diagnostics: tab IDs & origins only — strictly zero PII, no DOM, no passwords
      console.info('[PrivAgent SW] Discovered tabs:', resolution.discoveredTabs);
      console.info('[PrivAgent SW] Target tab selected:', {
        tabId: resolution.selectedTab?.id,
        origin: resolution.selectedTab?.url ? new URL(resolution.selectedTab.url).origin : null,
        reason: resolution.reason,
      });

      const targetTab = resolution.selectedTab;
      if (!targetTab || !targetTab.id) {
        if (dashboardTabId) {
          chrome.tabs.sendMessage(dashboardTabId, {
            type: 'PRIVAGENT_DASHBOARD_PROGRESS',
            payload: {
              status: 'FAILED',
              currentStep: 0,
              maxSteps: 10,
              task,
              steps: [],
              reason: resolution.reason || 'No browser tab is available for this task. Open the webpage you want PrivAgent to work with and try again.',
            },
          }).catch(() => {});
        }
        return;
      }

      const targetTabId = targetTab.id;
      console.info('[AgentTrace] target tab resolved', {
        tabId: targetTabId,
        origin: targetTab.url ? new URL(targetTab.url).origin : null,
      });

      // Ensure content script is active and responsive in the target tab
      await ensureTargetTabReady(targetTabId);

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

      const loopCallbacks = {
        perceivePage: async (): Promise<AgentContextPayload | null> => {
          try {
            const scanRes = (await withTimeout(
              chrome.tabs.sendMessage(targetTabId, { type: 'PRIVAGENT_SCAN_REQUEST' }),
              10000,
              'Page perception timed out (10s).'
            )) as { report?: PrivacyScanReport } | null;

            if (!scanRes?.report) return null;
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
          if (dashboardTabId) {
            chrome.tabs.sendMessage(dashboardTabId, {
              type: 'PRIVAGENT_DASHBOARD_PROGRESS',
              payload: state,
            }).catch(() => {});
          }
        },
      };

      // Real provider: backend Gemma (or fallback to configured provider)
      const provider = createAgentProvider({ provider: 'backend' });

      activeLoop = new AgentLoop(provider, loopCallbacks, {
        maxSteps: 10,
        maxRetries: 2,
        delayBetweenStepsMs: 500,
      });

      try {
        console.info('[AgentTrace] M6 loop started');
        const finalState = await activeLoop.runTask(task);
        if (dashboardTabId) {
          chrome.tabs.sendMessage(dashboardTabId, {
            type: 'PRIVAGENT_DASHBOARD_PROGRESS',
            payload: finalState,
          }).catch(() => {});
        }
      } catch (err) {
        if (dashboardTabId) {
          chrome.tabs.sendMessage(dashboardTabId, {
            type: 'PRIVAGENT_DASHBOARD_PROGRESS',
            payload: {
              status: 'FAILED',
              currentStep: activeLoop?.getState().currentStep || 0,
              maxSteps: 10,
              task,
              steps: activeLoop?.getState().steps || [],
              reason: err instanceof Error ? err.message : String(err),
            },
          }).catch(() => {});
        }
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
