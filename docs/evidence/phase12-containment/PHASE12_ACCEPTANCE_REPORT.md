# Phase 12 Evidence — Containment / Sandbox

All numbers come from commands actually executed in this repository.

| Item | Command | Result |
| --- | --- | --- |
| Phase 12 focused tests | `npx vitest run tests/phase12/` | **1 file / 43 tests passed** |
| Full regression suite | `npx vitest run` | **93 files / 955 tests passed** (115.78 s) |
| TypeScript | `npx tsc -b --noEmit` | **0 new errors** (5 pre-existing, see §6) |
| Extension build | `npm run build:extension` | **exit 0** — `dist/contentScript.js` 108.41 kB |
| Real Chrome containment | `node scratch/verify_phase12_containment.mjs` | **7 / 7 checks PASS** |

Regression baseline before this phase: **92 files / 907 tests**. Delta: **+1 file
/ +48 tests**, all Phase 12. No pre-existing test was modified or removed.

---

## 1. The containment boundary

PrivAgent was already pinned to a single **target tab** (`targetTabId`, wired in
`d1fbf5c`). It was **not** pinned to the **origin** that tab may occupy.

A `navigate` action, an HTTP redirect, or a page-driven jump could move the
pinned tab onto any site — and the agent would then perceive and act on a page
the user never authorised. That is the blast radius.

**Phase 12 adds an origin-scoped environmental boundary:**

```
scope = rootHost of the origin the task actually resolved
        + the single contained tab id
```

Subdomains of the root host are inside the scope (a user who asked for
"google" authorised `www.google.com` and `accounts.google.com`); every other
host is outside it.

Containment is evaluated at **two** points:

1. **In the AgentLoop, immediately before dispatch** — after Grounding, M5, the
   Security Critic, the Privacy Firewall and Risk/Confirmation have all already
   approved the action.
2. **In the service worker, at the dispatch boundary** — re-checked against the
   **live** tab state, plus a post-navigation landing check.

A denial is **terminal**: the task fails closed rather than handing the refused
action to the Recovery Engine, because retrying into an environment containment
has denied *is* the blast radius.

### The architectural distinction, preserved

> **M5 controls WHETHER an action is allowed.**
> **Containment controls WHERE the agent is allowed to act.**

Containment is strictly additive and can only ever **refuse more**. It never
authorizes, never relaxes, and never reorders any gate. `REASONING ≠ AUTHORITY`
is unchanged: the reasoner proposes; the local pipeline plus this boundary
decide what actually happens.

---

## 2. What IS contained

| Surface | Containment behaviour |
| --- | --- |
| `navigate` to a different site | **DENIED** — `CROSS_ORIGIN_NAVIGATION_DENIED` |
| Target tab redirected / page-jumped off-scope | **DENIED** — `SCOPE_DRIFT_DETECTED` |
| Action addressed to a tab other than the contained one | **DENIED** — `TAB_SCOPE_VIOLATION` |
| `navigate` to `javascript:`, `data:`, `file:`, `chrome:` | **DENIED** — `UNSUPPORTED_SCHEME_DENIED` |
| Post-navigation landing outside the scope | **REFUSED** — task does not continue there |
| Target with no containable origin (incl. the dashboard) | Scope cannot be established; the service worker **refuses to start the task** |
| In-scope actions (click / type / select / scroll / pressKey) | **ALLOWED** — `WITHIN_SCOPE` |

## 3. What is deliberately NOT contained

* **Action authorization.** Containment does not decide whether an action is
  well-formed (M5), safe (Security Critic), permitted for its data class
  (Privacy Firewall), or consequential (Risk/Confirmation).
* **In-scope risk.** If a site the user *did* authorise hosts destructive or
  exfiltrating content, containment does not stop the agent acting there — M5,
  the Security Critic and Risk/Confirmation are what stop that.
* **Process / device state.** No OS, filesystem, or network isolation. This is
  a browser-environment boundary, not a VM, container or sandbox escape.
* **Content on the permitted site.** A malicious page inside the scope is still
  handled by the injection firewall and the Security Critic, not by containment.
* **Multi-site tasks.** A task that legitimately spans two sites needs the
  second site resolved as its own target; containment will not let it wander
  there on its own.
* **Timing / volume.** Step, retry and long-horizon bounds remain owned by the
  existing loop, not by containment.

## 4. Files changed

