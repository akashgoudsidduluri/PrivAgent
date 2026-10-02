# STEP 10.2 — DESTINATION TRUST-BOUNDARY CLOSURE (G2 + G3 + G4)

HEAD throughout: `b677654`. Nothing was committed or pushed.

Evidence labels used in this note are exactly
`PROVEN_REAL`, `PROVEN_UNIT_ONLY`, `PARTIAL`, `NOT_REACHED`.

---

## 1. Baseline (Part 0) — before any change

| Check | Result |
|---|---|
| `git rev-parse --short HEAD` | `b677654` |
| Working tree | 24 modified tracked files + untracked `extension/src/planning/`, `extension/src/semanticObservation/`, `scratch/**`, `docs/evidence/**` — all pre-existing Step 5–10.1 work, none touched. |
| `tests/destinationPropagationAndAlreadySatisfied.test.ts` | **52 passed / 52** |
| `-t "D · W31/W32"` (G1 closure, Step 10.1) | **5 passed** — G1/M13 still closed, not reopened |
| Full extension regression | **131 files / 2093 tests passed** |
| Backend `pytest tests -q` | **243 passed** |
| `npx tsc --noEmit` | PASS |
| `npm run build:extension` / `build:frontend` | PASS / PASS |
| `git diff --check` | PASS |

Baseline manifest of all 283 `.ts`/`.py` source + test files was captured to
`scratch/.step102/baseline_manifest.md5` before any edit, and re-captured after,
so Part 9 is a byte-level proof rather than a claim.

---

## 2. G2 — model-facing destination propagation

### 2.1 What the production dataflow actually is (call-site evidence)

```
serviceWorker.ts:891   minimizeAgentContext(built, { task })
                      └─ contextMinimizer.ts:286  semantic_context forwarded WHOLESALE
                      └─ contextMinimizer.ts:336  modelView = buildModelFacingContext(...)
serviceWorker.ts:891   returns { context: minimized.payload, ... }
agentLoop.ts:1072      PlannerContextBuilder.buildContext(context, goal, activeSubgoal)
                      └─ plannerContextBuilder.ts:103  toDeclaredDestinationConstraint(...)
                      └─ plannerContextBuilder.ts:113  injects into semantic_context
agentLoop.ts:1078      context = builtPlannerCtx.contextPayload
agentLoop.ts:2860      provider.requestAction(task, context, this.state.previousActions)
modelRouter.ts:66      backendProvider.requestAction(task, context, ...)
backendAgentProvider.ts:135-156
                      destructure FOUR local-only fields, then
                      payload = { task, context: egressContext, history, model_role }
```

`modelView` is computed and **discarded** by every production caller
(`serviceWorker.ts:891` reads only `minimized.payload`; `popup.ts:127` does not
read it). Its only consumer is `openRouterProvider.ts:133`, which
`providerRegistry.ts:15` documents as DEV/TEST-ONLY and which is never
constructed by the shipped service worker (`serviceWorker.ts:1228` wires
`createAgentProvider({ provider: 'backend' })`).

**So the production backend path never touched `buildModelFacingContext` — the
declaration reached the backend correctly. G2 was a latent divergence, not a
live outage.** Real bytes confirming this were already captured by Step 10; they
are re-confirmed independently in §5 below.

### 2.2 The defect that was real

Two functions build a model-facing view of the same context:
`minimizeAgentContext` forwards `semantic_context` wholesale;
`buildModelFacingContext` projects it field by field. The allowlist omitted
`declaredDestination`, and **the type system could not object**, because the
field was not declared on `SanitizedSemanticContext` — it existed only behind an
`as AgentContextPayload['semantic_context']` cast at the single injection site.
A module that documents itself as "the ONE minimization code path every provider
uses" therefore disagreed with the function production actually uses.

### 2.3 The fix (smallest correct layer)

* `SanitizedSemanticContext.declaredDestination?: DeclaredDestinationConstraint`
  — declared as a **type reference**, not a copy, so this module gains no
  ownership and there is still exactly one definition of the constraint shape.
* `buildModelFacingContext` projects it. Because it is now read off the declared
  interface, omitting it is a type error rather than a silent semantic loss.
* The unchecked `as` cast in `plannerContextBuilder.ts` is **removed**.

No provider behaviour changed. `openRouterProvider.ts` is untouched, so its
prompt content is byte-identical.

---

## 3. G3 — entry URL vs destination URL

### 3.1 The contract (unchanged, Step 6)

* `entryUrl` — the site to START at. Provenance only. **Never read by the
  verifier** (`destinationVerifier.ts:305`).
* `destinationUrl` — an explicit URL the USER declared as the destination.
  Compared exactly on `origin` + `path` (`destinationVerifier.ts:260`).

### 3.2 The defect (reproduced before the fix)

`normalizeDestinations` blanked every URL out of the token stream and then, after
all constructs had been emitted, attached the URL to `out[firstRole]` — the
first declaration carrying a role — with no regard for which construct the URL
belonged to. Proven consequence:

