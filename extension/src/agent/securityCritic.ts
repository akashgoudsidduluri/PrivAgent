/**
 * PrivAgent — Independent Security Critic (Phase 8)
 *
 * A lightweight, deterministic, LOCAL reviewer that inspects a proposed browser
 * action BEFORE execution and returns ALLOW / REVIEW / BLOCK with a stable code.
 *
 * ── Position in the pipeline ────────────────────────────────────────────────
 *   Reasoner → Target Grounding → M5 Validator → SECURITY CRITIC
 *           → Privacy Policy → Risk/Semantic → Confirmation → Execution
 *
 * ── Authority model (non-negotiable) ───────────────────────────────────────
 *  1. The critic ADDS a review. It never replaces, weakens or re-orders any
 *     existing gate. M5, privacy policy, risk assessment, user confirmation,
 *     target grounding and goal verification all keep their existing authority
 *     and run unchanged before and after the critic.
 *  2. The critic can only ever TIGHTEN: ALLOW means "no objection", never
 *     "permission". A downstream gate may still block an ALLOWed action.
 *  3. It is advisory-by-construction for REVIEW: REVIEW never authorises
 *     anything, it only annotates. It may BLOCK.
 *  4. It is model-agnostic and fully local. No network, no model call, no
 *     provider dependency. Same inputs always produce the same verdict.
 *  5. It fails CLOSED: any malformed, missing or uncertain input yields BLOCK.
 *  6. It never receives raw sensitive values. It reads only the sanitized
 *     AgentContextPayload, the proposed action's structural fields, and
 *     non-sensitive agent state. It returns codes and reasons, never values.
 *
 * Webpage content and model output are UNTRUSTED inputs to this function, never
 * instructions it obeys.
 */

import { BrowserAction } from './actionTypes';
import { AgentContextPayload, AgentDetection } from '../privacy/types';
import { ActionRiskAssessment } from './riskEngine';
import { classifyWebContent, classifyModelOutput } from '../security/injectionFirewall';
import { scanForRawSensitiveValues } from '../privacy/rawValueScanner';

// ── Verdict ──────────────────────────────────────────────────────────────────

export type CriticVerdict = 'ALLOW' | 'REVIEW' | 'BLOCK';

export type CriticCode =
  // BLOCK
  | 'MALFORMED_INPUT'
  | 'INJECTION_INFLUENCE'
  | 'UNSAFE_PROTOCOL'
  | 'SENSITIVE_DISCLOSURE_ATTEMPT'
  | 'GOAL_MISMATCH'
  | 'CONTRADICTORY_SEQUENCE'
  | 'SUSPICIOUS_NAVIGATION'
  | 'DESTRUCTIVE_WITHOUT_INTENT'
  // REVIEW
  | 'HIGH_RISK_REVIEW'
  | 'AMBIGUOUS_TARGET'
  | 'UNUSUAL_SEQUENCE'
  // ALLOW
  | 'NO_OBJECTION';

export interface SecurityCriticResult {
  verdict: CriticVerdict;
  code: CriticCode;
  /** Deterministic, value-free explanation. Never contains page or model text. */
  reason: string;
  /** Every finding, in evaluation order. Codes only — no values. */
  findings: CriticCode[];
  /** True only when the critic examined a complete, well-formed input. */
  inputWellFormed: boolean;
}

export interface SecurityCriticInput {
  action: BrowserAction;
  task: string;
  context: AgentContextPayload;
  risk?: ActionRiskAssessment;
  /** Active subgoal description/id, if any. Contextual only — never authority. */
  subgoal?: { id?: string; description?: string; category?: string };
  /** Actions already executed in this task (oldest first). */
  history?: BrowserAction[];
  /** URL the action would leave the current origin for, if it navigates. */
  destinationUrl?: string;
  /** The current page URL. Defaults to context.url. */
  currentUrl?: string;
}

// ── Deterministic constants ──────────────────────────────────────────────────

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Schemes that must never be executed, regardless of anything else. */
const DANGEROUS_PROTOCOLS = ['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:'];

/**
 * Value-free intent lexicon. These are GENERIC browser-agent terms, not
 * domain rules: the critic must work for any site, not just one vertical.
 */
