# Phase 17.9 — D-02 Audit

**Status:** audit only. **No production code was modified.** D-02 remains exactly as
documented in 17.8; this file establishes its exact behaviour and the exact scope of any
future fix, so that the change can be made deliberately rather than inherited from a
report written before the code was measured.

**Base commit:** `fe21961` (pushed, `main == origin/main`).

---

## 1. The defect, measured rather than inherited

`extension/src/agent/selfHealing.ts:110`:

```ts
const goalHint = (taskGoal || '').toLowerCase();
```

`goalHint` is computed from the **fourth** parameter. The goal-semantic scoring block at
`:139-155` is guarded by `if (goalHint)`, so it is reachable only when a caller passes a
fourth argument.

**No caller anywhere passes one.** Verified across production, tests and evaluation:

| Call site | Arguments | Goal reaches `goalHint`? |
|---|---|---|
| `extension/src/agent/agentLoop.ts:1215` | `(staleTargetId, action, context)` | no |
| `extension/src/agent/agentLoop.ts:1762` | `((action as any).target, action, context)` | no |
| `tests/selfHealing.test.ts:42,77` | ≤ 3 | no |
| `tests/phase17/phase177MutationGaps.test.ts:288` | 2 | no |
| `evaluation/phase17_8/authorities.ts:224,232` | `(action, context, goal)` | **no** — goal is 3rd |

The last row matters. The 17.8 benchmark's own RECOVERY adapter uses the
three-argument form that *carries* a goal, and that form is inert for exactly the same
reason. So the benchmark measures recovery only through selector similarity — which is
what 17.8 §311 already stated, now confirmed in the source rather than inferred.

## 2. A layer the 17.8 report did not record

The 17.8 report described the goal as being "assigned to a local `goal`" by the
three-argument form, which implies that local is used. It is not.

```
selfHealing.ts:66    let goal = taskGoal;
selfHealing.ts:76    goal = contextOrGoal as string | undefined;
```

`goal` is **assigned twice and read zero times**. It is a write-only local. So the defect
has three layers, not two:

1. the production call sites omit the goal;
2. the three-argument form stores the goal in a local that `goalHint` does not read;
3. that local is read by nothing at all.

Any fix that only re-points `goalHint` at the parameter, or only passes the goal at the
call sites, still leaves layer 3 in place. The fix has to address all three together.

## 3. Measurement

`scratch/d02_audit.ts` imports the unmodified production module and calls it. The
fixture is built to **discriminate**: the failed target `orphan-control` shares no token
with any candidate selector, and no `orphan-control` detection exists, so all three
token-similarity strategies score exactly 0.0. The acceptance floor is 0.40. Recovery
succeeding is therefore *itself* the signal that the goal branch fired.

This matters — a naive fixture lets the failed target self-match its own id at ~0.5,
and recovery "succeeds" by the wrong path, which makes a dead branch look alive. That
false negative was hit and discarded during this audit.

| Call | recovered | score | strategy | target |
|---|---|---|---|---|
| **A1** production form `(targetId, action, context)` | `false` | 0.00 | `NONE` | — |
| **B1** `(action, context, goal)` — goal 3rd | `false` | 0.00 | `NONE` | — |
| **C0** 4-arg, **control**, goal matches nothing | `false` | 0.00 | `NONE` | — |
| **C1** `(action, context, undefined, goal)` | `true` | **0.90** | `LABEL_SIMILARITY` | `privagent-det-transaction-history` |
| **C2** `(targetId, action, context, goal)` | `true` | **0.90** | `LABEL_SIMILARITY` | `privagent-det-transaction-history` |

**C0 is the load-bearing row.** Same code path, same candidate, goal supplied but
matching nothing → 0.00. That rules out residual token overlap and proves the 0.90 in
C1/C2 is produced by the goal-semantic branch.

## 4. Severity — unchanged, fail-safe

Recovery failing means the action is **refused**. It is never the reason something
unsafe is dispatched. Not a bypass, and not a fail-open condition.

The real cost is the one 17.8 named: the code reads as a working semantic-recovery
feature and is silently inert, so a future change could reasonably assume it runs. That
is worse than absent code.

## 5. Established scope of any future fix

**Production changes required — three, all necessary:**

| File | Change |
|---|---|
| `selfHealing.ts:110` | compute `goalHint` from the value the function actually receives, not the unused fourth parameter |
| `agentLoop.ts:1215` | pass the task goal at the pre-dispatch self-heal call |
| `agentLoop.ts:1762` | pass the task goal at the post-execution self-heal call |

**Non-production consequences that must be re-verified:**

- `evaluation/phase17_8/authorities.ts:224,232` — the three-argument adapter begins
  honouring the goal. The three RECOVERY cases are **verdict-stable** under the fix:
  - **H1** similarity 0.50 → goal 0.90, still `RECOVERED` (expectation unchanged);
  - **H2** still heals to a `heading`, still `REFUSED` at re-grounding `TARGET_MISMATCH`;
  - **H3** goal is `'Send money to a saved payee'`, containing neither `transaction` nor
    `account`, so the branch cannot fire; still `NOT_RECOVERED`.
- The **rationale text** of H1 and H3 explicitly cites D-02 as the reason the corpus
  avoids the goal branch. After a fix that rationale is stale and must be rewritten —
  a documentation change, not a verdict change.
- The fix **widens which targets recovery can propose.** That is the actual risk surface,
  and it is why the following must be re-run, exactly as 17.8 already required:

| Must re-run | Why |
|---|---|
| **M9** | mutates `if (healedVal.allowed) {` in the loop — the healed-target adoption path a live goal branch feeds |
| **M9b** | same site, additionally overwrites `action` and `validation` |
| **R12** | the isolating probe for M9/M9b; its goal is `'Open the transaction history'`, so a live goal branch bears directly on it |
| full suite + benchmark | any verdict movement must be attributable, not assumed |

- **`person_name` is not involved.** R12's refusal is driven by a person name in the
  action reason, independently of the goal branch. Fixing D-02 must not change it, and
  the `person_name` false positive stays out of scope.

## 6. Tests a fix will need

Carried forward from 17.8 §13, unchanged and still valid:

1. a unit test that a goal-aligned candidate scores above the floor **when supplied as
   the function will actually receive it** — the test must use the production call shape,
   not the shape that happens to work;
2. a loop-level test that a recovered target still passes GATE 1 and M5;
3. M9 and M9b re-run, because widening recovery changes what those mutants can reach.

A fourth follows from §2: a test that fails if `goal` is ever left write-only again, so
the dead local cannot silently return.

## 7. Classification

| Finding | Classification |
|---|---|
| Goal-semantic recovery unreachable from every call site | **`PROVEN_TEST`** (A1, B1 measured 0.00 against a 4-arg control at 0.90) |
| Local `goal` is a write-only dead local — third layer, not previously recorded | **`PROVEN_TEST`** (exhaustive `grep` of the module) |
| The 17.8 benchmark's RECOVERY adapter is on the inert path | **`PROVEN_TEST`** (source read) |
| Fix scope, mutation and probe re-verification requirements | **established, not yet acted on** |
| D-02 remediation itself | **NOT STARTED** — deliberately, pending approval |

**D-02 has not been modified. Phase 17.9 has begun with the audit, as instructed.**
