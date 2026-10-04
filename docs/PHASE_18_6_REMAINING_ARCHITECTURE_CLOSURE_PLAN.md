# PRIVAGENT REMAINING ARCHITECTURE CLOSURE PLAN

Phase 18.6 — architecture / perception / forensics.
**Read-only phase.** No production code, no tests, no commits were modified.
Every claim below is tagged **PROVEN** (verified in this session against code or a
runtime artifact), **OBSERVED** (seen in a runtime artifact), **INFERRED**
(deduced from code structure), or **PROPOSED** (this document's design).

---

## 1. Verified Baseline

| Item | State | Evidence |
|---|---|---|
| Extension suite | **2373/2373, 149/149 files** | run this session, exit 0 |
| Backend suite | **601/601** | run this session, exit 0 |
| `tsc --noEmit` | PASS | exit 0 |
| `npm run build` | PASS | exit 0 |
| Commits | `0849eb9`, `d38cc58` (I-4/I-6), `03bee68` (I-7) | `git log` |
| Working tree | clean | `git status` |

**PROVEN — security authorities byte-unchanged vs `fcd94ea`:**
`securityCritic.ts`, `containment.ts`, `destinationVerifier.ts`, `goalVerifier.ts`,
`effectVerifier.ts`, `egressFirewall.ts`, `rawValueScanner.ts`, `recoveryEngine.ts`.
Only `worldModelSanitizer.ts` differs (+116 lines, pure addition; `assertWorldModelSafe`
sha256-verified identical).

**PROVEN — repo-wide markers:** zero occurrences of `TODO|FIXME|DEFERRED|UNPROVEN|TEMPORARY|HACK`
in `extension/src` or `backend/app`.

**Real-browser baseline artifact** (Wikipedia, real Chrome, real backend, real Groq):
`worldModelId != null`, `visualRegionsCount 96–98`, `semantic state OBSERVED`,
`facts 24`, `entities 5`, `affordances 6`, `privacySelfCheck.clean true`,
`rawScreenshotsTransmitted 0`. Terminal `FAILED`.

---

## 2. I-1 Intent Boundary

### Current flow (PROVEN)
```
serviceWorker.ts:520  message.type === 'PRIVAGENT_DASHBOARD_START_TASK'
   → (no gate of any kind)
serviceWorker.ts:1368 thisLoop.runTask(task)          // raw string
   → agentLoop.ts:538  parseUserGoal(task)           // goalParser.ts:153
   → agentLoop.ts:585  decomposeTask(task, …)        // taskDecomposer.ts
   → AgentLoop main loop → ModelRouter → backend /api/v1/agent/action
```
`serviceWorker.ts:520 → 1368` contains **no** precondition, no classification, no
rejection path. A bare string is handed to the automation loop.

### Root cause (PROVEN)
`parseUserGoal` produces `actionIntent`, but it is **only a decomposition hint** —
it is consumed to shape subgoals and is never consulted as a gate.
Its type is `'shopping' | 'search' | 'banking' | 'login' | 'navigation' | 'general'`.

Two gaps, both PROVEN by exhaustive grep:
- **No `INFORMATION_REQUEST`** — `"find information about charminar"` matches
  `lower.includes('find')` at `goalParser.ts:169` and is classified `'search'`.
- **No `GREETING`/`CASUAL`/`AMBIGUOUS`/`UNSUPPORTED`** — repo-wide grep for
  `greeting|casual|smalltalk|classifyIntent|intentClassifier` returns **one** hit:
  the word `'casual'` as a *clothing size* in `goalParser.ts:30`. There is no
  intent classifier anywhere.

### Required architecture (PROPOSED)
A **deterministic, local, fail-closed intent boundary evaluated inside the service
worker before `runTask`**, not inside the loop. It must be a pure function of the
raw task string with no model call, so intent can never be overridden by model
output. It establishes intent **once**, at task creation, and stores it on
`AgentTaskState` as an immutable field for the run.

Why here and not in `runTask`: `serviceWorker.ts:520` is the first place the raw
user string exists, and it already owns task ownership (`activeTaskRunId`), so
intent admission is enforceable at the same trust boundary as task ownership.

### Types / contracts (PROPOSED)
```ts
export type TaskIntent =
  | 'INFORMATION_REQUEST'
  | 'NAVIGATION_REQUEST'
  | 'ACTION_REQUEST'
  | 'MIXED_TASK'
  | 'GREETING_CASUAL'
  | 'AMBIGUOUS'
  | 'UNSUPPORTED';

export type IntentAdmission =
  | { kind: 'ADMIT'; intent: TaskIntent; confidence: 'DETERMINISTIC' }
  | { kind: 'REFUSE'; intent: 'GREETING_CASUAL' | 'UNSUPPORTED' | 'AMBIGUOUS';
      reason: string };           // reason is a fixed enum code, never free text

export interface IntentDecision {
  readonly intent: TaskIntent;
  readonly confidence: 'DETERMINISTIC' | 'HEURISTIC';
  readonly requiresDestination: boolean;   // drives destination declaration
  readonly requiresEvidence: boolean;      // drives evidence completion (I-5)
  readonly admitsBrowserAutomation: boolean;
}
```
- `AMBIGUOUS` → `admitsBrowserAutomation: false` → `NEEDS_CLARIFICATION`, never guessed.
- `GREETING_CASUAL` → `REFUSE`. Must **not** open a target tab or call the provider.
- Mixed tasks (`"open wikipedia and find information about charminar"`) →
  `MIXED_TASK` with `requiresDestination: true`, `requiresEvidence: true`; it
  decomposes into a navigation subgoal plus an information completion criterion.
- Destination declaration stays independent (I-4 already made it fail-closed);
  intent may *request* a destination but may never synthesise one.
- `AMBIGUOUS` / unparseable → fail closed to `NEEDS_CLARIFICATION`.

### Interaction with GoalVerifier
`requiresEvidence: true` is what later selects the information completion rule
(§3, A5). Intent is **not** a verifier: it never marks a goal satisfied.

### Acceptance criteria
1. `"hi"` performs **zero** provider calls and **zero** tab provisioning.
2. Each of the 7 intents classifies deterministically (same input → same output).
3. `AMBIGUOUS` never auto-resolves to an action.
4. Intent cannot be changed by model output (assert no write path post-admission).
5. `actionIntent` from `goalParser` is preserved for backward compatibility.
6. Full suite stays green; no security file modified.

### Real-browser test
Six real-Chrome scenarios: casual, information query, navigation, action, mixed,
ambiguous. For casual, assert the provider request counter is 0 and no tab opened.

---

## 3. I-5 Information Tasks

### Current flow (PROVEN from `llm_context_0019.json`, real run)
```
DOM → world model (98 regions) → semanticUnderstanding → facts(24)/entities(5)/affordances(6)
    → sanitizeWorldModel (I-7 choke point) → buildAgentPayload
    → minimizeAgentContext → backend /api/v1/agent/action → Groq
```
The exact model-facing prompt contains, in order:
`User task` · `Current page URL` · `Semantic Understanding` block ·
`Observed page facts` · `Viewport` · `Screenshot dimensions` ·
`Loop status` · `Previous actions` · `Detected sensitive elements` ·
`"Respond with the single JSON action object now."`

### Root causes — five, all PROVEN

**(a) No terminal channel exists.** `TaskStatus` is
`'IN_PROGRESS' | 'SUCCESS' | 'FAILED' | 'NEEDS_USER_CONFIRMATION' | 'STOPPED'`.
Grep for `'ANSWER'|'PARTIAL'|NEEDS_INFORMATION|CANNOT_VERIFY` across
`extension/src` and `backend/app` returns **zero** matches.
The prompt's last line permits only an action.

**(b) OBSERVED — the model states it already has the answer and still must act.**
The provider returned:
> `"reason": "The user wants to find information about Charminar. The current page is already the Wikipedia article for Charminar, and the observed page facts contain the relevant information (history, structure, surrounding area). Scrolling down will reveal more …"`

The model **correctly determined sufficiency** and had no way to express it, so it
emitted `scroll`. This is the single most important finding in this audit: the
information capability is blocked by a **missing protocol**, not by missing perception.

**(c) PROVEN — GoalVerifier cannot verify this task.** `goalVerifier.ts:631`
condition **2c "Read-only display-fact goals"** *is* an evidence-based information
verifier, and it is well built (freshness, tab match, document identity, page
generation, injection exclusion, ambiguity provision, fail-closed). But it is gated on:
```ts
const reportIntent = /\b(?:report|tell\s+me|read|state|say|what\s+is|what's|whats|display|show\s+me)\b/i;
```
Verified in this session:
```
"open wikipedia and find information about charminar" -> false
"tell me about charminar"                             -> true
"what is charminar"                                   -> true
```
So for the actual failing task **2c never fires**. The task key `charminar` *does*
appear in the task text (`factMatchesTaskWording`), so the rest of the rule would
have succeeded. **The verb allowlist is the sole blocker.**

**(d) OBSERVED — evidence payloads are truncated mid-word.** Real facts include
`"The fifth ruler of the Qutb Shahi dynast"` (39 chars) and
`"The construction began in 1589 and was c"` (39 chars). Cause:
`semanticObservation/types.ts:163 MAX_FACT_LABEL_CHARS = 40`, `:165 MAX_FACT_TEXT_CHARS = 120`.
Facts are cut without word boundaries, so they are not quotable as evidence.

**(e) PROVEN — an invented UI subgoal.** The real run logged:
`subgoal NOT completed — no observed evidence … Element "wikipedia information about" is not observable`
— a subgoal synthesised from the task string, which no element can ever satisfy.

### Where evidence lives today (PROVEN)
Grep for `evidence` in `extension/src` returns **only classifier justification
prose** (`workflowState.ts`, `pageClassifier.ts`) — e.g.
`evidence: ['General web document browsing']`. There is **no** evidence record type:
no `sourceUrl`, no `pageGeneration`, no `verificationStatus`, no freshness, no
deduplication. `SemanticFact` (via `evidenceFacts`) is the closest thing and is
already freshness-scoped — **it should be the evidence substrate, not a replacement
for a ledger.**

### Required architecture (PROPOSED)
```
INTENT(INFORMATION|MIXED, requiresEvidence)
  → PERCEPTION → sanitizeWorldModel (I-7) → SemanticFacts
  → EVIDENCE LEDGER (local, provenance-carrying)
  → DECISION STATE (A3)
  → REASONER may propose ANSWER | NEEDS_INFORMATION | PARTIAL | CANNOT_VERIFY
  → EVIDENCE VERIFIER (new, non-weakening) checks each cited claim
  → ANSWER terminal state
```
Critically, **the re-perception/verification loop must be able to terminate without
acting.** Today every cycle must dispatch.

### Evidence model (see §7 for exact schema)
Promote the verified `SemanticFact` into a ledger record carrying provenance
(`sourceUrl`, `pageGeneration`, `source`, `observedAt`). Fact content must pass
`sanitizeWorldModel`'s detector (already proven safe) and must **not** carry raw
DOM, raw OCR, screenshots, or values classified sensitive.

### Completion model (A5)
Add a GoalVerifier information rule selected by `intent.requiresEvidence`, not by a
verb regex. It requires: ≥1 ledger record, fresh for the current generation, whose
`key`/`label` matches the question's subject term as a whole word, verified, with
no injection-shaped content. Ambiguity (multiple conflicting candidates for one
key) → `PARTIAL`, never `SUCCESS`.

### Acceptance criteria
1. `"open wikipedia and find information about charminar"` reaches a **truthful
   terminal state** — `ANSWER` or `PARTIAL` — without exhausting the step budget.
2. No subgoal is synthesised from a UI element name.
3. Fact text is not truncated mid-word.
4. `SUCCESS` requires verified evidence, never a model claim.
5. Insufficient evidence → `NEEDS_INFORMATION`, never `SUCCESS`.
6. No `GoalVerifier` existing rule is removed or weakened; 2c is generalised, not replaced.

### Real-browser test
Wikipedia Charminar; assert terminal state ∈ {ANSWER, PARTIAL}, ledger non-empty,
and that no raw sensitive value is in the ledger or the model-facing prompt.

---

## 4. I-8 Scroll

### Current behaviour (PROVEN)
`longHorizon.ts` already contains loop detection:
- `maxRepeatedStates` repeated-fingerprint limit (default window `fingerprintWindow: 8`).
- A period-2 detector at `:378–383`: `fp[n-4]===fp[n-2] && fp[n-3]===fp[n-1] && fp[n-4]!==fp[n-3]`.

### Root cause (PROVEN)
`fingerprintObservation` (`:251`) hashes:
```
url | topCandidates | topEntities | geometry:${scrollY}:${targetValueLength} | action:${type}:${target}
```
`scrollY` participates **by design** (comment at `:241–249` explains this prevents
false positives on genuinely-scrolling pages). The consequence is structural:

- **Every successful scroll produces a unique fingerprint** → `maxRepeatedStates`
  can never fire on real scrolling.
- The period-2 detector needs exact alternation of fingerprints; monotonically
  increasing `scrollY` never alternates.

And `assessProgress` (`:281+`) treats a changed document hash as `observedChange`,
so scrolling a long article **is** counted as progress → `consecutiveNoProgress`
never accumulates.

Net: **unbounded, individually-productive, goal-ineffective scrolling.** The loop
is finally stopped by `maxSteps: 10`, not by oscillation detection. That matches the
real run exactly (10 steps → TERMINAL).

**PROVEN second defect:** `runBoundedScrollDiscovery` / `infiniteScrollScanner.ts`
is referenced **nowhere** outside its own file —
`grep -rn "runBoundedScrollDiscovery|infiniteScrollScanner" extension/src` returns
only the definition. The bounded scroll scanner is dead code.

### Required architecture (PROPOSED)
Not a retry counter. Add a **semantic-progress** signal orthogonal to geometric change:

1. **Scroll-direction budget** — a per-task bound on consecutive same-direction
   scrolls with no `ANSWER`-enabling evidence delta (default 3). Distinct from
   `maxSteps`.
2. **Viewport fingerprint with saturation** — quantise `scrollY` into bands so
   genuinely-idle-but-jittering scroll produces repeating fingerprints.
3. **Evidence-delta rule** — a scroll that yields no new ledger record does not
   count as progress toward an `requiresEvidence` intent. This is the rule that
   actually stops the observed loop: the model scrolls, the page changes, but no
   new evidence appears, so the budget drains.
4. **Strategy change, not more scrolling** — on budget exhaustion, deterministically
   derive a *different* action class (extract from current page / navigate to a
   declared destination / terminate `CANNOT_VERIFY`). Never another scroll.
5. Wire `runBoundedScrollDiscovery` into the loop, or delete it. Dead security-shaped
   code is a liability.

### Acceptance criteria
1. DOWN→DOWN→DOWN on a page producing no new evidence is interrupted within the budget.
2. DOWN→UP→DOWN→UP with no evidence delta is detected as oscillation.
3. A genuinely productive scroll (new evidence) never trips the budget.
4. Termination is a truthful terminal state, not `FAILED` by step exhaustion.
5. `assessProgress`'s existing semantics are not weakened.

### Real-browser test
Wikipedia article; assert scroll count is bounded and the run terminates with a
truthful information terminal state rather than `maxSteps` exhaustion.

---

## 5. A1–A10

### A1 — General information-answer contract
**Current (PROVEN):** no answer contract. `TaskStatus` has 5 states; zero matches
for ANSWER/PARTIAL/NEEDS_INFORMATION/CANNOT_VERIFY. The prompt ends
`"Respond with the single JSON action object now."`
**Root cause:** the reasoner contract was designed for action-only loops.
**Production change:** widen the backend response model with an optional
`proposal: {kind: 'ACTION'|'ANSWER'|'NEEDS_INFORMATION'|'PARTIAL'|'CANNOT_VERIFY', …}`.
The LLM may **propose**; it may never **decide**.
**Dependencies:** A3, A2, I-1. **Security impact:** none — the proposal is inert
until an evidence verifier promotes it.
**Tests:** every existing action-only path must still parse; a proposal with no
evidence must be rejected.
**Real Chrome:** model must be able to answer on turn 1 of the Wikipedia task.
**Acceptance:** a run that currently returns `scroll` can return `ANSWER`.

### A2 — Cross-page evidence ledger
**Current (PROVEN):** no ledger. Only classifier justification prose.
**Root cause:** facts are computed per perception and discarded; nothing carries
provenance across turns or generations.
**Production change:** new `extension/src/evidence/` module; §7 schema.
**Dependencies:** I-7 sanitizer must land first (it has).
**Security impact:** ledger crosses a serialization boundary into the prompt →
must be scanned by `scanForRawSensitiveValues` at write time and again at egress.
**Tests:** staleness on generation change; conflict detection; dedup; injection-shaped
content cannot become evidence; raw values rejected at write.
**Real Chrome:** multi-page task accumulates across two generations.
**Acceptance criteria:** (1) a record written at generation *N* can never satisfy a goal
evaluated at generation *M > N* without re-verification; (2) conflicting records for one
key are both retained and marked `CONFLICTED`, never silently merged; (3) a phone/card/
credential-shaped value is rejected **at write**, not merely filtered at egress; (4) the
ring buffer is bounded and respects `MAX_SEMANTIC_FACTS`; (5) existing I-7 tests unchanged.

### A3 — Structured decision state
**Current (PROVEN):** the prompt carries task, URL, semantic block, facts, viewport,
loop status, previous actions, detections. It does **not** carry `intent`,
`pendingCriteria`/`completedCriteria`, `destination.status`, `goal.status`,
`lastAction.dispatchStatus/effectStatus/effectDelta`, or `evidence[]`.
**Root cause:** the prompt builder predates the verifier-rich loop.
**Production change:** §6 schema; additive, allowlisted.
**Dependencies:** A2 for `evidence`; I-1 for `intent`.
**Security impact:** `GoalVerifier`'s internal reasoning, risk scores, Critic
verdicts, containment decisions and security state must **stay local** (§12).
**Tests:** prompt contains exactly the allowlisted keys; no internal security state leaks.
**Real Chrome:** model visibly refrains from re-doing a verified subgoal.
**Acceptance criteria:** (1) the prompt contains exactly the §6 keys and nothing else;
(2) `intent` is present and matches the I-1 decision; (3) `ObservationState` variants
never collapse — `UNAVAILABLE`, `UNKNOWN` and `STALE` remain distinct in output;
(4) risk scores, Critic verdicts and containment decisions are absent from the prompt;
(5) all existing reasoner tests still pass.

### A4 — Page semantic quality
**Current (OBSERVED on real Wikipedia):** facts are **relevant** and correct
("The Charminar (lit. 'four minarets') is", "The construction began in 1589…"),
but the entity layer is **semantically empty**: all 5 entities are
`type: "TableRow"`, `label: "Table Row 1..5"`, with only bare `safeAttributes`
(`col_1: "Charminar"`, `col_1: "Affiliation", col_2: "Islam"`). These are infobox
rows, not table rows. `pageType` is `"search"` on an article. Only **3** detected
elements reach the model, yet affordances point at `wm-elem-2-144/145/146` —
**element ids the model is told are not valid targets**. Fact labels truncate at 40 chars (§3d).
**Root cause:** `candidateEntities.ts` emits structural, not semantic, entities;
`entityUnderstanding` does not re-label them; the classifier weights a prominent
search box on Wikipedia as `SEARCH`; the affordance/detection id spaces disagree.
**Production change:** entity labelling from article/infobox structure; affordance
targets restricted to ids present in the offered detection set; fact word-boundary
truncation; `pageType` disambiguation (article body present ⇒ `article`).
**Dependencies:** none upstream; A3 consumes the result.
**Security impact:** richer semantics mean **more** page text toward the model —
must remain inside the I-7 choke point and the fact scanner.
**Tests:** entity labels non-generic; affordance targets ⊆ detection ids; fact
truncation respects word boundaries; `pageType === 'article'` for the article fixture.
**Real Chrome:** entityCount/labels meaningful; `pageType: "article"`.
**Acceptance:** no affordance references an id absent from the detection list.

### A5 — Information-task completion
**Current (PROVEN):** GoalVerifier conditions 1, 1b, 2, 2b, 2c, 3, 4, 5, 6, 7 are
all UI/action/observation-state conditions. Only **2c** is evidence-based, and it
is gated by a verb regex that excludes the failing task (§3c).
**Root cause:** completion was designed per-scenario; the information case was
patched rather than generalised, and the patch keys on wording.
**Production change:** generalise 2c to a `requiresEvidence` rule keyed on intent,
retaining all its existing guards (freshness, tab, document, generation,
injection exclusion, ambiguity provision).
**Dependencies:** I-1, A2, A1.
**Security impact:** this **adds** a SUCCESS path — it must fail closed on every
missing precondition. Never read the model's claim as evidence.
**Tests:** existing 2c tests must still pass unchanged (proves generalisation, not replacement).
**Real Chrome:** Wikipedia task terminates ANSWER/PARTIAL.
**Acceptance criteria:** (1) an information task can return `ANSWER`/`PARTIAL` instead of
exhausting `maxSteps`; (2) `SUCCESS` is unreachable without at least one `VERIFIED` +
`CURRENT` record matching the question subject term; (3) every existing `goalVerifier`
test passes **unchanged** (proves generalisation of 2c, not replacement).

### A6 — Action-effect history
**Current (PROVEN):** `historyContract.ts` is a **sender-side shape filter**
(`conformsToHistoryContract`, `filterToHistoryContract`) mirroring the backend's
`extra='forbid'` applicability rules. It carries **no** dispatch/effect status.
`backendAgentProvider.ts:166` adds only `scrollDelta`.
Conflation risk: the model sees bare `BrowserAction` objects, so dispatched-with-effect
and dispatched-without-effect are distinguishable only by prose.
**Root cause (PROVEN):** the history entry type is the same `BrowserAction` the model
proposed, so it can only say *what was proposed*, never *what happened*. The observed
effect exists in `EffectVerifier` and `longHorizon`, but it never crosses back into the
model-facing record — hence dispatch, execution, effect and goal success can all be
conflated in the model's own reading of its own history.
**Production change:** §9 schema adding explicit status to each history entry;
keep `historyContract.ts` as the shape gate.
**Dependencies:** A3.
**Security impact:** dropping non-conforming entries must stay counted and silent
(as today) — never report content.
**Tests:** every status round-trips; a `DISPATCHED_NO_EFFECT` entry is never
rendered as success; the existing 422-prevention test still passes.
**Real Chrome:** model distinguishes "scrolled and page moved" from "scrolled and nothing happened".
**Acceptance criteria:** (1) all six dispatch/effect states appear in history and round-trip
through the backend contract; (2) `NO_EFFECT` is never rendered as success anywhere;
(3) `EFFECT_UNVERIFIABLE` is never treated as `EFFECT_VERIFIED`; (4) the 422-prevention
test still passes (history shape gate unweakened); (5) no history entry leaks a typed value.

### A7 — Recovery
**Current (INFERRED from structure):** `recoveryEngine.ts` exists and
`longHorizon` tracks `recoveryCount` / `consecutiveNoProgress` / `totalNoProgress`,
but recovery rationale is not a typed, model-visible record; it is emitted as
console/decision-trace text.
**Root cause (INFERRED):** recovery decisions are computed and then discarded as log text,
so the next planning turn cannot see *why* the prior strategy was abandoned. The model
therefore re-proposes the exhausted approach from scratch, and the loop has no structured
way to express "this was already tried and did not work".
**Production change:** §10 schema; recovery rationale becomes structured safe metadata
and must record *why the strategy changed*, preventing recovery from becoming an
unrestricted second planner (it may select a strategy class, never bypass gates).
**Dependencies:** A6, I-8.
**Security impact:** recovery must not gain authority; it proposes, the normal
gate chain executes.
**Tests:** recovery cannot produce an action the primary path would reject;
retry budget is bounded; rationale contains no sensitive values.
**Real Chrome:** strategy change is visible after an oscillation.
**Acceptance criteria:** (1) recovery may select a strategy **class** only — every action it
induces still passes the full gate chain; (2) `retryCount` is hard-bounded per failure
category; (3) `madeProgress` derives from `assessProgress`, never from dispatch success;
(4) rationale fields are fixed enum codes with no free text and no sensitive values;
(5) no infinite retry is reachable.

### A8 — Provider reliability
**Current (OBSERVED):** the real run ended `503` ×3 after `200` ×2. Backend message:
`Reasoning unavailable: groq (rate_limit) and fallback openrouter (http_client_error) failed.`
**PROVEN good:** `backendAgentProvider` already distinguishes `kind` and `retryable`,
parses `retry-after`, has a 55 s timeout aligned to the backend's 30 s NVIDIA timeout.
**PROVEN defect (OBSERVED, separate from rate limits):** the provider returned
```json
{"action":"scroll","amount":500,"direction":"down","option":"down","reason":"…","target":"down","text":"down","url":"down"}
```
The model filled **every** unused field with the literal string `"down"`. This is
structured-output non-compliance by `openai/gpt-oss-20b`; it survived to the loop.
**Root causes:** (i) provider exhaustion is environmental; (ii) **response-shape
validation is missing on the success path** — malformed-but-200 responses are not
rejected, so a bad shape becomes a bogus action.
**Production change:** validate response shape on **every** path (not only errors);
reject `target`/`text`/`url` that are not applicable to the action type; add a
task-class-aware retry budget (information tasks may not burn all retries on a
rate-limited first attempt); surface a truthful `PROVIDER_UNAVAILABLE` terminal state.
**Dependencies:** A1 (needs a truthful non-action terminal state).
**Security impact:** provider failure must never become SUCCESS or goal-verified (already true — `FAILED` was truthful).
**Tests:** malformed 200 rejected; 429/502/503/timeout/malformed each map to the
right truthful state; provider failure never yields SUCCESS.
**Real Chrome:** rate-limited run terminates as `PROVIDER_UNAVAILABLE`, not a browser/goal failure.
**Acceptance criteria:** (1) a malformed-but-200 provider response is rejected before it can
become an action (kills the `target/text/url = "down"` class of defect); (2) 429, 502, 503,
timeout, malformed response, provider refusal and provider exhaustion each map to one
distinct truthful state; (3) no provider failure path yields `SUCCESS`, goal-verified, or a
completed subgoal; (4) `PROVIDER_UNAVAILABLE` is distinguishable from browser failure, goal
failure and insufficient evidence in the user-facing output.
**Explicitly NOT claimed:** rate limits are not "fixed" by code.

### A9 — Typed UNKNOWN / NEEDS_INFORMATION / PARTIAL
**Current (PROVEN):** `TaskStatus` has 5 states; `'UNKNOWN'` exists only as a page
type and a semantic-alignment value, never as a terminal state.
**Root cause:** the state machine predates information tasks; ambiguity has no
terminal representation, so it collapses to `FAILED`.
**Production change:** additive terminal states (§8). `UNKNOWN ≠ SUCCESS`,
`UNKNOWN ≠ ABSENCE` must be preserved structurally.
**Dependencies:** A1, A5.
**Security impact:** new states must never grant permission or bypass a gate.
**Tests:** every state is reachable and maps to exactly one user-facing message;
no state implies goal success without `goalVerified`.
**Real Chrome:** evidence-absent task terminates `NEEDS_INFORMATION`.
**Acceptance criteria:** (1) all five new terminal states are reachable from the state machine
and map to exactly one user-facing message each; (2) `UNKNOWN` is structurally incapable of
satisfying a goal — no code path maps it to `SUCCESS`; (3) `NEEDS_INFORMATION` is emitted only
when zero records are verified, `PARTIAL` only when some are, by a deterministic rule;
(4) no new state grants permission or bypasses a gate; (5) existing five states keep their
exact current semantics.

### A10 — Broad real-web reliability
**Current (PROVEN):** 2 of 10 mandated scenarios have been run. Both produced `FAILED`
terminal states, and the real-browser artifacts show perception succeeding
(96–98 regions, `OBSERVED`, 24 facts, `privacySelfCheck.clean`) while the task layer fails.
**Root cause:** there is no real-web evaluation harness at all — each phase invents its own
one-off probe (this audit alone referenced seven `scratch/p185_*` scripts), so scenarios are
neither enumerated, nor repeatable, nor checked for false success.
**Production change:** a single enumerated evaluation harness covering §14's 10 scenarios,
recording per scenario: intent, pages visited, sanitized context, evidence records, actions,
action effects, destination verification, goal verification, terminal state, privacy result,
and whether any raw sensitive value left the browser.
**Dependencies:** every other item — this is the instrument that verifies the rest.
**Security impact:** the harness must assert the privacy criteria independently of the
system under test; a run that leaks must be recorded as a leak even if the task "succeeds".
**Tests:** harness self-test — an injected failure must be detected by the harness itself.
**Real Chrome:** all 10 scenarios are themselves real-browser runs.
**Acceptance criteria:** (1) 10/10 scenarios executed with recorded artifacts;
(2) **zero false successes** — any `SUCCESS` without verified evidence fails the run;
(3) every scenario records the §14 field set; (4) privacy criteria asserted independently;
(5) fixtures used only for what §14 says they can prove, with real-browser runs for
real-DOM, real-provider and scroll dynamics.

---

## 6. Decision-State Contract (PROPOSED)

Additive and allowlisted. Rendered into the model-facing prompt; internal security
state stays local (§12).

```ts
export type ObservationState = 'OBSERVED' | 'UNAVAILABLE' | 'UNKNOWN' | 'STALE' | 'NOT_APPLICABLE';
export type DispatchStatus = 'NOT_DISPATCHED' | 'DISPATCHED' | 'POLICY_BLOCKED' | 'EXECUTION_FAILED';
export type EffectStatus = 'EFFECT_VERIFIED' | 'NO_EFFECT' | 'EFFECT_UNVERIFIABLE' | 'NOT_APPLICABLE';

export interface ModelFacingDecisionState {
  readonly task: string;
  readonly intent: TaskIntent;                       // I-1
  readonly activeSubgoal: { readonly id: string; readonly description: string } | null;
  readonly pendingCriteria: readonly string[];
  readonly completedCriteria: readonly string[];
  readonly page: {
    readonly url: string;
    readonly type: string;
    readonly state: ObservationState;
    readonly generation: number;
  };
  readonly lastAction: {
    readonly action: string;
    readonly dispatchStatus: DispatchStatus;
    readonly effectStatus: EffectStatus;
    readonly effectDelta: string;                    // value-free summary
  } | null;
  readonly destination: { readonly status: 'NONE' | 'DECLARED' | 'VERIFIED' | 'MISMATCH' | 'UNVERIFIABLE' };
  readonly goal: { readonly status: 'IN_PROGRESS' | 'SATISFIED' | 'UNSATISFIED' | 'UNVERIFIABLE' };
  readonly evidence: readonly EvidenceRef[];         // A2, §7 — refs only
  readonly recovery: { readonly occurred: boolean; readonly strategy: string; readonly retryCount: number } | null;
}
```
`ObservationState` deliberately keeps `UNAVAILABLE`/`UNKNOWN`/`STALE`/`NOT_APPLICABLE`
distinct — they must not collapse.

---

## 7. Evidence-Ledger Contract (PROPOSED)

```ts
export type EvidenceType = 'PAGE_TEXT' | 'TABLE_CELL' | 'ATTR' | 'OCR' | 'SEMANTIC_FACT' | 'VISUAL';
export type EvidencePrivacyStatus = 'SANITIZED' | 'WITHHELD' | 'QUARANTINED';
export type EvidenceVerification = 'VERIFIED' | 'UNVERIFIED' | 'CONFLICTED' | 'INVALIDATED' | 'QUARANTINED';
export type EvidenceFreshness = 'CURRENT' | 'STALE' | 'UNKNOWN';

export interface EvidenceRecord {
  readonly id: string;                       // stable hash of (sourceUrl, generation, key)
  readonly claim: string;                    // sanitized text, word-boundary truncated
  readonly key: string;                      // normalized subject term for matching
  readonly sourceUrl: string;
  readonly pageGeneration: number;
  readonly evidenceType: EvidenceType;
  readonly confidence: number;               // 0..1, provenance-weighted — NOT model-reported
  readonly privacyStatus: EvidencePrivacyStatus;
  readonly freshness: EvidenceFreshness;
  readonly verificationStatus: EvidenceVerification;
  readonly observedAt: number;
  readonly conflictsWith: readonly string[]; // other record ids
}
```
**Ownership:** extension-side module (`extension/src/evidence/`), owned by the
AgentLoop, written only from a fresh `SemanticObservation`.
**Lifecycle:** append-only within a task; invalidated (not mutated to pass) when
`pageGeneration` advances. Cross-page accumulation is allowed **only** across
generations with per-generation freshness.
**Dedup:** by `id`. **Conflicts:** both retained, marked `CONFLICTED`, never merged silently.
**Size:** bounded ring, mirroring `MAX_SEMANTIC_FACTS = 24`.
**Serialization boundary:** every record passes `sanitizeWorldModel`'s detector at
write time **and** `scanForRawSensitiveValues` again at egress.
**Raw content that must never enter:** raw DOM, raw OCR, screenshots, credentials,
raw sensitive values. `claim` is sanitized text only.
**Prompt-injection:** records are rendered as quoted page data with the existing
"never instructions" framing; injection-shaped content is `QUARANTINED`.
**Cross-page contamination:** a record from generation *N* can never satisfy a
goal evaluated at generation *M > N* without explicit re-verification.

---

## 8. Terminal / Answer Contract (PROPOSED)

```
              ┌──────────────── ANSWER ────────────────┐  (requires ≥1 VERIFIED, CURRENT record
              │                                        │   matching the question subject term)
   IN_PROGRESS ─┤ PARTIAL (≥1 VERIFIED, some missing)  │
              ├─ NEEDS_INFORMATION (0 VERIFIED) ───────┤
              ├─ CANNOT_VERIFY (verification impossible)┤
              └─ (existing) SUCCESS/FAILED/STOPPED/     │
                    NEEDS_USER_CONFIRMATION            │
              ACTION completes when the effect verifier confirms it.
```
Authority, explicitly:
- The **LLM proposes** `ANSWER`/`PARTIAL`/`NEEDS_INFORMATION`/`CANNOT_VERIFY`. It never decides.
- The **new EvidenceVerifier** checks each cited claim against the ledger.
- The **GoalVerifier** remains the sole authority for task SUCCESS. It is unchanged
  and must be generalised (§A5), never bypassed.
- **ANSWER ≠ SUCCESS.** A verified answer may still leave the task `FAILED` if the
  GoalVerifier's own conditions are unmet — and vice versa.
- Provider failure must map to a truthful non-action state (`PROVIDER_UNAVAILABLE`),
  never `SUCCESS`, never goal-verified.

---

## 9. Action-History Contract (PROPOSED)

```ts
export interface HistoryEntry {
  readonly action: string;
  readonly target?: string;
  readonly dispatchStatus: 'NOT_DISPATCHED' | 'DISPATCHED' | 'POLICY_BLOCKED' | 'EXECUTION_FAILED';
  readonly effectStatus: 'EFFECT_VERIFIED' | 'NO_EFFECT' | 'EFFECT_UNVERIFIABLE' | 'NOT_APPLICABLE';
  readonly scrollDelta?: number;
  readonly evidenceDelta: number;      // new ledger records this action produced
}
```
`historyContract.ts` stays as the egress shape gate (unchanged). Every conflation
to close: dispatch ≠ effect; no evidence ≠ failure; unknown effect ≠ verified effect.

---

## 10. Recovery Contract (PROPOSED)

```ts
export interface RecoveryRecord {
  readonly failureCategory: 'NO_EFFECT' | 'POLICY_BLOCKED' | 'EXECUTION_FAILED'
                          | 'PROVIDER_UNAVAILABLE' | 'STALE_PERCEPTION' | 'OSCILLATION';
  readonly previousActionResult: HistoryEntry;      // ref only
  readonly observationState: ObservationState;
  readonly madeProgress: boolean;                   // from assessProgress — never from dispatch
  readonly strategyFrom: string;
  readonly strategyTo: string;
  readonly retryCount: number;                      // bounded
  readonly reasonCode: string;                      // fixed enum, no free text
}
```
Recovery may **select a strategy class**; the normal gate chain (Grounding → M5 →
Security Critic → Risk → Confirmation → Containment) executes whatever it selects.
Recovery gains **no** authority.

---

## 11. Perception Contract (PROPOSED)

Exactly what may reach the reasoner — all of it already inside the I-7 boundary:

**Permitted:** task; intent; current URL; page type/state/generation; viewport;
screenshot **dimensions only**; sanitized semantic facts (word-boundary truncated);
entity labels + safe attributes; affordances **restricted to offered detection ids**;
detection metadata (id/type/bbox/length/selector) with values redacted; bounded
ledger refs; decision state (§6); action history (§9); recovery record (§10).

**Forbidden:** raw DOM text; raw OCR; screenshot pixels; credential values;
raw sensitive values; raw table cells; internal security state (risk scores,
Critic verdicts, containment decisions, GoalVerifier internals).

---

## 12. Authority Diagram

```
                     ┌──────────────┐
                     │     LLM      │  proposes ONLY
                     └──────┬───────┘
        ┌───────────────────┼────────────────────┐
        ▼                   ▼                    ▼
   Grounding          Decision State        ANSWER proposal ──▶ EvidenceVerifier
   (aligns action)     (privacy-safe)             (inert until verified)
        │
        ▼
   M5 / Privacy Firewall
        ▼
   Security Critic ──── POLICY_BLOCKED ──┐
        ▼                                │
   Risk / Confirmation ── NEEDS_USER_CONFIRMATION
        ▼                                │
   Containment ─────────────── refused ──┤
        ▼                                ▼
     ACTION ──▶ EffectVerifier ──▶ Fresh Perception
                      │                     │
                      └── NO_EFFECT ──▶ Recovery (no authority)
                                            │
                                            ▼
                              DestinationVerifier (declared destination)
                                            │
                              EvidenceVerifier (ledger claims)
                                            │
                                            ▼
                                  GoalVerifier  ◄── SOLE authority for SUCCESS
                                            │
                                            ▼
              ANSWER │ PARTIAL │ NEEDS_INFORMATION │ CANNOT_VERIFY │ PROVIDER_UNAVAILABLE
```

| Authority | Owns | Must never |
|---|---|---|
| LLM | Proposals | Decide anything |
| Grounding | Action↔task alignment | Grant permission |
| M5 / Privacy Firewall | Raw payload admission | Be bypassed by a terminal state |
| Security Critic | Destination/suspicion block | Be weakened by intent or recovery |
| Risk / Confirmation | Consequential pause | Be skipped |
| Containment | Origin scope | Be widened by recovery |
| EffectVerifier | Did the action change the page | Inflate to goal success |
| DestinationVerifier | Is this the declared destination | Substitute for evidence |
| EvidenceVerifier | Does each cited claim exist & is fresh | Invent evidence |
| **GoalVerifier** | **Task SUCCESS** | Be bypassed by `ANSWER` |

**Local-only, never to the LLM:** risk scores, Critic verdicts, containment
decisions, GoalVerifier internals, sanitizer stats internals, provider credentials.

---

## 13. Dependency Graph (derived from the code, not assumed)

```
A4  perception quality ──────────────┐ (improves ledger yield; not a blocker)
                                    │
I-1 intent boundary ──▶ A3 decision state ──▶ A2 evidence ledger ──▶ A9 terminal states
   │                        │                                              │
   │                        └──▶ A6 action history ──▶ I-8 scroll bounds │
   │                                                            │        │
   └──────────────────────────▶ A5 goal verification ◀───────────┘        │
                                     │                                     │
                          A1 answer contract ◀────────────────────────────┘
                                     │
                        A7 recovery  │  A8 provider truthful states
                                     ▼
                              A10 real-web evaluation
```
Derived order: **I-1 → A3 → A2 → A9/A1 → A5** is the critical spine (nothing can
be verified without intent, state and evidence). **A4 is parallel and can start
immediately.** **I-8 depends on A6** (an action must report `evidenceDelta` before a
scroll budget can be meaningful). **A8 depends on A9** (a truthful provider state
needs the terminal protocol). **A10 last.**

---

## 14. Real-Browser Evaluation Matrix

| # | Scenario | Proves | Pass criteria | False-success trap |
|---|---|---|---|---|
| 1 | Wikipedia information lookup | end-to-end info task | terminal ∈ {ANSWER, PARTIAL}; ledger ≥1 VERIFIED CURRENT | SUCCESS with 0 verified records |
| 2 | Search → result → information | multi-hop | ≥2 generations; each cited record fresh at its generation | citing a stale record |
| 3 | Multi-page information | ledger accumulation | records span ≥2 URLs, provenance intact | merging conflicting records |
| 4 | Info requiring scrolling | I-8 bound | scroll count bounded; terminates truthfully | terminating by `maxSteps` |
| 5 | Missing information | A9 | terminal `NEEDS_INFORMATION` | `SUCCESS` |
| 6 | Stale evidence | A2 freshness | generation advance invalidates old records | stale record satisfying goal |
| 7 | Sensitive-data page | I-7 + ledger | no raw value in ledger/prompt; `privacySelfCheck.clean` | ledger capturing a phone/card |
| 8 | Navigation + information | I-1 MIXED | destination VERIFIED **and** evidence verified | destination verified ⇒ task success |
| 9 | Ambiguous request | I-1 | terminal `AMBIGUOUS`/`NEEDS_CLARIFICATION`; 0 provider calls | guessing a destination |
| 10 | Provider failure | A8 | truthful `PROVIDER_UNAVAILABLE`; ≠ SUCCESS | retry exhaustion reported as goal failure |

Fixtures vs real web: fixtures prove determinism, gating, and privacy invariants
deterministically; they **cannot** prove real-DOM perception, real-provider
behaviour, or genuine scroll dynamics. Every row above marked real requires a real
Chrome run against the production extension + backend.

---

## 15. Security Non-Regression Matrix (must remain unchanged)

| Component | Non-regression requirement |
|---|---|
| Security Critic | No intent/recovery/terminal-state path may bypass or weaken it |
| M5 / Privacy Firewall | No new egress path; every new field passes the scanner |
| Containment | Recovery and MIXED_TASK must not widen origin scope |
| DestinationVerifier | Intent may request a destination, never synthesise one |
| GoalVerifier | Sole SUCCESS authority; only generalised, never bypassed |
| EffectVerifier | Effect ≠ goal; unchanged |
| Egress Firewall | Ledger/prompt additions must be scanned |
| `rawValueScanner` | Unchanged |
| World-model choke point (I-7) | `sanitizeWorldModel` before `assertWorldModelSafe`; unchanged |
| `assertWorldModelSafe` | Byte-identical |

New risks introduced and how they are contained:
- **Evidence poisoning** → ledger records only from fresh observations; injection-shaped content `QUARANTINED`; the model may never author a record.
- **Stale evidence** → per-generation freshness; invalidation on generation advance.
- **Cross-page contamination** → records carry provenance and cannot satisfy a later generation unverified.
- **Recovery as second planner** → selects strategy class only; full gate chain still runs.

---

## 16. Implementation Handoff

**Step 1 — I-1 Intent boundary** (independent)
- FILES: new `extension/src/agent/intentBoundary.ts`; `serviceWorker.ts:520`.
- TYPES: `TaskIntent`, `IntentDecision` (§2).
- DATA FLOW: raw task → `classifyIntent` → `IntentDecision` → admit/refuse before `runTask`.
- TESTS: 7 intents, determinism, no-provider-call for casual/ambiguous.
- REAL CHROME: 6 scenarios.
- ACCEPT: casual ⇒ 0 provider calls, 0 tabs.

**Step 2 — A4 Perception quality** (independent, parallel)
- FILES: `candidateEntities.ts`, `entityUnderstanding.ts`, `pageClassifier.ts`, `factExtraction.ts`.
- CHANGES: semantic entity labels; affordance targets ⊆ detection ids; word-boundary truncation; article disambiguation.
- TESTS: non-generic labels; target-subset invariant; no mid-word truncation.
- REAL CHROME: `pageType: "article"`, meaningful entity labels.
- ACCEPT: no affordance references an unoffered id.

**Step 3 — A2 Evidence ledger** (needs I-7 ✓)
- FILES: new `extension/src/evidence/`.
- TYPES: `EvidenceRecord` (§7).
- DATA FLOW: fresh `SemanticObservation` → sanitise → dedup/conflict → ring buffer.
- TESTS: staleness, conflict, dedup, injection quarantine, raw-value rejection at write **and** egress.
- REAL CHROME: cross-generation accumulation.
- ACCEPT: no raw sensitive value ever enters the ledger.

**Step 4 — A3 Decision state + A6 History** (needs I-1, A2)
- FILES: `agentState.ts`, `backendAgentProvider.ts`, `historyContract.ts` (shape gate unchanged).
- DATA FLOW: `ModelFacingDecisionState` → prompt, allowlisted keys only.
- TESTS: exact key allowlist; no internal security state in prompt; all dispatch/effect statuses round-trip.
- REAL CHROME: model distinguishes effect from no-effect.
- ACCEPT: prompt contains exactly the §6 keys.

**Step 5 — A9/A1 Terminal + answer contract** (needs A3, A2)
- FILES: `backend/app/models.py` (widened response model), `agentState.ts`, reasoner prompt.
- NEW: `EvidenceVerifier`; states `ANSWER|PARTIAL|NEEDS_INFORMATION|CANNOT_VERIFY|PROVIDER_UNAVAILABLE`.
- TESTS: existing action-only paths still parse; evidence-free ANSWER rejected; provider failure ≠ SUCCESS.
- REAL CHROME: Wikipedia run can answer on turn 1.
- ACCEPT: no terminal state implies SUCCESS without GoalVerifier.

**Step 6 — A5 Goal verification** (needs I-1, A2, A9)
- FILES: `goalVerifier.ts` — generalise 2c to an intent-keyed rule, **retaining every guard**.
- TESTS: **all existing 2c tests pass unchanged** (proves generalisation, not replacement).
- REAL CHROME: task terminates ANSWER/PARTIAL.
- ACCEPT: no invented UI subgoal.

**Step 7 — I-8 Scroll** (needs A6)
- FILES: `longHorizon.ts`; wire or delete `infiniteScrollScanner.ts`.
- CHANGES: evidence-delta progress rule; direction budget; fingerprint saturation.
- TESTS: DOWN×N interrupted; oscillation detected; productive scroll never tripped.
- REAL CHROME: bounded scrolls, truthful termination.
- ACCEPT: no `maxSteps`-exhaustion termination on an information task.

**Step 8 — A7 Recovery + A8 Provider**
- FILES: `recoveryEngine.ts`, `backendAgentProvider.ts`.
- CHANGES: `RecoveryRecord`; success-path response validation; task-class retry budget.
- TESTS: recovery cannot bypass a gate; malformed 200 rejected; every provider error maps truthfully.
- REAL CHROME: rate-limited run ⇒ `PROVIDER_UNAVAILABLE`.
- ACCEPT: provider failure never becomes SUCCESS or goal-verified.

**Step 9 — A10 Evaluation**
- Build the 10-scenario harness with recorded artifacts and false-success detectors.
- ACCEPT: 10/10 executed, zero false successes, full suite + backend + build green after every step.

---

## PROVEN CLOSED
- **I-4** — Google-centric destination/search assumptions (`0849eb9`)
- **I-6** — stale `NEEDS_USER_CONFIRMATION` fixture (`0849eb9`)
- **I-7** — world-model privacy choke point (`03bee68`)
- Security authorities byte-unchanged; full suite 2373/2373; backend 601/601.

## REMAINING
- **I-1** intent boundary — root cause PROVEN (no gate exists; `serviceWorker.ts:520→1368`)
- **I-5** information tasks — root cause PROVEN (`TaskStatus` lacks ANSWER; `reportIntent` regex excludes the failing task)
- **I-8** scroll — root cause PROVEN (`scrollY` in the fingerprint makes loops undetectable; bounded scanner unwired)
- **A1** answer contract, **A2** evidence ledger, **A3** decision state, **A4** page semantics, **A5** info-task completion, **A6** action history, **A7** recovery, **A8** provider reliability, **A9** typed terminal states, **A10** real-web reliability

## IMPLEMENTATION ORDER
**I-1 → A3 → A2 → A9/A1 → A5**, with **A4** in parallel from the start,
then **A6 → I-8 → A7 → A8 → A10**.

## DO NOT MODIFY
Security Critic · M5/Privacy Firewall · Containment · DestinationVerifier ·
GoalVerifier's existing rules · EffectVerifier · Egress Firewall · Recovery Engine's
non-authority posture · `rawValueScanner` · `sanitizeWorldModel` ·
`assertWorldModelSafe` · `historyContract.ts` shape gate.

---

**This phase made no production, test, or configuration changes and created no commits.**