```
"visit http://localhost:4174/product.html then open the catalog"
  → [ {DECLARED, role LISTING, entryUrl /product.html} ]

"open the catalog, then visit http://localhost:4174/product.html"
  → [ {DECLARED, role LISTING, entryUrl /product.html} ]      ← BYTE-IDENTICAL
```

The user explicitly named a destination URL **with their own verb**, and it was
silently demoted to the `entryUrl` of a different, unrelated declaration. An
explicit destination URL could only ever reach `destinationUrl` when no role
noun appeared anywhere in the task — which is exactly what the Step 10 capture
showed on the wire.

### 3.3 The fix

The **first** URL is replaced in the token stream by one `URL_PLACEHOLDER` token
instead of whitespace (later URLs keep the existing N1 single-URL channel
limitation, which is left intact and is asserted). That makes one fact readable
that blanking had destroyed: whether the URL is the direct complement of a
destination verb.

* `open <url>` / `visit <url>` / `navigate to <url>` → the URL is that
  construct's **`url`**, emitted in textual order.
* `open the catalog AT <url>` → the URL is that construct's **`entryUrl`**,
  attached exactly as before.

Both branches are decided from the user's own sentence. No URL shape is
inspected, so Step 6's pinned invariant *"the same literal splits two ways
depending only on whether a role noun governs the destination verb"* still
holds and is re-asserted (`G3-SPLIT`).

`destinationVerifier.ts` is **byte-identical to `b677654`**. Exact URL matching
was not touched.

---

## 4. G4 — backend provenance trust boundary

### 4.1 The defect

`semantic_context` is the **page-derived** context object, yet the reasoner
rendered `declaredDestination` whenever its `provenance` literal read
`USER_DECLARED_DESTINATION`. That literal is chosen by the client. So the one
field whose entire job is to say *"this came from the user, not from the page"*
was, structurally, a page-context field attesting to its own trustworthiness.

### 4.2 The fix — and what it deliberately is not

No new authentication, signing or cryptographic system was introduced. The
repository has no shared secret between the extension and this backend and never
claimed one; inventing a key would be a redesign, not a closure. What the
architecture does have is exactly **one** input the backend can independently
attest to: `task`, the user's own request text.

`backend/app/reasoner.py` now applies two gates before anything is rendered:

1. **Positional** — `_markers_outside_declared_slot()` walks `semantic_context`
   and `history`; the marker keys `declaredDestination` / `destinationUrl` /
   `entryUrl` may appear at exactly one position, `semantic_context["declaredDestination"]`.
   Anywhere else — inside an entity (targetEntity), an affordance, a sanitized
   display fact, the workflow, or a previous action — the whole declaration is
   dropped. The check is positional, so it does not need to guess which producer
   wrote a value.
2. **Attested** — `validate_declared_destination()` requires:
   * exactly the four allowed keys (an unknown key refuses the WHOLE object);
   * `provenance` exactly `USER_DECLARED_DESTINATION`;
   * `role` a bounded list drawn from the closed `SemanticPageType` vocabulary,
     minus `UNKNOWN` and `ERROR` (the two the verifier already refuses);
   * every claimed URL reduced to one normalised origin+path identity that
     occurs in the **user's own task text**, and free of query, fragment and
     credentials;
   * at least one destination channel;
   * the result is a **freshly built dict**, so the caller's object can never be
     aliased and rewritten after validation.

It can never CREATE a declaration: there is no code path that manufactures one,
infers a role from a URL or vice versa, or fills a missing field. Refusal is
always "render nothing", which is the fail-closed direction.

Containment in `task` is a **trust check, not a matching relaxation**. Nothing
here compares one declared URL against another, and no two destinations are ever
compared with one another. `verify_payload_invariants`, `models.py` and the
system prompt are all untouched.

---

## 5. Real runtime evidence (Part 6)

Real Chrome **153.0.8010.12**, real production `dist/` build, real fixture
`http://localhost:4174`, real dashboard `:5173`, real backend `:8010`, real
Groq model. Request bodies captured from the service worker via CDP `Network`.

### REAL-A — role-only reaches the production boundary, no fabricated URL

Task `open the store catalog`, browser sitting on `http://localhost:4174/`.
Actual bytes in `context.semantic_context`:

```json
{"provenance":"USER_DECLARED_DESTINATION","role":["LISTING"]}
```

`destinationUrl: null`, `entryUrl: null`. The live tab URL — which the user
never typed — is absent from the declaration. **`PROVEN_REAL`**
(`step10_2_real_A_role_only.json`)

### REAL-B — explicit destination URL reaches the boundary unchanged

Task `open http://localhost:4174/results.html`. Actual bytes:

```json
{"provenance":"USER_DECLARED_DESTINATION",
 "destinationUrl":"http://localhost:4174/results.html"}
```

