/**
 * PHASE 18.8 / F2 — IPv4 (and IPv6) CONTAINMENT SCOPE ISOLATION.
 *
 * THE DEFECT, exactly as reported
 *   `deriveRootHost('http://127.0.0.1:4174/')` returned `0.1`, because it splits
 *   the host on '.' and keeps the LAST TWO labels — a rule that is correct for a
 *   DNS registrable domain and wrong for an IP literal, which has no registrable
 *   hierarchy: its identity IS its scope.
 *
 *   With that root, the second half of the defect appears in the containment
 *   predicate: `hostWithinScope('10.0.0.1', '0.1')` is `true`, because the suffix
 *   test treats a dotted quad as though it were a DNS name. So a task scoped to
 *   `127.0.0.1` would contain `10.0.0.1` — two distinct origins sharing one
 *   containment scope.
 *
 * THE INVARIANT THIS FILE PINS
 *   For any two hosts that must not share containment:
 *       hostWithinScope(A, scope(A)) === true
 *       hostWithinScope(B, scope(A)) === false
 *   and the two host CLASSES never mix: an IP literal has EXACT identity, a DNS
 *   name has hierarchical suffix containment, and neither is matched by the
 *   other's rule.
 *
 * WHAT MUST NOT CHANGE (PART 3/4)
 *   DNS hostname containment, subdomain containment, `localhost`, ports,
 *   scheme parsing, and the fail-closed behaviour on malformed input. No
 *   allowlist, no bypass, no IP exempted from containment: the fix narrows the
 *   containment calculation, it never widens it.
 */
import { describe, it, expect } from 'vitest';

import {
  deriveRootHost,
  establishContainmentScope,
  hostWithinScope,
} from '../extension/src/agent/containment';

/** Scope root for a URL, as the containment authority derives it. */
function scopeOf(url: string): string | null {
  return deriveRootHost(url);
}

const HOST_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['127.0.0.1', '10.0.0.1'],
  ['127.0.0.1', '192.168.0.1'],
  ['10.0.0.1', '10.0.0.2'],
  ['192.168.0.1', '192.168.1.1'],
  ['8.8.8.8', '1.1.1.1'],
  ['127.0.0.1', '172.16.0.1'],
  ['8.8.8.8', '8.8.8.9'],
  ['10.0.0.1', '192.168.0.1'],
];

const urlFor = (host: string): string => `http://${host}:4174/app`;

describe('F2 — IPv4 root-host identity', () => {
  it('1. 127.0.0.1 → root host 127.0.0.1', () => {
    expect(scopeOf(urlFor('127.0.0.1'))).toBe('127.0.0.1');
  });

  it('2. 10.0.0.1 → root host 10.0.0.1', () => {
    expect(scopeOf(urlFor('10.0.0.1'))).toBe('10.0.0.1');
  });

  it('3. 192.168.0.1 → root host 192.168.0.1', () => {
    expect(scopeOf(urlFor('192.168.0.1'))).toBe('192.168.0.1');
  });

  it('4. 8.8.8.8 → root host 8.8.8.8', () => {
    expect(scopeOf(urlFor('8.8.8.8'))).toBe('8.8.8.8');
  });

  it('5. distinct IPv4 literals never share a containment scope', () => {
    for (const [a, b] of HOST_PAIRS) {
      const rootA = scopeOf(urlFor(a));
      expect(rootA, a).toBeTruthy();
      expect(hostWithinScope(b, rootA), `${b} in scope(${a})`).toBe(false);
      // …and symmetrically, so neither direction can slip through.
      const rootB = scopeOf(urlFor(b));
      expect(hostWithinScope(a, rootB), `${a} in scope(${b})`).toBe(false);
    }
  });

  it('6. the SAME IPv4 literal does share its scope', () => {
    for (const [a] of HOST_PAIRS) {
      const rootA = scopeOf(urlFor(a));
      expect(hostWithinScope(a, rootA), `scope(${a}) must contain ${a}`).toBe(true);
    }
  });

  it('7. adjacent IPv4 addresses remain distinct (the original repro)', () => {
    // hostWithinScope('10.0.0.1', '0.1') was TRUE before the fix.
    expect(hostWithinScope('10.0.0.1', '0.1')).toBe(false);
    expect(hostWithinScope('10.0.0.2', scopeOf(urlFor('10.0.0.1')))).toBe(false);
    expect(hostWithinScope('8.8.8.9', scopeOf(urlFor('8.8.8.8')))).toBe(false);
  });

  it('8. distinct PRIVATE ranges stay distinct', () => {
    for (const [a, b] of [
      ['10.0.0.1', '172.16.0.1'],
      ['192.168.0.1', '192.168.0.10'],
      ['172.16.0.1', '172.17.0.1'],
    ] as ReadonlyArray<readonly [string, string]>) {
      expect(hostWithinScope(b, scopeOf(urlFor(a))), `${b} in scope(${a})`).toBe(false);
      expect(hostWithinScope(a, scopeOf(urlFor(b))), `${a} in scope(${b})`).toBe(false);
    }
  });

  it('14. different hosts never become the same scope through normalization', () => {
    const hosts = Array.from(new Set(HOST_PAIRS.flatMap(([a, b]) => [a, b])));
    const roots = hosts.map((h) => scopeOf(urlFor(h)));
    // One distinct host ⇒ one distinct root; normalization never merges two.
    expect(roots.every((r) => r !== null)).toBe(true);
    expect(new Set(roots).size).toBe(hosts.length);
    expect(hosts.length).toBeGreaterThanOrEqual(8);
  });
});

