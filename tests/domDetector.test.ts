import { describe, it, expect, beforeEach } from 'vitest';
import { scanDOM } from '../extension/src/privacy/domDetector';

describe('PrivAgent DOM Privacy Detector', () => {
  beforeEach(() => {
    // Set up a mock DOM representing the synthetic banking site
    document.body.innerHTML = `
      <form id="banking-form">
        <label for="pwd">Master Password</label>
        <input type="password" id="pwd" name="password" value="DemoPassword123" />

        <label for="mail">Email ID</label>
        <input type="email" id="mail" name="email" value="rahul.sharma@example.com" />

        <label for="mob">Mobile Number</label>
        <input type="tel" id="mob" name="phone" value="9876543210" />

        <label for="card">Debit Card</label>
        <input type="text" id="card" name="cardnumber" autocomplete="cc-number" value="4111 1111 1111 1111" />

        <label for="acc">Account Number</label>
        <input type="text" id="acc" name="account_number" value="123456789012" />

        <label for="name">Legal Name</label>
        <input type="text" id="name" name="fullname" autocomplete="name" value="Rahul Sharma" />
      </form>

      <div class="card-display">
        <span id="card-cvv">892</span>
        <span class="card-number">4111 1111 1111 1111</span>
        <span id="account-number">123456789012</span>
      </div>
    `;
  });

  it('should scan DOM and detect all synthetic sensitive entities', () => {
    const { detections, scanLatencyMs, totalElementsScanned } = scanDOM(document);

    expect(detections.length).toBeGreaterThanOrEqual(6);
    expect(totalElementsScanned).toBeGreaterThan(0);
    expect(scanLatencyMs).toBeGreaterThanOrEqual(0);

    const types = detections.map(d => d.type);
    expect(types).toContain('password');
    expect(types).toContain('email');
    expect(types).toContain('phone');
    expect(types).toContain('credit_card');
    expect(types).toContain('account_number');
    expect(types).toContain('person_name');
  });

  it('should accurately calculate coordinates and bounding boxes', () => {
    const { detections } = scanDOM(document);
    for (const det of detections) {
      expect(det.bbox).toHaveLength(4);
      expect(typeof det.bbox[0]).toBe('number');
      expect(typeof det.bbox[1]).toBe('number');
      expect(typeof det.bbox[2]).toBe('number');
      expect(typeof det.bbox[3]).toBe('number');
    }
  });

  it('should STRICTLY omit raw values, passwords, or textContent in detections', () => {
    const { detections } = scanDOM(document);

    for (const det of detections) {
      const keys = Object.keys(det);
      expect(keys).not.toContain('value');
      expect(keys).not.toContain('textContent');
      expect(keys).not.toContain('innerText');
      expect(keys).not.toContain('password');

      // Verify no sensitive string leaks in any field
      const serialized = JSON.stringify(det);
      expect(serialized).not.toContain('DemoPassword123');
      expect(serialized).not.toContain('rahul.sharma@example.com');
      expect(serialized).not.toContain('9876543210');
      expect(serialized).not.toContain('4111 1111 1111 1111');
      expect(serialized).not.toContain('123456789012');
    }
  });
});
