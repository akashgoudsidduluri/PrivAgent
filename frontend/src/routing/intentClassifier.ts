/**
 * PrivAgent — Deterministic Intent Classification Layer
 *
 * Classifies incoming user messages into:
 *  - CHAT: Conversational, greetings, capability inquiries, explanations
 *  - BROWSER_TASK: Requests requiring web page navigation, inspection, or interaction
 *
 * Conservative policy:
 *  - Clear browser requests -> BROWSER_TASK
 *  - Clearly conversational -> CHAT
 *  - Ambiguous / ungrounded requests -> CHAT (asking user for clarification rather than executing unexpected browser actions)
 */

export type UserIntentType = 'CHAT' | 'BROWSER_TASK';

export interface ExplicitTarget {
  hostname?: string;
  port?: string;
}

export interface IntentClassification {
  intent: UserIntentType;
  confidence: number;
  reason: string;
  suggestedResponse?: string;
  explicitTarget?: ExplicitTarget | null;
}

/**
 * Extracts explicit port or target hostname from task text locally and deterministically.
 * Zero LLM calls.
 */
export function extractExplicitTargetFromTask(task: string): ExplicitTarget | null {
  if (!task) return null;
  const text = task.toLowerCase();

  // Pattern 1: http(s)://localhost:4173 or http(s)://domain.com
  const urlMatch = text.match(/https?:\/\/([a-zA-Z0-9.-]+)(?::(\d+))?/);
  if (urlMatch && urlMatch[1]) {
    return {
      hostname: urlMatch[1],
      port: urlMatch[2],
    };
  }

  // Pattern 2: "localhost:4173" or "127.0.0.1:4173" or "domain.com:8080"
  const hostPortMatch = text.match(/([a-zA-Z0-9.-]+):(\d+)/);
  if (hostPortMatch && hostPortMatch[1] && hostPortMatch[2]) {
    return {
      hostname: hostPortMatch[1],
      port: hostPortMatch[2],
    };
  }

  // Pattern 3: "localhost 4173" or "localhost port 4173" or "127.0.0.1 4173"
  const spacePortMatch = text.match(/(localhost|127\.0\.0\.1)(?:\s+(?:port\s+|on\s+port\s+)?(\d+))/);
  if (spacePortMatch && spacePortMatch[1] && spacePortMatch[2]) {
    return {
      hostname: spacePortMatch[1],
      port: spacePortMatch[2],
    };
  }

  return null;
}

export function classifyUserIntent(rawInput: string): IntentClassification {
  const text = (rawInput || '').trim();
  if (!text) {
    return {
      intent: 'CHAT',
      confidence: 1.0,
      reason: 'Empty message',
      suggestedResponse: 'Please type a message or ask me to perform a browser task.',
    };
  }

  const lower = text.toLowerCase();

  // 1. Pure greetings and social pleasantries
  const greetingPattern = /^(hi|hello|helo|hey|howdy|greetings|good\s+(morning|afternoon|evening|day)|sup|yo)[\s!?,.]*$/i;
  if (greetingPattern.test(lower)) {
    return {
      intent: 'CHAT',
      confidence: 1.0,
      reason: 'Greeting',
      suggestedResponse: 'Hi. I can help you automate tasks in your browser while keeping sensitive information protected on-device.',
    };
  }

  const thanksPattern = /^(thank\s+you|thanks|thx|great|awesome|perfect|ok|okay|cool)[\s!?,.]*$/i;
  if (thanksPattern.test(lower)) {
    return {
      intent: 'CHAT',
      confidence: 1.0,
      reason: 'Pleasantry',
      suggestedResponse: "You're welcome! Let me know if there's a browser task you'd like me to perform.",
    };
  }

  // 2. Capability inquiries & Meta questions
  const capabilityPattern = /^(what\s+can\s+you\s+do|what\s+do\s+you\s+do|who\s+are\s+you|help|capabilities)[\s!?,.]*$/i;
  if (capabilityPattern.test(lower)) {
    return {
      intent: 'CHAT',
      confidence: 0.95,
      reason: 'Capability inquiry',
      suggestedResponse: 'I am PrivAgent, an on-device privacy-preserving browser agent. I can perform browser tasks such as navigating websites, extracting data, filling forms, and finding information — all while redacting and protecting your credentials, financial data, and PII locally before any context is shared.',
    };
  }

  const explainPattern = /^(explain|how\s+does|tell\s+me\s+about|what\s+is)\s+(privagent|it\s+work|privacy|on-device|the\s+architecture)/i;
  if (explainPattern.test(lower)) {
    return {
      intent: 'CHAT',
      confidence: 0.95,
      reason: 'Explanation inquiry',
      suggestedResponse: 'PrivAgent uses a local visual privacy boundary: DOM elements and viewport screenshots are scanned on-device for sensitive data (passwords, cards, PII) using local regex and WebAssembly OCR. Sensitive coordinates are redacted locally, context is minimized (M8), and only sanitized tokens reach the remote LLM. Actions are validated against strict safety policies before execution.',
    };
  }

  // 3. Explicit web target mentioned (URL / localhost port)
  const explicit = extractExplicitTargetFromTask(text);
  if (explicit && (explicit.port || explicit.hostname)) {
    return {
      intent: 'BROWSER_TASK',
      confidence: 0.95,
      reason: 'Explicit web target detected',
      explicitTarget: explicit,
    };
  }

  // 4. Action verbs & Web element context
  const actionVerbs = [
    'open', 'navigate', 'go to', 'visit', 'browse',
    'click', 'press', 'tap', 'select', 'choose',
    'fill', 'type', 'enter', 'input', 'submit',
    'scroll',
    'find', 'get', 'check', 'search', 'lookup', 'extract', 'read', 'fetch', 'show me'
  ];

  const browserContextKeywords = [
    'button', 'link', 'tab', 'page', 'site', 'website', 'url', 'form',
    'input', 'cart', 'price', 'transactions', 'account', 'balance', 'table',
    'gold chain', 'product', 'item', 'menu', 'dropdown', 'checkbox',
    'login', 'signin', 'logout', 'checkout', 'profile'
  ];

  const hasActionVerb = actionVerbs.some((v) => {
    const reg = new RegExp(`\\b${v}\\b`, 'i');
    return reg.test(lower);
  });

  const hasBrowserContext = browserContextKeywords.some((k) => {
    const reg = new RegExp(`\\b${k}\\b`, 'i');
    return reg.test(lower);
  });

  if (hasActionVerb || hasBrowserContext) {
    return {
      intent: 'BROWSER_TASK',
      confidence: 0.9,
      reason: 'Browser action or element keyword detected',
      explicitTarget: null,
    };
  }

  // 5. Conservative fallback: Conversational response asking user for clarification
  return {
    intent: 'CHAT',
    confidence: 0.7,
    reason: 'Conversational fallback (no browser action detected)',
    suggestedResponse: "I'm ready to help with browser automation. Tell me what webpage to open or what task you'd like me to perform on your active tab.",
  };
}
