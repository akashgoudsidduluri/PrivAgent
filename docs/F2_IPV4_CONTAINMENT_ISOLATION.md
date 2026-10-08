# F2 — IPv4 Containment Root-Host Isolation

**Status: CLOSED (2026-10-08).** Containment scope now preserves IPv4/IPv6 host
identity exactly. Confirmed as a security defect, reproduced first, fixed in the
responsible abstraction, verified by 17 focused tests, the existing security
suites, and a real-Chrome run.

* Implementation: `extension/src/agent/containment.ts`
  (`isIpLiteralHost`, `deriveRootHost`, `hostWithinScope`).
* Tests: `tests/phase18_8_f2Ipv4ContainmentIsolation.test.ts` (17 tests).

---

## 1. Root cause

Two lines of one abstraction, both treating a dotted quad as a DNS name:

```ts
// deriveRootHost — “keep the last two labels”
const labels = host.split('.').filter(Boolean);   // '127.0.0.1' → ['127','0','1']
return labels.slice(-2).join('.');                // → '0.1'

// hostWithinScope — suffix containment for registrable domains
return h === r || h.endsWith('.' + r);            // '10.0.0.1'.endsWith('.0.1') → true
```

The first half is a **registrable-domain** rule (`accounts.google.com →
google.com`) applied to a host class that has no registrable hierarchy. The
second half then re-applies the DNS suffix rule to whatever root came out, so
the damaged root *propagates into containment decisions*: every `*.0.1` address
was inside the scope of `127.0.0.1`.

```ts
deriveRootHost('http://127.0.0.1:4174/') === '0.1'          // reported
hostWithinScope('10.0.0.1', '0.1')       === true           // reported
```

## 2. Vulnerable behaviour (before)

A task scoped to one IPv4 literal contained other IP literals:

| scope of | wrongly contained |
|---|---|
| `127.0.0.1` | `10.0.0.1`, `192.168.0.1`, `8.8.8.8`, any `*.0.1` |
| `10.0.0.1` | `10.0.0.2` (root `0.1`), `172.16.0.1` |
| `8.8.8.8` | `1.1.1.1` (root `8.8`) |

and, from the DNS side of the same rule, a DNS-shaped root could capture an IP
host (`hostWithinScope('10.0.0.1', '0.1') === true`) while an IP root could
capture a crafted DNS host (`evil.127.0.0.1` under root `127.0.0.1`).

## 3. Corrected behaviour (after)

The host **class** is decided in exactly one place, `isIpLiteralHost`, and both
functions use it:

* `deriveRootHost` — an IP literal (IPv4 dotted quad with octets ≤ 255, or any
  colon-bearing / bracketed IPv6 literal) is returned **as-is**: its identity is
  its scope. DNS names keep the existing last-two-labels rule unchanged.
* `hostWithinScope` — if **either** side is an IP literal, containment is
  **exact equality only**; the DNS suffix rule applies only to DNS/DNS pairs.

```ts
deriveRootHost('http://127.0.0.1:4174/') === '127.0.0.1'
hostWithinScope('10.0.0.1', '0.1')       === false
hostWithinScope('evil.127.0.0.1', '127.0.0.1') === false
```

This only ever **removes** matches — it cannot broaden containment.

## 4. The containment invariant

```text
hostWithinScope(A, scope(A)) === true          for every host A
hostWithinScope(B, scope(A)) === false         for every distinct B that must not share A's scope
```

Verified for: `127.0.0.1` vs `10.0.0.1`, `127.0.0.1` vs `192.168.0.1`,
`10.0.0.1` vs `10.0.0.2`, `192.168.0.1` vs `192.168.1.1`, `8.8.8.8` vs
`1.1.1.1`, `127.0.0.1` vs `172.16.0.1`, `8.8.8.8` vs `8.8.8.9`, private ranges
against each other — in **both** directions, plus same-literal containment
(still `true`).

## 5. What was deliberately NOT changed (PART 3/4)

* No allowlist, no exclusion of IPv4 from containment, no localhost bypass, no
  `127.0.0.1` special case, no change to the security authority's role.
* DNS hostname and subdomain containment are byte-for-byte the same rule
  (`google.com`/`accounts.google.com`/`evil-google.com`/`google.com.evil.test`,
  `www.` handling, `localhost`, `*.localhost`).
* Ports and schemes: same host on different ports still shares one scope
  (`127.0.0.1:4174` and `127.0.0.1:4175`), and the dashboard origin is still
  refused.
* IPv6: `[::1]`, `[fe80::1]` and `[0:0:0:0:0:0:0:1]` each remain their own
  scope, equal to the parsed hostname (canonicalization not regressed).
* Malformed / non-http(s) input still fails closed (`null`, `false`).

## 6. Tests and regression

| Check | Command | Result |
|---|---|---|
| F2 focused matrix | `npx vitest run tests/phase18_8_f2Ipv4ContainmentIsolation.test.ts` | **17/17** (9 failed before the fix) |
| Existing security/containment/target/privacy/navigation suites | `npx vitest run security boundary privacy target navigat containment harness stale origin` | **34 files / 658 tests** |
| Full suite | `npx vitest run --reporter=dot` | **174 files / 3005 tests** |
| TypeScript | `npx tsc -b --noEmit` | exit 0 |
| Extension build | `npm run build:extension` | built |
| Frontend build | `npm run build:frontend` | exit 0 |
| Backend | `backend/.venv/bin/python -m pytest tests/ -q` | 670 passed |
| A10 regression | `npx vite-node scratch/a10_matrix_grade.ts [--require-pass]` | 3 PASS / 7 FAIL, privacy clean, exit 1 (unchanged — no verdict gained by this fix) |

## 7. Real-browser evidence

`PROVEN_REAL_CHROME / CONTROLLED_PROVIDER (stub_mode=act_then_answer)` — §14 row S4
re-executed in real Chrome on the rebuilt extension against the IP-literal fixture:

```
[AgentTrace] containment scope established {"established":true,"rootHost":"127.0.0.1","tabId":1105116876}
[AgentTrace] containment decision {"code":"WITHIN_SCOPE","contained":true,"scope":"contained:127.0.0.1"}
```

The same run previously recorded `rootHost: "0.1"`. Privacy stayed clean
(`rawValueFindings: 0`), and the corrected label still passes the output screen,
so F1's fix is unaffected. No live-provider claim is made: the controlled stub
owns `:8010`.

## 8. Scope boundaries

* **A10 is unchanged and still NOT CERTIFIED** — F2 fixing changed no verdict
  (`3 PASS / 7 FAIL`, `--require-pass` exits 1).
* **I-5 is not reopened**: this is containment, not the information-success
  contract; the contract doc's reference to F2 as "unfixed" is corrected to
  point here.
* The remaining A10 blockers (live-provider rows, citation-gate rows) are
  unaffected by this change.