const SEARCH_TERMS = ['search', 'look up', 'find', 'query', 'google', 'bing', 'duckduckgo'];
/**
 * STRONG search markers, used only to decide whether a GOAL is search-shaped.
 * 'find' is deliberately excluded: it is an ordinary English verb ("find the
 * director, producers, screenwriters...") and would classify almost any
 * research goal as a search task, which wrongly blocked legitimate
 * long-horizon navigation between pages. It is still used to recognise search
 * CONTROLS, where the wording really is a signal.
 */
const STRONG_SEARCH_TERMS = ['search', 'look up', 'query', 'google', 'bing', 'duckduckgo'];
const NAVIGATE_TERMS = ['open', 'go to', 'navigate', 'visit', 'browse', 'show me'];
/**
 * PHASE 17.5A. The UNAMBIGUOUS subset of `NAVIGATE_TERMS`.
 *
 * `NAVIGATE_TERMS` is the right vocabulary for asking "does this goal mention
 * navigation at all?". It is NOT the right vocabulary for EXEMPTING a goal from
 * the read-only rule, because `'show me'` is far more often a request to READ
 * the current page ("Show me the current page title.") than to move away from
 * it.
 *
 * The distinction matters because the cross-origin safety check below also
 * consults `NAVIGATE_TERMS`. Treating `'show me'` as navigation intent in the
 * read-only exemption would therefore ALSO satisfy that check, and a read-only
 * "Show me ..." goal could have permitted an unrelated external navigation.
 * Only verbs that mean "go somewhere" exempt a goal here.
 */
const UNAMBIGUOUS_NAVIGATE_TERMS = ['go to', 'navigate', 'visit', 'browse', 'open'];
const READ_TERMS = ['show', 'read', 'display', 'view', 'what', 'check', 'see'];
const TYPE_TERMS = ['enter', 'type', 'fill', 'input', 'write', 'search for'];
const SCROLL_TERMS = ['scroll', 'down', 'up'];

/** Generic actions that mutate state and are never implied by ordinary goals. */
const DESTRUCTIVE_TERMS = [
  'delete', 'remove', 'erase', 'wipe', 'close account', 'deactivate',
  'revoke', 'unsubscribe', 'drop table',
];

/** Generic actions that move value or commit the user financially. */
const CONSEQUENTIAL_TERMS = [
  'pay', 'payment', 'transfer', 'send money', 'wire', 'checkout', 'purchase',
  'buy', 'order', 'subscribe', 'charge', 'withdraw', 'donate', 'tip',
];

/** Terms that indicate the caller is trying to move a secret out of the page. */
const DISCLOSURE_TERMS = [
  'send', 'post', 'upload', 'transmit', 'email', 'share', 'export', 'copy',
  'report', 'leak', 'exfiltrate', 'webhook', 'api key', 'otp', 'cvv',
  'password', 'card number', 'account number', 'token', 'secret', 'session',
];

const TASK_STOPWORDS = new Set([
  'the', 'and', 'then', 'for', 'with', 'from', 'into', 'onto', 'this', 'that',
  'these', 'those', 'please', 'open', 'show', 'go', 'goto', 'navigate', 'click',
  'on', 'in', 'at', 'to', 'of', 'a', 'an', 'is', 'are', 'it', 'its', 'page',
  'using', 'use', 'find', 'search', 'look', 'up', 'me', 'my', 'all', 'any',
  'can', 'you', 'i', 'want', 'need', 'do', 'now', 'and/or',
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

function hasAnyTerm(haystack: string, terms: string[]): boolean {
  const h = haystack.toLowerCase();
  return terms.some((t) => h.includes(t));
}

function goalTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !TASK_STOPWORDS.has(t));
}

