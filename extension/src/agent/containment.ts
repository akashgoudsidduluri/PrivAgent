/**
 * PrivAgent — Phase 12: Containment / Sandbox
 *
 * A deterministic ENVIRONMENTAL control that limits the blast radius of
 * autonomous browser actions.
 *
 * ── The distinction this phase exists to draw ────────────────────────────────
 *
 *   M5              controls WHETHER AN ACTION IS ALLOWED.
 *   Containment      controls WHERE THE AGENT IS ALLOWED TO ACT.
 *
 * Containment is strictly ADDITIVE. It runs as a final environmental check at
 * the dispatch boundary and can only ever REFUSE more than the existing
 * pipeline already allows. It never authorizes, never relaxes, and never
 * reorders Grounding → M5 → Security Critic → Privacy → Risk/Confirmation →
 * Effect Verification → Goal Verification → Recovery.
 *
 *   REASONING ≠ AUTHORITY  still holds. The reasoner proposes; the local
 *   pipeline plus this containment boundary decide what can actually happen.
 *
 * ── What is contained ───────────────────────────────────────────────────────
 *
 * PrivAgent is already pinned to a single target tab. What it was NOT pinned
 * to is the ORIGIN that tab may occupy. A `navigate` action, a redirect, or a
 * page-driven jump could move the target tab onto an arbitrary site, after
 * which the agent would perceive and act on a page the user never authorised.
 * That is the blast radius this phase closes: the agent may act on the site
 * the task actually resolved, and not beyond it.
 *
 * ── What containment deliberately does NOT do ───────────────────────────────
 *
 * It does not decide whether an action is well-formed (M5), safe (Security
 * Critic), permitted for the data class (Privacy Firewall), or consequential
 * (Risk/Confirmation). It does not replace grounding, effect verification, goal
 * verification or the Recovery Engine. A contained action that is otherwise
 * valid still passes every one of those gates first.
 *
 * ── Determinism ─────────────────────────────────────────────────────────────
 *
 * Pure functions only: no network, no clock-dependent policy, no model call.
 * The same inputs always produce the same verdict. Unknown or malformed input
 * FAILS CLOSED.
 */

import { BrowserAction } from './actionTypes';

// ── Containment codes ────────────────────────────────────────────────────────

/**
 * Every containment outcome is a stable, value-free CODE. Codes never contain
 * a URL, a query, or any page/model text.
 */
export type ContainmentCode =
  /** Action stays inside the resolved scope. */
  | 'WITHIN_SCOPE'
  /** A navigation was proposed to an origin outside the containment scope. */
  | 'CROSS_ORIGIN_NAVIGATION_DENIED'
  /** The live tab has already drifted outside the scope (redirect / page jump). */
  | 'SCOPE_DRIFT_DETECTED'
  /** No containment scope was established — fail closed, never open. */
  | 'CONTAINMENT_UNINITIALIZED'
  /** The action addressed a different tab than the contained target tab. */
  | 'TAB_SCOPE_VIOLATION'
  /** The dashboard origin is never a permitted agent environment. */
  | 'DASHBOARD_ORIGIN_DENIED'
  /** A non-web scheme can never be contained, so it is refused. */
  | 'UNSUPPORTED_SCHEME_DENIED'
  /** Input was missing or malformed — fail closed. */
  | 'MALFORMED_INPUT';

export interface ContainmentDecision {
  /** True only when the action may proceed to the dispatch boundary. */
  contained: boolean;
  code: ContainmentCode;
  /** Deterministic, value-free explanation. Never contains a URL or page text. */
  reason: string;
  /** The containment scope the verdict was evaluated against. */
  scopeOrigin: string | null;
  /** True when the denial is terminal (the task must not retry into the scope). */
  terminal: boolean;
}

// ── Scope ────────────────────────────────────────────────────────────────────

/**
 * The environmental boundary for one task.
 *
 * `rootHost` is the registrable-ish root of the resolved target (e.g.
 * `google.com`). Subdomains of it are INSIDE the scope, because a user who
 * asked for "google" authorises `www.google.com` and `accounts.google.com`,
 * but not `example.com`.
 */
export interface ContainmentScope {
  /** Root host the task resolved to. Subdomains are contained. */
  rootHost: string;
  /** The exact origin the scope was established from, for audit/telemetry. */
  origin: string;
  /** The single tab id the agent is allowed to act in. */
  tabId: number | null;
  /** The dashboard origin, which is never a valid agent environment. */
  dashboardOrigin: string;
}

