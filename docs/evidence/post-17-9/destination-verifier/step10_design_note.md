# POST-17.10 Step 10 — Design note (written BEFORE any production edit)

## The two objectives, restated as architecture

```
                    ┌─ Objective A ─────────────────────────────┐
USER PROMPT         │  role = LISTING must reach the           │
   ↓                │  reasoning / action-selection boundary   │
normalizeDestination│                                          │
   ↓                └──────────────────────────────────────────┘
typed declaration
   ↓
HighLevelGoal → Subgoal
   ↓
┌──────────────────────┴──────────────┐
│ Objective A: reasoning boundary    │   Objective B: already-at-destination
└─────────────────────┬───────────────┘
                    ↓
              candidate action → execution
                      ↓ no transition
                 fresh observation
                      ↓
              destinationVerifier → MATCH → subgoal COMPLETE
```

## A. How does a ROLE-ONLY destination reach the action-selection / reasoning boundary?

`PlannerContextBuilder.buildContext(context, goal, activeSubgoal, memoryHints)` in
`extension/src/hierarchicalPlanning/plannerContextBuilder.ts` is already **the** planner→reasoning boundary.
It already receives `activeSubgoal`, already asserts privacy safety, and already produces the exact object the
provider receives. The destination is attached there as a new typed key inside `semantic_context`.

**The backend schema does NOT need to change.** `backend/app/models.py:169` declares
`semantic_context: Optional[Dict[str, Any]] = None` — a free dictionary, not a strict sub-model. `extra='forbid'`
applies to the top-level payload only. Step 9 proved the egress payload shape
(`{task, context, previousActions}`), and this adds a key *inside* `context.semantic_context`.

## B. What exact typed fields carry it?

```ts
interface DeclaredDestinationConstraint {
  /** Always this literal. Provenance is structural, not a debug string. */
  provenance: 'USER_DECLARED_DESTINATION';
  /** Closed-enum page roles the user asked for. Absent when the user named a URL instead. */
  role?: string[];
  /** Present ONLY when the user explicitly named the destination as a URL. */
  destinationUrl?: string;
  /** Where to start. NEVER a destination constraint; carried for provenance only. */
  entryUrl?: string;
}
```

Serialized as `semantic_context.declaredDestination`. Deliberately **not** `text` / `value` / `input` —
those keys are in `backend/app/security.py:19 FORBIDDEN_KEYS` and are rejected at any nesting depth.

## C. Where is provenance preserved?

The value is serialized from `Subgoal.destination`, which is a `DestinationDeclaration` whose every field is
`readonly`, produced exactly once by `normalizeDestination(userPrompt)`. `PlannerContextBuilder` only **reads**
it. There is no setter, and no code path assigns to `Subgoal.destination` after decomposition.

## D. How do we guarantee observation / model / action data cannot rewrite it?

The constraint is built from `subgoal.destination` alone. The function receives no model output, no
`action.url`, no `executionSuccess`, no `previousActions`, and no page-derived field is consulted when building
it. `role` comes from the declaration's closed enum, never from `classification.pageType`. Tests W7–W10 assert
this directly.

## E. How does the reasoner know `role = LISTING` without being told a fake URL?

The backend renders it as **typed data**, never as an instruction, and states that it is user-derived and
non-modifiable. One minimal addition to `_build_user_prompt`. This is the ONLY backend change, and Phase 1
proves it is strictly necessary: without it the field is accepted by the schema and then silently dropped
before the model ever sees it, leaving Objective A unimplemented. No unrelated backend behaviour is touched.

## F. How does the system decide whether a route/action can reach that role?

The extension cannot, and must not, guess. A role is a *semantic* target with no URL. The deterministic
navigator (`proposeDestinationNavigation`) therefore still returns `null` for a role-only declaration. The
reasoner, now knowing the role, may propose in-page affordance actions (`click`) — which system-prompt rule 6
permits. Whether it worked is decided by the verifier, not by the model.

## G. How is "destination already satisfied" handled without calling the action successful?

On `ACTION_NO_EFFECT`, the loop does **not** treat the action as successful. It requests a **fresh
perception** and asks `GoalProgressTracker.verifySubgoalCondition`, which calls `verifyDestination`.

- verifier `MATCH` → the subgoal completes, **credited to the observation and the verifier**, never to the
  action.
- anything else → the existing `ACTION_NO_EFFECT` failure record and recovery path run **unchanged**.

Effect Verification keeps its `ACTION_NO_EFFECT` verdict and its failure record in both branches. It is never
re-labelled, downgraded, or bypassed.

## H. Which authority decides destination satisfaction?

`destinationVerifier` (`extension/src/planning/destinationVerifier.ts`), reachable only through
`GoalProgressTracker.verifySubgoalCondition`. Unchanged in this step.

## I. Which authority decides overall task success?

`GoalVerifier` (`extension/src/agent/goalVerifier.ts`), unchanged. No new task-success path is introduced.

## Scope decisions taken from this design

| | |
|---|---|
| Backend **schema** | **Not changed.** Not necessary — `semantic_context` is a free dict. |
| Backend **prompt render** | One minimal addition. Strictly necessary; documented as such. |
| `destinationVerifier` | **Unchanged.** |
| `GoalVerifier` | **Unchanged.** |
| `classifyTaskCategory` | **Unchanged.** |
| Fixture routing | **None added.** No `"catalog" → /results.html` mapping exists or will exist. |
| `targetEntity` | **Unchanged**, never carries the destination. |
| Effect Verification | **Unchanged.** Its verdict is still recorded in both branches. |
| Recovery | **Unchanged**, except that it is no longer reached when the verifier independently proves the destination. |