describe('F2 — DNS hostname containment is unchanged', () => {
  it('9. hostname containment behaves exactly as before', () => {
    expect(hostWithinScope('google.com', 'google.com')).toBe(true);
    expect(hostWithinScope('accounts.google.com', 'google.com')).toBe(true);
    expect(hostWithinScope('example.com', 'google.com')).toBe(false);
    expect(hostWithinScope('evil-google.com', 'google.com')).toBe(false);
    expect(hostWithinScope('google.com.evil.test', 'google.com')).toBe(false);
    expect(scopeOf('https://accounts.google.com/signin')).toBe('google.com');
    expect(scopeOf('https://a.b.c.example.co.uk/x')).toBe('co.uk');
    expect(scopeOf('https://www.flipkart.com/')).toBe('flipkart.com');
  });

  it('10. subdomain containment behaves exactly as before', () => {
    expect(hostWithinScope('www.example.com', 'example.com')).toBe(true);
    expect(hostWithinScope('a.b.example.com', 'example.com')).toBe(true);
    expect(hostWithinScope('example.com.evil.com', 'example.com')).toBe(false);
    expect(hostWithinScope('evil-localhost.example.com', 'localhost')).toBe(false);
  });

  it('localhost keeps its single-label semantics', () => {
    expect(scopeOf('http://localhost:4191/')).toBe('localhost');
    expect(hostWithinScope('localhost', 'localhost')).toBe(true);
    expect(hostWithinScope('sub.localhost', 'localhost')).toBe(true);
  });
});

describe('F2 — IPv6 literal containment', () => {
  it('11. an IPv6 literal is its own scope, exactly like IPv4', () => {
    const root = scopeOf('http://[::1]:4174/app');
    expect(root).toBeTruthy();
    // Whatever the engine reports as the hostname, identity must hold…
    expect(hostWithinScope(new URL('http://[::1]:4174/app').hostname, root)).toBe(true);
    // …and another IPv6 literal must not share it.
    const other = new URL('http://[::2]:4174/app').hostname;
    expect(hostWithinScope(other, root)).toBe(false);
    expect(hostWithinScope(new URL('http://[fe80::1]/').hostname, root)).toBe(false);
  });

  it('12. IPv6 canonicalization does not regress', () => {
    // The URL parser canonicalizes; the derived root must equal the parsed host.
    for (const url of ['http://[FE80::1]/', 'http://[::1]/', 'http://[0:0:0:0:0:0:0:1]/']) {
      const root = deriveRootHost(url);
      expect(root, url).toBe(new URL(url).hostname);
    }
  });
});

describe('F2 — origins, ports and malformed input', () => {
  it('13. same host with different ports keeps one scope', () => {
    const a = establishContainmentScope({ targetUrl: 'http://127.0.0.1:4174/', targetTabId: 1 });
    const b = establishContainmentScope({ targetUrl: 'http://127.0.0.1:4175/', targetTabId: 1 });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b!.rootHost).toBe(a!.rootHost);
    expect(hostWithinScope('127.0.0.1', a!.rootHost)).toBe(true);
    // The dashboard origin is still refused.
    expect(establishContainmentScope({ targetUrl: 'http://127.0.0.1:5173/app', targetTabId: 1 })).toBeNull();
  });

  it('15. malformed input fails safely', () => {
    expect(deriveRootHost(null)).toBeNull();
    expect(deriveRootHost(undefined)).toBeNull();
    expect(deriveRootHost('')).toBeNull();
    expect(deriveRootHost('   ')).toBeNull();
    expect(deriveRootHost('not a url')).toBeNull();
    expect(deriveRootHost('javascript:alert(1)')).toBeNull();
    expect(deriveRootHost('file:///etc/passwd')).toBeNull();
    expect(hostWithinScope(null, 'example.com')).toBe(false);
    expect(hostWithinScope('127.0.0.1', null)).toBe(false);
    expect(hostWithinScope('', 'example.com')).toBe(false);
    expect(establishContainmentScope({ targetUrl: 'javascript:alert(1)', targetTabId: 1 })).toBeNull();
  });

  it('16. containment is never broadened — the two host classes never mix', () => {
    // A DNS root must not capture an IP host (the second half of F2: a
    // DNS-shaped root `0.1` used to capture `10.0.0.1`).
    expect(hostWithinScope('10.0.0.1', '0.1')).toBe(false);
    expect(hostWithinScope('10.0.0.1', 'example.com')).toBe(false);
    expect(hostWithinScope('127.0.0.1', 'google.com')).toBe(false);
    // …and an IP root must not capture a DNS host.
    expect(hostWithinScope('evil.127.0.0.1', '127.0.0.1')).toBe(false);
    expect(hostWithinScope('127.0.0.1.example.com', '127.0.0.1')).toBe(false);
    // An unrelated IP is out of a DNS scope even when its tail matches a label.
    expect(hostWithinScope('8.8.8.8', '8.8')).toBe(false);
  });
});
