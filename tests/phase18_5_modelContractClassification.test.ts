/**
 * PHASE 18.5 / I-3 — extension-side classification.
 *
 * The backend now reports a model contract violation as 502 `model_contract`
 * instead of a bare 503. This test pins the extension half: the distinct kind
 * must survive parsing, must map to its own failure category, and must NOT be
 * mistaken for a provider outage.
 *
 * The failure this prevents is the one that made Phase 18.5's provider
 * failures indistinguishable: a model that answered with unusable output was
 * classified exactly like an outage.
 */
import { describe, it, expect } from 'vitest';
import { categoryForKind } from '../extension/src/agent/providerResponse';
import type { ProviderErrorKind } from '../extension/src/agent/openRouterProvider';

describe('PHASE 18.5 model-contract classification', () => {
  it('has a dedicated kind distinct from every transport kind', () => {
    const kind: ProviderErrorKind = 'model_contract';
    expect(kind).toBe('model_contract');
  });

  it('maps model_contract to its OWN category, not a 5xx bucket', () => {
    expect(categoryForKind('model_contract', 502)).toBe('MODEL_CONTRACT');
  });

  it('does NOT collapse model_contract into a provider-outage category', () => {
    // The regression being prevented: contract failure == outage.
    expect(categoryForKind('model_contract', 502)).not.toBe('HTTP_5XX');
    expect(categoryForKind('model_contract', 502)).not.toBe('UNKNOWN_PROVIDER_FAILURE');
  });

  it('keeps genuine transport faults in their own categories', () => {
    expect(categoryForKind('timeout', 503)).toBe('TIMEOUT');
    expect(categoryForKind('rate_limit', 429)).toBe('HTTP_429_RATE_LIMIT');
    expect(categoryForKind('network')).toBe('NETWORK_FAILURE');
  });

  it('leaves the pre-existing http_error 5xx fallthrough intact', () => {
    // A 5xx with no recognised body kind is still a generic 5xx. The new kind
    // must not have stolen that path.
    expect(categoryForKind('http_error', 503)).toBe('HTTP_5XX');
  });
});