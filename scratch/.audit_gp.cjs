"use strict";

// extension/src/agent/goalParser.ts
var COMMON_COLORS = [
  "black",
  "white",
  "red",
  "blue",
  "green",
  "yellow",
  "orange",
  "purple",
  "pink",
  "brown",
  "grey",
  "gray"
];
var COMMON_SIZES = ["xxxl", "xxl", "xl", "xs", "s", "m", "l"];
var COMMON_STYLES = [
  "baggy",
  "casual",
  "formal",
  "slim",
  "oversized",
  "vintage",
  "leather",
  "cotton",
  "denim",
  "canvas"
];
var COMMON_CATEGORIES = [
  "bag",
  "bags",
  "shoe",
  "shoes",
  "shirt",
  "shirts",
  "t-shirt",
  "laptop",
  "phone",
  "watch",
  "dress",
  "jacket"
];
function extractTaskConstraints(task) {
  const lower = task.toLowerCase();
  const constraints = {};
  const priceRegex = /(?:under|below|less than|max(?:imum)? price of?|at most|up to|<=?)\s*(?:[₹$£€]|rs\.?|inr)?\s*(\d+(?:[.,]\d+)?)/i;
  const matchPrice = lower.match(priceRegex);
  if (matchPrice && matchPrice[1]) {
    constraints.maxPrice = parseFloat(matchPrice[1].replace(/,/g, ""));
  } else {
    const altPriceRegex = /(?:[₹$£€]|rs\.?|inr)\s*(\d+(?:[.,]\d+)?)/i;
    const altMatch = lower.match(altPriceRegex);
    if (altMatch && altMatch[1]) {
      constraints.maxPrice = parseFloat(altMatch[1].replace(/,/g, ""));
    }
  }
  if (task.includes("\u20B9") || /\brs\b/.test(lower) || lower.includes("inr")) {
    constraints.currency = "\u20B9";
  } else if (task.includes("$") || lower.includes("usd")) {
    constraints.currency = "$";
  } else if (task.includes("\u20AC") || lower.includes("eur")) {
    constraints.currency = "\u20AC";
  }
  for (const size of COMMON_SIZES) {
    const sizeRegex = new RegExp(`\\b${size}\\b`, "i");
    if (sizeRegex.test(lower)) {
      constraints.size = size.toUpperCase();
      break;
    }
  }
  for (const color of COMMON_COLORS) {
    const colorRegex = new RegExp(`\\b${color}\\b`, "i");
    if (colorRegex.test(lower)) {
      constraints.color = color;
      break;
    }
  }
  for (const style of COMMON_STYLES) {
    const styleRegex = new RegExp(`\\b${style}\\b`, "i");
    if (styleRegex.test(lower)) {
      constraints.style = style;
      break;
    }
  }
  for (const cat of COMMON_CATEGORIES) {
    const catRegex = new RegExp(`\\b${cat}\\b`, "i");
    if (catRegex.test(lower)) {
      constraints.category = cat.endsWith("s") && cat.length > 3 ? cat.slice(0, -1) : cat;
      break;
    }
  }
  if (lower.includes("login") || lower.includes("sign in") || lower.includes("log in") || lower.includes("authenticate")) {
    constraints.requiresAuth = true;
  }
  return constraints;
}
function extractTargetSite(task) {
  const urlRegex = /(https?:\/\/[^\s]+)/i;
  const matchUrl = task.match(urlRegex);
  if (matchUrl && matchUrl[1]) return matchUrl[1];
  const domainRegex = /\b([a-z0-9-]+\.(?:com|org|net|in|io|gov|edu))\b/i;
  const matchDomain = task.match(domainRegex);
  if (matchDomain && matchDomain[1]) return `https://www.${matchDomain[1].toLowerCase()}`;
  if (task.toLowerCase().includes("shopping site") || task.toLowerCase().includes("shopping portal")) {
    return "http://localhost:4174";
  }
  if (task.toLowerCase().includes("google")) {
    return "https://www.google.com";
  }
  return void 0;
}
function parseUserGoal(task) {
  const lower = task.toLowerCase();
  const constraints = extractTaskConstraints(task);
  const targetSite = extractTargetSite(task);
  let actionIntent = "general";
  if (constraints.maxPrice !== void 0 || constraints.category || constraints.size || lower.includes("shopping") || lower.includes("buy") || lower.includes("product")) {
    actionIntent = "shopping";
  } else if (lower.includes("search") || lower.includes("google") || lower.includes("find")) {
    actionIntent = "search";
  } else if (lower.includes("transaction") || lower.includes("account number") || lower.includes("banking")) {
    actionIntent = "banking";
  } else if (lower.includes("login") || lower.includes("sign in")) {
    actionIntent = "login";
  } else if (targetSite) {
    actionIntent = "navigation";
  }
  const subgoals = [];
  let order = 1;
  if (targetSite) {
    subgoals.push({
      id: `subgoal-${order}`,
      order: order++,
      description: `Navigate to target destination (${targetSite})`,
      expectedActionType: "navigate",
      status: "PENDING",
      targetHint: targetSite
    });
  }
  if (constraints.requiresAuth) {
    subgoals.push({
      id: `subgoal-${order}`,
      order: order++,
      description: "Authenticate / Sign in securely on-device",
      expectedActionType: "click",
      status: "PENDING",
      targetHint: "login-button"
    });
  }
  if (actionIntent === "shopping" || actionIntent === "search") {
    const searchTerms = [];
    if (constraints.size) searchTerms.push(constraints.size);
    if (constraints.color) searchTerms.push(constraints.color);
    if (constraints.style) searchTerms.push(constraints.style);
    if (constraints.category) searchTerms.push(constraints.category);
    const query = searchTerms.join(" ") || "search items";
    subgoals.push({
      id: `subgoal-${order}`,
      order: order++,
      description: `Locate search input and query for "${query}"`,
      expectedActionType: "type",
      status: "PENDING",
      targetHint: "search-input"
    });
    subgoals.push({
      id: `subgoal-${order}`,
      order: order++,
      description: "Submit search and observe resulting candidates",
      expectedActionType: "click",
      status: "PENDING",
      targetHint: "search-submit"
    });
    if (actionIntent === "shopping") {
      subgoals.push({
        id: `subgoal-${order}`,
        order: order++,
        description: "Verify candidate products against price, size, and color constraints",
        expectedActionType: "verify",
        status: "PENDING"
      });
    }
  } else if (actionIntent === "banking") {
    subgoals.push({
      id: `subgoal-${order}`,
      order: order++,
      description: "Locate banking activity or account details view",
      expectedActionType: "click",
      status: "PENDING",
      targetHint: "account-details"
    });
    subgoals.push({
      id: `subgoal-${order}`,
      order: order++,
      description: "Inspect transactions or account information safely on-device",
      expectedActionType: "verify",
      status: "PENDING"
    });
  } else {
    subgoals.push({
      id: `subgoal-${order}`,
      order: order++,
      description: "Perceive and interact with relevant target elements",
      expectedActionType: "inspect",
      status: "PENDING"
    });
  }
  let normalizedGoal = task;
  if (actionIntent === "shopping") {
    const constraintDesc = [];
    if (constraints.category) constraintDesc.push(`category: ${constraints.category}`);
    if (constraints.size) constraintDesc.push(`size: ${constraints.size}`);
    if (constraints.color) constraintDesc.push(`color: ${constraints.color}`);
    if (constraints.maxPrice !== void 0) constraintDesc.push(`max price: ${constraints.currency || ""}${constraints.maxPrice}`);
    normalizedGoal = `Find and verify qualifying products (${constraintDesc.join(", ") || "matching query"})`;
  }
  return {
    normalizedGoal,
    targetSite,
    actionIntent,
    constraints,
    subgoals
  };
}

