/**
 * PrivAgent — Capability-Based Privacy Policy (Milestone 5.4)
 *
 * Enforces local privacy policy governance over browser agent reasoning and actions.
 *
 * Core Principle:
 *   "The user is allowed to see their account number ≠ the remote LLM needs to see their account number."
 *
 * Capabilities:
 *  - LOCATE: Identify coordinate / element ID for an entity
 *  - CLICK: Trigger click on element
 *  - SCROLL: Scroll viewport
 *  - TYPE: Input non-sensitive text
 *  - SELECT: Select dropdown option
 *  - READ_METADATA: Inspect safe metadata (id, type, bbox, confidence, source)
 *  - READ_SENSITIVE_VALUE: Read raw unmasked string (e.g. account number, password)
 *  - DISCLOSE_TO_USER: Render raw value in the local user UI on-device
 *  - TRANSMIT_EXTERNALLY: Send data to remote LLMs or remote APIs
 *
 * Security Invariants:
 *  1. Remote/local LLM is strictly prohibited from receiving sensitive values.
 *  2. Remote/local LLM is NEVER granted READ_SENSITIVE_VALUE or TRANSMIT_EXTERNALLY.
 *  3. Local execution/privacy layer may access protected values only when an explicit
 *     user-authorized capability and local policy permits it (e.g. unredact to user).
 *  4. DISCLOSE_TO_USER is strictly local-only and never transmitted externally.
 *  5. LLM can NEVER override this local policy.
 */

import { SensitiveEntityType, isSensitiveEntityType, AgentContextPayload, AgentDetection } from '../privacy/types';
import { PrivacyBoundaryError, scanForRawSensitiveValues } from '../privacy/rawValueScanner';
import { BrowserAction } from './actionTypes';

export type Capability =
  | 'LOCATE'
  | 'CLICK'
  | 'SCROLL'
  | 'TYPE'
  | 'SELECT'
  | 'READ_METADATA'
  | 'READ_SENSITIVE_VALUE'
  | 'DISCLOSE_TO_USER'
  | 'TRANSMIT_EXTERNALLY';

export type CallerRole = 'agent_llm' | 'local_user';

export interface PolicyDecision {
  granted: boolean;
  reason: string;
}

// Entity classification
const HIGH_RISK_ENTITIES = new Set<SensitiveEntityType>([
  'password',
  'credit_card',
  'account_number',
  'cvv',
  'pan',
  'otp',
]);

/**
 * Evaluates whether a caller role can exercise a capability on a sensitive entity type.
 */
export function checkCapability(
  entityType: SensitiveEntityType,
  capability: Capability,
  caller: CallerRole
): PolicyDecision {
  // 1. External transmission of sensitive entity values is unconditionally blocked
  if (capability === 'TRANSMIT_EXTERNALLY') {
    return {
      granted: false,
      reason: `Policy violation: '${entityType}' values must never be transmitted externally.`,
    };
  }

  // 2. Capabilities for the Agent / LLM
  if (caller === 'agent_llm') {
    switch (capability) {
      case 'LOCATE':
      case 'CLICK':
      case 'SCROLL':
      case 'TYPE':
      case 'SELECT':
      case 'READ_METADATA':
        return {
          granted: true,
          reason: `Agent granted safe operational capability '${capability}' for entity '${entityType}'.`,
        };

      case 'READ_SENSITIVE_VALUE':
        return {
          granted: false,
          reason: `Access denied: Remote LLMs are strictly prohibited from receiving raw sensitive values for '${entityType}'.`,
        };

      case 'DISCLOSE_TO_USER':
        return {
          granted: false,
          reason: `Access denied: Remote LLM cannot invoke direct user disclosure. Only local user intent can trigger disclosure.`,
        };

      default:
        return {
          granted: false,
          reason: `Unknown capability '${capability}' denied for agent.`,
        };
    }
  }

  // 3. Capabilities for the Local User / Local UI
  if (caller === 'local_user') {
    switch (capability) {
      case 'LOCATE':
      case 'CLICK':
      case 'SCROLL':
      case 'TYPE':
      case 'SELECT':
      case 'READ_METADATA':
        return {
          granted: true,
          reason: `Local user granted operational capability '${capability}'.`,
        };

      case 'READ_SENSITIVE_VALUE':
      case 'DISCLOSE_TO_USER':
        // Local user authorized on-device access: permitted locally, strictly confined to the device
        return {
          granted: true,
          reason: `Local user permitted on-device '${capability}' for '${entityType}'. Data remains confined locally.`,
        };

      default:
        return {
          granted: false,
          reason: `Capability '${capability}' not permitted for local user.`,
        };
    }
  }

  return { granted: false, reason: 'Invalid caller role.' };
}