function parseUrlSafely(url: string | undefined): URL | null {
  if (typeof url !== 'string' || url.trim().length === 0) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function targetDescriptor(action: BrowserAction, target?: AgentDetection): string {
  const parts: string[] = [action.reason ?? ''];
  if ('target' in action && typeof (action as { target?: unknown }).target === 'string') {
    parts.push(String((action as { target?: string }).target));
  }
  if (target) {
    parts.push(target.selector || '', target.label || '');
  }
  return parts.join(' ').toLowerCase();
}

// ── The critic ───────────────────────────────────────────────────────────────

/**
 * Reviews a proposed action. Deterministic, local, value-free, fail-closed.
 */
export function reviewProposedAction(input: SecurityCriticInput): SecurityCriticResult {
  const findings: CriticCode[] = [];

  // ── 0. Input well-formedness. Anything uncertain fails closed. ───────────
  if (!input || typeof input !== 'object') {
    return {
      verdict: 'BLOCK',
      code: 'MALFORMED_INPUT',
      reason: 'Security critic received no input; failing closed.',
      findings: ['MALFORMED_INPUT'],
      inputWellFormed: false,
    };
  }
  const { action, task, context } = input;
  if (!action || typeof action !== 'object' || typeof action.action !== 'string') {
    return fail('Action is missing or is not a structured BrowserAction.');
  }
  if (typeof task !== 'string' || task.trim().length === 0) {
    return fail('Task/goal is missing; the critic cannot judge goal alignment.');
  }
  if (!context || !Array.isArray(context.detections)) {
    return fail('Sanitized page context is missing or malformed.');
  }
  if (context.sanitized_status !== 'sanitized_only') {
    return fail('Context is not a sanitized payload; refusing to review.');
  }
  // Defence in depth: the critic must never be handed raw values.
  if (scanForRawSensitiveValues(context).length > 0) {
    return fail('Context failed the raw-value firewall; refusing to review.');
  }

  const resolvedTarget = resolveTarget(action, context);
  const descriptor = targetDescriptor(action, resolvedTarget);
  // The control's own machine-generated surface, WITHOUT the model-supplied
  // reason. The reason is untrusted model output and can say anything; only
  // page-derived metadata is used to judge whether a control relates to a goal.
  const targetSurface = resolvedTarget
    ? `${resolvedTarget.label || ''} ${resolvedTarget.selector || ''} ${resolvedTarget.id || ''}`.toLowerCase()
    : '';

  // The page's own machine-generated surface. Used ONLY to decide whether the
  // goal is anchored to this page at all — a goal that names nothing on the
  // current page cannot be meaningfully contradicted by a control on it.
  const pageSurface = context.detections
    .map((d) => `${d.label || ''} ${d.selector || ''} ${d.id || ''}`)
    .join(' ')
    .toLowerCase();
  const currentUrl = input.currentUrl || context.url || '';
  const current = parseUrlSafely(currentUrl);
  const goal = `${task} ${input.subgoal?.description ?? ''} ${input.subgoal?.id ?? ''}`.toLowerCase();
  // Phase 16 P1 remediation, follow-on. `goal` above deliberately blends the
  // USER's task with the planner's MODEL-AUTHORED subgoal narration, because
  // goal-ALIGNMENT is a usefulness question. It must not be reused for the
  // cross-origin navigation rule, which is a SAFETY question: a subgoal the
  // model itself wrote ("Navigate to search engine or knowledge portal") is
  // not the user asking to be sent off-origin, and must not vouch for a
  // destination the user never named. Before the injection fix, this defect
  // was masked by INJECTION_INFLUENCE firing on the model's own reason text;
  // with that false positive gone, the distinction has to be explicit.
  const userGoal = task.toLowerCase();
  const goalAnchored = (() => {
    const pageTokens = new Set(goalTokens(pageSurface));
    for (const t of goalTokens(goal)) {
      if (pageTokens.has(t)) return true;
    }
    return false;
  })();

  // ── 1. Dangerous / suspicious navigation ──────────────────────────────────
  const proposedUrl =
    action.action === 'navigate'
      ? (action as { url?: string }).url
      : input.destinationUrl;
  if (typeof proposedUrl === 'string' && proposedUrl.trim().length > 0) {
    const raw = proposedUrl.trim().toLowerCase();
    if (DANGEROUS_PROTOCOLS.some((p) => raw.startsWith(p))) {
      findings.push('UNSAFE_PROTOCOL');
    } else {
      const parsed = parseUrlSafely(proposedUrl);
      if (!parsed) {
        findings.push('SUSPICIOUS_NAVIGATION');
      } else if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        findings.push('UNSAFE_PROTOCOL');
      } else if (
        /(@|%40)/.test(parsed.hostname) ||
        /^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.hostname) ||
        /^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.hostname.replace(/^\[|\]$/g, ''))
      ) {
        // Credential-in-host or raw-IP navigation is never goal-implied.
        findings.push('SUSPICIOUS_NAVIGATION');
      } else if (current && parsed.origin !== current.origin) {
        // Cross-origin: legitimate, but always worth a second look unless the
        // goal actually names the destination.
        const goalNamesHost =
          userGoal.includes(parsed.hostname.toLowerCase()) ||
          goalTokens(userGoal).some((t) => t.length >= 4 && parsed.hostname.toLowerCase().includes(t));
        if (!goalNamesHost && !hasAnyTerm(userGoal, NAVIGATE_TERMS)) {
          findings.push('SUSPICIOUS_NAVIGATION');
        }
      }
    }
  }

  // ── 2. Sensitive-data disclosure attempt ─────────────────────────────────
  if (
    hasAnyTerm(descriptor, DISCLOSURE_TERMS) &&
    (hasAnyTerm(descriptor, CONSEQUENTIAL_TERMS) || action.action === 'navigate' || action.action === 'type')
  ) {
    findings.push('SENSITIVE_DISCLOSURE_ATTEMPT');
  }
  // A typing action that carries an obviously credential-shaped value.
  if (action.action === 'type') {
    const typed = String((action as { text?: string }).text ?? '');
    if (/\b\d{13,19}\b/.test(typed) || /\b\d{3,4}\b/.test(typed) && /\bcvv\b|\bpin\b/i.test(descriptor)) {
      findings.push('SENSITIVE_DISCLOSURE_ATTEMPT');
    }
  }

  // ── 3. Prompt-injection influence (webpage + model output are untrusted) ──
  //
  // Phase 16 P1 remediation: the two provenances are classified SEPARATELY.
  //
  // `descriptor` used to be handed to the page-injection classifier as one
  // blob. But it mixes PAGE-DERIVED text (the target's selector, id and label
  // come from the page) with MODEL-AUTHORED text (the action's own `reason`).
  // Running the page-hijack signature list over the model's own narration
  // flagged ordinary plans — "Navigate to the products page." — as
  // INJECTION_INFLUENCE and blocked them.
  //
  // The fix is provenance, not a weaker scanner:
  //   • page-derived strings → classifyWebContent  (full page-hijack set)
  //   • the model's reason  → classifyModelOutput   (relay/steering set only)
  // Nothing is whitelisted: no domain, no phrase, no task. A page that injects
  // is still caught, and a model that RELAYS an injection is still caught.
  const pageDerivedSources = [
    // Only the page-derived half of the descriptor. The model's `reason` is
    // deliberately excluded and handled below.
    resolvedTarget
      ? `${resolvedTarget.selector || ''} ${resolvedTarget.label || ''} ${resolvedTarget.id || ''}`
      : '',
    (context.semantic_context?.entities ?? [])
      .map((e) => (e as { label?: string; description?: string }).label ?? '')
      .join(' '),
    (context.semantic_context?.affordances ?? [])
      .map((a) => (a.description ?? ''))
      .join(' '),
  ]
    .filter((s) => typeof s === 'string' && s.trim().length > 0)
    .map((s) => classifyWebContent(s).trustLevel);

  const modelAuthoredSources = [action.reason ?? '']
    .filter((s) => typeof s === 'string' && s.trim().length > 0)
    .map((s) => classifyModelOutput(s).trustLevel);

  if ([...pageDerivedSources, ...modelAuthoredSources].some((t) => t === 'HOSTILE')) {
    findings.push('INJECTION_INFLUENCE');
  }
  if (context.semantic_context?.promptInjectionDetected === true) {
    findings.push('INJECTION_INFLUENCE');
  }

  // ── 4. Action / goal mismatch ────────────────────────────────────────────
  const intentMismatch = detectGoalMismatch(action, goal, descriptor, targetSurface, goalAnchored);
  if (intentMismatch) findings.push('GOAL_MISMATCH');

  // ── 5. Destructive or consequential action the goal never asked for ──────
  if (hasAnyTerm(descriptor, DESTRUCTIVE_TERMS) && !hasAnyTerm(goal, DESTRUCTIVE_TERMS)) {
    findings.push('DESTRUCTIVE_WITHOUT_INTENT');
  }

  // ── 6. Unusual / contradictory sequences ─────────────────────────────────
  const history = Array.isArray(input.history) ? input.history : [];
  const sequenceCode = reviewSequence(action, history, goal);
  if (sequenceCode) findings.push(sequenceCode);

  // ── 7. High-risk or ambiguous actions → REVIEW, never an authorisation ───
  const risk = input.risk;
  if (risk && (risk.riskLevel === 'HIGH' || risk.riskLevel === 'CRITICAL')) {
    findings.push('HIGH_RISK_REVIEW');
  }
  if (isAmbiguousTarget(action, context)) {
    findings.push('AMBIGUOUS_TARGET');
  }

  // ── Verdict ──────────────────────────────────────────────────────────────
  const blocking = findings.filter(isBlocking);
  if (blocking.length > 0) {
    return {
      verdict: 'BLOCK',
      code: blocking[0]!,
      reason: blockingReason(blocking),
      findings,
      inputWellFormed: true,
    };
  }
  if (findings.length > 0) {
    return {
      verdict: 'REVIEW',
      code: findings[0]!,
      reason: `Security critic raised no blocking finding but flagged: ${findings.join(', ')}. Downstream gates remain authoritative.`,
      findings,
      inputWellFormed: true,
    };
  }
  return {
    verdict: 'ALLOW',
    code: 'NO_OBJECTION',
    reason: 'Security critic found no objection. This is not an authorisation; M5, privacy, risk and confirmation still decide.',
    findings: [],
    inputWellFormed: true,
  };
}

