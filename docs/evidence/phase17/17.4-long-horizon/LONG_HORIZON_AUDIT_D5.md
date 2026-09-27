# PHASE 17.4 — D5 REMEDIATION: PERSISTENCE DESIGN AUDIT

**Parent audit:** [`LONG_HORIZON_AUDIT.md`](./LONG_HORIZON_AUDIT.md) (defect **D5**)
**HEAD:** `89817c6` — note D5 is remediated *after* that commit, not before it.
**Scope:** make `LongHorizonTracker` state survive an MV3 service-worker restart
for the *same* active task. Nothing else.

---

## 1. The defect

`agentLoop.ts:300`

```ts
private readonly longHorizon = new LongHorizonTracker(DEFAULT_LONG_HORIZON_BOUNDS);
```

Every bound that keeps a long task safe — `actionCount`, `recoveryCount`,
`consecutiveNoProgress`, `totalNoProgress`, the fingerprint ring, the last
observation, and the subgoal lifecycle — lives in that one instance. The service
worker holds it in a module-level `activeLoop`. An MV3 service worker is evicted
when idle; the JS context, and with it the tracker, is destroyed.

On revival a fresh `AgentLoop` is constructed and `longHorizon.initialize()` runs
again, so **every bound silently returns to zero mid-task**. A task that had
already burned 20 of 24 actions gets 24 more. A task that had already been
declared a loop gets a clean fingerprint ring. The bounds are the *only* thing
preventing an unbounded run, so this is the one D5-class defect that could turn a
bounded failure into an unbounded one.

---

## 2. The ten design questions

### Q1. What uniquely identifies an active autonomous task?

**Nothing does today.** `hierarchicalGoal.goalId` is produced by `decomposeTask()`
and is derived from the task *text*, so two separate runs of "search for cats"
share a `goalId`. It is not a run identity and cannot be used as one.

**Decision:** introduce an explicit per-run identity, `runId`, minted once inside
`runTask()`. It is an identity token for reliability state — **not** an
authorization credential, and it grants nothing.

### Q2. Where is task identity created?

`AgentLoop.runTask(task)` (`agentLoop.ts:~440`) is the single boundary at which a
task begins, initialises the tracker, and (on terminal exit) ends. The service
worker constructs a fresh `AgentLoop` immediately before calling it
(`serviceWorker.ts:1188-1200`). So `runTask` is the correct and only minting point,
and it is also where restore must be attempted.

### Q3. Where does AgentLoop hold LongHorizonTracker?

`agentLoop.ts:300` as a `private readonly` instance field, initialised at
`:460`. Because it is `readonly` and created in the field initialiser, a revived
worker cannot re-enter it — the whole object is gone.

### Q4. Where can the MV3 service worker restart?

Anywhere across an `await`. The longest are `provider.requestAction()` and
`chrome.tabs.sendMessage()` perception, both per cycle. The tracker is advanced
once per cycle at `:801`, so a restart between cycles loses everything since
`initialize()`, and a restart *during* a cycle additionally loses the in-flight
step — which the existing terminal-state and effect-verification logic already
handles fail-closed.

Persistence therefore needs to be written at a point that is **reached every
cycle**, not only at task end, because the task may never reach task end.

### Q5. What state must survive restart?

Exactly the fields that decide a bound, and nothing else:

| Field | Why |
|---|---|
| `actionCount` | `ACTION_BUDGET_EXHAUSTED` |
| `recoveryCount` | `REPLANNING_EXHAUSTED` |
| `consecutiveNoProgress` | `detectStall` |
| `totalNoProgress` | `STALL_BUDGET_EXHAUSTED` |
| `fingerprints` (bounded ring) | `detectLoop` — `REPEATED_STATE`, `ALTERNATING_LOOP` |
| `lastObservation` | `assessProgress` — without it every post-restart cycle looks like a brand-new page and reports false progress |
| subgoal `{id, status, attempts}` | so completed subgoals are not redone, and the `COMPLETED`-is-terminal rule survives |
| `lastLoop`, `lastStallReason` | diagnostic continuity |

