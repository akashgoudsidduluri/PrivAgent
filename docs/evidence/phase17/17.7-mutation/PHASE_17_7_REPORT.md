# Phase 17.7 — Adversarial Mutation Audit of the Authorization Chain

**Base commit:** `40e608c` (Phase 17.6)
**Status:** audit complete; two coverage gaps closed. **Not committed, not pushed.**

---

## 1. What this phase is

Phases 17.1–17.6 each added a control and a test for it. A test that asserts a
control exists is weaker than a test that fails when the control is removed, and
the project has had more than one control whose only proof was its own test.

So 17.7 removes the controls and asks the existing suite to notice.

Each of the 15 mutations disables **exactly one** safety authority in production
code and runs the suite unmodified. No test is edited, relaxed, skipped or
mocked away. If the suite still passes, the mutation **survived**, and that is
recorded as a finding — not as a reason to weaken the mutation.

Harness: `scratch/mut17_7.mjs`. Results: `mutation_results.json` (this directory).

**Detection uses the vitest exit code only.** The agent loop logs the literal
string `M6 failed` on a clean run (118 occurrences across the suite), so any
`/(\d+)\s+failed/` match over stdout reports false failures. An earlier harness
revision did exactly that and wrongly credited 11 mutations; the current one
keys on the exit code and nothing else.

**Crash safety.** The active mutation is journalled to
`scratch/.mut17_7_journal.json` *before* the file is written, and every run
restores by hash. A run killed mid-write is recovered with
`node scratch/mut17_7.mjs --recover`, which refuses to overwrite a file that
matches neither the original nor the mutation.

**Two tiers.** `targeted` (61 pre-existing security/loop/observation files) runs
first; anything that survives it is re-run against the full 114-file suite. The
three survivors below were all re-run at the full tier before being called
survivors.

---

## 2. Results — 14 of 15 caught

| ID | Mutation | File | Verdict | Caught at |
|---|---|---|---|---|
| `M1` | Goal Verification bypass — `isTaskGoalSatisfied` reports SUCCESS from its own authority | `agentLoop.ts` | **CAUGHT** | targeted |
| `M2` | M5 privacy/action-validator bypass — the refusal branch in `runTask` never runs | `agentLoop.ts` | **CAUGHT** | targeted |
| `M3` | Security Critic bypass — a `BLOCK` verdict no longer stops the action | `agentLoop.ts` | **CAUGHT** | targeted |
| `M4` | Containment bypass at the dispatch boundary | `agentLoop.ts` | **CAUGHT** | targeted |
| `M5` | Effect Verification fabrication — `pageStateObservable` no longer honoured | `effectVerifier.ts` | **CAUGHT** *(was a survivor — §3.1)* | targeted |
| `M5b` | Effect Verification fabrication — the per-field `OBSERVED` contract weakened to `!== 'UNAVAILABLE'` | `effectVerifier.ts` | **CAUGHT** | targeted |
| `M6` | Observation fabrication — an unobservable host yields a synthesised snapshot instead of `null` | `agentLoop.ts` | **CAUGHT** | targeted |
| `M7` | Stale observation acceptance — the 17.5 stale-response refusal never fires | `agentLoop.ts` | **CAUGHT** | targeted |
| `M8` | Prompt-injection acceptance — nothing can be classified `HOSTILE` | `securityCritic.ts` | **CAUGHT** | targeted |
| `M9` | Self-heal authorisation — the healed-target branch always taken | `agentLoop.ts` | **SURVIVED** | full — equivalent mutant, §3.3 |
| `M9b` | Self-heal authorisation — healed target adopted **and** marked allowed without re-gating | `agentLoop.ts` | **CAUGHT** *(was a survivor — §3.2)* | targeted |
| `M10` | Subgoal completion fabrication — every subgoal completes on dispatch state | `agentLoop.ts` | **CAUGHT** | targeted |
| `M11` | Privacy egress leak — the raw-value firewall becomes a no-op | `privacyPolicy.ts` | **CAUGHT** | full |
| `M11b` | F-08 re-opened — local-only `ocr_observation` re-attached to the wire payload | `backendAgentProvider.ts` | **CAUGHT** | targeted |
| `M12` | Provider schema weakening — unknown action fields accepted | `providerResponse.ts` | **CAUGHT** | targeted |

Every mutation was restored and the restore verified by hash. `git diff` is
empty against `40e608c` for all six mutated production files.

