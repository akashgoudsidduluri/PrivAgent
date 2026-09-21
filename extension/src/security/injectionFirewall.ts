import { ProvenanceData, TrustClass } from './types';

const INJECTION_SIGNATURES = [
  /ignore (?:all )?previous instructions/i,
  /reveal (?:your )?(?:system )?prompt/i,
  /send this information/i,
  /use this password/i,
  /upload this file/i,
  /navigate to/i,
  /disable security/i,
  /remember this secret/i,
  /use this hidden instruction/i,
  /disregard its earlier constraints/i,
  /system instruction:/i,
  /new rule:/i
];

/**
 * Scans web content for prompt injection signatures.
 * If detected, the content is quarantined (marked as HOSTILE).
 * Otherwise, it remains WEBPAGE (which is still UNTRUSTED).
 *
 * IMPORTANT: We do not delete the content. We merely classify it
 * so it remains separated from trusted agent instructions.
 */
export function classifyWebContent(text: string): ProvenanceData<string> {
  let trustLevel: TrustClass = 'UNTRUSTED'; // Default for all web content

  for (const sig of INJECTION_SIGNATURES) {
    if (sig.test(text)) {
      trustLevel = 'HOSTILE';
      break;
    }
  }

  return {
    value: text,
    source: 'WEBPAGE',
    trustLevel
  };
}
