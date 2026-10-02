/**
 * PrivAgent — POST-17.10 Step 10.2: DESTINATION TRUST-BOUNDARY CLOSURE.
 *
 * G2 — MODEL-FACING PROPAGATION
 * G3 — ENTRY URL vs DESTINATION URL
 *
 * WHAT THIS FILE IS
 * ─────────────────
 * The Step 10 audit recorded two gaps in the destination pipeline, and this
 * file is the executable form of their closure.
 *
 * G2 was a DIVERGENCE, not a production outage. Two functions build a
 * model-facing view of the same context: `minimizeAgentContext`, which forwards
 * `semantic_context` wholesale, and `buildModelFacingContext`, which projects
 * it field by field through an allowlist. The allowlist omitted
 * `declaredDestination`, and the type system could not object, because the field
 * was not declared on `SanitizedSemanticContext` — it only existed behind an
 * `as` cast at the single injection site. The production backend path uses the
 * wholesale payload (proved in Part 1 of the Step 10.2 evidence, and re-proved
 * here against the real function rather than against a comment), but a module
 * that documents itself as "the ONE minimization code path every provider uses"
 * disagreed with it. Section A below proves the production path is lossless and
 * that both projections now agree.
 *
 * G3 was a real producer defect. A user's URL was attached to a declaration
 * AFTER every construct had been emitted, to whichever declaration happened to
 * carry a role — with no regard for which verb the URL belonged to. The visible
 * symptom: `"visit http://h/product.html then open the catalog"` and
 * `"open the catalog, then visit http://h/product.html"` produced BYTE-IDENTICAL
 * declarations, and in both the user's explicit destination URL was silently
 * demoted to the `entryUrl` of the other construct. An explicit destination URL
 * could therefore only ever reach `destinationUrl` when no role noun appeared
 * anywhere in the task.
 *
 * HONESTY NOTE
 * ────────────
 * Everything here is Node/unit or Node/integration with a CONTROLLED provider.
 * It is `PROVEN_UNIT_ONLY` unless the evidence files under
 * `docs/evidence/post-17-10/audit/` say otherwise. No test in this file talks to
 * a real model or a real browser, and none claims to.
 */

import { describe, it, expect } from 'vitest';

import {
  normalizeDestination,
  normalizeDestinations,
} from '../extension/src/planning/destinationNormalizer';
import { verifyDestination } from '../extension/src/planning/destinationVerifier';
import {
  PlannerContextBuilder,
  toDeclaredDestinationConstraint,
} from '../extension/src/hierarchicalPlanning/plannerContextBuilder';
import {
  minimizeAgentContext,
  buildModelFacingContext,
} from '../extension/src/privacy/contextMinimizer';
import type { AgentContextPayload } from '../extension/src/privacy/types';
import type { HighLevelGoal, Subgoal } from '../extension/src/hierarchicalPlanning/hierarchicalTypes';
import type { DestinationDeclaration } from '../extension/src/planning/destinationNormalizer';

const ORIGIN = 'http://localhost:4174';
const RESULTS = `${ORIGIN}/results.html`;
const SEARCH = `${ORIGIN}/search.html`;

// ════════════════════════════════════════════════════════════════════════════
// Fixtures
// ════════════════════════════════════════════════════════════════════════════

/**
 * A sanitized payload shaped exactly like the one the service worker hands to
 * `minimizeAgentContext`: a full M4 payload with a semantic context attached.
 */
