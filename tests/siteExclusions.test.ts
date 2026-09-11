import { describe, it, expect } from 'vitest';
import { isUrlExcluded, getExclusionReason } from '../extension/src/privacy/siteExclusions';

describe('PrivAgent Site Exclusion Policy', () => {
  it('should exclude ChatGPT domains', () => {
    expect(isUrlExcluded('https://chatgpt.com/')).toBe(true);
    expect(isUrlExcluded('https://chatgpt.com/c/67210')).toBe(true);
    expect(isUrlExcluded('https://chat.openai.com/')).toBe(true);
    expect(getExclusionReason('https://chatgpt.com/')).toContain('ChatGPT');
  });

  it('should exclude browser-privileged protocols', () => {
    expect(isUrlExcluded('chrome://extensions/')).toBe(true);
    expect(isUrlExcluded('chrome-extension://abcdefg/popup.html')).toBe(true);
    expect(isUrlExcluded('edge://settings/')).toBe(true);
    expect(isUrlExcluded('about:blank')).toBe(true);
  });

  it('should NOT exclude normal user webpages', () => {
    expect(isUrlExcluded('https://github.com/login')).toBe(false);
    expect(isUrlExcluded('https://accounts.google.com/')).toBe(false);
    expect(isUrlExcluded('https://amazon.in/')).toBe(false);
    expect(isUrlExcluded('http://localhost:4173/')).toBe(false);
    expect(isUrlExcluded('https://mybank.com/portal')).toBe(false);
    expect(getExclusionReason('https://github.com/login')).toBeNull();
  });
});