/**
 * Verifies whether a proposed BrowserAction is permitted under the privacy policy.
 */
export function canPerformAction(
  action: BrowserAction,
  detection: AgentDetection | undefined,
  caller: CallerRole
): PolicyDecision {
  // Non-targeted actions
  if (action.action === 'scroll' || action.action === 'navigate') {
    return { granted: true, reason: `Action '${action.action}' does not target sensitive entities.` };
  }

  // Targeted actions: check entity if target is sensitive
  if (detection) {
    let capability: Capability;
    switch (action.action) {
      case 'click':
        capability = 'CLICK';
        break;
      case 'type':
        capability = 'TYPE';
        break;
      case 'select':
        capability = 'SELECT';
        break;
    }

    if (!isSensitiveEntityType(detection.type)) {
      return { granted: true, reason: `Target element is a standard interactive control (${detection.type}).` };
    }

    return checkCapability(detection.type, capability, caller);
  }

  // Target not marked as sensitive
  return { granted: true, reason: `Target element is not classified as sensitive.` };
}

/**
 * Handles a local request to disclose a protected value to the user.
 * Guarantees that the value is shown ONLY on-device and never leaked to an agent.
 */
export function handleLocalUserDisclosure(
  entityType: SensitiveEntityType,
  rawProtectedValue: string,
  caller: CallerRole
): { disclosed: boolean; value?: string; reason: string } {
  const check = checkCapability(entityType, 'DISCLOSE_TO_USER', caller);
  if (!check.granted) {
    return { disclosed: false, reason: check.reason };
  }

  // Permitted on-device for local user only
  return {
    disclosed: true,
    value: rawProtectedValue,
    reason: `Disclosed on-device to user locally. Zero network transmission.`,
  };
}

/**
 * Validates that an AgentContextPayload contains ONLY safe metadata before passing to an LLM.
 * Throws if any forbidden keys or raw values are present.
 *
 * M8: this is ALSO the shared raw-value firewall. Every provider calls it before
 * building a prompt or opening a socket, so a single strengthened check protects
 * all current and future providers without touching any of them.
 */
export function assertSanitizedContextSafe(context: AgentContextPayload): void {
  if (context.sanitized_status !== 'sanitized_only') {
    throw new Error(
      `[PrivacyPolicy] Context payload rejected: sanitized_status is '${context.sanitized_status}', expected 'sanitized_only'.`
    );
  }

  for (const det of context.detections) {
    const raw = det as unknown as Record<string, unknown>;
    const forbidden = [
      'value', 'text', 'textContent', 'innerText',
      'rawText', 'rawOCR', 'ocrText', 'password',
      'token', 'secret', 'card', 'cardNumber', 'cvv',
      'pan', 'accountNumber',
    ];
    for (const f of forbidden) {
      if (f in raw || f.toLowerCase() in raw) {
        throw new Error(
          `[PrivacyPolicy] Security invariant violation: detection ${det.id} contains forbidden key '${f}'. Context blocked.`
        );
      }
    }
  }

  // M8 privacy firewall: independent forbidden-key + PII-shaped-value scan over
  // the whole context. Metadata allowlisting guarantees which fields exist; this
  // guarantees no field carries a raw sensitive VALUE. Fails closed.
  const violations = scanForRawSensitiveValues(context);
  if (violations.length > 0) {
    const rules = Array.from(new Set(violations.map((v) => v.rule))).join(', ');
    throw new PrivacyBoundaryError(
      `[PrivacyPolicy] Raw-value firewall rejected the context ` +
        `(${violations.length} violation(s): ${rules}). Nothing may be transmitted.`,
      violations
    );
  }
}