| File | Change |
| --- | --- |
| `extension/src/agent/containment.ts` | **New.** The containment module: scope establishment, decision function, navigation verification, value-free reporting. Pure and deterministic. |
| `extension/src/agent/agentLoop.ts` | Containment evaluated immediately before dispatch; terminal denial recorded as `CONTAINMENT_DENIED`; `containmentScope` option; `containmentDecision` recorded on task state. |
| `extension/src/agent/agentState.ts` | `FailureCategory` gains `CONTAINMENT_DENIED`; `TaskState.containmentDecision` added. |
| `extension/src/background/serviceWorker.ts` | Establishes the scope; **fails closed at task start** if none can be established; re-checks containment at the dispatch boundary; verifies post-navigation landing. |
| `tests/phase12/containment.test.ts` | **New.** 43 focused tests. |
| `scratch/verify_phase12_containment.mjs` | **New.** Real-Chrome containment harness. |

No existing security module was modified, refactored or reordered.

---

## 5. Tests actually run

### 5.1 Focused Phase 12 tests — 43 / 43 PASS

* Scope establishment (6) — determinism, non-web refusal, malformed refusal,
  dashboard refusal, root-host derivation.
* Primitives (5) — subdomain containment, out-of-scope hosts, missing input,
  scheme check, dashboard detection.
* Blast radius (12) — in-scope allow, in-site navigate, cross-origin deny,
  unestablished scope, tab violation, drift, uncontainable scheme, malformed
  input, forged dashboard scope, `about:blank`, determinism.
* Across-navigation (4) — landing in/out of scope, non-web landing, no scope.
* Value-free reporting (3) — no URL or query in reasons, stable audit line,
  root-host-only summary.
* AgentLoop integration (7) — gate ordering, drift denial, terminal denial,
  no-scope host, in-scope work still runs, SW start guard, no raw values.
* **Invariants (7)** — M5 still refuses an off-allowlist key even though
  containment allows it; grounding still rejects an ungrounded target; the
  Security Critic still BLOCKS an out-of-goal destructive control *inside* the
  scope; the Privacy Firewall still governs sensitive controls; risk still
  scores in-scope actions; and containment never authorizes something the
  pipeline refused.

### 5.2 Regression — 93 files / 955 tests PASS

Full suite green, including all prior-phase suites (Phase 8 critic, Phase 9
long-horizon, Phase 10 recovery, Phase 11 interaction, target-tab provisioning).

### 5.3 Real Chrome — 7 / 7 PASS

Real Chromium over CDP, the **real** content script executing in a **real** tab,
with the dashboard opened first and the target tab provisioned separately.

| Check | Recorded result |
| --- | --- |
| Dashboard isolation | dashboard tab and target tab are distinct ids |
| Content script attached | real scan report produced; detections read back |
| Scope established | `rootHost = localhost` from the live URL |
| In-scope click really executes | `contained=true`, `executed=true`, page marker changed, `window.__clicks = 1` |
| Cross-origin navigation | `contained=false`, `CROSS_ORIGIN_NAVIGATION_DENIED`, not dispatched |
| Off-scope tab | `contained=false`, `SCOPE_DRIFT_DETECTED` |
| `javascript:` navigation | `contained=false`, `UNSUPPORTED_SCHEME_DENIED` |
| Gate ordering | off-site navigate → Security Critic `BLOCK / SUSPICIOUS_NAVIGATION` **before** containment |
| Environment held | final URL still inside scope; landing verification `contained` |

Machine-readable: `phase12_containment_evidence.json` · Screenshot:
`phase12_final_state.png`.

---

## 6. Remaining limitations

1. **5 pre-existing TypeScript errors** in `extension/src/background/targetResolver.ts`
   (introduced by `d1fbf5c`, present on `main` before this phase). Confirmed by
   stashing this phase's work: `npx tsc -b --noEmit` fails identically on a
   clean tree. **Phase 12 adds zero new type errors.** Left unfixed as
   out-of-scope.
2. **Host owns the scope.** The AgentLoop enforces the scope it is given. The
   service worker — the real browser host — always establishes one and refuses
   to start a task when it cannot, so the product path is fail-closed. A host
   with no tab of its own (in-process harness) passes no scope and claims no
   boundary, which the state records as `containmentDecision: null`.
3. **Root-host heuristic.** `deriveRootHost` uses the last two hostname labels.
   Correct for `example.com` / `a.b.example.com`, but **wrong for multi-part
   public suffixes** — `a.b.example.co.uk` derives `co.uk`, which would over-
   widen the scope. A production deployment should use the Public Suffix List.
   Not fixed here because it is a pre-existing pattern in the tab resolver and
   the spec did not require it.
4. **Same-site is trusted.** Cross-**origin** is denied; a different site on the
   same registrable host is inside the scope. This matches the subdomain
   reasoning the tab resolver already relies on.
5. **Backend (pytest) suite not runnable** here — `No module named pytest`. No
   backend code was changed by this phase.
6. **Headless Chrome** (`--headless=new`), matching the repo's established
   Phase 9/10/11 harnesses; there is no display in this environment.