export interface ContainmentInput {
  /** The action about to be dispatched. */
  action: BrowserAction;
  /** The established containment scope, or null when none was established. */
  scope: ContainmentScope | null;
  /** The tab the executor is about to act in, when known. */
  targetTabId?: number | null;
  /** The LIVE url of the target tab, when known. Used to detect drift. */
  liveUrl?: string | null;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

function parseHost(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Host containment. The target's own root host and any subdomain of it are
 * inside the scope; every other host is outside. A leading `www.` is treated
 * as a subdomain, so `www.example.com` and `example.com` share a scope.
 */
export function hostWithinScope(host: string | null, rootHost: string | null): boolean {
  if (!host || !rootHost) return false;
  const h = host.toLowerCase();
  const r = rootHost.toLowerCase();
  return h === r || h.endsWith('.' + r);
}

/** Scheme check. Only real web origins can be contained. */
export function isContainableScheme(url: string | null | undefined): boolean {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Derive the root host for a target url. A single leading label is kept for
 * bare hostnames (e.g. `localhost`); otherwise the last two labels are used,
 * which matches the subdomain reasoning the tab resolver already relies on.
 */
export function deriveRootHost(url: string | null | undefined): string | null {
  const host = parseHost(url);
  if (!host) return null;
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return host;
  return labels.slice(-2).join('.');
}

// ── Scope establishment ──────────────────────────────────────────────────────

/**
 * Establish the containment scope for a task from the resolved target.
 *
 * Returns null (fail closed) when the target is not a real web origin, or when
 * the target IS the dashboard — the agent must never be contained inside the
 * dashboard, because the dashboard is the control surface, not the target.
 */
export function establishContainmentScope(input: {
  targetUrl: string | null | undefined;
  targetTabId: number | null;
  dashboardOrigin?: string;
}): ContainmentScope | null {
  const dashboardOrigin = input.dashboardOrigin || 'http://localhost:5173';
  const targetUrl = input.targetUrl;

  if (!isContainableScheme(targetUrl)) return null;

  let rootHost: string | null;
  let origin: string;
  try {
    const parsed = new URL(targetUrl as string);
    origin = parsed.origin;
    rootHost = deriveRootHost(targetUrl);
  } catch {
    return null;
  }
  if (!rootHost) return null;

  // The dashboard is never a valid agent environment.
  if (isDashboardOrigin(origin, dashboardOrigin)) return null;

  return { rootHost, origin, tabId: input.targetTabId, dashboardOrigin };
}

export function isDashboardOrigin(origin: string, dashboardOrigin = 'http://localhost:5173'): boolean {
  try {
    const o = new URL(origin).origin;
    let d: string;
    try {
      d = new URL(dashboardOrigin).origin;
    } catch {
      return false;
    }
    if (o === d) return true;
    // Any port-5173 origin is the dashboard family.
    try {
      return new URL(o).port === '5173';
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

// ── The containment decision ─────────────────────────────────────────────────

/**
 * Evaluate one proposed action against the containment scope.
 *
 * This is an ENVIRONMENTAL check, not an authorization check. It is called at
 * the dispatch boundary, AFTER the full security pipeline has already run, and
 * it can only ever narrow what happens next.
 */
export function evaluateContainment(input: ContainmentInput): ContainmentDecision {
  const { action, scope } = input;

  // 0. Malformed input fails closed.
  if (!action || typeof action !== 'object' || typeof action.action !== 'string') {
    return {
      contained: false,
      code: 'MALFORMED_INPUT',
      reason: 'Containment received no well-formed action; failing closed.',
      scopeOrigin: scope?.origin ?? null,
      terminal: true,
    };
  }

  // 1. No scope established → fail closed. An uncontained agent is never a
  //    permitted state, even if every other gate would have allowed the action.
  if (!scope) {
    return {
      contained: false,
      code: 'CONTAINMENT_UNINITIALIZED',
      reason:
        'No containment scope is established for this task; the agent environment is undefined, so every action fails closed.',
      scopeOrigin: null,
      terminal: true,
    };
  }

  // 2. Tab containment. The agent may only act in the ONE tab it was pinned
  //    to, even though every action is well-formed and authorized.
  if (typeof input.targetTabId === 'number' && typeof scope.tabId === 'number') {
    if (input.targetTabId !== scope.tabId) {
      return {
        contained: false,
        code: 'TAB_SCOPE_VIOLATION',
        reason: 'Action addressed a tab outside the contained target tab.',
        scopeOrigin: scope.origin,
        terminal: true,
      };
    }
  }

  // 3. Scheme containment. Only http/https can be contained at all; anything
  //    else (javascript:, data:, file:, chrome:, about:) has no origin we can
  //    bound, so it is refused regardless of how it reached this point.
  if (action.action === 'navigate' && typeof action.url === 'string') {
    if (!isContainableScheme(action.url)) {
      return {
        contained: false,
        code: 'UNSUPPORTED_SCHEME_DENIED',
        reason: 'Navigation scheme is not a containable web origin.',
        scopeOrigin: scope.origin,
        terminal: true,
      };
    }
  }

  // 4. Navigation containment. A `navigate` may not leave the resolved site.
  if (action.action === 'navigate' && typeof action.url === 'string') {
    const destHost = parseHost(action.url);
    if (!hostWithinScope(destHost, scope.rootHost)) {
      return {
        contained: false,
        code: 'CROSS_ORIGIN_NAVIGATION_DENIED',
        reason:
          'Navigation target is outside the containment scope for this task. The agent may act on the resolved site only.',
        scopeOrigin: scope.origin,
        terminal: true,
      };
    }
  }

  // 5. Drift containment. If the live tab has already left the scope (a
  //    redirect, a page-driven jump, or a stale pinned target), the agent must
  //    not keep acting on the page it has drifted to.
  if (typeof input.liveUrl === 'string' && input.liveUrl.trim()) {
    if (isContainableScheme(input.liveUrl)) {
      const liveHost = parseHost(input.liveUrl);
      if (!hostWithinScope(liveHost, scope.rootHost)) {
        return {
          contained: false,
          code: 'SCOPE_DRIFT_DETECTED',
          reason:
            'The target tab has left the containment scope; further interaction is refused until the scope is re-established.',
          scopeOrigin: scope.origin,
          terminal: true,
        };
      }
    } else if (parseHost(input.liveUrl) === null && !/^about:blank$/i.test(input.liveUrl.trim())) {
      // A non-web, non-blank live URL is outside the web containment boundary.
      return {
        contained: false,
        code: 'UNSUPPORTED_SCHEME_DENIED',
        reason: 'The target tab is no longer on a containable web origin.',
        scopeOrigin: scope.origin,
        terminal: true,
      };
    }
  }

  // 6. Dashboard containment — belt and braces; the scope can never be
  //    established on the dashboard, so this only fires on a forged scope.
  if (isDashboardOrigin(scope.origin, scope.dashboardOrigin)) {
    return {
      contained: false,
      code: 'DASHBOARD_ORIGIN_DENIED',
      reason: 'The dashboard origin is never a valid agent environment.',
      scopeOrigin: scope.origin,
      terminal: true,
    };
  }

  return {
    contained: true,
    code: 'WITHIN_SCOPE',
    reason: 'Action stays within the containment scope for this task.',
    scopeOrigin: scope.origin,
    terminal: false,
  };
}

/**
 * Verify a post-navigation landing url against the scope.
 *
 * Containment must hold ACROSS a navigation, not only before it: a site that
 * redirects the agent to another origin has moved the environment, and the
 * agent must not continue acting there.
 */
export function verifyNavigationContainment(
  scope: ContainmentScope | null,
  actualUrl: string | null | undefined
): ContainmentDecision {
  if (!scope) {
    return {
      contained: false,
      code: 'CONTAINMENT_UNINITIALIZED',
      reason: 'No containment scope established; post-navigation verification fails closed.',
      scopeOrigin: null,
      terminal: true,
    };
  }
  if (!isContainableScheme(actualUrl)) {
    return {
      contained: false,
      code: 'UNSUPPORTED_SCHEME_DENIED',
      reason: 'Post-navigation landing is not a containable web origin.',
      scopeOrigin: scope.origin,
      terminal: true,
    };
  }
  const actualHost = parseHost(actualUrl);
  if (!hostWithinScope(actualHost, scope.rootHost)) {
    return {
      contained: false,
      code: 'SCOPE_DRIFT_DETECTED',
      reason: 'Navigation landed outside the containment scope for this task.',
      scopeOrigin: scope.origin,
      terminal: true,
    };
  }
  return {
    contained: true,
    code: 'WITHIN_SCOPE',
    reason: 'Navigation landed inside the containment scope.',
    scopeOrigin: scope.origin,
    terminal: false,
  };
}

/** Stable, value-free audit line for a containment decision. */
export function describeContainment(decision: ContainmentDecision): string {
  return `CONTAINMENT_${decision.code} (${decision.contained ? 'ALLOW' : 'DENY'})`;
}

/**
 * A short, deterministic summary of the scope for the task state. Contains no
 * page content, only the root host the task was contained to.
 */
export function containmentSummary(scope: ContainmentScope | null): string {
  return scope ? `contained:${scope.rootHost}` : 'contained:none';
}