### Q6. What must NOT survive a new task?

**All of it.** Every field above is task-scoped. There is no cross-task or
cross-session reliability state, and none is introduced.

### Q7. What happens if the extension restarts between tasks?

There is no active task, so the record is either absent (fresh task) or carries a
different `runId` (fresh task). Either way the next task starts clean. The
`initialize()` path already clears every collection and counter.

### Q8. What happens if a task is explicitly reset or terminated?

The tracker is **cleared on every terminal exit** — `SUCCESS`, `FAILED` and
`STOPPED` alike. A terminated task therefore cannot donate its counters to the
next run even if `runId` were somehow reused. This is a belt-and-braces measure:
`runId` is the primary guard, terminal-clear is the secondary one.

### Q9. What if persisted state is malformed, incompatible, or belongs to another task?

**Fail closed: refuse the record, start a fresh tracker, and say so.**

The important subtlety: a fresh tracker is *not* unlimited budget. Every bound
still applies from cycle one — `maxTotalActions`, `maxConsecutiveNoProgress`,
`maxRepeatedStates`, `maxStallActions`, `maxReplans` are tracker construction
parameters, not accumulated state. So refusing a corrupt record cannot hand the
agent an unbounded run; it can only fail to *remember* previous consumption,
which is the conservative direction.

Rejecting is preferred over failing the task outright: a corrupt blob in storage
would otherwise brick the agent until the blob was manually cleared, and the
existing task semantics for "no usable state" are already "fresh bounded task".

**Non-negotiable, from the brief: never turn corrupted persistence into fresh
unlimited budget *silently*.** So the refusal is recorded — `restoreStatus` is
carried on the tracker and surfaces in the snapshot — and the bad record is
deleted rather than left to be re-read every cycle.

### Q10. What if there is no persisted state?

The ordinary first-run path: fresh tracker. This is the common case and must stay
silent and cheap.

---

## 3. Storage decision

**`chrome.storage.session`, with in-memory fallback — never `storage.local`.**

- `chrome.storage.session` is the MV3 area for **live, in-memory** extension state.
  It is held by the browser process, survives service-worker eviction, and is
  **never written to disk**. That is the right home for a record that exists only
  to preserve bounds within one browsing session, and it keeps the privacy
  property absolute.
### Manifest permission change — flagged

`chrome.storage` is gated behind the `storage` permission, and the extension
declared **no** `storage` permission. That was verified empirically inside the
**real** service worker, not assumed:

```
before manifest change:  hasStorage:false  local:false  session:false
after  manifest change:  hasStorage:true   local:true   session:true  roundTrip:true
```

Without it, every byte of D5 persistence is **dead code in the shipped build** —
and `memory/memoryStore.ts` has been silently inert for the same reason.

`"storage"` was therefore added to `permissions` in `extension/manifest.json`.
This is an **authority-surface change** and is called out here, in the
acceptance report, and in the remediation report rather than buried. It was not
made by reflex: it is the minimum permission that makes the required capability
exist, it grants no new API beyond `storage.local`/`session`/`sync`, and it
adds no permission warning that reveals user data. The alternative — degrading
to memory — was rejected because it leaves D5 unimplemented in production.

Degradation is still implemented and still **explicit, never silent**: the store
probes availability and sets `persistenceAvailable: false` in state if it is
genuinely unavailable, so a browser or build without the API fails loudly rather
than silently losing bounds.
- `memoryStore.ts` already uses `chrome.storage.local`, but it is wrapped in a
  `!chrome.storage?.local` guard rather than a permission check, so this is
  pre-existing behaviour and not something to rely on or to copy.

## 4. Privacy properties of the persisted record

Persisted **metadata only**. Two exclusions are structural, not filtered:

1. **`originalGoal` is never persisted.** The user's task text is free text and
   may contain PII ("find John Doe's account number"). A `stableHash` digest of
   the goal is stored instead, which is enough to detect a mismatched record and
   useless for reconstructing text.
2. **Subgoal `description` and discovery `label` are never persisted.** Both are
   model-authored text. Only `{id, status, attempts}` is kept.

