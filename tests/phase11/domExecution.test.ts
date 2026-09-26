/**
 * PrivAgent — Phase 11 Acceptance: DOM-level human interaction
 *
 * These cases drive the REAL production executor
 * (extension/src/content/contentScript.ts) under jsdom — no mock action
 * runner. They assert the observable, value-free behaviour of a human-like
 * interaction:
 *
 *   - click: exactly once, focused, pre-flight blocked when hidden/disabled
 *   - overlays: the agent never clicks through a modal
 *   - typing: value applied, REPLACED not concatenated, focus verified
 *   - select: option resolved and post-state verified, never guessed
 *   - pressKey: safe-key allowlist, focused control only, form submit on Enter
 *   - off-screen targets: scrolled into view rather than dropped
 *   - dynamic DOM: added controls work, removed controls fail closed
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  loadContentScript,
  addControl,
  resetDom,
  stubRect,
  failureCode,
  type ContentScriptModule,
} from './harness';
import { assessInteractability } from '../../extension/src/agent/humanInteraction';

let cs: ContentScriptModule;

beforeAll(async () => {
  cs = await loadContentScript();
});

beforeEach(() => {
  resetDom();
});

describe('P11-5 a healthy click is dispatched exactly once', () => {
  it('5.1 a visible, enabled, in-viewport button is clicked and focused', () => {
    const btn = addControl('ok-button', 'button');
    let clicks = 0;
    btn.addEventListener('click', () => { clicks += 1; });

    const res = cs.executeBrowserAction({ action: 'click', target: 'ok-button' });
    expect(res.success).toBe(true);
    expect(clicks).toBe(1);
    expect(document.activeElement).toBe(btn);
    expect(res.success && res.message).toMatch(/ok-button/);
  });

  it('5.2 a missing target fails closed without dispatching anything', () => {
    const res = cs.executeBrowserAction({ action: 'click', target: 'does-not-exist' });
    expect(res.success).toBe(false);
    expect(failureCode(res)).toMatch(/not found in DOM/i);
  });

  it('5.3 a hidden target is blocked BEFORE any dispatch', () => {
    const btn = addControl('hidden-button', 'button');
    btn.style.display = 'none';
    let clicks = 0;
    btn.addEventListener('click', () => { clicks += 1; });

    const res = cs.executeBrowserAction({ action: 'click', target: 'hidden-button' });
    expect(res.success).toBe(false);
    expect(failureCode(res)).toMatch(/INTERACTABILITY_BLOCKED/);
    expect(clicks).toBe(0);
  });

  it('5.4 a visibility:hidden target is blocked', () => {
    const btn = addControl('invisible-button', 'button');
    btn.style.visibility = 'hidden';
    const res = cs.executeBrowserAction({ action: 'click', target: 'invisible-button' });
    expect(res.success).toBe(false);
    expect(failureCode(res)).toMatch(/INTERACTABILITY_BLOCKED/);
  });

  it('5.5 a pointer-events:none target is blocked', () => {
    const btn = addControl('no-pointer-button', 'button');
    btn.style.pointerEvents = 'none';
    const res = cs.executeBrowserAction({ action: 'click', target: 'no-pointer-button' });
    expect(res.success).toBe(false);
    expect(failureCode(res)).toMatch(/INTERACTABILITY_BLOCKED/);
  });

  it('5.6 a disabled button is blocked', () => {
    const btn = addControl('disabled-button', 'button') as HTMLButtonElement;
    btn.disabled = true;
    let clicks = 0;
    btn.addEventListener('click', () => { clicks += 1; });

    const res = cs.executeBrowserAction({ action: 'click', target: 'disabled-button' });
    expect(res.success).toBe(false);
    expect(failureCode(res)).toMatch(/INTERACTABILITY_BLOCKED/);
    expect(failureCode(res)).toMatch(/disabled/i);
    expect(clicks).toBe(0);
  });

  it('5.7 an aria-disabled button is blocked', () => {
    const btn = addControl('aria-disabled-button', 'button');
    btn.setAttribute('aria-disabled', 'true');
    const res = cs.executeBrowserAction({ action: 'click', target: 'aria-disabled-button' });
    expect(res.success).toBe(false);
    expect(failureCode(res)).toMatch(/INTERACTABILITY_BLOCKED/);
  });

  it('5.8 a zero-size (degenerate) target is blocked', () => {
    addControl('zero-size-button', 'button', { top: 10, left: 10, width: 0, height: 0 });
    const res = cs.executeBrowserAction({ action: 'click', target: 'zero-size-button' });
    expect(res.success).toBe(false);
    expect(failureCode(res)).toMatch(/INTERACTABILITY_BLOCKED/);
  });

  it('5.9 pre-flight reports why a target is not interactable', () => {
    const btn = addControl('reason-button', 'button') as HTMLButtonElement;
    btn.disabled = true;
    const pre = cs.assessLiveInteractability(btn);
    expect(pre.interactable).toBe(false);
    expect(pre.report.enabled).toBe(false);
    expect(pre.report.reason).toMatch(/disabled/i);
  });
});

describe('P11-6 the agent never clicks through an overlay', () => {
  it('6.1 a control behind an open modal is blocked', () => {
    const behind = addControl('behind-modal', 'button');
    let clicks = 0;
    behind.addEventListener('click', () => { clicks += 1; });

    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.appendChild(dialog);

    const res = cs.executeBrowserAction({ action: 'click', target: 'behind-modal' });
    expect(res.success).toBe(false);
    expect(failureCode(res)).toMatch(/INTERACTABILITY_BLOCKED/);
    expect(failureCode(res)).toMatch(/modal/i);
    expect(clicks).toBe(0);
  });

  it('6.2 a control INSIDE the modal is not treated as occluded', () => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    const inner = document.createElement('button');
    inner.id = 'inside-modal';
    dialog.appendChild(inner);
    document.body.appendChild(dialog);
    stubRect(inner, { top: 100, left: 20, width: 120, height: 30 });

    let clicks = 0;
    inner.addEventListener('click', () => { clicks += 1; });

    const pre = cs.assessLiveInteractability(inner);
    expect(pre.report.occludedByModal).toBe(false);
    expect(pre.interactable).toBe(true);

    const res = cs.executeBrowserAction({ action: 'click', target: 'inside-modal' });
    expect(res.success).toBe(true);
    expect(clicks).toBe(1);
  });

  it('6.3 a dynamically removed target is reported as non-existent by the same rule', () => {
    const btn = addControl('detached-button', 'button');
    expect(cs.assessLiveInteractability(btn).report.exists).toBe(true);
    btn.remove();
    const report = assessInteractability({ exists: false });
    expect(report.interactable).toBe(false);
    expect(report.reason).toMatch(/detached/i);
  });
});

describe('P11-7 a repeated click on one target is suppressed', () => {
  it('7.1 the second click inside the window is refused and never dispatched', () => {
    const btn = addControl('dup-target', 'button');
    let clicks = 0;
    btn.addEventListener('click', () => { clicks += 1; });

    const first = cs.executeBrowserAction({ action: 'click', target: 'dup-target' });
    expect(first.success).toBe(true);
    expect(clicks).toBe(1);

    const second = cs.executeBrowserAction({ action: 'click', target: 'dup-target' });
    expect(second.success).toBe(false);
    expect(failureCode(second)).toMatch(/DUPLICATE_CLICK_SUPPRESSED/);
    expect(clicks).toBe(1);
  });
});

describe('P11-8 typing applies the value and replaces instead of concatenating', () => {
  it('8.1 typing focuses the field, sets the value and fires input + change', () => {
    const input = addControl('type-input', 'input') as HTMLInputElement;
    const events: string[] = [];
    input.addEventListener('input', () => events.push('input'));
    input.addEventListener('change', () => events.push('change'));

    const res = cs.executeBrowserAction({ action: 'type', target: 'type-input', text: 'black cats' });
    expect(res.success).toBe(true);
    expect(input.value).toBe('black cats');
    expect(document.activeElement).toBe(input);
    expect(events).toEqual(['input', 'change']);
  });

  it('8.2 the executor reports only a LENGTH, never the typed value', () => {
    addControl('len-input', 'input');
    const res = cs.executeBrowserAction({
      action: 'type',
      target: 'len-input',
      text: 'black cats',
    });
    expect(res.success && res.message).toMatch(/10 chars/);
    expect(res.success && res.message).not.toContain('black cats');
  });

  it('8.3 an existing value is REPLACED, not appended to', () => {
    const input = addControl('replace-input', 'input') as HTMLInputElement;
    input.value = 'old query that is long';

    const res = cs.executeBrowserAction({ action: 'type', target: 'replace-input', text: 'cats' });
    expect(res.success).toBe(true);
    expect(input.value).toBe('cats');
    expect(res.success && res.message).toMatch(/replacing existing value/);
  });

  it('8.4 a control that refuses focus fails closed with FOCUS_MISMATCH', () => {
    const input = addControl('unfocusable-input', 'input') as HTMLInputElement;
    input.focus = () => undefined;

    const res = cs.executeBrowserAction({
      action: 'type',
      target: 'unfocusable-input',
      text: 'cats',
    });
    expect(res.success).toBe(false);
    expect(failureCode(res)).toMatch(/FOCUS_MISMATCH/);
    expect(input.value).toBe('');
  });

  it('8.5 a control that rejects the value fails closed with VALUE_NOT_APPLIED', () => {
    const input = addControl('rejecting-input', 'input') as HTMLInputElement;
    Object.defineProperty(input, 'value', {
      get: () => '',
      set: () => undefined,
      configurable: true,
    });

    const res = cs.executeBrowserAction({
      action: 'type',
      target: 'rejecting-input',
      text: 'cats',
    });
    expect(res.success).toBe(false);
    expect(failureCode(res)).toMatch(/VALUE_NOT_APPLIED/);
  });

  it('8.6 typing into a non-input control fails closed', () => {
    addControl('div-target', 'div');
    const res = cs.executeBrowserAction({ action: 'type', target: 'div-target', text: 'cats' });
    expect(res.success).toBe(false);
    expect(failureCode(res)).toMatch(/not an input or textarea/i);
  });

  it('8.7 a disabled field is never typed into', () => {
    const input = addControl('disabled-input', 'input') as HTMLInputElement;
    input.disabled = true;
    const res = cs.executeBrowserAction({
      action: 'type',
      target: 'disabled-input',
      text: 'cats',
    });
    expect(res.success).toBe(false);
    expect(failureCode(res)).toMatch(/INTERACTABILITY_BLOCKED/);
    expect(input.value).toBe('');
  });
});

describe('P11-9 dropdown selection is verified, never guessed', () => {
  function addSelect(id: string): HTMLSelectElement {
    const sel = document.createElement('select');
    sel.id = id;
    for (const [value, text] of [
      ['red', 'Red'],
      ['blue', 'Blue'],
      ['green', 'Green'],
    ] as const) {
      const o = document.createElement('option');
      o.value = value;
      o.text = text;
      sel.appendChild(o);
    }
    document.body.appendChild(sel);
    stubRect(sel, { top: 100, left: 20, width: 160, height: 30 });
    return sel;
  }

  it('9.1 selecting by visible text applies and verifies the option', () => {
    const sel = addSelect('colour-a');
    let changes = 0;
    sel.addEventListener('change', () => { changes += 1; });

    const res = cs.executeBrowserAction({
      action: 'select',
      target: 'colour-a',
      option: 'Green',
    });
    expect(res.success).toBe(true);
    expect(sel.selectedIndex).toBe(2);
    expect(changes).toBe(1);
  });

  it('9.2 selecting by option value also works', () => {
    const sel = addSelect('colour-b');
    const res = cs.executeBrowserAction({
      action: 'select',
      target: 'colour-b',
      option: 'blue',
    });
    expect(res.success).toBe(true);
    expect(sel.selectedIndex).toBe(1);
  });

  it('9.3 an option that does not exist fails closed — no index is guessed', () => {
    const sel = addSelect('colour-c');
    const res = cs.executeBrowserAction({
      action: 'select',
      target: 'colour-c',
      option: 'Chartreuse',
    });
    expect(res.success).toBe(false);
    expect(failureCode(res)).toMatch(/SELECT_OPTION_NOT_FOUND/);
    expect(sel.selectedIndex).toBe(0);
  });

  it('9.4 an option that does not persist fails closed with SELECT_NOT_APPLIED', () => {
    addSelect('colour-d');
    // jsdom proxies <select>, so the refusing accessor is patched on the
    // prototype for the duration of the call only.
    const original = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
    Object.defineProperty(HTMLSelectElement.prototype, 'selectedIndex', {
      get: () => 0,
      set: () => undefined,
      configurable: true,
    });
    try {
      const res = cs.executeBrowserAction({
        action: 'select',
        target: 'colour-d',
        option: 'Blue',
      });
      expect(res.success).toBe(false);
      expect(failureCode(res)).toMatch(/SELECT_NOT_APPLIED/);
    } finally {
      if (original) {
        Object.defineProperty(HTMLSelectElement.prototype, 'selectedIndex', original);
      }
    }
  });

  it('9.5 a select that cannot take focus fails closed with FOCUS_MISMATCH', () => {
    const sel = addSelect('colour-e');
    sel.focus = () => undefined;
    const res = cs.executeBrowserAction({ action: 'select', target: 'colour-e', option: 'Red' });
    expect(res.success).toBe(false);
    expect(failureCode(res)).toMatch(/FOCUS_MISMATCH/);
    expect(sel.selectedIndex).toBe(0);
  });

  it('9.6 a non-select control fails closed', () => {
    addControl('not-a-select', 'input');
    const res = cs.executeBrowserAction({ action: 'select', target: 'not-a-select', option: 'Red' });
    expect(res.success).toBe(false);
    expect(failureCode(res)).toMatch(/not a select element/i);
  });
});

describe('P11-10 keyboard interaction is safe, focused and bounded', () => {
  it('10.1 a safe key is delivered to the FOCUSED control only', () => {
    const input = addControl('kb-input', 'input') as HTMLInputElement;
    input.focus();

    const seen: string[] = [];
    input.addEventListener('keydown', (e) => seen.push(`down:${(e as KeyboardEvent).key}`));
    input.addEventListener('keyup', (e) => seen.push(`up:${(e as KeyboardEvent).key}`));

    const res = cs.executeBrowserAction({ action: 'pressKey', key: 'Tab' });
    expect(res.success).toBe(true);
    expect(seen).toEqual(['down:Tab', 'up:Tab']);
  });

  it('10.2 Enter on a focused field inside a form submits that form', () => {
    const form = document.createElement('form');
    const input = document.createElement('input');
    input.id = 'kb-submit-input';
    form.appendChild(input);
    document.body.appendChild(form);
    stubRect(input, { top: 100, left: 20, width: 200, height: 30 });

    let submitted = 0;
    form.requestSubmit = () => { submitted += 1; };

    input.focus();
    const res = cs.executeBrowserAction({ action: 'pressKey', key: 'Enter' });
    expect(res.success).toBe(true);
    expect(submitted).toBe(1);
  });

  it('10.3 Enter on a focused control that is NOT in a form submits nothing', () => {
    const input = addControl('kb-noform-input', 'input') as HTMLInputElement;
    input.focus();
    let submits = 0;
    document.addEventListener('submit', () => { submits += 1; });

    const res = cs.executeBrowserAction({ action: 'pressKey', key: 'Enter' });
    expect(res.success).toBe(true);
    expect(submits).toBe(0);
  });

  it('10.4 Escape is delivered on the focused control and bubbles like a real key', () => {
    const btn = addControl('popup-trigger', 'button') as HTMLButtonElement;
    btn.focus();
    let escapes = 0;
    document.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') escapes += 1;
    });

    const res = cs.executeBrowserAction({ action: 'pressKey', key: 'Escape' });
    expect(res.success).toBe(true);
    expect(escapes).toBe(1);
  });

  it('10.5 a non-allowlisted key is refused at execution time too (defence in depth)', () => {
    const input = addControl('kb-unsafe-input', 'input') as HTMLInputElement;
    input.focus();
    const res = cs.executeBrowserAction({ action: 'pressKey', key: 'Delete' as never });
    expect(res.success).toBe(false);
    expect(failureCode(res)).toMatch(/UNSAFE_KEY/);
  });

  it('10.6 with nothing focused, keyboard interaction fails closed', () => {
    (document.activeElement as HTMLElement | null)?.blur();
    const res = cs.executeBrowserAction({ action: 'pressKey', key: 'Enter' });
    expect(res.success).toBe(false);
    expect(failureCode(res)).toMatch(/FOCUS_MISMATCH/);
  });

  it('10.7 focus on the WRONG control fails closed before any key is delivered', () => {
    const expected = addControl('expected-field', 'input') as HTMLInputElement;
    const other = addControl('other-field', 'input') as HTMLInputElement;
    other.focus();

    let delivered = 0;
    expected.addEventListener('keydown', () => { delivered += 1; });

    const res = cs.executeBrowserAction({
      action: 'pressKey',
      key: 'Enter',
      target: 'expected-field',
    });
    expect(res.success).toBe(false);
    expect(failureCode(res)).toMatch(/FOCUS_MISMATCH/);
    expect(delivered).toBe(0);
  });

  it('10.8 focus inside the expected form is accepted', () => {
    const form = document.createElement('form');
    form.id = 'kb-form';
    const expected = document.createElement('input');
    expected.id = 'kb-form-input';
    form.appendChild(expected);
    document.body.appendChild(form);
    stubRect(expected, { top: 100, left: 20, width: 200, height: 30 });
    expected.focus();

    const res = cs.executeBrowserAction({ action: 'pressKey', key: 'Tab', target: 'kb-form' });
    expect(res.success).toBe(true);
  });
});

describe('P11-11 an off-screen target is scrolled into view, not dropped', () => {
  it('11.1 pre-flight reports the target as outside the viewport', () => {
    // jsdom viewport is 1024x768; 5000px is far below the fold.
    const el = addControl('offscreen-button', 'button', { top: 5000, left: 20, width: 120, height: 30 });
    const pre = cs.assessLiveInteractability(el);
    expect(pre.report.inViewport).toBe(false);
    expect(pre.interactable).toBe(false);
    expect(pre.report.reason).toMatch(/viewport/i);
  });

  it('11.2 the click still lands — the executor scrolls the target into view first', () => {
    const el = addControl('offscreen-clickable', 'button', { top: 5000, left: 20, width: 120, height: 30 });
    let clicked = 0;
    el.addEventListener('click', () => { clicked += 1; });

    const res = cs.executeBrowserAction({ action: 'click', target: 'offscreen-clickable' });
    expect(res.success).toBe(true);
    expect(clicked).toBe(1);
    expect(document.activeElement).toBe(el);
  });

  it('11.3 a scroll action moves the viewport by at most the validated amount', () => {
    const calls: number[] = [];
    const originalScrollBy = window.scrollBy.bind(window);
    let fakeY = 0;
    (window as unknown as { scrollBy: (o: unknown, y?: number) => void }).scrollBy = (
      o: unknown,
      y?: number
    ) => {
      const delta =
        typeof o === 'number'
          ? o
          : typeof o === 'object' && o !== null
            ? Number((o as { top?: number }).top ?? 0)
            : (y ?? 0);
      calls.push(delta);
      fakeY += delta;
      Object.defineProperty(window, 'scrollY', { value: fakeY, configurable: true });
    };

    try {
      const res = cs.executeBrowserAction({ action: 'scroll', direction: 'down', amount: 600 });
      expect(res.success).toBe(true);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((d) => Math.abs(d) <= 600)).toBe(true);
      expect(res.success && res.message).toMatch(/Scrolled down by \d+px/);
    } finally {
      (window as unknown as { scrollBy: typeof originalScrollBy }).scrollBy = originalScrollBy;
    }
  });
});

describe('P11-12 dynamic DOM is handled by the same rules', () => {
  it('12.1 a control added after the initial scan is clickable', () => {
    const el = document.createElement('button');
    el.id = 'dynamic-button';
    el.textContent = 'Added later';
    document.body.appendChild(el);
    stubRect(el, { top: 120, left: 20, width: 140, height: 32 });

    let clicked = 0;
    el.addEventListener('click', () => { clicked += 1; });

    const res = cs.executeBrowserAction({ action: 'click', target: 'dynamic-button' });
    expect(res.success).toBe(true);
    expect(clicked).toBe(1);
  });

  it('12.2 a control removed by a dynamic re-render fails closed', () => {
    const el = addControl('ephemeral-button', 'button');
    el.remove();
    const res = cs.executeBrowserAction({ action: 'click', target: 'ephemeral-button' });
    expect(res.success).toBe(false);
    expect(failureCode(res)).toMatch(/not found in DOM/i);
  });
});