function fail(reason: string): SecurityCriticResult {
  return {
    verdict: 'BLOCK',
    code: 'MALFORMED_INPUT',
    reason,
    findings: ['MALFORMED_INPUT'],
    inputWellFormed: false,
  };
}

const BLOCKING_CODES: ReadonlySet<CriticCode> = new Set<CriticCode>([
  'MALFORMED_INPUT',
  'INJECTION_INFLUENCE',
  'UNSAFE_PROTOCOL',
  'SENSITIVE_DISCLOSURE_ATTEMPT',
  'GOAL_MISMATCH',
  'CONTRADICTORY_SEQUENCE',
  'SUSPICIOUS_NAVIGATION',
  'DESTRUCTIVE_WITHOUT_INTENT',
]);

function isBlocking(code: CriticCode): boolean {
  return BLOCKING_CODES.has(code);
}

function blockingReason(codes: CriticCode[]): string {
  switch (codes[0]) {
    case 'INJECTION_INFLUENCE':
      return 'Proposed action carries prompt-injection influence from untrusted page or model content.';
    case 'UNSAFE_PROTOCOL':
      return 'Proposed action requests a protocol that must never be executed.';
    case 'SENSITIVE_DISCLOSURE_ATTEMPT':
      return 'Proposed action attempts to move sensitive data out of the page.';
    case 'GOAL_MISMATCH':
      return 'Proposed action is unrelated to the current goal or subgoal.';
    case 'CONTRADICTORY_SEQUENCE':
      return 'Proposed action contradicts the actions already taken in this task.';
    case 'SUSPICIOUS_NAVIGATION':
      return 'Proposed navigation destination is not implied by the goal.';
    case 'DESTRUCTIVE_WITHOUT_INTENT':
      return 'Proposed destructive action is not implied by the goal.';
    default:
      return 'Security critic could not form a decision; failing closed.';
  }
}

