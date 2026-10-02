"use strict";

// extension/src/hierarchicalPlanning/hierarchicalTypes.ts
var DEFAULT_PLANNING_BOUNDS = {
  maxSubgoals: 10,
  maxReplans: 3,
  maxTotalActions: 15,
  maxRepeatedFailures: 2
};

// extension/src/hierarchicalPlanning/taskDecomposer.ts
function classifyTaskCategory(prompt) {
  const lower = prompt.toLowerCase().trim();
  if (!lower) {
    return "UNSUPPORTED_TASK_TYPE";
  }
  const hazardousKeywords = ["exploit", "bypass security", "exfiltrate", "steal password", "crack key"];
  if (hazardousKeywords.some((k) => lower.includes(k))) {
    return "UNSUPPORTED_TASK_TYPE";
  }
  if (lower.includes("buy") || lower.includes("purchase") || lower.includes("cart") || lower.includes("product") || lower.includes("price") || lower.includes("order") || lower.includes("amazon") || lower.includes("shop")) {
    return "ECOMMERCE_SEARCH";
  }
  if (lower.includes("search") || lower.includes("find") || lower.includes("lookup") || lower.includes("what is") || lower.includes("who is") || lower.includes("google") || lower.includes("wiki")) {
    return "INFORMATION_RETRIEVAL";
  }
  if (lower.includes("fill") || lower.includes("form") || lower.includes("register") || lower.includes("sign up") || lower.includes("submit form") || lower.includes("enter") || lower.includes("type into")) {
    return "FORM_FILL";
  }
  if (lower.includes("login") || lower.includes("sign in") || lower.includes("log in") || lower.includes("authenticate")) {
    return "AUTHENTICATION";
  }
  return "GENERIC_INTERACTION";
}
function extractEntitiesAndConstraints(prompt, category) {
  const entities = [];
  const constraints = {};
  const quotes = prompt.match(/"([^"]+)"|'([^']+)'/g);
  if (quotes) {
    for (const q of quotes) {
      const clean = q.replace(/['"]/g, "").trim();
      if (clean.length > 1) {
        entities.push(clean);
      }
    }
  }
  if (entities.length === 0) {
    const tokens = prompt.replace(/https?:\/\/\S+/gi, " ").replace(/[^\w\s-]/g, "").split(/\s+/).filter((t) => t.length > 2);
    const stopWords = /* @__PURE__ */ new Set([
      "the",
      "and",
      "for",
      "with",
      "search",
      "find",
      "open",
      "page",
      "site",
      "click",
      "press",
      "show",
      "look",
      "what",
      "where",
      "when",
      "from",
      "into"
    ]);
    const candidates = tokens.filter((t) => !stopWords.has(t.toLowerCase()));
    if (candidates.length > 0) {
      entities.push(candidates.slice(0, 3).join(" "));
    }
  }
  const priceMatch = prompt.match(/under\s*\$?(\d+)|less than\s*\$?(\d+)|\$?(\d+)\s*or less/i);
  if (priceMatch) {
    const val = Number(priceMatch[1] || priceMatch[2] || priceMatch[3]);
    if (!isNaN(val)) constraints.maxPrice = val;
  }
  return { targetEntities: entities, constraints };
}
function decomposeTask(userPrompt, options) {
  const maxSubgoals = options?.maxSubgoals ?? DEFAULT_PLANNING_BOUNDS.maxSubgoals;
  const worldModel = options?.worldModel;
  const currentUrl = options?.currentUrl || worldModel?.page?.url || "";
  const currentCategory = options?.knownPageCategory || worldModel?.page?.pageType;
  const taskCategory = classifyTaskCategory(userPrompt);
  const goalId = `goal-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
  const { targetEntities, constraints } = extractEntitiesAndConstraints(userPrompt, taskCategory);
  const highLevelGoal = {
    goalId,
    rawUserPrompt: userPrompt,
    sanitizedGoalDescription: userPrompt.replace(/[^\x20-\x7E]/g, "").trim(),
    taskCategory,
    targetEntities,
    constraints,
    createdAt: Date.now(),
    status: taskCategory === "UNSUPPORTED_TASK_TYPE" ? "FAILED" : "ACTIVE"
  };
  if (taskCategory === "UNSUPPORTED_TASK_TYPE") {
    return {
      goal: highLevelGoal,
      subgoals: [],
      skippedInitialSteps: []
    };
  }
  const subgoals = [];
  const skippedInitialSteps = [];
  const addSubgoal = (category, description, expectedActionType, prerequisites = [], verificationCondition, targetEntity) => {
    if (subgoals.length >= maxSubgoals) return "";
    const id = `${goalId}-sg${subgoals.length + 1}`;
    subgoals.push({
      id,
      goalId,
      index: subgoals.length,
      category,
      description,
      expectedActionType,
      state: "PENDING",
      prerequisites,
      retryCount: 0,
      maxRetries: 2,
      verificationCondition,
      targetEntity
    });
    return id;
  };
  const isAlreadyOnSearchPage = currentUrl.includes("google.com") || currentUrl.includes("bing.com") || currentUrl.includes("duckduckgo.com") || currentCategory === "SEARCH" || currentCategory === "SEARCH_RESULTS";
  const isAlreadyOnEcommerce = currentCategory === "LISTING" || currentCategory === "CHECKOUT" || currentCategory === "PRODUCT_LISTING" || currentCategory === "PRODUCT_DETAIL";
  switch (taskCategory) {
    case "INFORMATION_RETRIEVAL": {
      let navId = "";
      if (!isAlreadyOnSearchPage && !currentUrl) {
        navId = addSubgoal(
          "NAVIGATE",
          "Navigate to search engine or knowledge portal",
          "navigate",
          [],
          { type: "URL_CONTAINS", expectedValue: "google.com", description: "Search portal loaded" }
        );
      } else if (isAlreadyOnSearchPage) {
        skippedInitialSteps.push("NAVIGATE (Browser already on search provider/page)");
      }
      const searchPrereq = navId ? [navId] : [];
      const searchTarget = targetEntities[0] || userPrompt;
      const searchId = addSubgoal(
        "SEARCH",
        `Enter search query "${searchTarget}" into search box`,
        "type",
        searchPrereq,
        { type: "AFFORDANCE_AVAILABLE", description: "Query results displayed" },
        searchTarget
      );
      const locateId = addSubgoal(
        "LOCATE",
        `Locate relevant search result matching "${searchTarget}"`,
        "inspect",
        [searchId],
        { type: "ELEMENT_EXISTS", description: "Relevant search item found" },
        searchTarget
      );
      const extractId = addSubgoal(
        "EXTRACT",
        "Extract target information from verified search result",
        "inspect",
        [locateId],
        { type: "STATE_CHANGED", description: "Information verified on-device" }
      );
      addSubgoal(
        "VERIFY",
        "Verify target information satisfies user query",
        "verify",
        [extractId],
        { type: "STATE_CHANGED", description: "Goal verified" }
      );
      break;
    }
    case "ECOMMERCE_SEARCH": {
      let navId = "";
      if (!isAlreadyOnEcommerce && !currentUrl.includes("amazon") && !currentUrl.includes("shop")) {
        navId = addSubgoal(
          "NAVIGATE",
          "Navigate to commerce catalog or store front",
          "navigate",
          [],
          { type: "AFFORDANCE_AVAILABLE", description: "Store catalog reachable" }
        );
      } else {
        skippedInitialSteps.push("NAVIGATE (Browser already on commerce catalog)");
      }
      const searchPrereq = navId ? [navId] : [];
      const productQuery = targetEntities[0] || "requested item";
      const searchId = addSubgoal(
        "SEARCH",
        `Search catalog for product "${productQuery}"`,
        "type",
        searchPrereq,
        { type: "AFFORDANCE_AVAILABLE", description: "Catalog results presented" },
        productQuery
      );
      const selectId = addSubgoal(
        "SELECT",
        `Select product candidate conforming to constraints (${JSON.stringify(constraints)})`,
        "click",
        [searchId],
        { type: "ELEMENT_EXISTS", description: "Product detail viewed" },
        productQuery
      );
      const verifyId = addSubgoal(
        "VERIFY",
        "Verify product specifications, price, and availability on-device",
        "verify",
        [selectId],
        { type: "STATE_CHANGED", description: "Product matches constraints" }
      );
      if (userPrompt.toLowerCase().includes("cart") || userPrompt.toLowerCase().includes("buy")) {
        addSubgoal(
          "CONFIRM",
          "Locate add to cart affordance and request user confirmation before proceeding",
          "click",
          [verifyId],
          { type: "USER_CONFIRMED", description: "User explicitly confirmed cart action" }
        );
      }
      break;
    }
    case "FORM_FILL": {
      const inspectId = addSubgoal(
        "LOCATE",
        "Inspect and ground required form fields on current page",
        "inspect",
        [],
        { type: "ELEMENT_EXISTS", description: "Form fields mapped" }
      );
      const fillId = addSubgoal(
        "FILL",
        "Fill input fields using sanitized local attributes with zero remote credential leakage",
        "type",
        [inspectId],
        { type: "STATE_CHANGED", description: "Inputs populated" }
      );
      const verifyFillId = addSubgoal(
        "VERIFY",
        "Verify form inputs are valid and conform to constraints",
        "verify",
        [fillId],
        { type: "STATE_CHANGED", description: "Form validated" }
      );
      addSubgoal(
        "CONFIRM",
        "Request explicit user confirmation before submitting form",
        "click",
        [verifyFillId],
        { type: "USER_CONFIRMED", description: "User approved submission" }
      );
      break;
    }
    case "AUTHENTICATION": {
      const inspectId = addSubgoal(
        "LOCATE",
        "Inspect login form inputs and verify secure HTTPS origin",
        "inspect",
        [],
        { type: "ELEMENT_EXISTS", description: "Login fields grounded securely" }
      );
      const confirmAuthId = addSubgoal(
        "CONFIRM",
        "Request user authorization before populating credentials locally",
        "verify",
        [inspectId],
        { type: "USER_CONFIRMED", description: "User confirmed authentication" }
      );
      const fillAuthId = addSubgoal(
        "FILL",
        "Populate login identifiers on-device with zero network exfiltration",
        "type",
        [confirmAuthId],
        { type: "STATE_CHANGED", description: "Credentials populated locally" }
      );
      addSubgoal(
        "VERIFY",
        "Verify authentication outcome safely without capturing session secrets",
        "verify",
        [fillAuthId],
        { type: "STATE_CHANGED", description: "Authentication verified" }
      );
      break;
    }
    case "GENERIC_INTERACTION":
    default: {
      const inspectId = addSubgoal(
        "LOCATE",
        `Perceive page and locate candidate controls relevant to "${highLevelGoal.sanitizedGoalDescription}"`,
        "inspect",
        [],
        { type: "AFFORDANCE_AVAILABLE", description: "Controls identified" }
      );
      const actId = addSubgoal(
        "SELECT",
        "Execute primary safe interaction with grounded target",
        "click",
        [inspectId],
        { type: "STATE_CHANGED", description: "Target interaction executed" }
      );
      addSubgoal(
        "VERIFY",
        "Verify state change satisfies user goal",
        "verify",
        [actId],
        { type: "STATE_CHANGED", description: "Interaction outcome verified" }
      );
      break;
    }
  }
  for (const sg of subgoals) {
    if (sg.prerequisites.length === 0) {
      sg.state = "READY";
    }
  }
  return {
    goal: highLevelGoal,
    subgoals,
    skippedInitialSteps
  };
}

// scratch/audit_decomposer_probe.ts
var TASK = "open the store catalog at http://localhost:4174 and open the first product listed";
function show(label, prompt) {
  const r = decomposeTask(prompt, { currentUrl: "http://localhost:4174/" });
  console.log(`
--- ${label} ---`);
  console.log("  prompt    :", JSON.stringify(prompt));
  console.log("  category  :", r.category ?? r.taskCategory ?? "(see keys)");
  console.log("  entities  :", JSON.stringify(r.targetEntities));
  console.log("  constraints:", JSON.stringify(r.constraints));
  for (const s of r.subgoals ?? []) {
    console.log(`    ${s.category.padEnd(9)} | ${s.description} | targetEntity=${JSON.stringify(s.targetEntity ?? null)}`);
  }
}
console.log("keys of decomposeTask result:", Object.keys(decomposeTask(TASK, { currentUrl: "http://localhost:4174/" })).join(", "));
show("REAL TASK", TASK);
show("control: no URL in the prompt", "open the store catalog and open the first product listed");
show("control: explicit quoted product", 'open the store catalog and open the first product "Alpha Widget" listed');
show("control: unrelated read task", "report the page title on http://localhost:4174");
