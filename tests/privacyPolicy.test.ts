/**
 * PrivAgent — Privacy Policy Test Suite (Milestone 5.4)
 *
 * Tests requirements:
 *  13. raw PII cannot enter agent payload
 *  17. sanitized context contains no raw sensitive values
 *  18. capability policy blocks unauthorized sensitive disclosure / external transmission
 *  19. explicit user disclosure can be handled locally without remote transmission
 */

import { describe, it, expect } from 'vitest';
import {
  checkCapability,
  canPerformAction,
  handleLocalUserDisclosure,
  assertSanitizedContextSafe,
} from '../extension/src/agent/privacyPolicy';
import { AgentContextPayload, buildAgentPayload, PrivacyScanReport } from '../extension/src/privacy/types';

describe('PrivAgent Capability-Based Privacy Policy', () => {
  const validContext: AgentContextPayload = {
    url: 'https://bank.example.com',
    timestamp: 1720000000000,
    viewport: { width: 1280, height: 800, scroll_x: 0, scroll_y: 0 },
    screenshot_dimensions: null,
    detections: [
      {
        id: 'element_account',
        type: 'account_number',
        confidence: 0.98,
        bbox: { x: 50, y: 100, width: 200, height: 40 },
        length: 12,
        source: 'dom_input_type',
        selector: '#account-input',
        is_partially_visible: false,
      },
    ],
    total_elements_scanned: 10,
    sensitive_elements_detected: 1,
    sanitized_status: 'sanitized_only',
    ocr_metrics: null,
  };

  // Test 13: Raw PII cannot enter agent payload
  it('13. ensures buildAgentPayload never copies raw values into agent payload', () => {
    const rawReport: PrivacyScanReport = {
      timestamp: 1720000000000,
      url: 'https://bank.example.com',
      scanLatencyMs: 5,
      redactionLatencyMs: 3,
      totalElementsScanned: 10,
      sensitiveElementsDetected: 1,
      elementsProtected: 1,
      leakageCount: 0,
      categories: {
        password: 0,
        credit_card: 0,
        account_number: 1,
        email: 0,
        phone: 0,
        person_name: 0,
        pan: 0,
        otp: 0,
        cvv: 0,
        address: 0,
      },
      detections: [
        {
          id: 'det_1',
          type: 'account_number',
          confidence: 0.95,
          selector: '#acc',
          bbox: [10, 20, 200, 30],
          length: 12,
          source: 'dom_input_type',
          // Note: raw DetectionResult in M1 never contains value, but we verify allowlist construction
        },
      ],
      status: 'Sanitized Context — Local Privacy Check Passed',
      redactionMode: 'blackout',
    };

    const payload = buildAgentPayload(rawReport, null);
    expect(payload).not.toBeNull();
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('"value"');
    expect(serialized).not.toContain('"password"');
    expect(serialized).not.toContain('"rawText"');
  });

  // Test 17: Sanitized context contains no raw sensitive values
  it('17. throws security invariant violation if raw sensitive keys sneak into context', () => {
    // Valid context passes check
    expect(() => assertSanitizedContextSafe(validContext)).not.toThrow();

    // Context containing a raw password or text key throws
    const poisonedContext = JSON.parse(JSON.stringify(validContext));
    poisonedContext.detections[0].password = 'Secret123!';
    expect(() => assertSanitizedContextSafe(poisonedContext)).toThrow(/forbidden key 'password'/i);

    const poisonedContextValue = JSON.parse(JSON.stringify(validContext));
    poisonedContextValue.detections[0].value = '123456789012';
    expect(() => assertSanitizedContextSafe(poisonedContextValue)).toThrow(/forbidden key 'value'/i);
  });

  // Test 18: Capability policy blocks unauthorized sensitive disclosure
  it('18. capability policy blocks LLM from READ_SENSITIVE_VALUE, DISCLOSE_TO_USER, and TRANSMIT_EXTERNALLY', () => {
    // LLM is granted safe operational capabilities
    const locate = checkCapability('account_number', 'LOCATE', 'agent_llm');
    expect(locate.granted).toBe(true);

    const click = checkCapability('account_number', 'CLICK', 'agent_llm');
    expect(click.granted).toBe(true);

    const metadata = checkCapability('account_number', 'READ_METADATA', 'agent_llm');
    expect(metadata.granted).toBe(true);

    // LLM is DENIED sensitive reading and disclosure
    const readVal = checkCapability('account_number', 'READ_SENSITIVE_VALUE', 'agent_llm');
    expect(readVal.granted).toBe(false);
    expect(readVal.reason).toMatch(/Remote LLMs are strictly prohibited/i);

    const disclose = checkCapability('account_number', 'DISCLOSE_TO_USER', 'agent_llm');
    expect(disclose.granted).toBe(false);
    expect(disclose.reason).toMatch(/Remote LLM cannot invoke direct user disclosure/i);

    const transmit = checkCapability('account_number', 'TRANSMIT_EXTERNALLY', 'agent_llm');
    expect(transmit.granted).toBe(false);
    expect(transmit.reason).toMatch(/never be transmitted externally/i);
  });

  // Test 19: Explicit user disclosure can be handled locally without remote transmission
  it('19. allows on-device disclosure to local user UI while blocking external transmission', () => {
    const rawAccountNumber = '123456789012';

    // Local user requesting disclosure on-device succeeds
    const userResult = handleLocalUserDisclosure('account_number', rawAccountNumber, 'local_user');
    expect(userResult.disclosed).toBe(true);
    expect(userResult.value).toBe(rawAccountNumber);
    expect(userResult.reason).toMatch(/Disclosed on-device to user locally/i);

    // Agent/remote LLM requesting disclosure fails
    const agentResult = handleLocalUserDisclosure('account_number', rawAccountNumber, 'agent_llm');
    expect(agentResult.disclosed).toBe(false);
    expect(agentResult.value).toBeUndefined();
    expect(agentResult.reason).toMatch(/Remote LLM cannot invoke/i);

    // External transmission for user is also blocked (values never leave the device)
    const externalCheck = checkCapability('account_number', 'TRANSMIT_EXTERNALLY', 'local_user');
    expect(externalCheck.granted).toBe(false);
  });
});