`M11` is worth noting for a non-obvious reason: the raw-value firewall is
caught **only by the full suite**. The 61-file targeted tier misses it. The
firewall's own tests exercise it in isolation, but the mutation also removes it
from every loop call site, and only the loop-level tests notice.

---

## 3. The three survivors

### 3.1 `M5` — the Phase 16 unreadable-page flag was load-bearing and untested

`verifyActionEffect` derived its page-observability flag like this:

```ts
const pageObservable = (post as { pageStateObservable?: boolean }).pageStateObservable === true ? true : true;
```

Always `true`. The mutation deletes the Phase 16 DEFECT 3 distinction — "the tab
record was readable, the page was not" — and with it the only thing that stops a
**page-local comparison from being reported as an observed effect on a page
nobody could read**.

This is the project's own founding failure mode. A dispatched action on a page
whose state cannot be read produces `DOM_MUTATION_OBSERVED`, `SCROLL_CHANGED` or
`VALUE_STATE_CHANGED` from numbers that were never read. **No test in 114 files
noticed**, at either tier.

**Root cause of the coverage hole.** Every existing effect-verifier fixture
either supplies a readable page or an unreadable page *together with* the
per-field `ObservationState` values that already say so. In the unreadable
cases the field states are `UNAVAILABLE`, so `unreadableRequired` is non-empty
and the verdict is `EFFECT_UNVERIFIABLE` for a reason that has nothing to do
with the flag. The flag is only *load-bearing* when the field states claim
`OBSERVED` and the flag still says the page was unreadable — a contradictory
input that is exactly what a partially-degraded host produces, and exactly the
input no fixture contained.

**Remediation** (`tests/phase17/phase177MutationGaps.test.ts`): four cases built
on deliberately contradictory input — every field `OBSERVED` on both sides,
`pageStateObservable: false` on the post snapshot.

- a click with a real DOM delta → `EFFECT_UNVERIFIABLE`, and explicitly *not*
  `DOM_MUTATION_OBSERVED`;
- a scroll with a real `scrollDelta` → `EFFECT_UNVERIFIABLE`;
- **control:** the same two snapshots with `pageStateObservable: true` report
  `DOM_MUTATION_OBSERVED` and `SCROLL_CHANGED`, so the gate is not passing by
  refusing everything;
- **control:** a `navigate` whose URL genuinely changed is still
  `URL_NAVIGATION_OBSERVED` while the page is unreadable. The flag governs
  page-local comparison; the tab record is a different channel. This is why the
  Phase 16 fix works, and a verifier that let `M5` leak into this case would
  throw that fix away.

`M5` re-run: **CAUGHT**.

### 3.2 `M9b` — a self-healed target was trusted, and the suite could not see it

The self-heal branch of `runTask` adopts a recovered action only when the healed
target passes **GATE 1 (grounding) and then M5** — the same gates as any other
proposal. `M9b` removes the condition *and* rewrites `validation` to
`{ allowed: true }`, so a healed target that **failed re-grounding** is adopted
and dispatched. **No test in 114 files noticed**, at either tier.

**Root cause of the coverage hole.** `tests/selfHealing.test.ts` exercises
`recoverStaleTarget` in isolation. It is a pure function that proposes a
candidate. The *authorisation decision* — whether that candidate may be adopted
— is made in `AgentLoop.runTask`, and nothing ran the loop into that branch. The
one test that came closest failed earlier for an unrelated reason: a PII-bearing
reason is refused by the **decision tracer's raw-value firewall** before the
loop reaches the self-heal branch at all (a correct refusal, but not the one
under test).

**Remediation.** A loop-level fixture: the provider always proposes a click on
`det-stale-node` whose reason restates a customer's name (M5 refuses it), the
context contains one label-similar recovery candidate `det-stale-node-apply`,
and `executeAction` records everything dispatched. Four cases:

- *non-vacuity:* M5 refuses the original; recovery really does find
  `det-stale-node-apply`; and **M5 alone would wave the healed action through**,
  because the healed reason carries no page-derived PII and the element exists.
  Only re-grounding refuses it. That is the point of the gate.
- *the gate:* with the candidate visible, same-origin, and a **label rather than
  a control**, GATE 1 refuses the healed click (`TARGET_MISMATCH`) while every
  later gate is happy with it. Nothing is dispatched.
- *defence in depth:* with a zero-dimension candidate the loop refuses twice —
  at the self-heal gate and again at the later geometry authority.
- *control:* an interactable, compatible candidate **is** dispatched.