On top of that, the fully serialized record is passed through the existing
`scanForRawSensitiveValues` before writing. If it trips, the record is **not
written** and the failure is surfaced — the same input-boundary defence
`addDiscovery()` already applies to discovery labels.

No screenshots, no DOM, no OCR text, no prompts, no raw values: none of those are
inputs to this record in the first place, and no new outbound path is created.
Persistence is local-to-extension state consumed by one reliability class.

## 5. Shape of the record

```jsonc
{
  "schemaVersion": 1,
  "runId": "<per-run id>",
  "goalDigest": "<stableHash of the task text>",
  "updatedAt": 1730000000000,
  "actionCount": 7, "recoveryCount": 1,
  "consecutiveNoProgress": 2, "totalNoProgress": 3,
  "fingerprints": ["…"],            // bounded, opaque hashes
  "lastObservation": { "url": "…", "pageGeneration": 3, "entityIds": [],
                       "candidateIds": [], "scrollY": 0,
                       "targetValueLength": 0, "viewportObservable": true },
  "subgoals": [{ "id": "sg-1", "status": "ACTIVE", "attempts": 1 }],
  "lastLoop": { "kind": "REPEATED_STATE", "reason": "…" },
  "lastStallReason": "…"
}
```

Rejection rules on load: wrong `schemaVersion`; `runId` mismatch; `goalDigest`
mismatch; a missing or non-numeric counter; a negative counter; an array longer
than its bound; a subgoal without an `id`. All are **refusals**, not repairs.

## 6. Task lifecycle

| Scenario | Behaviour |
|---|---|
| **NEW TASK** | no record, or a record with a different `runId` → fresh tracker |
| **SAME TASK + SW RESTART** | `runId` matches → counters, fingerprints, last observation and subgoals restored |
| **TASK COMPLETES** (SUCCESS/FAILED/STOPPED) | record cleared; terminal verdict never overwritten by restore |
| **TASK EXPLICITLY RESET** | record cleared; next task cannot inherit counters |
| **NEW TASK AFTER OLD TASK** | cleared on terminal exit, and `runId` differs anyway — double-guarded |
| **PERSISTENCE FAILURE** | record refused and deleted, fresh bounded tracker, `restoreStatus` surfaced |

## 7. Why this is not an authorization path

`LongHorizonTracker` remains a reliability mechanism. It cannot grant, allow,
expedite or authorize anything:

- it holds no gates and runs none;
- restoring a record can only make the agent **stop sooner**, never proceed —
  every restored value feeds loop/stall/bounds checks whose only terminal output
  is `FAILED` or a replan;
- `checkBounds` still returns a bound, never a verdict;
- goal `SUCCESS` remains writable only at the two `agentLoop.ts` sites, both
  gated by `isTaskGoalSatisfied` → `verifyTaskGoal`, which reads only observed
  state.

A restored record therefore cannot create a false success, and cannot bypass
Grounding, M5, the Privacy Firewall, the Security Critic, Risk/Confirmation,
Effect Verification or Containment, all of which are untouched and unreordered.

## 8. D6 assessment (no scope change)

`resumeWithConfirmation` re-dispatches an already-authorized action without
re-validating against the current page generation.

**Assessment: it does not bypass an authoritative gate.** The action reached
`resumeWithConfirmation` only after passing Grounding, M5, the Privacy Firewall,
the Security Critic and Risk/Confirmation — that is precisely why the loop
paused. The redispatch is the *continuation* of a user-authorized action, not a
new proposal. After redispatch the action still goes through effect verification
(`ACTION_NO_EFFECT` on a stale target) and goal verification. The stale-target
risk is real but is an already-documented reliability limitation, not a gate
bypass, and it is **not** changed here.

## 9. D7 and other limitations

Unchanged and still out of scope: `SUBGOAL_BUDGET_EXHAUSTED` accounting under
replanning remains unverified; `UNVERIFIABLE` is still absent from
`GoalVerificationResult`; `targetValueLength` progress remains unavailable.
None of these violates the 17.4 acceptance criteria.