function resolveTarget(action: BrowserAction, context: AgentContextPayload): AgentDetection | undefined {
  if (!('target' in action) || typeof (action as { target?: unknown }).target !== 'string') {
    return undefined;
  }
  const id = (action as { target: string }).target;
  return context.detections.find((d) => d.id === id);
}

/**
 * Deterministic goal-alignment check. The action kind must be one the goal
 * actually implies, and its target must not belong to a conflicting intent.
 */
function detectGoalMismatch(
  action: BrowserAction,
  goal: string,
  descriptor: string,
  targetSurface: string,
  goalAnchored: boolean
): boolean {
  const goalIsSearch = hasAnyTerm(goal, STRONG_SEARCH_TERMS);
  const goalIsNavigate = hasAnyTerm(goal, NAVIGATE_TERMS);
  const goalIsType = hasAnyTerm(goal, TYPE_TERMS);
  const goalIsScroll = hasAnyTerm(goal, SCROLL_TERMS);
  const goalIsRead = hasAnyTerm(goal, READ_TERMS);
  // "Show / read / view / check" with no state-changing intent at all: the user
  // asked to LOOK, not to act.
  const goalIsReadOnly =
    goalIsRead && !goalIsSearch && !goalIsType && !hasAnyTerm(goal, [...DESTRUCTIVE_TERMS, ...CONSEQUENTIAL_TERMS]);
  // PHASE 17.5A. Does the goal UNAMBIGUOUSLY ask to go somewhere? See
  // UNAMBIGUOUS_NAVIGATE_TERMS for why 'show me' is excluded.
  const goalExplicitlyNavigates = hasAnyTerm(goal, UNAMBIGUOUS_NAVIGATE_TERMS);
  const goalSaysNothingSpecific = !goalIsSearch && !goalIsNavigate && !goalIsType && !goalIsScroll && !goalIsRead;

  // Destructive or financial commitment is never implied by an ordinary goal.
  if (hasAnyTerm(descriptor, DESTRUCTIVE_TERMS) && !hasAnyTerm(goal, DESTRUCTIVE_TERMS)) {
    return true;
  }

  switch (action.action) {
    case 'navigate': {
      // ── PHASE 17.5A ────────────────────────────────────────────────────────
      // A goal that ITSELF asks to navigate is not "read-only".
      //
      // `goalIsNavigate` is computed a few lines above and was omitted from the
      // `goalIsReadOnly` expression, so any goal containing BOTH a navigation
      // verb and a read verb ("Go to X and report Y" — 'go to' + 'report'/
      // 'display') was classified read-only, and the very next line then
      // returned a mismatch on the goal's own requested navigation.
      //
      // This scoping is deliberate. The read-only rule still holds for goals
      // that ask ONLY to read ("Read the current page title."), which is the
      // signal it was written for. A goal that names navigation explicitly has
      // given POSITIVE evidence that navigation is wanted, which is exactly the
      // standard the comment below sets for the rest of this case.
      //
      // Nothing is broadened: unrelated and out-of-scope destinations are still
      // blocked by the dedicated navigation-safety checks (unsafe protocol,
      // raw-IP / credential-in-host, and cross-origin without the goal naming
      // the destination), and every other authority is untouched.
      if (goalIsReadOnly && !goalExplicitlyNavigates) return true;
      if (goalSaysNothingSpecific) return true;
      // A navigate is a mismatch only on POSITIVE evidence of conflict. The
      // absence of a search/navigation word in the model-supplied reason proves
      // nothing: reasons are untrusted free text, and a long research goal
      // ("...find the director, producers, screenwriters and cinematographer")
      // legitimately moves between many pages of the same site.
      //
      // Genuinely suspicious destinations — unsafe schemes, raw-IP or
      // credential-in-host URLs, and cross-origin targets the goal does not
      // imply — remain BLOCK-level via the dedicated navigation-safety checks.
      // Nothing is given up by refusing to guess from a bare verb here.
      return false;
    }
    case 'type': {
      // Typing is only expected for search / form-filling goals.
      if (goalIsReadOnly) return true;
      if (goalIsSearch || goalIsType || goalIsNavigate) return false;
      if (goalAnchored) return false;
      return goalSaysNothingSpecific;
    }
    case 'click': {
      // A vague goal is NOT itself a mismatch: a grounded click on a live
      // control is a normal step. Only a goal that is demonstrably anchored to
      // this page can be contradicted (see the anchored-overlap rule below).
      // Clicking a control whose own text names a conflicting intent.
      if (hasAnyTerm(descriptor, DESTRUCTIVE_TERMS) && !hasAnyTerm(goal, DESTRUCTIVE_TERMS)) {
        return true;
      }
      // NOTE: we deliberately do NOT treat "the control/reason mentions no
      // search word" as a mismatch. That reads untrusted model free text and
      // the model may word a perfectly legitimate step however it likes. A real
      // mismatch (e.g. clicking a theme toggle during a search task) is caught
      // below by the control-surface overlap rule, which uses only the control's
      // own machine-generated metadata.
      // A click is only expected on a control that relates to the goal. Judge
      // the CONTROL's own machine-generated surface, never the model-supplied
      // reason: an untrusted reason can name any intent it likes.
      const controlSurface = targetSurface || descriptor;
      if (
        hasAnyTerm(controlSurface, [...SEARCH_TERMS, ...TYPE_TERMS, ...READ_TERMS, ...NAVIGATE_TERMS]) ||
        hasAnyTerm(controlSurface, [...DESTRUCTIVE_TERMS, ...CONSEQUENTIAL_TERMS])
      ) {
        return false;
      }
      // Absent overlap is NOT on its own a security finding. Which of several
      // grounded controls best serves the goal is a RELEVANCE decision, and it
      // already has dedicated local authority in the semantic verifier,
      // candidate entities and goal verification. Blocking here would let a
      // security heuristic veto legitimate exploration (e.g. deliberately
      // probing an alternative control on the page the goal is anchored to).
      //
      // The rule is therefore scoped to the one case where a mismatch is
      // unambiguous and security-relevant: the goal is a SEARCH/QUERY task, so
      // clicking a control that relates to no searching, typing, reading or
      // navigation intent is an action the goal does not support at all.
      if (!goalIsSearch) return false;
      // Only judge control-vs-goal overlap when the goal actually names
      // something on THIS page; otherwise the goal is too vague to contradict.
      if (!goalAnchored) return false;
      const goalTerms = new Set(goalTokens(goal));
      if (goalTerms.size === 0) return false;
      const controlTokens = new Set(goalTokens(controlSurface));
      for (const t of goalTerms) {
        if (controlTokens.has(t)) return false;
      }
      return true;
    }
    case 'select': {
      return false;
    }
    case 'pressKey': {
      // Phase 11: the key comes from a fixed non-destructive allowlist (M5 is
      // authoritative for it) and the target, when present, must be a grounded
      // form control. The destructive/consequential cross-check above runs
      // BEFORE this switch, so a keyboard step is never exempt from goal
      // alignment on those grounds; it is only exempt from the verb-heuristics
      // above, which cannot be reasoned about for a key with no own semantics.
      return false;
    }
    case 'scroll': {
      return false;
    }
    default:
      return true;
  }
}

