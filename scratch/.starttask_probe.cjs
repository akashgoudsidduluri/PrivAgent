"use strict";

// extension/src/background/targetResolver.ts
var GOOGLE_ORIGIN = "https://www.google.com";
function isDashboardUrl(url, dashboardOrigin = "http://localhost:5173") {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.port === "5173") return true;
  try {
    return parsed.origin === new URL(dashboardOrigin).origin;
  } catch {
    return false;
  }
}
function extractProvisioningDestination(task, dashboardOrigin = "http://localhost:5173") {
  if (!task) return null;
  const urlMatch = task.match(/https?:\/\/[^\s"'`)\]]+/i);
  if (urlMatch && urlMatch[0]) {
    const candidate = urlMatch[0];
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        if (isDashboardUrl(candidate, dashboardOrigin)) return null;
        return { url: parsed.toString(), source: "explicit-url" };
      }
    } catch {
    }
  }
  const lower = task.toLowerCase();
  const mentionsGoogle = /\bgoogle\b/.test(lower);
  const hasNavVerb = /\b(open|opens|go|goes|visit|visits|navigate|navigates|launch|launches|search|searches|searching|browse|browses)\b/.test(
    lower
  );
  if (mentionsGoogle && hasNavVerb && !isDashboardUrl(GOOGLE_ORIGIN, dashboardOrigin)) {
    return { url: GOOGLE_ORIGIN, source: "google-intent" };
  }
  return null;
}
function isEligibleWebTab(tab, dashboardOrigin = "http://localhost:5173", dashboardTabId) {
  if (!tab.id) return false;
  if (typeof dashboardTabId === "number" && tab.id === dashboardTabId) {
    return false;
  }
  const urlToTest = tab.url || tab.pendingUrl;
  if (!urlToTest) return false;
  let parsed;
  try {
    parsed = new URL(urlToTest);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  let dashParsed = null;
  try {
    dashParsed = new URL(dashboardOrigin);
  } catch {
  }
  if (dashParsed && parsed.origin === dashParsed.origin) {
    return false;
  }
  if (parsed.port === "5173") {
    return false;
  }
  if (parsed.hostname === "localhost" && parsed.port === "5173") {
    return false;
  }
  return true;
}
var COMMON_TLDS = /* @__PURE__ */ new Set([
  "com",
  "org",
  "net",
  "in",
  "io",
  "co",
  "ai",
  "dev",
  "app",
  "edu",
  "gov",
  "uk",
  "ca",
  "de",
  "jp",
  "fr",
  "au",
  "ru",
  "ch",
  "it",
  "nl",
  "se",
  "no",
  "es",
  "mil"
]);
function parseTaskTargetReference(task) {
  if (!task) return null;
  const text = task.trim();
  const lower = text.toLowerCase();
  const isAlreadyOpenedIntent = /\b(already\s+(?:opened|open)|have\s+opened|opened)\b/i.test(lower);
  const isOpenIntent = !isAlreadyOpenedIntent && /\b(open|opens|go\s+to|goto|visit|visits|navigate(?:\s+to)?|launch|launches|browse|browses)\b/i.test(lower);
  const urlMatch = text.match(/https?:\/\/[^\s"'`)\]]+/i);
  if (urlMatch && urlMatch[0]) {
    try {
      const parsed = new URL(urlMatch[0]);
      const hostParts = parsed.hostname.split(".");
      const sitePart = hostParts[0] === "www" && hostParts.length > 1 ? hostParts[1] : hostParts[0];
      return {
        rawTarget: urlMatch[0],
        hostname: parsed.hostname,
        port: parsed.port || void 0,
        fullUrl: parsed.toString(),
        siteName: sitePart,
        isOpenIntent: true,
        isAlreadyOpenedIntent
      };
    } catch {
    }
  }
  const hostPortMatch = lower.match(/\b(localhost|127\.0\.0\.1):(\d+)\b/);
  if (hostPortMatch) {
    return {
      rawTarget: hostPortMatch[0],
      hostname: hostPortMatch[1],
      port: hostPortMatch[2],
      isOpenIntent: true,
      isAlreadyOpenedIntent
    };
  }
  const spacePortMatch = lower.match(/\b(localhost|127\.0\.0\.1)(?:\s+(?:port\s+)?(\d+))\b/);
  if (spacePortMatch) {
    return {
      rawTarget: spacePortMatch[0],
      hostname: spacePortMatch[1],
      port: spacePortMatch[2],
      isOpenIntent: true,
      isAlreadyOpenedIntent
    };
  }
  const domainMatch = lower.match(/\b([a-zA-Z0-9-]+\.(?:[a-zA-Z]{2,}))(?::(\d+))?\b/);
  if (domainMatch && domainMatch[1]) {
    const candidateHost = domainMatch[1];
    const parts = candidateHost.split(".");
    const tld = parts[parts.length - 1] || "";
    if (COMMON_TLDS.has(tld) || tld.length === 2 || parts.length >= 2) {
      const sitePart = parts[0] === "www" && parts.length > 1 ? parts[1] : parts[0];
      return {
        rawTarget: candidateHost,
        hostname: candidateHost,
        port: domainMatch[2] || void 0,
        siteName: sitePart,
        isOpenIntent,
        isAlreadyOpenedIntent
      };
    }
  }
  const openVerbMatch = lower.match(
    /\b(?:open|opens|go\s+to|goto|visit|visits|navigate(?:\s+to)?|launch|launches|browse|browses)\s+([a-zA-Z0-9-]+)(?:\.([a-zA-Z]{2,}))?\b/i
  );
  if (openVerbMatch && openVerbMatch[1]) {
    const rawName = openVerbMatch[1];
    const rawTld = openVerbMatch[2];
    const STOP_WORDS = /* @__PURE__ */ new Set(["tab", "the", "a", "an", "this", "that", "page", "new", "browser", "link", "url", "window"]);
    if (!STOP_WORDS.has(rawName)) {
      if (rawTld) {
        return {
          rawTarget: `${rawName}.${rawTld}`,
          hostname: `${rawName}.${rawTld}`,
          siteName: rawName,
          isOpenIntent: true,
          isAlreadyOpenedIntent: false
        };
      }
      return {
        rawTarget: rawName,
        siteName: rawName,
        isOpenIntent: true,
        isAlreadyOpenedIntent: false
      };
    }
  }
  const prepMatch = lower.match(/\b(?:on|in|at)\s+([a-zA-Z0-9-]+)(?:\.([a-zA-Z]{2,}))?\b/i);
  if (prepMatch && prepMatch[1]) {
    const rawName = prepMatch[1];
    const rawTld = prepMatch[2];
    const STOP_WORDS = /* @__PURE__ */ new Set(["the", "a", "an", "this", "that", "page", "tab", "window", "top", "bottom", "left", "right", "screen"]);
    if (!STOP_WORDS.has(rawName)) {
      if (rawTld) {
        return {
          rawTarget: `${rawName}.${rawTld}`,
          hostname: `${rawName}.${rawTld}`,
          siteName: rawName,
          isOpenIntent: false,
          isAlreadyOpenedIntent: false
        };
      }
      return {
        rawTarget: rawName,
        siteName: rawName,
        isOpenIntent: false,
        isAlreadyOpenedIntent: false
      };
    }
  }
  return null;
}
function doesTabMatchTarget(tab, ref) {
  const urlStr = tab.url || tab.pendingUrl;
  if (!urlStr) return false;
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    return false;
  }
  if (ref.port) {
    if (parsed.port !== ref.port) return false;
    if (ref.hostname) {
      const isLocalRef = ref.hostname === "localhost" || ref.hostname === "127.0.0.1";
      const isLocalTab = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
      if (isLocalRef && isLocalTab) return true;
      return parsed.hostname.toLowerCase() === ref.hostname.toLowerCase() || parsed.hostname.toLowerCase().endsWith("." + ref.hostname.toLowerCase());
    }
    return true;
  }
  if (ref.fullUrl) {
    try {
      const refParsed = new URL(ref.fullUrl);
      if (parsed.hostname.toLowerCase() === refParsed.hostname.toLowerCase() || parsed.hostname.toLowerCase().endsWith("." + refParsed.hostname.toLowerCase()) || refParsed.hostname.toLowerCase().endsWith("." + parsed.hostname.toLowerCase())) {
        return true;
      }
    } catch {
    }
  }
  if (ref.hostname) {
    const tabHost = parsed.hostname.toLowerCase();
    const refHost = ref.hostname.toLowerCase();
    if (tabHost === refHost || tabHost.endsWith("." + refHost) || refHost.endsWith("." + tabHost)) {
      return true;
    }
  }
  if (ref.siteName) {
    const site = ref.siteName.toLowerCase();
    const tabHost = parsed.hostname.toLowerCase();
    if (tabHost.includes(site)) {
      return true;
    }
    if (tab.title && tab.title.toLowerCase().includes(site)) {
      return true;
    }
  }
  return false;
}
function buildProvisioningDestinationUrl(ref) {
  if (ref.fullUrl) return ref.fullUrl;
  if (ref.hostname) {
    const protocol = ref.hostname === "localhost" || ref.hostname === "127.0.0.1" ? "http:" : "https:";
    return `${protocol}//${ref.hostname}${ref.port ? `:${ref.port}` : ""}`;
  }
  if (ref.siteName) {
    if (ref.siteName.toLowerCase() === "google") {
      return "https://www.google.com";
    }
    return `https://www.${ref.siteName.toLowerCase()}.com`;
  }
  return "";
}
function resolveTargetWebTab(tabs, task, dashboardOrigin = "http://localhost:5173", dashboardTabId) {
  const discoveredTabs = [];
  const eligibleTabs = [];
  for (const t of tabs) {
    const tabUrl = t.url || t.pendingUrl;
    if (!tabUrl) continue;
    let origin = "";
    try {
      origin = new URL(tabUrl).origin;
    } catch {
      origin = "invalid";
    }
    discoveredTabs.push({
      id: t.id,
      origin,
      url: tabUrl.split("?")[0]
      // strip query params for safe diagnostics
    });
    if (isEligibleWebTab(t, dashboardOrigin, dashboardTabId)) {
      eligibleTabs.push(t);
    }
  }
  const targetRef = parseTaskTargetReference(task);
  if (targetRef) {
    const matchingTabs = eligibleTabs.filter((t) => doesTabMatchTarget(t, targetRef));
    if (matchingTabs.length > 0) {
      const activeMatch = matchingTabs.find((t) => t.active);
      const selected = activeMatch || matchingTabs[0] || null;
      return {
        selectedTab: selected,
        discoveredTabs,
        reason: `Matched explicit target in task: ${targetRef.rawTarget}`
      };
    }
    if (targetRef.isOpenIntent && !targetRef.port) {
      const destUrl = buildProvisioningDestinationUrl(targetRef);
      if (destUrl && !isDashboardUrl(destUrl, dashboardOrigin)) {
        return {
          selectedTab: null,
          discoveredTabs,
          reason: `Target tab for "${targetRef.rawTarget}" not found. Provisioning a dedicated target tab at ${destUrl}.`,
          provisioning: {
            url: destUrl,
            source: targetRef.fullUrl ? "explicit-url" : "google-intent"
          }
        };
      }
    }
    const notFoundReason = targetRef.port ? `No target web tab found. Please open http://${targetRef.hostname || "localhost"}:${targetRef.port}.` : `Target tab for "${targetRef.rawTarget}" was not found among open tabs. Please open ${targetRef.rawTarget} and try again.`;
    return {
      selectedTab: null,
      discoveredTabs,
      reason: notFoundReason,
      failureCode: "DESTINATION_REQUIRED"
    };
  }
  if (eligibleTabs.length === 0) {
    const provisioning = extractProvisioningDestination(task, dashboardOrigin);
    if (provisioning) {
      return {
        selectedTab: null,
        discoveredTabs,
        reason: `No eligible web tab is open. Provisioning a dedicated target tab at ${provisioning.url} (${provisioning.source}).`,
        provisioning
      };
    }
    return {
      selectedTab: null,
      discoveredTabs,
      reason: "No browser tab is available for this task. Open the webpage you want PrivAgent to work with and try again.",
      failureCode: "DESTINATION_REQUIRED"
    };
  }
  const activeTab = eligibleTabs.find((t) => t.active);
  if (activeTab) {
    return {
      selectedTab: activeTab,
      discoveredTabs,
      reason: "Selected active web tab."
    };
  }
  return {
    selectedTab: eligibleTabs[0] || null,
    discoveredTabs,
    reason: "Selected first eligible web tab."
  };
}

// scratch/starttask_probe.ts
var DASHBOARD_ORIGIN = "http://localhost:5173";
var DASHBOARD_TAB_ID = 10;
function show(label, task, tabs) {
  const res = resolveTargetWebTab(tabs, task, DASHBOARD_ORIGIN, DASHBOARD_TAB_ID);
  const ref = parseTaskTargetReference(task);
  console.log("\n=== " + label + " ===");
  console.log("task            :", JSON.stringify(task));
  console.log("eligible tabs   :", JSON.stringify(tabs.filter((t) => isEligibleWebTab(t, DASHBOARD_ORIGIN, DASHBOARD_TAB_ID)).map((t) => t.id)));
  console.log("targetRef       :", JSON.stringify(ref));
  console.log("isOpenIntent    :", ref?.isOpenIntent);
  console.log("ref.port        :", ref?.port);
  console.log("ref.fullUrl     :", ref?.fullUrl);
  console.log("provisioning    :", JSON.stringify(res.provisioning ?? null));
  console.log("failureCode     :", res.failureCode ?? null);
  console.log("selectedTab     :", res.selectedTab ? `id=${res.selectedTab.id} url=${res.selectedTab.url}` : "null  <-- Target Tab: \u2014");
  console.log("reason          :", res.reason);
  return res;
}
console.log("isDashboardUrl(localhost:5174):", isDashboardUrl("http://localhost:4174", DASHBOARD_ORIGIN));
console.log("isDashboardUrl(localhost:5173):", isDashboardUrl("http://localhost:5173", DASHBOARD_ORIGIN));
console.log("isEligibleWebTab(4174 tab)   :", isEligibleWebTab({ id: 22, url: "http://localhost:4174/" }, DASHBOARD_ORIGIN, DASHBOARD_TAB_ID));
console.log("isEligibleWebTab(5173 tab)   :", isEligibleWebTab({ id: 10, url: "http://localhost:5173/" }, DASHBOARD_ORIGIN, DASHBOARD_TAB_ID));
show("A explicit-url 4174, tab absent", "open http://localhost:4174 and fill the contact form", [
  { id: 10, url: "http://localhost:5173/", active: true },
  { id: 31, url: "https://freebuff.com/", active: false }
]);
show("B explicit-url 4174, tab present", "open http://localhost:4174 and fill the contact form", [
  { id: 10, url: "http://localhost:5173/", active: true },
  { id: 22, url: "http://localhost:4174/", active: false }
]);
show("C bare localhost:4174, tab absent", "open localhost 4174 and fill the contact form", [
  { id: 10, url: "http://localhost:5173/", active: true }
]);
show("D explicit remote url, tab absent", "open https://example.com and read the page", [
  { id: 10, url: "http://localhost:5173/", active: true }
]);
show("E no target reference, dashboard only", "summarise the page", [
  { id: 10, url: "http://localhost:5173/", active: true }
]);
show("F no target reference, eligible tab present", "summarise the page", [
  { id: 10, url: "http://localhost:5173/", active: true },
  { id: 41, url: "https://freebuff.com/", active: true }
]);
console.log("\nextractProvisioningDestination(A task):", JSON.stringify(extractProvisioningDestination("open http://localhost:4174 and fill the contact form", DASHBOARD_ORIGIN)));