The visible-but-wrong-type candidate is deliberate, and the reason is worth
recording: **a hidden candidate cannot tell you whether the self-heal gate is
doing its job.** The first version of this test used a zero-dimension node and
passed under `M9b` — the loop's later geometry authority caught it anyway. That
is genuine defence in depth, but it means the hidden case proves the *system* is
safe, not that the *gate* holds. Only a candidate that the later gates accept
pins the gate itself.

`M9b` re-run: **CAUGHT** — the target case fails under the mutation and passes
without it.

### 3.3 `M9` — an equivalent mutant, documented rather than "fixed"

`M9` neutralises the same branch condition but leaves the body intact:

```ts
if (true as boolean) {
  action = healingResult.recoveredAction;
  validation = healedVal;   // ← still the healed validation
  ...
}
```

It survives the full 114-file suite, and it should: **no test can catch it,
because it changes nothing.**

1. The branch is entered only from `if (!validation.allowed && …)`, so the
   original `validation.allowed` is already `false` at that point.
2. Its only assignment to `validation` is `validation = healedVal`, and
   `healedVal.allowed === false` whenever re-grounding refused.
3. The gate immediately after the branch is `if (!validation.allowed)`.

Forcing the branch to run therefore still leaves `validation.allowed === false`,
and the refusal is unchanged. A surviving mutation is normally a defect; this
one is a **proof that the branch body is written safely** — it re-reads the
healed verdict rather than assuming success.

`M9b` is the honest form of the same attack (it also rewrites `validation`), it
is a real bypass, and it is now covered. **No production change was made for
`M9`, and none should be.** Writing a test for an equivalent mutant would be a
test that asserts nothing.

---

## 4. What was changed

Production code: **none.** 17.7 changed no authority and no control. It found
that two authorities were correct in production and unproven in the suite, and
it proved them.

| File | Purpose |
|---|---|
| `tests/phase17/phase177MutationGaps.test.ts` | 8 tests closing the `M5` and `M9b` coverage gaps, each with a control case so it cannot pass vacuously. |
| `scratch/mut17_7.mjs` | The audit harness: 15 mutations, journal-based crash-safe writes, hash-verified restores, `--recover`, tiered targeted → full. |
| `docs/evidence/phase17/17.7-mutation/` | This report and the machine-readable results. |

`scratch/.mut17_7_journal.json` is a transient state file and is not committed.

---

## 5. Verification

| Check | Result |
|---|---|
| `npx tsc -b --noEmit` | exit 0 |
| Full vitest suite, chunk 1 of 3 (38 files) | 359 passed |
| Full vitest suite, chunk 2 of 3 (38 files) | 830 passed |
| Full vitest suite, chunk 3 of 3 (39 files) | 319 passed |
| **Total** | **115 files / 1508 tests passed** (114 / 1500 before this phase; +1 file, +8 tests) |
| `npm run build:extension` | exit 0 |
| `npm run build:frontend` | exit 0 |
| `git diff` against `40e608c` for all six mutated files | empty |
| `M5` after remediation | CAUGHT |
| `M9b` after remediation | CAUGHT |
| `M9` | equivalent mutant, unchanged |
| Backend pytest | not run — no backend file was touched in this phase |

The suite is run in three bounded chunks because a single 115-file pass exceeds
the command deadline in this environment. The three chunks partition the file
list, so the total is a complete run, not a sample.

---

## 6. Reproduction

```bash
# Full audit (journal-based; safe to re-run, skips recorded mutations)
node scratch/mut17_7.mjs

# One mutation, forced
node scratch/mut17_7.mjs M9b --force

# A survivor re-tested against the whole suite
node scratch/mut17_7.mjs M5 --force --full

# Recover a run killed mid-write
node scratch/mut17_7.mjs --recover
```

After every run:

```bash
git status --short          # must show no modified file under extension/src/
```

---

## 7. What this phase does not claim

- **Not a proof of coverage.** 15 mutations is a sample of the failure space,
  not an enumeration of it. A surviving mutation is a proven gap; a caught one
  means *this* attack is detected, not that the authority is unbreakable.
- **Not a fuzzing result.** The mutations are hand-written from the authority
  list in the source. No property-based or random mutation generation was used.
- **M9 was not fixed**, because there is nothing in it to fix (§3.3).
- **The `M11` gap in the targeted tier was not closed.** The 61-file targeted
  list still misses the raw-value firewall; only the full suite catches it. The
  list is a scratch convenience, not a gate, and every survivor is escalated to
  the full tier — but a future reader who trusts the targeted tier alone would be
  misled. Recorded here rather than fixed, because the fix is to widen a scratch
  list, not to change a control.
