/**
 * PrivAgent — OpenRouter / External LLM Provider (Milestone 5.3)
 *
 * Pluggable agent reasoning provider connecting sanitized M4 context to an LLM.
 *
 * Security Invariants:
 *  1. NEVER transmits raw sensitive values, passwords, OCR text, or screenshots.
 *  2. Sends ONLY sanitized M4 metadata (id, type, confidence, bbox).
 *  3. Context is verified via assertSanitizedContextSafe before formatting prompt.
 *  4. Requests strict structured JSON matching the BrowserAction schema.
 *  5. Output is NOT trusted: must still pass the local Action Validator before execution.
 */

import { AgentProvider } from './agentProvider';
import { BrowserAction, SUPPORTED_ACTION_TYPES } from './actionTypes';
import { AgentContextPayload } from '../privacy/types';
import { assertSanitizedContextSafe } from './privacyPolicy';

export interface OpenRouterConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export class OpenRouterProvider implements AgentProvider {
  readonly name = 'OpenRouterProvider';

  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: OpenRouterConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model || 'openai/gpt-4o-mini';
    this.baseUrl = config.baseUrl || 'https://openrouter.ai/api/v1/chat/completions';
  }

  async requestAction(task: string, context: AgentContextPayload): Promise<BrowserAction> {
    // 1. Enforce local privacy boundary on outgoing payload
    assertSanitizedContextSafe(context);

    // 2. Prepare safe element summaries (strictly allowlisted fields: id, type, bbox, confidence)
    const elementSummaries = context.detections.map((d) => ({
      id: d.id,
      type: d.type,
      confidence: d.confidence,
      bbox: d.bbox,
    }));

    const systemPrompt = [
      'You are a lightweight browser automation agent.',
      'You are provided with a user task and sanitized page metadata.',
      'You must respond ONLY with a single valid JSON object representing a browser action.',
      'Supported actions:',
      '- { "action": "click", "target": "<element_id>", "reason": "..." }',
      '- { "action": "scroll", "direction": "up"|"down", "amount": <1-5000>, "reason": "..." }',
      '- { "action": "type", "target": "<element_id>", "text": "...", "reason": "..." }',
      '- { "action": "select", "target": "<element_id>", "option": "...", "reason": "..." }',
      '- { "action": "navigate", "url": "https://...", "reason": "..." }',
      'Target element IDs MUST match one of the element IDs provided.',
      'Do not include markdown code fences or conversational text. Output raw JSON only.',
    ].join('\n');

    const userPrompt = [
      `User Task: "${task}"`,
      `Current URL: ${context.url}`,
      `Available Elements (sanitized metadata only):`,
      JSON.stringify(elementSummaries, null, 2),
    ].join('\n\n');

    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://github.com/akashgoudsidduluri/PrivAgent',
        'X-Title': 'PrivAgent Browser Agent',
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenRouter API error (HTTP ${response.status}): ${errText}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('LLM returned an empty response.');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content.trim());
    } catch {
      throw new Error(`LLM output could not be parsed as JSON: ${content}`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('LLM output is not a valid JSON object.');
    }

    return parsed as BrowserAction;
  }
}