/**
 * Sequence review over the actions already executed in this task.
 * Detects direct contradiction (same target, different intent) and
 * pathological repetition without ever executing anything.
 */
function reviewSequence(
  action: BrowserAction,
  history: BrowserAction[],
  goal: string
): CriticCode | null {
  if (history.length === 0) return null;

  const last = history[history.length - 1]!;

  // Contradiction: the agent just navigated away, yet proposes to act on an
  // element that only existed on the page it left.
  if (last.action === 'navigate' && 'target' in action) {
    const target = (action as { target?: string }).target;
    if (target && /^[a-z]+(?:-[a-z]+)*-\d+$/i.test(target)) {
      return 'CONTRADICTORY_SEQUENCE';
    }
  }

  // Unusual: the same destructive/consequential click repeated many times.
  const descriptor = targetDescriptor(action);
  if (hasAnyTerm(descriptor, DESTRUCTIVE_TERMS)) {
    const repeats = history.filter(
      (h) => h.action === action.action && targetDescriptor(h) === descriptor
    ).length;
    if (repeats >= 2) return 'CONTRADICTORY_SEQUENCE';
  }

  // Unusual: typing the same value into the same field over and over.
  if (action.action === 'type' && last.action === 'type') {
    const sameTarget =
      'target' in action && 'target' in last
        ? (action as { target?: string }).target === (last as { target?: string }).target
        : false;
    if (sameTarget && hasAnyTerm(goal, SEARCH_TERMS)) return 'UNUSUAL_SEQUENCE';
  }

  return null;
}

/** Ambiguity: a target that matches several interactive elements, or a zero-size one. */
function isAmbiguousTarget(action: BrowserAction, context: AgentContextPayload): boolean {
  if (!('target' in action) || typeof (action as { target?: unknown }).target !== 'string') {
    return false;
  }
  const id = (action as { target: string }).target;
  const matches = context.detections.filter((d) => d.id === id);
  if (matches.length !== 1) return true;
  const det = matches[0]!;
  if (det.bbox && det.bbox.width <= 0 && det.bbox.height <= 0) return true;
  if (det.confidence < 0.5) return true;
  return false;
}
