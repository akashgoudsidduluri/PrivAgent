# STEP 10 AUDIT — role-only destination propagation + already-satisfied semantics

**Nature of this document.** Read-only audit of a Step 10 change set that appeared in
the working tree and that the auditor did **not** author. No Step 10 code was modified,
nothing was committed or pushed, and Phase 18 was not started. HEAD stayed `b677654`
throughout. Every claim below is labelled with the evidence class that actually supports
it.

Evidence files in this directory:

| file | what it is |
| --- | --- |
| `case_A_role_only.json` | real Chrome, real extension, role-only prompt — egress bytes |
| `case_B_explicit_url.json` | real Chrome, explicit-URL prompt — egress bytes + real navigation |
| `case_C_already_at_destination*.json` | real Chrome, already on the destination — already-satisfied branch |
| `case_D_wrong_destination*.json` | real Chrome, non-destination start page — MISMATCH |
| `case_E_unknown.json` | real Chrome, UNKNOWN start page — UNKNOWN never completes |
| `mutation_matrix.json` | M1–M20 with exact classification and the failing test that killed each |
| `scratch/step10_egress_capture.mjs` | the audit harness that produced the captures |
| `scratch/step10_mutation_matrix.mjs` | the audit harness that produced the matrix |

---

## 1. The declared-destination dataflow, as measured

`normalizeDestination` has exactly **one** production call site in the whole extension:

```
extension/src/hierarchicalPlanning/taskDecomposer.ts:203
  const destinationDeclaration = normalizeDestination(userPrompt);
```

No other file calls it. `grep -rn "normalizeDestination(" extension/src --include=*.ts`
returns that single line plus one comment. This is the structural reason
`DECLARED DESTINATION = USER-DERIVED ONLY` holds: the only string that can ever become a
declaration is the raw user prompt.

| # | boundary | file / function | type | authority |
| --- | --- | --- | --- | --- |
| 1 | user prompt | `taskDecomposer.decomposeTask(task)` | `string` | the only declaration source |
| 2 | normalizer | `normalizeDestination` (`planning/destinationNormalizer.ts`) | `DestinationDeclaration` (`DECLARED`/`AMBIGUOUS`/`UNSUPPORTED`/`NONE`) | decides *what was declared*, never resolves ambiguity |
| 3 | goal | `HighLevelGoal.destinationDeclaration` (`taskDecomposer.ts:214`) | `DestinationDeclaration` | carry, read-only |
| 4 | subgoal | `addDestinationSubgoal()` (`taskDecomposer.ts:302-313`) | `Subgoal.destination` | the only writer; `dynamicReplanner.ts` has **no** `destination` reference at all |
| 5 | projection | `toDeclaredDestinationConstraint` (`plannerContextBuilder.ts:48-65`) | `DeclaredDestinationConstraint` | total projection; `undefined` for `NONE`/`AMBIGUOUS`/`UNSUPPORTED` |
| 6 | egress | `PlannerContextBuilder.buildContext` (`:103-116`) | `context.semantic_context.declaredDestination` | serialised into the request context |
| 7 | minimizer | `minimizeAgentContext` (`contextMinimizer.ts:286`) | pass-through | forwards `semantic_context` wholesale; only removes detections |
| 8 | transport | `backendAgentProvider` → `POST /api/v1/agent/action` | JSON | real bytes captured |
| 9 | backend | `reasoner._build_user_prompt` (`reasoner.py:265-274`) | `dest_data` dict | renders only when `provenance == "USER_DECLARED_DESTINATION"` |
| 10 | model | `SYSTEM_PROMPT` rule 1 (`reasoner.py:160-167`) | prose constraint | may *propose* a route; may not define or complete the destination |
| 11 | action | `OneActionPlanner.proposeDestinationNavigation` (`oneActionPlanner.ts:176`) | `BrowserAction \| null` | deterministic navigator; **returns `null` for role-only** |
| 12 | observation | `perceivePage()` → fresh `AgentContextPayload` | `semantic_context` | may prove or disprove; never writes |
| 13 | verification | `GoalProgressTracker.verifySubgoalCondition` → `DESTINATION_VERIFIED` (`goalProgressTracker.ts:333-395`) | `DestinationVerdict` | **sole** destination authority, `MATCH` only |
| 14 | completion | `SubgoalGraph.completeSubgoal` | state | planning bookkeeping only |
| 15 | goal success | `GoalVerifier` | — | **sole** task-success authority; not imported by the destination path |