`entryUrl: null`, `role: null`. **This is the G3 fix on the wire**: the user's
explicit destination URL lands in `destinationUrl`, not `entryUrl`. The backend
answered HTTP 200 with
`{"action":"navigate","url":"http://localhost:4174/results.html"}` — the real
model was told the destination and navigated to it exactly.
**`PROVEN_REAL`** (`step10_2_real_B_explicit_url.json`)

### REAL-C — entry and destination stay structurally distinct

Three real runs, three real wire objects, no overlap:

| Task | `declaredDestination` bytes |
|---|---|
| `open the store catalog` | `{"provenance":…,"role":["LISTING"]}` |
| `open http://localhost:4174/results.html` | `{"provenance":…,"destinationUrl":"http://localhost:4174/results.html"}` |
| `open the store catalog at http://localhost:4174/results.html` | `{"provenance":…,"role":["LISTING"],"entryUrl":"http://localhost:4174/results.html"}` |

**`PROVEN_REAL`**
(`step10_2_real_{A_role_only,B_explicit_url,C_entry_url,F_action_url}.json`)

### REAL-D — backend refuses forged / untrusted declarations

Two layers, both against the real backend code.

**Decisive layer** — the real FastAPI app, real routing, real Pydantic
validation, real `verify_payload_invariants`, real trust boundary, real prompt
builder; only the outbound provider call echoed so the rendered text is
directly observable:

| payload | rendered `declaredDestination` |
|---|---|
| valid role-only | `{"provenance":…,"role":["LISTING"]}` |
| valid explicit URL | `{"provenance":…,"destinationUrl":"http://localhost:4174/results.html"}` |
| missing provenance | `null` |
| unknown provenance | `null` |
| forged URL the user never typed | `null` |
| forged through an affordance | `null` |
| forged through a targetEntity | `null` |
| extra raw field (`reason`) | `null` |

**`PROVEN_REAL_BACKEND`** for the two positive rows and for all six negative
rows. **Not claimed**: a real LLM invocation — the invariant under test is
decided before the model is reached.

**Live-HTTP layer** — real socket against the running server on `:8010`, real
Groq:

* both valid declarations → **HTTP 200** (one returning the exact `navigate` to
  the declared URL). **`PROVEN_REAL_BACKEND`**
* the six forged declarations → **HTTP 503** `groq (rate_limit) and fallback
  openrouter (http_client_error)`. The model was never reached, so these carry
  **no live verdict**. **`NOT_REACHED` at this layer**; the verdict comes from
  the decisive layer above.

(`step10_2_real_D_backend_forgery.json`)

### REAL-E / REAL-F — observation and action URL cannot rewrite the declaration

Verified over the **raw captured request bodies** of four real runs — 17 real
requests, 5 real `declaredDestination` blocks, **0 violations**:

* every rendered block is byte-identical to the declaration derived from the
  user prompt alone;
* every URL inside a declaration is a URL the user typed;
* no observed `context.url` and no `history[].url` ever appeared inside a
  declaration.

Concretely: run A observed `http://localhost:4174/` (a URL the user never typed)
and the declaration still carried **no URL at all**. Run F carried
`history: [{"action":"navigate","url":"http://localhost:4174/search.html"}]`
while the declaration stayed exactly the prompt-derived one.
**`PROVEN_REAL`** (`step10_2_real_EF_no_rewrite.json`)

---

## 6. Mutation matrix (Part 5)

29 targeted mutants across the five production files, run against the Step 10.2
matrix plus every pre-existing destination suite.

**KILLED 29 · EQUIVALENT 0 · SURVIVED 0 · INVALID 0.**
All five mutated files restored byte-identical (`cmp -s` verified) and the
backup directory removed.

`G2-02` survived the first run — the entry-url→destination-url substitution
mutant only fires on a declaration that actually carries an `entryUrl`. Two
legitimate tests were added (`B6`, `B7`, the CASE C declaration through both
projections and through the production egress bytes) and the mutant was killed
on the re-run. Recorded here rather than quietly re-run, because a survivor is
exactly the case the process exists to catch.

---

## 7. Pre-existing P1 — unchanged, not fixed, not claimed

`backend/app/text_safety.py` is **byte-identical to the Part 0 baseline**
(`rule=person_name` at :197 and :231). It over-blocks model `reason` prose, and
`context.semantic_context.facts[].label` still carries page-derived display
labels. This produced the real HTTP 503s seen in REAL-A:

```
503  {"reason":"Reasoning unavailable: Model-emitted reason rejected by
      text-safety scan (rule=person_name)"}
```

and Groq free-tier rate limits. Both are **pre-existing and out of scope**.
No claim is made that either is fixed.

---

## 8. Out-of-scope observation (not a G2/G3/G4 defect)

In real runs the declaration appears on the **first** request(s) and is absent
from later ones, because `PlannerContextBuilder` reads
`activeSubgoal?.destination` and the destination subgoal completes after the
navigate. That is the already-recorded **G5** (per-subgoal scoping). It is not
regressed by any change in Step 10.2 and was deliberately left alone.