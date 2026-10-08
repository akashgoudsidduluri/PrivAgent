# I-5 — Information-Task Verification / Success-Contract Closure

**Status: CLOSED (2026-10-08).** The information-task success contract is defined,
enforced in one place, covered by focused tests, and re-verified in real Chrome.

* Implementation: `extension/src/agent/goalVerifier.ts` (the gate),
  `extension/src/agent/agentLoop.ts` (the refresh that feeds it).
* Focused tests: `tests/phase18_8_i5InformationSuccessContract.test.ts` (22 tests).
* Live re-verification: `docs/evidence/post-17-10/audit/a10_18_6/` (§14 rows
  re-executed after this change — see “Evidence” below).

---

## 1. The contract

An **information task** is one the I-1 intent boundary marks
`requiresEvidence: true` — deterministically `INFORMATION_REQUEST`, or `MIXED_TASK`
whose goal contains knowledge and navigation (`open wikipedia and find information
about charminar`). The decision is frozen at admission, derived only from the user's
own text, and is never read from a model response.

For such a task, **SUCCESS requires all of**:

| # | Requirement | Where it is enforced |
|---|---|---|
| 1 | The requested subject is identified from the **user's own task text** (`subjectTermsFromTask`) | `goalVerifier.hasVerifiedSubjectEvidence` |
| 2 | At least one ledger record is **VERIFIED** by the local verifier | `EvidenceLedger.verify()` → `state.verifiedEvidenceKeys` |
| 3 | That record is **CURRENT** — not superseded by a later observed page generation | `EvidenceLedger.citable()` (STALE/INVALIDATED excluded; `advance()` never refreshes) |
| 4 | The record is **SANITIZED** at write time (the authoritative raw-value screen) | `EvidenceLedger.record()` |
| 5 | The record's normalized key **matches a subject term** of the task | `hasVerifiedSubjectEvidence` |
| 6 | The answer the user sees is **composed from the accepted records**, never from model prose | `composeEvidenceAnswerFromLedger` / `buildSupportedAnswer` |
| 7 | Privacy screening of the outbound payload passes | output screen (unchanged) |

**Nothing else authorises SUCCESS**: not a page visited, not a dispatched action, not
a search-results URL, not a provider claiming `ANSWER`/`SUCCESS`, not a non-empty
answer string, and not evidence that merely exists in the ledger about something
else. `verifyTerminalProposal` cannot produce `SUCCESS` at all — its status union
(`ANSWER | PARTIAL | NEEDS_INFORMATION | CANNOT_VERIFY`) cannot express it.

## 2. Terminal semantics (unchanged, and why)

| Situation | Terminal | Why it is truthful |
|---|---|---|
| Evidence VERIFIED + CURRENT + on-subject | `SUCCESS` (GoalVerifier only) | the device holds the answer |
| Some verified facts, none on-subject | `PARTIAL` (+ `INSUFFICIENT_EVIDENCE`) | it has established something, not the question |
| No verified fact at all | `NEEDS_INFORMATION` | “not known yet”, never “does not exist” |
| Nothing citable was ever observed | `CANNOT_VERIFY` | verification really is impossible |
| Observed page is stale/frozen when freshness is required | `FRESHNESS_UNVERIFIED` | refuse to report a value as current |
| Provider outage | `PROVIDER_UNAVAILABLE` | 0 dispatches, no speculative action |
| Ambiguous request | `NEEDS_CLARIFICATION` / `AMBIGUOUS` | refused before any provider call |
| Privacy screen rejects a payload | fail closed (`OUTPUT_SCREEN_BLOCKED`) | no partial output |

No new terminal state was added: the existing vocabulary already distinguishes every
case, and the I-5 brief requires the distinction to be preserved unless a defect is
demonstrated.

## 3. The defect this closes

**The A5 evidence precondition was positional, so rules that certify an *action*
could still certify an *information task*.**

A5 (`PHASE 18.7`) added “an information task cannot report SUCCESS without verified
subject evidence” — but the check sat *after* rules 1, 1b, 2, 2b and after the scroll
preconditions. Every one of those rules returns `SUCCESS` on observed state that is
not evidence of the requested information:

* rule 1/1b certify a **search was performed** (the query appears in the URL);
* rule 2 certifies a login from a URL transition;
* rule 2b certifies research from the pages that were **reached**;
* the scroll preconditions certify that the page **moved**.

Reproduced before the fix (`tests/phase18_8_i5InformationSuccessContract.test.ts`,
cases 2a and 2c, both failing on the pre-fix build):

```
task  = 'search for cats on wikipedia'          → MIXED_TASK, requiresEvidence = true
URL   = https://en.wikipedia.org/w/index.php?search=cats&title=Special%3ASearch
state = verifiedEvidenceKeys: []                → no verified record at all
BEFORE: { satisfied: true,  status: 'SUCCESS', rule: '1' }   ← false success
AFTER:  { satisfied: false, status: 'IN_PROGRESS' }
```

