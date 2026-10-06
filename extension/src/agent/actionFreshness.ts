/**
 * PHASE 18.8 / A16 — PRE-ACTION STATE FRESHNESS.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * Everything the agent knows about a page is a SNAPSHOT. Between the moment an
 * action is planned against that snapshot and the moment it is dispatched, the
 * document can move on: it can navigate, be replaced, or be re-rendered by the
 * site. A consequential action dispatched on a view that is no longer the view
 * it was planned on is not "acting on slightly old information" — it is acting
 * on a page nobody looked at, and on a purchase, submission, send, deletion or
 * transfer that is exactly how the wrong thing gets clicked.
 *
 * ── The contract ────────────────────────────────────────────────────────────
 * `FreshnessState` is a first-class, typed verdict on the state a consequential
 * action is about to be dispatched against:
 *
 *   FRESH            — the observation the action was grounded on is still the
 *                      current one. Proceed.
 *   STALE            — the page generation has advanced since the action was
 *                      planned. Do NOT dispatch; re-observe and re-plan.
 *   REFRESH_REQUIRED — there is no usable current observation (none was made, or
 *                      the one that was made failed). Re-observe before acting.
 *   CONFLICT         — two OBSERVED readings disagree about which document this
 *                      is (the URL moved, the document was replaced). The device
 *                      cannot decide which view the action belongs to, so it
 *                      stops and asks.
 *   UNKNOWN          — the device has no state information at all, so it cannot
 *                      claim the view is the one it planned on. Stops and asks.
 *
 * Two invariants make this fail-closed rather than decorative:
 *
 *   1. only an OBSERVATION can produce FRESH — a missing reading is never
 *      rounded up to "probably still fine";
 *   2. the verdict can only ever REMOVE a dispatch. FRESH grants nothing:
 *      grounding, M5, the security critic, privacy, risk/confirmation, the
 *      commit gate and the effect verifier all still run after it.
 *
 * This module is PURE and local: no I/O, no clock, no model, and no parameter
 * for what a model said the page looks like.
 */

/** The typed freshness of the state a consequential action is planned against. */
export type FreshnessState = 'FRESH' | 'STALE' | 'REFRESH_REQUIRED' | 'CONFLICT' | 'UNKNOWN';

/** Why the verdict came out the way it did. Fixed vocabulary, never prose. */
export type FreshnessCode =
  | 'SAME_GENERATION'
  | 'GENERATION_ADVANCED'
  | 'ACTION_GENERATION_OLDER'
  | 'NO_CURRENT_OBSERVATION'
  | 'OBSERVATION_FAILED'
  | 'URL_CHANGED_SINCE_PLANNING'
  | 'DOCUMENT_REPLACED'
  | 'NOT_CONSEQUENTIAL';

/** What the loop must do with the verdict. */
export type FreshnessResolution = 'PROCEED' | 'RE_PERCEIVE' | 'STOP_AND_ASK';

export interface FreshnessRecord {
  readonly state: FreshnessState;
  readonly code: FreshnessCode;
  readonly resolution: FreshnessResolution;
  /** The page generation the action was planned on, when the device knows it. */
  readonly plannedGeneration: number | null;
  /** The generation the device has NOW. */
  readonly currentGeneration: number | null;
  /** True when an observation was actually obtained at dispatch time. */
  readonly observed: boolean;
  readonly at: number;
}

export interface FreshnessAssessment {
  readonly state: FreshnessState;
  readonly code: FreshnessCode;
  readonly resolution: FreshnessResolution;
  /** True only for FRESH. Convenience for the caller; never a grant of authority. */
  readonly mayDispatchStaleView: boolean;
  readonly record: FreshnessRecord | null;
}

export interface FreshnessInput {
  /** True when the action can change the world outside this browser. */
  readonly consequential: boolean;
  /**
   * The page generation the action was PLANNED against. `null` means the device
   * does not know — which is not the same as "current".
   */
  readonly plannedGeneration?: number | null;
  readonly currentGeneration?: number | null;
  /** The URL the action was planned on. */
  readonly plannedUrl?: string | null;
  /**
   * The URL actually OBSERVED immediately before dispatch, from the same
   * observation channel the effect verifier uses. `null` = nothing observed.
   */
  readonly observedUrl?: string | null;
  /** True when an observation was obtained at dispatch time. */
  readonly observed: boolean;
  /** True when the host HAS an observation channel that failed for this action. */
  readonly observationFailed?: boolean;
  /** True when the observed snapshot describes a different document. */
  readonly differentDocument?: boolean;
  readonly at?: number;
}

