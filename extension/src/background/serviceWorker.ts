import { AgentLoop, TaskState } from '../agent/agentLoop';
import { createAgentProvider } from '../agent/providerRegistry';
import { buildAgentPayload, PrivacyScanReport, AgentContextPayload } from '../privacy/types';
import { minimizeAgentContext } from '../privacy/contextMinimizer';
import { BrowserAction } from '../agent/actionTypes';

// PrivAgent Background Service Worker (Manifest V3)
let activeLoop: AgentLoop | null = null;
let currentDashboardTabId: number | null = null;

chrome.runtime.onInstalled.addListener(() => {
  console.info('[PrivAgent] Background Service Worker installed successfully.');
  chrome.action.setBadgeText({ text: 'ON' });
  chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
});

/**
 * Resolve target web tab for browser automation.
 * CRITICAL RULE: NEVER target the dashboard tab (localhost:5173).
 */
async function resolveTargetWebTab(dashboardUrl?: string): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });

  const eligibleTabs = tabs.filter((t) => {
    if (!t.url || !t.id) return false;
    if (dashboardUrl && t.url.startsWith(dashboardUrl)) return false;
    if (t.url.includes(':5173')) return false; // Dashboard exclusion
    return true;
  });

  if (eligibleTabs.length === 0) return null;

  // Prioritize the synthetic banking demo site (localhost:4173) or active tab
  const demoTab = eligibleTabs.find((t) => t.url?.includes(':4173') || t.url?.includes('bank'));
  if (demoTab) return demoTab;

  const activeTab = eligibleTabs.find((t) => t.active);
  return activeTab || eligibleTabs[0];
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
    const task = message.task as string;
    const dashboardTabId = sender.tab?.id;
    if (dashboardTabId) currentDashboardTabId = dashboardTabId;

    (async () => {
      const targetTab = await resolveTargetWebTab(message.originUrl);
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
              reason: 'No target web tab found. Please open http://localhost:4173 in another tab.',
            },
          });
        }
        return;
      }

      const targetTabId = targetTab.id;

      // Bring target tab into view briefly if desired, or focus
      const loopCallbacks = {
        perceivePage: async (): Promise<AgentContextPayload | null> => {
          try {
            const scanRes = (await chrome.tabs.sendMessage(targetTabId, {
              type: 'PRIVAGENT_SCAN_REQUEST',
            })) as { report?: PrivacyScanReport } | null;

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
            const execRes = (await chrome.tabs.sendMessage(targetTabId, {
              type: 'PRIVAGENT_EXECUTE_ACTION',
              action,
            })) as { result?: { success: boolean; error?: string } } | null;

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

    sendResponse({ started: true });
    return true;
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
