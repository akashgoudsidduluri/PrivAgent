import { describe, it, expect, beforeEach } from 'vitest';
import { LocalRedactor } from '../extension/src/redaction/redactor';
import { DetectionResult } from '../extension/src/privacy/types';

describe('PrivAgent Local Redaction Engine', () => {
  let redactor: LocalRedactor;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="test-input" style="width: 200px; height: 40px;">Mock Field</div>
    `;
    redactor = new LocalRedactor();
  });

  const mockDetections: DetectionResult[] = [
    {
      id: 'privagent-det-1',
      type: 'password',
      confidence: 1.0,
      selector: '#test-input',
      bbox: [10, 20, 200, 40],
      length: 12,
      source: 'dom_input_type',
    },
    {
      id: 'privagent-det-2',
      type: 'credit_card',
      confidence: 0.98,
      selector: '.card-num',
      bbox: [10, 80, 240, 40],
      length: 16,
      source: 'text_pattern',
    },
  ];

  it('should create blackout visual masks over detected coordinates', () => {
    const res = redactor.applyRedaction(mockDetections, 'blackout');

    expect(res.elementsProtected).toBe(2);
    expect(res.redactionLatencyMs).toBeGreaterThanOrEqual(0);
    expect(res.mode).toBe('blackout');

    const container = document.getElementById('privagent-redaction-root');
    expect(container).not.toBeNull();
    const masks = container!.querySelectorAll('.privagent-mask-box');
    expect(masks.length).toBe(2);
  });

  it('should support blur redaction mode', () => {
    const res = redactor.applyRedaction(mockDetections, 'blur');
    expect(res.mode).toBe('blur');

    const container = document.getElementById('privagent-redaction-root');
    const masks = container!.querySelectorAll('.privagent-mode-blur');
    expect(masks.length).toBe(2);
  });

  it('should support mask [REDACTED] mode', () => {
    const res = redactor.applyRedaction(mockDetections, 'mask');
    expect(res.mode).toBe('mask');

    const container = document.getElementById('privagent-redaction-root');
    const masks = container!.querySelectorAll('.privagent-mode-mask');
    expect(masks.length).toBe(2);
    expect(masks[0]?.textContent).toContain('[REDACTED: password]');
  });

  it('should clear redactions cleanly when requested', () => {
    redactor.applyRedaction(mockDetections, 'blackout');
    redactor.clearRedaction();

    const container = document.getElementById('privagent-redaction-root');
    expect(container!.children.length).toBe(0);
  });
});