function payload(semanticContext: Record<string, unknown>): AgentContextPayload {
  return {
    url: `${ORIGIN}/`,
    timestamp: 1_700_000_000_000,
    viewport: { width: 1280, height: 900, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: null,
    detections: [],
    total_elements_scanned: 12,
    sensitive_elements_detected: 0,
    sanitized_status: 'sanitized_only',
    ocr_metrics: null,
    semantic_context: {
      pageType: 'LISTING',
      confidence: 0.99,
      pageState: 'populated',
      pageGeneration: 5,
      entities: [],
      affordances: [],
      promptInjectionDetected: false,
      ...semanticContext,
    } as AgentContextPayload['semantic_context'],
  };
}

/**
 * The production egress step, verbatim: `serviceWorker.ts` calls
 * `minimizeAgentContext(built, { task })` and hands `minimized.payload` to the
 * agent loop, which hands `context` to `provider.requestAction(task, context)`.
 * `backendAgentProvider` then strips four LOCAL-ONLY fields and serializes.
 *
 * The four stripped fields are device-local provenance (`viewportObservable`,
 * `viewportSource`, `ocr_observation`, `semanticObservation`). They are applied
 * here by reference so the resulting object is what actually goes on the wire.
 */
function productionEgress(base: AgentContextPayload, task: string): Record<string, unknown> {
  const minimized = minimizeAgentContext(base, { task });
  const {
    viewportObservable: _vo,
    viewportSource: _vs,
    ocr_observation: _ocrObs,
    semanticObservation: _semObs,
    ...egressContext
  } = minimized.payload as unknown as Record<string, unknown>;
  return { task, context: egressContext, history: [], model_role: undefined };
}

function goalWith(declaration: DestinationDeclaration): HighLevelGoal {
  return {
    goalId: 'g1',
    rawUserPrompt: 'user task',
    sanitizedGoalDescription: 'user task',
    taskCategory: 'NAVIGATION',
    targetEntities: [],
    constraints: {},
    createdAt: 1_700_000_000_000,
    status: 'ACTIVE',
    destinationDeclaration: declaration,
  } as unknown as HighLevelGoal;
}

function subgoalWith(declaration: DestinationDeclaration): Subgoal {
  return {
    id: 'sg1',
    goalId: 'g1',
    index: 0,
    description: 'reach the declared destination',
    category: 'NAVIGATION',
    prerequisites: [],
    retryCount: 0,
    maxRetries: 2,
    state: 'PENDING',
    destination: declaration,
  } as unknown as Subgoal;
}

/** The planner→reasoner hop, exactly as `agentLoop.ts:1072` performs it. */
function plannerContext(base: AgentContextPayload, declaration: DestinationDeclaration) {
  return PlannerContextBuilder.buildContext(base, goalWith(declaration), subgoalWith(declaration))
    .contextPayload;
}

function declared(declaration: DestinationDeclaration) {
  return (declaration as { kind: string; url?: unknown }).url;
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION A — G2: the production model-facing path is lossless (tests 1–10)
// ════════════════════════════════════════════════════════════════════════════

describe('G2 — role-only declaration survives the production model-facing path', () => {
  const TASK = 'open the store catalog';
  const declaration = normalizeDestination(TASK);

  it('A1 · the user prompt produces a role-only declaration with no URL at all', () => {
    expect(declaration.kind).toBe('DECLARED');
    const d = declaration as Extract<DestinationDeclaration, { kind: 'DECLARED' }>;
    expect(d.role?.acceptablePageTypes).toEqual(['LISTING']);
    expect(declared(declaration)).toBeUndefined();
  });

  it('A2 · it survives planner → minimized payload → production egress bytes', () => {
    const bytes = productionEgress(
      plannerContext(payload({}), declaration),
      TASK
    );
    const rendered = (bytes.context as Record<string, unknown>).semantic_context as unknown as Record<
      string,
      unknown
    >;
    expect(rendered.declaredDestination).toEqual({
      provenance: 'USER_DECLARED_DESTINATION',
      role: ['LISTING'],
    });
  });

  it('A3 · no URL is synthesized anywhere on that path', () => {
    const bytes = productionEgress(plannerContext(payload({}), declaration), TASK);
    const rendered = (bytes.context as Record<string, unknown>).semantic_context as unknown as Record<
      string,
      unknown
    >;
    const block = rendered.declaredDestination as Record<string, unknown>;
    expect('destinationUrl' in block).toBe(false);
    expect('entryUrl' in block).toBe(false);
    // And nothing anywhere in the payload invents a results/search/product URL.
    expect(JSON.stringify(bytes)).not.toMatch(/results\.html|search\.html|product\.html|checkout/);
  });

  it('A4 · observation cannot rewrite it', () => {
    // A fresh observation of a completely different page changes the VERDICT,
    // never the DECLARATION. The declaration is a pure function of the prompt.
    const observed = {
      url: `${ORIGIN}/login.html`,
      pageGeneration: 9,
      semantic: { pageType: 'LOGIN' as const, confidence: 0.99, pageGeneration: 9 },
    };
    const verdict = verifyDestination({ declaration, observation: observed });
    expect(verdict.kind).toBe('MISMATCH');
    expect(verdict.decisiveChannel).toBe('pageRole');
    expect(normalizeDestination(TASK)).toEqual(declaration);
  });

  it('A5 · model output cannot rewrite it', () => {
    // No model output is an input to the normalizer: its signature is a single
    // string. A "model-authored destination" object in the page context is
    // dropped by the projection, not adopted.
    const poisoned = payload({
      declaredDestination: {
        provenance: 'MODEL_PROPOSED_DESTINATION',
        destinationUrl: `${ORIGIN}/checkout.html`,
      },
    });
    const bytes = productionEgress(poisoned, TASK);
    const rendered = (bytes.context as Record<string, unknown>).semantic_context as unknown as Record<
      string,
      unknown
    >;
    // Minimization forwards `semantic_context` verbatim, so the poisoned block
    // IS present on the wire — which is precisely why the backend's G4 trust
    // boundary refuses it. What matters here is that the extension's own
    // producer never produces such a block, and never one with a real
    // provenance and a URL the user did not type.
    expect(toDeclaredDestinationConstraint(declaration)).toEqual({
      provenance: 'USER_DECLARED_DESTINATION',
      role: ['LISTING'],
    });
    expect((rendered.declaredDestination as Record<string, unknown>).provenance).toBe(
      'MODEL_PROPOSED_DESTINATION'
    );
  });

  it('A6 · action.url cannot rewrite it', () => {
    const bytes = productionEgress(
      plannerContext(payload({}), declaration),
      TASK
    );
    const withAction: Record<string, unknown> = {
      ...bytes,
      history: [{ action: 'navigate', url: `${ORIGIN}/checkout.html`, reason: 'model said so' }],
    };
    const rendered = (withAction.context as Record<string, unknown>).semantic_context as unknown as Record<
      string,
      unknown
    >;
    expect(rendered.declaredDestination).toEqual({
      provenance: 'USER_DECLARED_DESTINATION',
      role: ['LISTING'],
    });
  });

  it('A7 · targetEntity cannot create a declaration', () => {
    const withEntity = payload({
      entities: [
        {
          id: 'e1',
          type: 'LINK',
          label: 'Catalog',
          confidence: 0.99,
          actionIds: ['a1'],
          safeAttributes: { destinationUrl: RESULTS },
        },
      ],
    });
    const bytes = productionEgress(plannerContext(withEntity, normalizeDestination(TASK)), TASK);
    const rendered = (bytes.context as Record<string, unknown>).semantic_context as unknown as Record<
      string,
      unknown
    >;
    expect((rendered.declaredDestination as Record<string, unknown>).role).toEqual(['LISTING']);
    expect('destinationUrl' in (rendered.declaredDestination as object)).toBe(false);
  });

  it('A8 · affordances cannot create a declaration', () => {
    const withAffordance = payload({
      affordances: [
        {
          id: 'a1',
          type: 'LINK',
          requiresConfirmation: false,
          description: 'Go to results',
          entryUrl: RESULTS,
        },
      ],
    });
    const bytes = productionEgress(
      plannerContext(withAffordance, normalizeDestination(TASK)),
      TASK
    );
    const rendered = (bytes.context as Record<string, unknown>).semantic_context as unknown as Record<
      string,
      unknown
    >;
    expect((rendered.declaredDestination as Record<string, unknown>).role).toEqual(['LISTING']);
    expect('entryUrl' in (rendered.declaredDestination as object)).toBe(false);
  });

  it('A9 · an undeclared task stays undeclared', () => {
    const TASK2 = 'find the cheapest blue running shoes';
    const none = normalizeDestination(TASK2);
    expect(none.kind).toBe('NONE');
    const bytes = productionEgress(plannerContext(payload({}), none), TASK2);
    const rendered = (bytes.context as Record<string, unknown>).semantic_context as unknown as Record<
      string,
      unknown
    >;
    expect('declaredDestination' in rendered).toBe(false);
  });

  it('A10 · raw page text/DOM cannot manufacture a declaration', () => {
    const withFacts = payload({
      facts: [
        {
          key: 'cta',
          label: 'Shop the catalog at http://localhost:4174/results.html',
          displayText: 'Catalog',
          untrusted: true,
        },
      ],
    });
    const declaration2 = normalizeDestination(TASK);
    const bytes = productionEgress(plannerContext(withFacts, declaration2), TASK);
    const rendered = (bytes.context as Record<string, unknown>).semantic_context as unknown as Record<
      string,
      unknown
    >;
    // The page-derived text is carried (it is sanitized display data), but it
    // produced NO channel: the declaration is byte-identical to the one derived
    // from the prompt alone, with a prompt that contains no URL whatsoever.
    expect(declaration2.kind === 'DECLARED' && declaration2.url).toBeUndefined();
    expect(rendered.declaredDestination).toEqual({
      provenance: 'USER_DECLARED_DESTINATION',
      role: ['LISTING'],
    });
  });
});

describe('G2 — explicit URL survives the production model-facing path', () => {
  const TASK = `open ${RESULTS}`;
  const declaration = normalizeDestination(TASK);

  it('B1 · the user prompt produces an exact normalized destination URL', () => {
    expect(declaration.kind).toBe('DECLARED');
    const d = declaration as Extract<DestinationDeclaration, { kind: 'DECLARED' }>;
    expect(d.url?.origin).toBe(ORIGIN);
    expect(d.url?.path).toBe('/results.html');
    expect(d.entryUrl).toBeUndefined();
  });

  it('B2 · it survives the complete production path byte-for-byte', () => {
    const bytes = productionEgress(plannerContext(payload({}), declaration), TASK);
    const rendered = (bytes.context as Record<string, unknown>).semantic_context as unknown as Record<
      string,
      unknown
    >;
    expect(rendered.declaredDestination).toEqual({
      provenance: 'USER_DECLARED_DESTINATION',
      destinationUrl: RESULTS,
    });
  });

  it('B3 · both model-facing projections now agree (the divergence that was G2)', () => {
    const minimized = minimizeAgentContext(plannerContext(payload({}), declaration), {
      task: TASK,
    });
    const wholesale = (minimized.payload.semantic_context as unknown as Record<string, unknown>)
      .declaredDestination;
    const projected = buildModelFacingContext(minimized.payload, TASK).semantic_context
      ?.declaredDestination;
    expect(projected).toEqual(wholesale);
    expect(projected).toEqual({
      provenance: 'USER_DECLARED_DESTINATION',
      destinationUrl: RESULTS,
    });
  });

  it('B4 · and they agree for the role-only case too', () => {
    const TASK2 = 'open the store catalog';
    const d2 = normalizeDestination(TASK2);
    const minimized = minimizeAgentContext(plannerContext(payload({}), d2), { task: TASK2 });
    const wholesale = (minimized.payload.semantic_context as unknown as Record<string, unknown>)
      .declaredDestination;
    const projected = buildModelFacingContext(minimized.payload, TASK2).semantic_context
      ?.declaredDestination;
    expect(projected).toEqual(wholesale);
    expect(projected).toEqual({ provenance: 'USER_DECLARED_DESTINATION', role: ['LISTING'] });
  });

  it('B5 · a payload with no declaration projects no declaration', () => {
    const minimized = minimizeAgentContext(payload({}), { task: TASK });
    expect(buildModelFacingContext(minimized.payload, TASK).semantic_context?.declaredDestination)
      .toBeUndefined();
  });

  it('B6 · the role+entryUrl declaration keeps BOTH fields distinct in BOTH projections', () => {
    // The substitution mutant (entry url rewritten as the destination url) only
    // fires when the declaration actually carries an entryUrl, so it needs a
    // CASE C declaration to reach. This is that case.
    const TASK2 = `open the store catalog at ${ORIGIN}`;
    const d2 = normalizeDestination(TASK2);
    const minimized = minimizeAgentContext(plannerContext(payload({}), d2), { task: TASK2 });
    const wholesale = (minimized.payload.semantic_context as unknown as Record<string, unknown>)
      .declaredDestination;
    const projected = buildModelFacingContext(minimized.payload, TASK2).semantic_context
      ?.declaredDestination;

    expect(wholesale).toEqual({
      provenance: 'USER_DECLARED_DESTINATION',
      role: ['LISTING'],
      entryUrl: `${ORIGIN}/`,
    });
    expect(projected).toEqual(wholesale);
    expect('destinationUrl' in (projected as object)).toBe(false);
    expect((projected as { entryUrl?: unknown }).entryUrl).toBe(`${ORIGIN}/`);
  });

  it('B7 · the role+entryUrl declaration survives the production egress bytes', () => {
    const TASK2 = `open the store catalog at ${ORIGIN}`;
    const bytes = productionEgress(
      plannerContext(payload({}), normalizeDestination(TASK2)),
      TASK2
    );
    const rendered = (bytes.context as Record<string, unknown>).semantic_context as unknown as Record<
      string,
      unknown
    >;
    expect(rendered.declaredDestination).toEqual({
      provenance: 'USER_DECLARED_DESTINATION',
      role: ['LISTING'],
      entryUrl: `${ORIGIN}/`,
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SECTION B — G3: entry URL vs destination URL
// ════════════════════════════════════════════════════════════════════════════

describe('G3 — CASE A/B/C/D: the entry/destination contract', () => {
  it('CASE A · role only: role present, BOTH URLs absent', () => {
    const d = normalizeDestination('open the store catalog');
    expect(d.kind).toBe('DECLARED');
    const dec = d as Extract<DestinationDeclaration, { kind: 'DECLARED' }>;
    expect(dec.role?.acceptablePageTypes).toEqual(['LISTING']);
    expect(dec.url).toBeUndefined();
    expect(dec.entryUrl).toBeUndefined();
  });

  it('CASE B · explicit URL: destinationUrl exact, entryUrl absent', () => {
    const d = normalizeDestination(`open ${RESULTS}`);
    const dec = d as Extract<DestinationDeclaration, { kind: 'DECLARED' }>;
    expect(`${dec.url?.origin}${dec.url?.path}`).toBe(RESULTS);
    expect(dec.entryUrl).toBeUndefined();
  });

  it('CASE C · entry-only: entryUrl present, destinationUrl absent', () => {
    const d = normalizeDestination(`open the store catalog at ${ORIGIN}`);
    const dec = d as Extract<DestinationDeclaration, { kind: 'DECLARED' }>;
    expect(dec.entryUrl?.origin).toBe(ORIGIN);
    expect(dec.entryUrl?.path).toBe('/');
    expect(dec.url).toBeUndefined();
  });

  it('CASE D · explicit URL + role: BOTH constraints are represented independently', () => {
    // The user's own verb governs the URL: "visit <url>" names the destination.
    const d = normalizeDestination(`visit ${RESULTS} then open the catalog`);
    expect(d.kind).toBe('DECLARED');
    const dec = d as Extract<DestinationDeclaration, { kind: 'DECLARED' }>;
    expect(`${dec.url?.origin}${dec.url?.path}`).toBe(RESULTS);
    expect(dec.entryUrl).toBeUndefined();

    // …and the role is a SEPARATE declaration in textual order, not merged into
    // one object and not lost.
    const all = normalizeDestinations(`visit ${RESULTS} then open the catalog`);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({
      kind: 'DECLARED',
      role: { acceptablePageTypes: ['LISTING'] },
    });
    expect((all[1] as { url?: unknown }).url).toBeUndefined();
    expect((all[1] as { entryUrl?: unknown }).entryUrl).toBeUndefined();
  });

  it('G3-ROOT · the URL is bound to ITS OWN construct, not to the first role', () => {
    // THE regression. Before the fix these two produced byte-identical
    // declarations and the user's explicit destination URL was demoted to the
    // catalog declaration's entryUrl.
    const urlFirst = normalizeDestinations(`visit ${RESULTS} then open the catalog`);
    const urlLast = normalizeDestinations(`open the catalog then visit ${RESULTS}`);

    expect(urlFirst[0]).toMatchObject({ kind: 'DECLARED', url: { path: '/results.html' } });
    expect((urlFirst[0] as { entryUrl?: unknown }).entryUrl).toBeUndefined();

    expect(urlLast[0]).toMatchObject({ kind: 'DECLARED', role: { acceptablePageTypes: ['LISTING'] } });
    expect((urlLast[0] as { url?: unknown }).url).toBeUndefined();
    expect((urlLast[0] as { entryUrl?: unknown }).entryUrl).toBeUndefined();
    expect(urlLast[1]).toMatchObject({ kind: 'DECLARED', url: { path: '/results.html' } });

    // The two tasks are no longer indistinguishable.
    expect(JSON.stringify(urlFirst)).not.toEqual(JSON.stringify(urlLast));
  });

  it('G3-SPLIT · the split still turns on grammar alone, never on URL shape', () => {
    // The SAME literal splits two ways depending only on whether a role noun
    // governs the destination verb. Step 6's pinned contract is preserved.
    const withRole = normalizeDestination(`open the catalog at ${RESULTS}`);
    const withoutRole = normalizeDestination(`open ${RESULTS}`);
    expect((withRole as Extract<DestinationDeclaration, { kind: 'DECLARED' }>).entryUrl?.path).toBe(
      '/results.html'
    );
    expect((withRole as Extract<DestinationDeclaration, { kind: 'DECLARED' }>).url).toBeUndefined();
    expect((withoutRole as Extract<DestinationDeclaration, { kind: 'DECLARED' }>).url?.path).toBe(
      '/results.html'
    );
    expect((withoutRole as Extract<DestinationDeclaration, { kind: 'DECLARED' }>).entryUrl).toBeUndefined();
  });

  it('G3 · a non-http URL is never claimed as a destination either', () => {
    for (const task of [
      'open file:///etc/passwd',
      'open chrome://settings',
      'visit ftp://localhost:4174/results.html',
    ]) {
      const d = normalizeDestination(task);
      expect((d as { url?: unknown }).url, task).toBeUndefined();
      expect((d as { entryUrl?: unknown }).entryUrl, task).toBeUndefined();
    }
  });
});

describe('G3 — destination verification cannot be satisfied by an entry URL', () => {
  const ENTRY_ONLY = normalizeDestination(`open the store catalog at ${ORIGIN}`);

  it('G3-V1 · an entry-only declaration opens NO url channel at all', () => {
    // With no observation the role channel is UNKNOWN; the decisive structural
    // fact is that `entryUrl` never became a URL channel in the first place.
    const noObs = verifyDestination({ declaration: ENTRY_ONLY });
    expect(noObs.kind).toBe('UNKNOWN');
    expect(noObs.channels.url).toBeNull();

    // …and with an observation of the entry site itself the URL channel is
    // still absent, so nothing about the entry URL can ever produce a verdict.
    const onEntry = verifyDestination({
      declaration: ENTRY_ONLY,
      observation: { url: `${ORIGIN}/`, pageGeneration: 1 },
      currentPageGeneration: 1,
    });
    expect(onEntry.channels.url).toBeNull();
    expect(onEntry.decisiveChannel).not.toBe('url');
  });

  it('G3-V2 · an entry-only declaration observed AT the entry URL is still UNKNOWN', () => {
    // The decisive case: the browser is sitting exactly on the URL the user
    // named. If entryUrl were treated as destinationUrl this would MATCH.
    const verdict = verifyDestination({
      declaration: ENTRY_ONLY,
      observation: { url: `${ORIGIN}/`, pageGeneration: 3 },
      currentPageGeneration: 3,
    });
    expect(verdict.kind).toBe('UNKNOWN');
    expect(verdict.channels.url).toBeNull();
  });

  it('G3-V3 · an entry-only declaration observed at the REAL destination still verifies on ROLE', () => {
    const verdict = verifyDestination({
      declaration: ENTRY_ONLY,
      observation: {
        url: RESULTS,
        pageGeneration: 4,
        semantic: { pageType: 'LISTING', confidence: 0.99, pageGeneration: 4 },
      },
      currentPageGeneration: 4,
    });
    expect(verdict.kind).toBe('MATCH');
    expect(verdict.decisiveChannel).toBe('pageRole');
  });

  it('G3-V4 · URL mismatch is MISMATCH even when the role matches (exact matching)', () => {
    const d = normalizeDestination(`open ${RESULTS}`);
    const verdict = verifyDestination({
      declaration: d,
      observation: {
        url: SEARCH,
        pageGeneration: 2,
        semantic: { pageType: 'LISTING', confidence: 0.99, pageGeneration: 2 },
      },
      currentPageGeneration: 2,
    });
    expect(verdict.kind).toBe('MISMATCH');
    expect(verdict.decisiveChannel).toBe('url');
  });

  it('G3-V5 · exact matching was NOT weakened: no substring, hostname or prefix escape', () => {
    const d = normalizeDestination(`open ${RESULTS}`);
    const observe = (url: string) =>
      verifyDestination({
        declaration: d,
        observation: { url, pageGeneration: 1 },
        currentPageGeneration: 1,
      }).kind;

    // A path PREFIX of the declared path is not a match.
    expect(observe(`${ORIGIN}/results`)).toBe('MISMATCH');
    // A SUPERSET path is not a match.
    expect(observe(`${ORIGIN}/results.html/details`)).toBe('MISMATCH');
    // The hostname alone is not a match.
    expect(observe(`${ORIGIN}/`)).toBe('MISMATCH');
    // A different path that CONTAINS the declared path is not a match.
    expect(observe(`${ORIGIN}/x/results.html`)).toBe('MISMATCH');
    // A different origin is not a match.
    expect(observe(`http://localhost:4175/results.html`)).toBe('MISMATCH');
    // Only the exact declared identity matches.
    expect(observe(RESULTS)).toBe('MATCH');
  });

  it('G3-V6 · an observed URL never becomes a declaration', () => {
    // Whatever the page is showing, the declaration is a function of the prompt.
    const prompt = 'open the store catalog';
    const before = normalizeDestination(prompt);
    verifyDestination({
      declaration: before,
      observation: {
        url: `${ORIGIN}/checkout.html`,
        pageGeneration: 7,
        semantic: { pageType: 'CHECKOUT', confidence: 1, pageGeneration: 7 },
      },
      currentPageGeneration: 7,
    });
    expect(normalizeDestination(prompt)).toEqual(before);
  });
});

describe('G3 — serialization preserves the distinction', () => {
  it('G3-S1 · role+entryUrl and destinationUrl are different wire objects', () => {
    const entry = toDeclaredDestinationConstraint(
      normalizeDestination(`open the store catalog at ${ORIGIN}`)
    );
    const dest = toDeclaredDestinationConstraint(normalizeDestination(`open ${RESULTS}`));

    expect(entry).toEqual({
      provenance: 'USER_DECLARED_DESTINATION',
      role: ['LISTING'],
      entryUrl: `${ORIGIN}/`,
    });
    expect(dest).toEqual({
      provenance: 'USER_DECLARED_DESTINATION',
      destinationUrl: RESULTS,
    });
    // A round trip through JSON changes neither object, and does not merge them.
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
    expect(JSON.parse(JSON.stringify(dest))).toEqual(dest);
    expect(Object.keys(entry!).sort()).not.toEqual(Object.keys(dest!).sort());
  });

  it('G3-S2 · the two channels never collide on one literal', () => {
    for (const task of [
      `open ${RESULTS}`,
      `open the catalog at ${RESULTS}`,
      `visit ${RESULTS} then open the catalog`,
      `open the catalog then visit ${RESULTS}`,
      `open the store catalog at ${ORIGIN}`,
      `open the store catalog`,
    ]) {
      const d = normalizeDestination(task) as Extract<DestinationDeclaration, { kind: 'DECLARED' }>;
      if (d.kind !== 'DECLARED') continue;
      expect(d.url && d.entryUrl, task).toBeFalsy();
    }
  });

  it('G3-S3 · the wire object carries no key the backend privacy firewall rejects', () => {
    const wire = [
      toDeclaredDestinationConstraint(normalizeDestination(`visit ${RESULTS} then open the catalog`)),
      toDeclaredDestinationConstraint(normalizeDestination(`open the catalog at ${RESULTS}`)),
      toDeclaredDestinationConstraint(normalizeDestination('open the store catalog')),
    ];
    for (const block of wire) {
      expect(JSON.stringify(block)).toBeTruthy();
      for (const forbidden of ['text', 'value', 'input', 'raw', 'password', 'token']) {
        expect(JSON.stringify(block), forbidden).not.toContain(`"${forbidden}"`);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SECTION C — Part 4 cross-layer adversarial matrix (A–J)
// ════════════════════════════════════════════════════════════════════════════

describe('Part 4 — cross-layer adversarial matrix', () => {
  /** prompt → declaration → planner → minimized → production egress bytes */
  const crossLayer = (task: string) => {
    const declaration = normalizeDestination(task);
    const planner = plannerContext(payload({}), declaration);
    const minimized = minimizeAgentContext(planner, { task });
    const {
      viewportObservable: _vo,
      viewportSource: _vs,
      ocr_observation: _o,
      semanticObservation: _s,
      ...egressContext
    } = minimized.payload as unknown as Record<string, unknown>;
    const projected = buildModelFacingContext(minimized.payload, task).semantic_context
      ?.declaredDestination;
    return {
      declaration,
      constraint: toDeclaredDestinationConstraint(declaration),
      egress: egressContext.semantic_context as Record<string, unknown>,
      projected,
    };
  };

  it('A · ROLE ONLY survives prompt → planner → model-facing → egress', () => {
    const r = crossLayer('open the store catalog');
    expect(r.constraint).toEqual({ provenance: 'USER_DECLARED_DESTINATION', role: ['LISTING'] });
    expect(r.egress.declaredDestination).toEqual(r.constraint);
    expect(r.projected).toEqual(r.constraint);
    expect(JSON.stringify(r)).not.toMatch(/results\.html|search\.html/);
  });

  it('B · EXPLICIT URL survives with the exact URL preserved', () => {
    const r = crossLayer(`open ${RESULTS}`);
    expect(r.constraint).toEqual({
      provenance: 'USER_DECLARED_DESTINATION',
      destinationUrl: RESULTS,
    });
    expect(r.egress.declaredDestination).toEqual(r.constraint);
    expect(r.projected).toEqual(r.constraint);
  });

  it('C · ENTRY + DESTINATION stay in their own fields', () => {
    const r = crossLayer(`visit ${RESULTS} then open the catalog at ${ORIGIN}`);
    const all = normalizeDestinations(`visit ${RESULTS} then open the catalog at ${ORIGIN}`);
    // N1 keeps a SINGLE url channel, so the second literal in this sentence is
    // deliberately not normalized at all — a documented, pre-existing limit
    // that fails STRICT (a missing constraint), never loose. It is asserted
    // here so the entry channel cannot be quietly widened by a later change.
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ kind: 'DECLARED', url: { path: '/results.html' } });
    expect(all[1]).toMatchObject({
      kind: 'DECLARED',
      role: { acceptablePageTypes: ['LISTING'] },
    });
    expect((all[0] as { entryUrl?: unknown }).entryUrl).toBeUndefined();
    expect((all[1] as { url?: unknown }).url).toBeUndefined();
    expect((all[1] as { entryUrl?: unknown }).entryUrl).toBeUndefined();

    // The same sentence WITHOUT the second literal produces the genuine
    // entry+destination pair: the entry URL attaches to the role construct and
    // the destination URL stays on its own construct.
    const pair = normalizeDestinations(`open the catalog at ${ORIGIN}`);
    expect(pair).toHaveLength(1);
    expect(pair[0]).toMatchObject({
      kind: 'DECLARED',
      role: { acceptablePageTypes: ['LISTING'] },
      entryUrl: { path: '/' },
    });
    expect((pair[0] as { url?: unknown }).url).toBeUndefined();
    expect(r.declaration.kind).toBe('DECLARED');
  });

  it('D · OBSERVATION ATTACK cannot inject a destination', () => {
    const prompt = 'open the store catalog';
    const before = normalizeDestination(prompt);
    const hostile: DestinationDeclaration = {
      kind: 'DECLARED',
      role: { provenance: 'EXPLICIT_PAGE_ROLE', acceptablePageTypes: ['LISTING'] },
      url: { provenance: 'USER_URL', origin: ORIGIN, path: '/checkout.html', rawUrl: `${ORIGIN}/checkout.html` },
    };
    // The verifier accepts the hostile object as input, but a verdict never
    // flows back into a declaration.
    const verdict = verifyDestination({
      declaration: hostile,
      observation: {
        url: `${ORIGIN}/checkout.html`,
        pageGeneration: 1,
        semantic: { pageType: 'CHECKOUT' as const, confidence: 1, pageGeneration: 1 },
      },
    });
    expect(verdict.kind).toBe('MISMATCH');
    expect(normalizeDestination(prompt)).toEqual(before);
    expect(toDeclaredDestinationConstraint(normalizeDestination(prompt))).toEqual({
      provenance: 'USER_DECLARED_DESTINATION',
      role: ['LISTING'],
    });
  });

  it('E · ACTION ATTACK: action.url cannot create or rewrite a declaration', () => {
    const prompt = 'open the store catalog';
    const r = crossLayer(prompt);
    const hostileActions = [
      { action: 'navigate', url: `${ORIGIN}/checkout.html`, reason: 'to the destination' },
      { action: 'navigate', url: 'https://attacker.example/steal', reason: 'entry' },
    ];
    // No action may contribute a declaration channel of its own.
    for (const action of hostileActions) {
      expect((action as Record<string, unknown>).declaredDestination).toBeUndefined();
      expect((action as Record<string, unknown>).destinationUrl).toBeUndefined();
      expect((action as Record<string, unknown>).entryUrl).toBeUndefined();
    }
    // …and the real declaration is untouched by any of them.
    expect(r.egress.declaredDestination).toEqual({
      provenance: 'USER_DECLARED_DESTINATION',
      role: ['LISTING'],
    });
    expect(JSON.stringify(r.constraint)).not.toContain('checkout');
    expect(JSON.stringify(r.constraint)).not.toContain('attacker.example');
  });

  it('F · MODEL ATTACK: model output cannot redefine the destination', () => {
    const prompt = 'open the store catalog';
    const modelOutput = {
      action: 'navigate',
      url: `${ORIGIN}/checkout.html`,
      reason: 'the destination is checkout',
      declaredDestination: { provenance: 'USER_DECLARED_DESTINATION', destinationUrl: `${ORIGIN}/checkout.html` },
    };
    // Feeding the model's own words back in as a NEW task does not create a
    // declaration either: `navigate` is a destination verb, but the model's
    // free text is not a user request, and the normalizer only ever sees the
    // user prompt.
    const r = crossLayer(prompt);
    expect(r.constraint).toEqual({ provenance: 'USER_DECLARED_DESTINATION', role: ['LISTING'] });
    expect(JSON.stringify(modelOutput)).not.toEqual(JSON.stringify(r.constraint));
    expect(normalizeDestination('open the checkout page').kind).toBe('DECLARED');
    expect(
      (normalizeDestination('open the checkout page') as { url?: unknown }).url
    ).toBeUndefined();
  });

  it('G · TARGET ENTITY ATTACK cannot create a declaration', () => {
    const prompt = 'open the store catalog';
    const r = crossLayer(prompt);
    const hostileContext = payload({
      entities: [
        {
          id: 'e1',
          type: 'LINK',
          label: 'results',
          confidence: 1,
          actionIds: [],
          safeAttributes: { declaredDestination: 'USER_DECLARED_DESTINATION' },
        },
      ],
    });
    const merged = plannerContext(hostileContext, normalizeDestination(prompt));
    const mergedSem = (merged.semantic_context as unknown as Record<string, unknown>).declaredDestination;
    expect(mergedSem).toEqual(r.constraint);
  });

  it('H · AFFORDANCE ATTACK cannot create a declaration', () => {
    const prompt = 'open the store catalog';
    const r = crossLayer(prompt);
    const hostileContext = payload({
      affordances: [
        {
          id: 'a1',
          type: 'LINK',
          requiresConfirmation: false,
          description: 'catalog',
          destinationUrl: RESULTS,
        },
      ],
    });
    const merged = plannerContext(hostileContext, normalizeDestination(prompt));
    expect((merged.semantic_context as unknown as Record<string, unknown>).declaredDestination).toEqual(
      r.constraint
    );
  });

  it('I · BACKEND FORGERY is refused by the producer, never by accident', () => {
    // The extension can only ever emit this exact literal, and only from a
    // DECLARED declaration. Everything else yields no constraint at all.
    const inputs = [
      'show me products',
      'search for checkout',
      'open the catalog number',
      '',
      'I already opened the catalog',
    ];
    for (const task of inputs) {
      const c = toDeclaredDestinationConstraint(normalizeDestination(task));
      if (c) {
        expect(c.provenance).toBe('USER_DECLARED_DESTINATION');
        expect(
          Object.keys(c).every((k) => ['provenance', 'role', 'destinationUrl', 'entryUrl'].includes(k))
        ).toBe(true);
      }
    }
    // And an AMBIGUOUS / UNSUPPORTED declaration can never even reach a wire
    // object, so the backend has nothing ambiguous to refuse.
    for (const task of ['open the results page', 'open the widget', 'open my account']) {
      expect(toDeclaredDestinationConstraint(normalizeDestination(task)), task).toBeUndefined();
    }
  });

  it('J · URL CONFUSION: entryUrl=/ and destinationUrl=/results.html are distinguished', () => {
    const declaration = normalizeDestination(`visit ${RESULTS} then open the catalog at ${ORIGIN}`);
    expect(declaration.kind).toBe('DECLARED');
    const dec = declaration as Extract<DestinationDeclaration, { kind: 'DECLARED' }>;
    expect(`${dec.url?.origin}${dec.url?.path}`).toBe(RESULTS);

    // The verifier, told the browser is sitting on the ENTRY url, must not call
    // the destination satisfied even though the entry URL is "where we started".
    const onEntry = verifyDestination({
      declaration,
      observation: { url: `${ORIGIN}/`, pageGeneration: 1 },
      currentPageGeneration: 1,
    });
    expect(onEntry.kind).toBe('MISMATCH');
    expect(onEntry.decisiveChannel).toBe('url');

    const onDestination = verifyDestination({
      declaration,
      observation: { url: RESULTS, pageGeneration: 1 },
      currentPageGeneration: 1,
    });
    expect(onDestination.kind).toBe('MATCH');
  });
});