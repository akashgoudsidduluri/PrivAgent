/**
 * Site Exclusion Policy for PrivAgent
 * Excludes browser-privileged pages and development-exempt AI conversational platforms
 * where automated DOM instrumentation during early milestones is inappropriate.
 */

export interface ExclusionRule {
  domainOrPrefix: string;
  reason: string;
  isPrefix?: boolean;
}

export const EXCLUSION_RULES: ExclusionRule[] = [
  // Browser internal & extension schemes
  { domainOrPrefix: 'chrome://', reason: 'Browser privileged protocol', isPrefix: true },
  { domainOrPrefix: 'chrome-extension://', reason: 'Extension internal origin', isPrefix: true },
  { domainOrPrefix: 'edge://', reason: 'Browser privileged protocol', isPrefix: true },
  { domainOrPrefix: 'about:', reason: 'Browser privileged protocol', isPrefix: true },
  { domainOrPrefix: 'devtools://', reason: 'Developer tools privileged protocol', isPrefix: true },

  // AI chat interfaces excluded during early milestone development
  { domainOrPrefix: 'chatgpt.com', reason: 'ChatGPT conversational workspace (development exclusion)' },
  { domainOrPrefix: 'chat.openai.com', reason: 'ChatGPT conversational workspace (development exclusion)' },
];

/**
 * Checks if a given URL should be excluded from automatic PrivAgent scanning.
 */
export function isUrlExcluded(url: string): boolean {
  if (!url) return false;
  const lowerUrl = url.toLowerCase().trim();

  return EXCLUSION_RULES.some(rule => {
    if (rule.isPrefix) {
      return lowerUrl.startsWith(rule.domainOrPrefix);
    }
    try {
      const parsed = new URL(lowerUrl);
      const host = parsed.hostname.toLowerCase();
      return host === rule.domainOrPrefix || host.endsWith('.' + rule.domainOrPrefix);
    } catch {
      return lowerUrl.includes(rule.domainOrPrefix);
    }
  });
}

/**
 * Returns the human-readable exclusion reason if the URL is excluded, or null if allowed.
 */
export function getExclusionReason(url: string): string | null {
  if (!url) return null;
  const lowerUrl = url.toLowerCase().trim();

  for (const rule of EXCLUSION_RULES) {
    if (rule.isPrefix && lowerUrl.startsWith(rule.domainOrPrefix)) {
      return rule.reason;
    }
    try {
      const parsed = new URL(lowerUrl);
      const host = parsed.hostname.toLowerCase();
      if (host === rule.domainOrPrefix || host.endsWith('.' + rule.domainOrPrefix)) {
        return rule.reason;
      }
    } catch {
      if (lowerUrl.includes(rule.domainOrPrefix)) {
        return rule.reason;
      }
    }
  }

  return null;
}
