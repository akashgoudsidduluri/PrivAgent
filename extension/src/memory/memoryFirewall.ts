/**
 * PrivAgent — Memory Firewall (Phase 5)
 * A dedicated write boundary that uses M8 to scan and reject unsafe memory candidates.
 */

import { assertNoRawSensitiveValues } from '../privacy/rawValueScanner';
import { AnyMemoryRecord, MemoryTrustLevel } from './memoryTypes';

export class MemoryFirewall {
  /**
   * Scans a memory candidate through the M8 privacy firewall and structural policies.
   * Fails closed by throwing an error if the candidate is unsafe.
   */
  public static assertSafeToWrite(candidate: AnyMemoryRecord): void {
    // 1. Structural Policy: Webpage content cannot become trusted memory
    if (candidate.provenance.source === 'WEBPAGE') {
      if (candidate.trustLevel < MemoryTrustLevel.LOW_CONFIDENCE_MEMORY) {
        throw new Error(`[MemoryFirewall] Prompt Injection Defense: WEBPAGE source cannot have trust level higher than LOW_CONFIDENCE_MEMORY.`);
      }
      if (candidate.class === 'SEMANTIC') {
        const sem = candidate as any;
        if (sem.type === 'USER_PREFERENCE' || sem.type === 'VERIFIED_FACT') {
          throw new Error(`[MemoryFirewall] Prompt Injection Defense: WEBPAGE source cannot create USER_PREFERENCE or VERIFIED_FACT.`);
        }
      }
    }

    // 2. Structural Policy: Remote models cannot directly write trusted memory
    if (candidate.provenance.source === 'REMOTE_MODEL') {
      if (candidate.trustLevel < MemoryTrustLevel.HIGH_CONFIDENCE_MEMORY) {
        throw new Error(`[MemoryFirewall] Structural Defense: REMOTE_MODEL source cannot have trust level higher than HIGH_CONFIDENCE_MEMORY.`);
      }
    }

    // 3. User Preferences must explicitly originate from USER
    if (candidate.class === 'SEMANTIC' && (candidate as any).type === 'USER_PREFERENCE') {
      if (candidate.provenance.source !== 'USER') {
        throw new Error(`[MemoryFirewall] Structural Defense: USER_PREFERENCE must originate from USER, got ${candidate.provenance.source}.`);
      }
    }

    // 4. M8 Privacy Firewall (Raw Value Scan)
    // Ensures no passwords, OTPs, CVVs, tokens, or PII-shaped values enter memory.
    try {
      assertNoRawSensitiveValues(candidate, {
        // We override structural keys to ensure we don't accidentally skip value scanning for memory keys
        extraStructuralKeys: ['id', 'goalId', 'subgoalId', 'origin', 'siteKey', 'taskType', 'key']
      });
    } catch (e) {
      throw new Error(`[MemoryFirewall] Rejected by M8 Privacy Firewall: ${(e as Error).message}`);
    }

    // 5. Explicitly deny stringified Javascript or obvious executable payloads in values
    const serialized = JSON.stringify(candidate);
    if (
      serialized.includes('javascript:') || 
      serialized.includes('eval(') || 
      serialized.includes('Function(') ||
      serialized.includes('<script>')
    ) {
      throw new Error(`[MemoryFirewall] Rejected: Memory must not contain executable content.`);
    }
  }
}