`DeclaredDestinationConstraint` (`hierarchicalTypes.ts:186-194`) carries only
`provenance` (a literal), `role?: readonly string[]`, `destinationUrl?: string`,
`entryUrl?: string`. There is no field capable of carrying prose.

---

## 2. Provider egress — real captured bytes

Captured from the **service worker** of the production build (`dist/`, built at
16:27:28, after the last Step 10 source edit at 16:24:45) via the CDP `Network`
domain, while the real Groq-backed backend answered. `PROVEN_REAL_CHROME` +
`PROVEN_REAL_BACKEND`.

**Case A — role-only, `"open the store catalog"` (no user URL):**

```
context.semantic_context keys:
  pageType, confidence, pageState, pageGeneration, entities, affordances,
  workflow, promptInjectionDetected, facts, declaredDestination

context.semantic_context.declaredDestination  (verbatim):
  {"provenance":"USER_DECLARED_DESTINATION","role":["LISTING"]}
```

* `destinationUrl` **absent** — a bare role acquired no URL.
* `entryUrl` **absent**, even though the observed page was `http://localhost:4174/`.
  That is direct evidence that `entryUrl` is not derived from the observation.
* Recursive key walk of the declaration: exactly `["provenance", "role"]`. No
  `text`/`value`/`input`/`label`/prose leaf anywhere inside it.

**Case B — explicit URL, `"open the store catalog at http://localhost:4174/results.html"`:**

```
declaredDestination:
  {"entryUrl":"http://localhost:4174/results.html",
   "provenance":"USER_DECLARED_DESTINATION","role":["LISTING"]}
```

The user's URL is preserved **byte-exact** — but it lands in `entryUrl`, and
`destinationUrl` is absent. See gap G3.

**Influence matrix, answered with evidence**

| could this influence `declaredDestination`? | answer | evidence |
| --- | --- | --- |
| page content / DOM text | **no** | single `normalizeDestination(userPrompt)` call site; declaration never read from a context; M3 KILLED |
| observation | **no** | `entryUrl` absent in case A while the observed URL was present; M3 KILLED |
| model output | **no** | no write path to `Subgoal.destination` outside `taskDecomposer`; M6 KILLED |
| `previousActions` / `history` | **no** | not read by the projection; M1-family + W8b |
| `action.url` | **no** | `proposeDestinationNavigation` returns `null` for role-only; M8 KILLED |
| `targetEntity` | **no** | not read; M4 KILLED |
| `affordances` | **no** | not read; M5 KILLED |
| backend-generated semantic data | **no** | `declaredDestination` is copied from the client dict, not from `page_type`; M17 KILLED |
| arbitrary caller objects | **only if the caller sets the literal** | `reasoner.py:266` trusts `provenance == "USER_DECLARED_DESTINATION"` from the client. Within the extension trust boundary this is the enforcement point; M16 KILLED proves a wrong/missing provenance is dropped. See gap G4. |

**PII in the destination field: none.** The declaration is `{provenance, role}` or
`{provenance, role, entryUrl/destinationUrl}` — closed-enum role strings and two URL
strings, nothing else, in every capture.

**Page-derived prose elsewhere in the same payload (pre-existing, out of scope).**
`context.semantic_context.facts[]` carries page labels such as
`"Discover Quality Gear & Apparel"`, `"Explore thousands of bags, travel gear,"`,
`"© 2026 ApexCart Demo Shopping Portal …"`. This is the documented Step 9 P1 in
`backend/app/text_safety.py`; it is **not** inside `declaredDestination` and Step 10 did
not introduce it. Left untouched, as instructed.

---

## 3. Real runtime, cases A–E

All five used the production extension in real headless Chrome against the real fixture
(`localhost:4174`) and the real backend (`localhost:8010`, Groq).

