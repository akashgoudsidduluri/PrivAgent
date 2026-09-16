import { describe, it, expect, beforeEach } from 'vitest';
import { scanDOM } from '../extension/src/privacy/domDetector';
import { PATTERNS, isValidLuhn, matchesKeyword, KEYWORDS } from '../extension/src/privacy/patterns';

describe('PrivAgent Detection Quality & False-Positive Regression Suite', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('Positive PII Detection Tests', () => {
    it('detects valid email addresses in input and text elements', () => {
      document.body.innerHTML = `
        <input type="email" id="user-email" value="alice@bankdomain.com" />
        <p>Support contact: helpdesk@company.org</p>
      `;
      const { detections } = scanDOM(document);
      const emailDets = detections.filter((d) => d.type === 'email');
      expect(emailDets.length).toBeGreaterThanOrEqual(2);
    });

    it('detects valid 10-digit Indian and international phone numbers', () => {
      document.body.innerHTML = `
        <input type="tel" id="mobile-phone" value="+91 98765 43210" />
        <div>Emergency line: 9876543210</div>
      `;
      const { detections } = scanDOM(document);
      const phoneDets = detections.filter((d) => d.type === 'phone');
      expect(phoneDets.length).toBeGreaterThanOrEqual(2);
    });

    it('detects Luhn-valid credit card numbers and rejects invalid sequences', () => {
      // Valid Luhn test card: 4532 0151 1283 0366
      expect(isValidLuhn('4532015112830366')).toBe(true);
      expect(isValidLuhn('4532015112830367')).toBe(false);

      document.body.innerHTML = `
        <input id="card-field" name="cardNumber" value="4532015112830366" />
      `;
      const { detections } = scanDOM(document);
      const cardDets = detections.filter((d) => d.type === 'credit_card');
      expect(cardDets.length).toBe(1);
    });

    it('detects account number input fields by label association', () => {
      document.body.innerHTML = `
        <label for="acc-input">Account Number</label>
        <input id="acc-input" value="123456789012" />
      `;
      const { detections } = scanDOM(document);
      const accDets = detections.filter((d) => d.type === 'account_number');
      expect(accDets.length).toBe(1);
    });

    it('detects password fields by type, autocomplete, or label keyword', () => {
      document.body.innerHTML = `
        <input type="password" id="secret-pwd" value="mypassword123" />
        <label>Passcode: <input id="pwd-pin" type="text" /></label>
      `;
      const { detections } = scanDOM(document);
      const pwdDets = detections.filter((d) => d.type === 'password');
      expect(pwdDets.length).toBe(2);
    });
  });

  describe('Negative Tests — False Positive Prevention', () => {
    it('does NOT misclassify normal numbers, ports, or counts as PII', () => {
      document.body.innerHTML = `
        <div id="item-count">Showing 15 of 45 results</div>
        <div id="port-number">Server running on port 4173 and 5173</div>
        <span>Total pages: 12</span>
      `;
      const { detections } = scanDOM(document);
      expect(detections.length).toBe(0);
    });

    it('does NOT misclassify order IDs or alphanumeric references as phone or card', () => {
      document.body.innerHTML = `
        <p>Order ID: ORD-98765432</p>
        <p>Invoice reference: INV-2024-0988</p>
        <div>Tracking code: TRACK-881234</div>
      `;
      const { detections } = scanDOM(document);
      const phoneOrCard = detections.filter((d) => d.type === 'phone' || d.type === 'credit_card');
      expect(phoneOrCard.length).toBe(0);
    });

    it('does NOT misclassify flight numbers as account numbers or PII', () => {
      document.body.innerHTML = `
        <span>Flight: AI-101</span>
        <span>Gate: B-12</span>
        <div>Terminal: 2</div>
      `;
      const { detections } = scanDOM(document);
      expect(detections.length).toBe(0);
    });

    it('does NOT misclassify dates and timestamps as phone or credit cards', () => {
      document.body.innerHTML = `
        <span class="date-stamp">Date: 2026-09-16</span>
        <span class="time-stamp">Updated: 12/05/2025 at 14:30</span>
      `;
      const { detections } = scanDOM(document);
      const phoneOrCard = detections.filter((d) => d.type === 'phone' || d.type === 'credit_card');
      expect(phoneOrCard.length).toBe(0);
    });

    it('does NOT misclassify prices and currency amounts as account numbers', () => {
      document.body.innerHTML = `
        <span class="price-val">$49.99</span>
        <span class="inr-price">₹1,499.00</span>
        <div>Total: 199.50 EUR</div>
      `;
      const { detections } = scanDOM(document);
      const accDets = detections.filter((d) => d.type === 'account_number');
      expect(accDets.length).toBe(0);
    });

    it('does NOT misclassify hex color codes or percentages as PII', () => {
      document.body.innerHTML = `
        <div class="color-badge">Color: #10b981</div>
        <div class="rate-stat">Accuracy rate: 99.4%</div>
      `;
      const { detections } = scanDOM(document);
      expect(detections.length).toBe(0);
    });
  });
});