with `verifiedEvidenceKeys: ['parking costs three euros per hour']` (verified, but
about a different subject) the pre-fix build also returned `SUCCESS` via rule 1.

## 4. The fix (smallest correct change)

1. **`goalVerifier.verifyTaskGoal` — the gate now runs FIRST.** The A5 condition and
   its fail-closed `IN_PROGRESS` are unchanged; only their position moved, so no rule
   can reach `SUCCESS` ahead of it. The old (now unreachable) copy was removed rather
   than duplicated. Action/navigation tasks are unaffected: an absent intent decision
   means “not required”, which is what keeps every pre-A5 caller's behaviour valid.
2. **`agentLoop` — the evidence inputs are refreshed before *every* goal verdict.**
   A5's contract says “called immediately before every goal verdict”, but only the
   step-top verdict site did so; the post-action “immediate completion” site decided
   on the copy taken before the action. It now re-derives from the device's own
   ledger, which is strictly fail-closed.

Nothing else changed. Grounding, M5/the privacy firewall, the security critic,
risk/confirmation, effect verification, the GoalVerifier's *rules* (only their order
relative to the gate), the recovery engine, containment, A12/A14/A16, normal-chat
routing, browser-task classification and the output privacy screen are untouched.

## 5. Evidence

**Focused (deterministic) — 22 tests, all passing:**
`tests/phase18_8_i5InformationSuccessContract.test.ts` covers the 18 required cases
(valid evidence → SUCCESS; visited page/search URL → no SUCCESS; ANSWER with no
support → downgraded; wrong subject; unverified; stale; current+on-subject → SUCCESS;
partial → `PARTIAL`; provider failure; ambiguous → refusal; privacy → fail closed;
contradiction → no false SUCCESS; multiple citations resolved; answer composed from
records only; chat never enters the path; information routing; value-free metadata;
the A10 evaluator still refuses an uncited SUCCESS).

**Real Chrome (controlled provider, honestly labelled) — §14 rows re-executed after
this change:**

| Row | I-5 acceptance case | Observed | Verdict |
|---|---|---|---|
| S1 | information task with valid evidence | `SUCCESS`, rule `2c`, 24/24 verified-current, **7 composed verified records**, 0 provider calls | PASS |
| S2 | information task with insufficient evidence | `PARTIAL`, `supportedRecords: 0`, `rejected: INSUFFICIENT_EVIDENCE`, `answerChars: 0` — no false success | FAIL (§14 citation gate; fail-closed behaviour is correct) |
| S6 | stale information | `FRESHNESS_UNVERIFIED`, goal not satisfied | FAIL (§14 terminal set) |
| S7 | privacy-sensitive page | `PARTIAL`, privacy clean, no raw value in the artifact | FAIL (§14 citation gate) |
| S9 | ambiguous request | `NEEDS_CLARIFICATION`, 0 provider calls, 0 dispatches | PASS |
| S10 | provider failure | `PROVIDER_UNAVAILABLE`, 0 dispatches | PASS |

A10 regression is unchanged and truthful: **3 PASS / 7 FAIL / 0 NOT_RUN, privacy
clean, `--require-pass` exits 1**. I-5 introduced no false SUCCESS and flipped no row.

## 6. Known limitation (not closed by I-5)

The gate reads `state.verifiedEvidenceKeys`, which the loop derives from the ledger,
and the ledger marks records STALE when a **new observation** arrives for a later page
generation. In the window between a settled navigation and that next observation, the
ledger still considers the previous page's records CURRENT, and the loop's own
generation counter (`state.currentPageGeneration`) has already advanced. A record from
the previous page therefore remains citable for that window. This is narrower than the
defect fixed above (which required no window at all) and closing it means teaching the
loop's refresh to intersect the ledger's freshness with the loop's own generation —
a change to the freshness contract that needs its own analysis and tests, so it is
recorded here rather than silently folded in.

**F2 (IPv4 containment root host) is out of scope for I-5** and was left unfixed by
this task, as the brief required. It has since been fixed by its own task — see
`docs/F2_IPV4_CONTAINMENT_ISOLATION.md` — which does not affect anything asserted
above and does not reopen I-5.

## 7. Verification commands

```bash
npx vitest run tests/phase18_8_i5InformationSuccessContract.test.ts \
               tests/phase18_7_a5EvidenceCompletion.test.ts      # 45 tests
npx vitest run --reporter=dot                                    # 173 files / 2988 tests
npx tsc -b --noEmit                                              # exit 0
npm run build:extension && npm run build:frontend                 # exit 0
backend/.venv/bin/python -m pytest tests/ -q                      # 670 passed
npx vite-node scratch/a10_matrix_grade.ts [--require-pass]         # 3 PASS / 7 FAIL; exit 1
```