| | A role-only | B explicit URL | C already at destination | D wrong destination | E UNKNOWN |
| --- | --- | --- | --- | --- | --- | --- |
| task | `open the store catalog` | `open the store catalog at …/results.html` | `open the store catalog` | `open the store catalog` | `open the store catalog` |
| start page | `/` | `/` | `/results.html` | `/login.html` | `/search.html` |
| final URL | `/` | `/results.html` | `/results.html` | `/search.html` | `/search.html` |
| pageType / confidence | `UNKNOWN` / 0.10 | `LISTING` / 0.99 | `LISTING` / 0.99 | `LOGIN` / 0.99 → `UNKNOWN` / 0.10 | `UNKNOWN` / 0.10 |
| egress carries `declaredDestination` | yes (1 of 1 request) | yes (2 of 7) | yes (2 of 3) | yes | yes (2 of 6) |
| action | — | real `navigate` to the user's URL | real `scroll` (no-op) | real click → real navigation, then no-op scrolls | real no-op scrolls |
| effect verdict | — | `EFFECT_VERIFIED` | `ACTION_NO_EFFECT` | `EFFECT_VERIFIED` then `ACTION_NO_EFFECT` ×2 | `ACTION_NO_EFFECT` ×3 |
| destination verifier | not reached | not reached | **MATCH on a fresh observation** | **MISMATCH** | **UNKNOWN** |
| destination subgoal | not reached | not reached | **COMPLETED** (`completedSubgoals: 1`) | not completed | not completed |
| recovery escalation | — | yes | **no `recovery decision` at all** | `REPERCEIVE` ×2 | `REPERCEIVE` ×2 |
| GoalVerifier | NOT_REACHED | NOT_REACHED | NOT_REACHED — run ended `outcome: FAILED` | NOT_REACHED | NOT_REACHED |
| provider calls | 1 (503) | 7 | 3 | 3 | 6 |
| class | `PARTIAL` | `PROVEN_REAL_CHROME` (egress + navigation) / `NOT_REACHED` (completion) | `PROVEN_REAL_CHROME` | `PROVEN_REAL_CHROME` | `PROVEN_REAL_CHROME` |

**Case C, verbatim trace (two independent runs, `case_C_run3.json`, `case_C_run4.json`):**

```
[AgentTrace] ACTION_EXECUTED + ACTION_NO_EFFECT
  {"status":"ACTION_NO_EFFECT","details":"Scroll down produced zero viewport movement (scrollDelta: 0px). Viewport likely hit scroll boundary."}
[AgentTrace] perception started {"perceptionGeneration":3,"url":"http://localhost:4174/results.html"}
[AgentTrace] semantic observation {"state":"OBSERVED","facts":15,"regionsConsidered":15,...}
[AgentTrace] destination already satisfied — no transition needed
  {"subgoalId":"goal-muprr1wx-eqck8-sg1",
   "evidence":"Observed page identity LISTING at confidence 0.99 is one of the declared roles [LISTING]."}
[AgentTrace] harness cycle {"cycle":2,"verdict":"CONTINUE","haltCode":null}
[AgentTrace] subgoal selected {"subgoalId":"goal-muprr1wx-eqck8-sg2","category":"LOCATE",...}
[AgentTrace] long-horizon update {"completedSubgoals":1,...}
[AgentTrace] output screen {"outcome":"FAILED","phase":"TERMINAL","resultKind":"NONE"}
```

This is the causal contract, satisfied exactly:

* the action is **not** credited (`ACTION_NO_EFFECT`, `lastActionResult.success = false`);
* a **fresh** perception is taken (`perceptionGeneration: 3`, a new `worldModelId`),
  distinct from the cycle's own page;
* the completion is credited to the **observation** (`evidence:` is the verifier's own
  MATCH reason naming the observed page identity and confidence);
* recovery is **not** escalated — the discriminator against cases D and E, where
  `recovery decision {"code":"ACTION_NO_EFFECT","strategy":"REPERCEIVE"}` *does* appear;
* the overall run still ends `FAILED` with `resultKind: NONE` — `GoalVerifier` was never
  told the task succeeded.

**Why the runs ended.** Groq's free tier plus the backend's own output validation ended
several runs before the interesting branch: `rule=person_name` over-blocking a
model-written `reason` (the documented P1), `'reason' exceeds the 300-character limit`,
`Target 'down' does not exist in the current sanitized context`, and
`groq (rate_limit) … fallback openrouter (http_client_error)`. These are reported as-is.
**Case A therefore never reached a browser arrival** — its egress evidence is complete
but its arrival is `NOT_REACHED`.

---

## 4. Mutation matrix

Runner: `scratch/step10_mutation_matrix.mjs` (async `spawn`, durable backup in
`scratch/.mutation_backup/`, `scratch/mutation_restore.mjs` afterwards, restore verified
byte-for-byte after every mutation). Suites: the Step 10 file for extension mutations,
the whole `backend/tests` for backend mutations. **19 KILLED · 1 EQUIVALENT ·
1 SURVIVED · 0 INVALID.**

