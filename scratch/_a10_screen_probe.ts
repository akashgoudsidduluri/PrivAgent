/**
 * A10 probe — WHAT trips the output screen's structural check?
 *
 * Phase 18.6/A10 recorded real-Chrome runs whose terminal projection was dropped
 * wholesale. With the F1 diagnostic in place, the run's own trace now names the
 * field:
 *
 *   [AgentTrace] output screen {"verdict":"BLOCKED","audit":"OUTPUT_SCREEN_BLOCKED (1 finding(s))",
 *     ...,"structuralViolations":[{"field":"artifacts[0]","rule":"credential_token"}]}
 *
 * `artifacts[0]` is the CONTAINMENT artifact, whose label is
 * `${containmentDecision.code}:${containmentDecision.scope}` and whose scope for a
 * local IP fixture is `contained:0.1` (the F2 root-host collapse). This probe asks
 * the same scanner the same question `structureIsClean` asks, about that exact
 * label and its neighbours, so the cause is pinned to a string rather than inferred.
 *
 * Run with `npx vite-node scratch/_a10_screen_probe.ts`.
 */
import { scanForRawSensitiveValues } from '../extension/src/privacy/rawValueScanner';

const candidates: Array<[string, string]> = [
  ['observed artifact label', 'CONTAINMENT:WITHIN_SCOPE:contained:0.1'],
  ['scope without prefix', 'contained:0.1'],
  ['scope value alone', 'WITHIN_SCOPE:contained:0.1'],
  ['same shape, URL scope', 'CONTAINMENT:WITHIN_SCOPE:http://127.0.0.1:4174'],
  ['other decision codes', 'CONTAINMENT:CROSS_ORIGIN_NAVIGATION_DENIED:contained:0.1'],
  ['other artifacts', 'HARNESS:6 cycle(s), 0 halt(s)'],
  ['other artifacts', 'RECOVERY:2 attempt(s)'],
  ['other artifacts', 'FAILURE:ACTION_NO_EFFECT'],
  ['other artifacts', 'PERCEPTION:9 cycle(s)'],
  ['timeline entry', 'scroll:EXECUTED'],
  ['timeline entry', 'scroll:FAILED'],
];

for (const [kind, value] of candidates) {
  const strict = scanForRawSensitiveValues(value, { structuralKeys: new Set() });
  const structural = scanForRawSensitiveValues(value);
  console.log(
    `${strict.length ? 'TRIPS ' : 'clean '} full-rules  ${kind.padEnd(22)} ${JSON.stringify(value).padEnd(52)} ${JSON.stringify(strict)}`,
  );
  if (strict.length !== structural.length) {
    console.log(`         (with the product's STRUCTURAL_VALUE_KEYS: ${JSON.stringify(structural)})`);
  }
}