// scratch/audit_goalparser_probe.ts
var TASK = "open the store catalog at http://localhost:4174 and open the first product listed";
function show(label, task) {
  const p = parseUserGoal(task);
  console.log(`
--- ${label} ---`);
  console.log("  task          :", JSON.stringify(task));
  console.log("  actionIntent  :", p.actionIntent);
  console.log("  normalizedGoal:", JSON.stringify(p.normalizedGoal));
  console.log("  constraints   :", JSON.stringify(p.constraints));
  console.log("  subgoals      :", p.subgoals.map((s) => `${s.expectedActionType}:${s.description}`).join(" || "));
}
console.log("=== the exact task from the real-browser run ===");
show("REAL TASK", TASK);
console.log("\n=== D1 probe: currency extractor substring matching ===");
for (const w of ["first", "rs", "shirt", "various", "cart"]) {
  console.log(`  "${w}".includes('rs') =`, w.toLowerCase().includes("rs"));
}
console.log('  REAL TASK lowercase contains "rs"? ->', TASK.toLowerCase().includes("rs"));
console.log("  where? ->", TASK.toLowerCase().indexOf("rs"), "in", JSON.stringify(TASK.toLowerCase().slice(18, 28)));
show('SAME TASK with "first" removed', "open the store catalog at http://localhost:4174 and open the product listed");
console.log("\n=== D2 probe: shopping intent trigger is a bare substring ===");
show('NO "product" token', "open the store catalog at http://localhost:4174 and open the first item listed");
show("bare mention, unrelated to shopping", "open http://localhost:4174 and report the product page title");