| id | mutation | invariant | result | proof |
| --- | --- | --- | --- | --- |
| M1 | `declaredDestination` never built in `buildContext` | role reaches the provider | KILLED | W4b, W4c, W8b, W14a, W21a |
| M2 | role spread gains a fabricated `…/results.html` | a bare role never acquires a URL | KILLED | W4a, W4b, +7 |
| M3 | fallback derived from `semantic_context.pageType` | not derived from observation | KILLED | W5b, W6, W7, W7b |
| M4 | fallback derived from `subgoal.targetEntity` | targetEntity is not a substitute | KILLED | W5b |
| M5 | fallback derived from `affordances[0].type` | affordances are not a substitute | KILLED | W5b, W6, +2 |
| M6 | fallback derived from `subgoal.suggestedAction` (model output) | model cannot create/rewrite it | KILLED | W5b |
| M7 | `destinationUrl` falls back to `entryUrl` | entry never promoted to destination | KILLED | W4a, W4b, +8 |
| M8 | role channel matches on *any* observed URL | arrival ≠ declaration | KILLED | W30c (×3 suites) |
| M9a | `DESTINATION_VERIFIED` returns `true` unconditionally | dispatch state cannot complete a destination | KILLED | 8 tests |
| **M9b** | `readonly provenance: 'USER_DECLARED_DESTINATION'` → `string` | **type erasure only** | **EQUIVALENT** | 47/47 still pass; zero runtime effect. *Pre-existing equivalent classification preserved as instructed.* |
| M10 | `MATCH \|\| UNKNOWN` | UNKNOWN never completes | KILLED | 4 tests |
| M11 | `MATCH \|\| MISMATCH` | MISMATCH never completes | KILLED | 4 tests |
| M12 | `currentPageGeneration` pinned to the observed generation | stale never completes | KILLED | 2 tests (W25b, W26) |
| **M13** | `lastActionResult = { success: true }` on the plain `ACTION_NO_EFFECT` failure path | no-effect never becomes action success | **SURVIVED** | **survives the whole suite: 131 files / 2088 tests all pass.** See gap G1. |
| M14 | fresh re-perception replaced by the cycle's own context | the verdict needs a fresh page | KILLED | W20b |
| M15 | `verifyDestination` short-circuits to `MATCH` | verifier is the sole authority | KILLED | 49 failing across 2 suites |
| M16 | backend drops the `provenance` gate | only a genuine user declaration reaches the model | KILLED | `test_a_forged_or_provenanceless_declaration_is_not_rendered` (3 params) |
| M17 | backend fabricates `declaredDestination` from the observed `pageType` | backend cannot fabricate a user destination | KILLED | same test (5 params) |
| M18 | page `facts[0].label` copied into the constraint as `text` | page text can never ride inside | KILLED | 14 tests (W4d) |
| M19 | the `role` spread is deleted | the role constraint is carried, not just the URL | KILLED | 4 tests |
| M20 | `destinationUrl` falls back to `entryUrl` (collapse) | entry and destination never collapse | KILLED | 10 tests |

---

## 5. Gaps found (no code was changed for any of them)

* **G1 — M13 survives the entire test suite.** Nothing pins
  `lastActionResult.success === false` on the *non-satisfied* `ACTION_NO_EFFECT` path.
  The Step 10 file's own comment claims this is covered "at loop level", but W20/W21/W22
  only exercise the *already-satisfied* branch, which writes its own literal. Production
  code is correct; the invariant is unpinned.
* **G2 — `buildModelFacingContext` drops the field.** `contextMinimizer.ts:403-425` is an
  explicit allowlist of `semantic_context` keys and does **not** include
  `declaredDestination`. The production backend path uses `minimized.payload`
  (wholesale pass-through, `contextMinimizer.ts:286`) and is unaffected — proven by the
  real captures. The allowlisted `modelView` is consumed only by
  `openRouterProvider.ts:133`, which `providerRegistry.ts:15` documents as
  DEV/TEST-only. If the extension is ever pointed at a browser-side provider key, the
  constraint is silently dropped. Fails closed toward less information; no security
  impact.
* **G3 — an explicit user URL lands in `entryUrl`, never `destinationUrl`.** The URL is
  preserved byte-exact and the model navigates to it, but the typed contract classifies a
  user-supplied path URL as the *entry* site with the *role* as the destination. The Step
  10 contract for case B asks for the exact URL to be preserved "through the typed
  contract"; it is preserved, but not in the `destinationUrl` field. This is inherited
  from the Step 7/8 normalizer, not introduced by Step 10.