const normUrl = (url: string | null | undefined): string | null => {
  if (typeof url !== 'string' || url.length === 0) return null;
  // Query strings and fragments are not part of "the same view" for this
  // purpose: a SPA that rewrites its own hash has not moved the action.
  const withoutFragment = url.split('#')[0] ?? url;
  const cut = withoutFragment.split('?')[0] ?? withoutFragment;
  return cut.replace(/\/+$/, '').toLowerCase();
};

/**
 * Decide whether the state a consequential action is planned against is still
 * the state the device observed.
 *
 * NOTE the order of the checks. An OBSERVED conflict about which document this
 * is outranks everything: no generation bookkeeping can rescue an action whose
 * page has moved. Only after that does a missing observation stop being
 * "probably fine".
 */
export function assessActionFreshness(input: FreshnessInput): FreshnessAssessment {
  const at = input.at ?? 0;
  const plannedGeneration = input.plannedGeneration ?? null;
  const currentGeneration = input.currentGeneration ?? null;

  const record = (
    state: FreshnessState,
    code: FreshnessCode,
    resolution: FreshnessResolution
  ): FreshnessAssessment => ({
    state,
    code,
    resolution,
    mayDispatchStaleView: state === 'FRESH',
    record: {
      state,
      code,
      resolution,
      plannedGeneration,
      currentGeneration,
      observed: input.observed === true,
      at,
    },
  });

  // A non-consequential action cannot commit anything, so freshness adds nothing
  // to the gates it already passes and must not manufacture a refusal.
  if (!input.consequential) {
    return record('FRESH', 'NOT_CONSEQUENTIAL', 'PROCEED');
  }

  const planned = normUrl(input.plannedUrl);
  const observedUrl = normUrl(input.observedUrl);

  // 1. Two OBSERVED readings that disagree about which document this is.
  if (input.differentDocument === true) {
    return record('CONFLICT', 'DOCUMENT_REPLACED', 'STOP_AND_ASK');
  }
  if (input.observed && planned !== null && observedUrl !== null && planned !== observedUrl) {
    return record('CONFLICT', 'URL_CHANGED_SINCE_PLANNING', 'STOP_AND_ASK');
  }

  // 2. The action was planned on a page the device has since moved past.
  if (plannedGeneration !== null && currentGeneration !== null && plannedGeneration < currentGeneration) {
    return record('STALE', 'ACTION_GENERATION_OLDER', 'RE_PERCEIVE');
  }

  // 3. No usable CURRENT observation.
  //
  // NOTE the position of this check, which is deliberate and load-bearing: it
  // sits BEFORE the "no declared generation" case below. An action that does not
  // say which page it was planned on is not thereby stale — but it is not fresh
  // either when nothing was observed, because invariant 1 above admits only an
  // OBSERVATION as evidence. Ordering this the other way lets a missing reading
  // fall through to FRESH, which is precisely the failure this module exists to
  // remove.
  if (input.observed !== true) {
    // The host has a channel and it failed: that is a refresh, not a conclusion
    // about the page — but a consequential action is not dispatched on a view
    // nobody can currently see either way.
    return record(
      'REFRESH_REQUIRED',
      input.observationFailed === true ? 'OBSERVATION_FAILED' : 'NO_CURRENT_OBSERVATION',
      'RE_PERCEIVE'
    );
  }

  // 4. The action does not say WHICH page it was planned on, the device does
  // know what page it is on, and the page was observed: not a stale view. It is
  // an action with no declared basis, which the grounding gate already owns.
  if (currentGeneration !== null && plannedGeneration === null) {
    return record('FRESH', 'SAME_GENERATION', 'PROCEED');
  }

  // 5. An action with no state information at all cannot be claimed as fresh.
  if (planned === null && observedUrl === null && currentGeneration === null) {
    return record('UNKNOWN', 'NO_CURRENT_OBSERVATION', 'STOP_AND_ASK');
  }

  return record('FRESH', 'SAME_GENERATION', 'PROCEED');
}

/** True for the two verdicts that end the run rather than refresh it. */
export function stopsTheRun(state: FreshnessState): boolean {
  return state === 'CONFLICT' || state === 'UNKNOWN';
}

/**
 * The user-facing sentence for a freshness stop. Fixed copy per state: the
 * dashboard must never receive an internal code, and it must never receive a
 * sentence claiming a failure that did not happen.
 */
export function freshnessStopMessage(state: FreshnessState): string | null {
  if (state === 'CONFLICT') {
    return 'The page moved while I was preparing that step, so I stopped without acting on the old view.';
  }
  if (state === 'UNKNOWN') {
    return 'I could not tell whether the page was still the one I planned that step on, so I stopped without acting.';
  }
  return null;
}
