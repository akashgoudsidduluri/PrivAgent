/**
 * PrivAgent 2.0 — Accessibility Tree Test Suite (Phase 1)
 *
 * Validates local accessibility hierarchy extraction and strict label sanitization.
 * Covers:
 *  - Scenario N: Accessibility metadata (roles, states, parent/child relationships)
 *  - Scenario O: Sensitive accessibility text sanitization (passwords, OTPs, cards scrubbed)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  extractAccessibilityTree,
  sanitizeAccessibleName,
} from '../extension/src/worldModel/accessibilityTree';

describe('AccessibilityTree — Roles, States & Privacy Sanitization', () => {
  let dom: JSDOM;
  let document: Document;

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    document = dom.window.document;
  });

  it('Scenario N: extracts standard accessible roles and interactive states', () => {
    document.body.innerHTML = `
      <main>
        <h1>Welcome to Portal</h1>
        <form id="sample-form">
          <label for="username">Username</label>
          <input id="username" type="text" placeholder="Enter username" />

          <label for="remember">Remember me</label>
          <input id="remember" type="checkbox" checked />

          <button id="submit-btn" type="submit" disabled>Login</button>
          <a id="help-link" href="/help">Need help?</a>
        </form>
      </main>
    `;

    const tree = extractAccessibilityTree(document.body);
    expect(tree.length).toBeGreaterThanOrEqual(5);

    // 1. Heading
    const heading = tree.find(n => n.name === 'Welcome to Portal');
    expect(heading).toBeDefined();
    expect(heading?.role).toBe('heading');

    // 2. Textbox
    const textbox = tree.find(n => n.elementId === 'username');
    expect(textbox).toBeDefined();
    expect(textbox?.role).toBe('textbox');
    expect(textbox?.name).toBe('Username');

    // 3. Checkbox with checked state
    const checkbox = tree.find(n => n.elementId === 'remember');
    expect(checkbox).toBeDefined();
    expect(checkbox?.role).toBe('checkbox');
    expect(checkbox?.checked).toBe(true);

    // 4. Button with disabled state
    const button = tree.find(n => n.elementId === 'submit-btn');
    expect(button).toBeDefined();
    expect(button?.role).toBe('button');
    expect(button?.disabled).toBe(true);

    // 5. Link
    const link = tree.find(n => n.elementId === 'help-link');
    expect(link).toBeDefined();
    expect(link?.role).toBe('link');
    expect(link?.name).toBe('Need help?');
  });

  it('Scenario N: preserves ARIA roles, aria-modal, and aria-expanded states', () => {
    document.body.innerHTML = `
      <div id="modal-box" role="dialog" aria-modal="true" aria-label="Confirm Purchase">
        <button id="menu-btn" aria-expanded="true" aria-label="Menu Options">Menu</button>
      </div>
    `;

    const tree = extractAccessibilityTree(document.body);
    const dialog = tree.find(n => n.elementId === 'modal-box');
    expect(dialog).toBeDefined();
    expect(dialog?.role).toBe('dialog');
    expect(dialog?.modal).toBe(true);
    expect(dialog?.name).toBe('Confirm Purchase');

    const menu = tree.find(n => n.elementId === 'menu-btn');
    expect(menu).toBeDefined();
    expect(menu?.expanded).toBe(true);
  });

  it('Scenario O: sanitizes sensitive credential names from aria-label, labels, and placeholders', () => {
    document.body.innerHTML = `
      <form>
        <!-- Sensitive aria-label -->
        <input id="pwd" type="password" aria-label="Your Master Password" />

        <!-- Sensitive placeholder -->
        <input id="cvv-input" type="text" placeholder="Enter CVV or CVC code" />

        <!-- Sensitive label for OTP -->
        <label for="otp-input">Verification OTP code</label>
        <input id="otp-input" type="text" />

        <!-- Sensitive account number label -->
        <label for="acc-input">Bank Account Number</label>
        <input id="acc-input" type="text" />
      </form>
    `;

    const tree = extractAccessibilityTree(document.body);

    const pwdNode = tree.find(n => n.elementId === 'pwd');
    expect(pwdNode?.name).toBe('Protected Credential Field');

    const cvvNode = tree.find(n => n.elementId === 'cvv-input');
    expect(cvvNode?.name).toBe('Protected Credential Field');

    const otpNode = tree.find(n => n.elementId === 'otp-input');
    expect(otpNode?.name).toBe('Protected Credential Field');

    const accNode = tree.find(n => n.elementId === 'acc-input');
    expect(accNode?.name).toBe('Protected Credential Field');
  });

  it('Scenario O: sanitizeAccessibleName scrubs keyword variations', () => {
    expect(sanitizeAccessibleName('Enter password')).toBe('Protected Credential Field');
    expect(sanitizeAccessibleName('Card Number (16-digits)')).toBe('Protected Credential Field');
    expect(sanitizeAccessibleName('Your secret token')).toBe('Protected Credential Field');
    expect(sanitizeAccessibleName('PAN details')).toBe('Protected Credential Field');
    expect(sanitizeAccessibleName('Search products in store')).toBe('Search products in store');
  });
});