* **G4 — the backend trusts the client's `provenance` literal.** `reasoner.py:266` renders
  whatever the client sends as long as `provenance == "USER_DECLARED_DESTINATION"`. The
  backend cannot independently re-derive it, so "USER-DERIVED ONLY" is enforced entirely
  on the extension side. Acceptable under the extension-is-trusted threat model, and
  M16/M17 prove the backend will not manufacture or mislabel one — but it should be
  stated as an assumption, not a property of the backend.
* **G5 — `declaredDestination` is per-subgoal scoped.** In the case B capture only 2 of
  7 requests carried it; later turns in the same run did not, because no active subgoal
  held a destination. Correct, but it means the constraint is not present on every turn.
* **G6 — labelling in the user prompt.** The declaration is rendered inside the
  `Semantic Understanding (on-device local inference)` block (`reasoner.py:275`), i.e.
  visually co-mingled with observed state. The system prompt does label it
  "read-only data, non-authoritative" and "extracted deterministically from the user's own
  request", so the model is told; the visual separation is only partial.
* **G7 — the real role-only case (A) never reached a browser arrival.** Blocked by the
  pre-existing `person_name` over-blocking of model-written `reason` prose, the documented
  Step 9 P1. Not fixed, as instructed.
* **G8 — one backend test is misnamed.** `test_the_rendered_prompt_passes_the_firewall`
  does not render a prompt; it re-runs the same `verify_payload_invariants` call as
  `test_constraint_keys_survive_the_outbound_firewall`.

---

## 6. Test classification (A–F)

`tests/destinationPropagationAndAlreadySatisfied.test.ts` — 47 tests.

| class | count | what they actually are |
| --- | --- | --- |
| A. unit / static | 35 | pure production functions: `normalizeDestination`, `toDeclaredDestinationConstraint`, `decomposeTask`, `GoalProgressTracker.verifySubgoalCondition`, `verifyDestination`, `verifyActionEffect`, `PlannerContextBuilder.buildContext`, plus the `W14b` source-grep that proves `results.html` appears nowhere in six production files |
| B. integration | 12 | `driveNoEffectLoop`: the real `AgentLoop` + real `PlannerContextBuilder` + real `GoalProgressTracker` + real `destinationVerifier`, driven in Node behind controlled `perceivePage` / `executeAction` / provider seams. Real production modules; **not** a browser, **not** the backend, **not** the reasoner |
| C. production extension runtime in-browser | 0 | — |
| D. real Chrome | 0 | — |
| E. real backend / provider | 0 | — |
| F. full agent-directed E2E | 0 | — |

`backend/tests/test_step10_declared_destination.py` — 14 cases, all class **A**: in-process
calls to the real `_build_user_prompt`, `AgentContextPayload` and
`verify_payload_invariants`, with the payload hand-built. It proves the backend's handling
of the field; it does not prove the extension sends it (that is what §2 is for).

**The gap this creates:** nothing in the test suite is class C–F. Every claim about the
browser, the wire and the model is carried solely by §3, which is audit-generated
evidence, not a regression test. The `B` section's own header says so explicitly:
*"The provider in the W17+ section is a CONTROLLED ADAPTER … It is explicitly NOT the
real reasoner and is never reported as one."*

---

## 7. No-regression verification

| check | result |
| --- | --- |
| HEAD | `b677654`, unchanged; nothing committed, pushed, reset or reverted |
| Step 9 focused destination suites (5 files) | **281/281** |
| Step 10 focused suite | **47/47** |
| full extension regression | **131 files / 2088 tests**, all pass |
| backend suite | **243 passed** |
| `npx tsc --noEmit` | PASS |
| `npm run build:extension` | PASS |
| `npm run build:frontend` | PASS |
| `git diff --check` | PASS |
| `proposeDestinationNavigation` still in `agentLoop.ts` | present (1 occurrence) |
| `results.html` anywhere in `extension/src` | absent |
| mutation residue after the run | none; all six mutated files byte-identical to their pre-run backups, backup directory removed |
| `dynamicReplanner.ts` `destination` references | none — a replanned subgoal cannot carry a declaration |
| `effectVerifier.ts` vs `b677654` | byte-identical; the already-satisfied logic lives in `agentLoop.ts:2049-2119`, not in the effect verifier |
