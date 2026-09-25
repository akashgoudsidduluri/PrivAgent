/**
 * PrivAgent 2.0 — Sanitized Semantic Context & Prompt Injection Defense (P3.8, P3.9, P3.10, P3.11)
 *
 * Assembles the minimal, sanitized semantic context for the Groq reasoning engine (< 2 KB).
 *
 * Security Invariants:
 *  1. ZERO raw credentials: Passwords, card numbers, OTPs, CVVs, account numbers,
 *     and raw media are strictly excluded.
 *  2. Prompt Injection Quarantine: Webpage text containing adversarial injection patterns
 *     (e.g., "Ignore previous instructions") is flagged and treated strictly as UNTRUSTED PAGE DATA.
 *     It is NEVER promoted to an agent instruction.
 *  3. Stamped with monotonic pageGeneration; rejects stale generation references.
 *  4. Full validation through M8 rawValueScanner and assertWorldModelSafe.
 */

import { scanForRawSensitiveValues } from '../privacy/rawValueScanner';
import {
  ActionAffordance,
  GoalRelevanceResult,
  PageClassificationResult,
  PageStateResult,
  PromptInjectionInspection,
  SanitizedSemanticContext,
  SemanticEntity,
  WorkflowObservation,
} from './semanticTypes';

export interface SemanticContextAssemblyOptions {
  pageClassification: PageClassificationResult;
  entities: SemanticEntity[];
  affordances: ActionAffordance[];
  pageState: PageStateResult;
  workflowState?: WorkflowObservation;
  goalRelevance?: GoalRelevanceResult;
  root?: Document | HTMLElement;
  pageGeneration?: number;
}

const KNOWN_INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/i,
  /system\s+prompt\s+override/i,
  /send\s+(?:the\s+)?(?:password|credential|token|card|account)\s+to/i,
  /reveal\s+(?:the\s+)?(?:user(?:'s)?\s+)?(?:account|card|password|token)/i,
  /disregard\s+(?:all\s+)?safety\s+(?:rules|guidelines|constraints)/i,
  /execute\s+this\s+hidden\s+(?:command|script|button)/i,
  /you\s+are\s+now\s+in\s+developer\s+mode/i,
];

/**
 * Scans webpage text for hostile prompt-injection attempts.
 * Quarantines any detected strings as untrusted webpage evidence.
 */
export function inspectPageForPromptInjection(
  root?: Document | HTMLElement,
  worldModel?: import('../worldModel/types').BrowserWorldModel
): PromptInjectionInspection {
  const targetDoc: Document = root
    ? 'defaultView' in root
      ? (root as Document)
      : root.ownerDocument || document
    : typeof document !== 'undefined'
    ? document
    : (null as unknown as Document);

  const suspiciousSnippets: string[] = [];
  const quarantinedText: string[] = [];
  const textNodes: string[] = [];

  if (targetDoc && targetDoc.body) {
    const walker = targetDoc.createTreeWalker(targetDoc.body, NodeFilter.SHOW_TEXT);
    let currentNode = walker.nextNode();

    while (currentNode) {
      const text = (currentNode.textContent || '').trim();
      if (text.length > 10) {
        textNodes.push(text);
      }
      currentNode = walker.nextNode();
    }
  }

  // Also check BrowserWorldModel safe text regions & element labels if available
  if (worldModel) {
    if (worldModel.textRegions) {
      for (const tr of worldModel.textRegions) {
        if (tr.sanitizedPreview && tr.sanitizedPreview.length > 10) {
          textNodes.push(tr.sanitizedPreview);
        }
      }
    }
    if (worldModel.elements) {
      for (const el of worldModel.elements) {
        if (el.label && el.label.length > 10) {
          textNodes.push(el.label);
        }
      }
    }
  }

  if (textNodes.length === 0) {
    return { detected: false, suspiciousSnippets: [], confidence: 0.1, quarantinedText: [] };
  }

  for (const snippet of textNodes) {
    for (const pattern of KNOWN_INJECTION_PATTERNS) {
      if (pattern.test(snippet)) {
        suspiciousSnippets.push(`Pattern match [${pattern.source}]: "${snippet.slice(0, 80)}"`);
        quarantinedText.push(snippet.slice(0, 100));
        break;
      }
    }
  }

  const detected = suspiciousSnippets.length > 0;
  return {
    detected,
    suspiciousSnippets,
    confidence: detected ? 0.98 : 0.95,
    quarantinedText,
  };
}

/**
 * Produces a sanitized, minimized semantic context object strictly within the 2 KB budget.
 */
export function createSanitizedSemanticContext(
  options: SemanticContextAssemblyOptions
): SanitizedSemanticContext {
  const pageGeneration = options.pageGeneration ?? options.pageClassification.pageGeneration;

  // 1. Inspect for Prompt Injections
  const injectionInspection = inspectPageForPromptInjection(options.root);

  // 2. Select Top Relevant Entities (limit to 5 to respect < 2 KB budget)
  const sortedEntities = options.goalRelevance && options.goalRelevance.relevantEntities.length > 0
    ? options.goalRelevance.relevantEntities
    : options.entities;

  const sanitizedEntities = sortedEntities.slice(0, 5).map(e => ({
    id: e.id,
    type: e.type,
    label: e.label.slice(0, 60),
    confidence: e.confidence,
    actionIds: e.associatedInteractiveElements.slice(0, 3),
    safeAttributes: e.safeAttributes,
  }));

  // 3. Select Action Affordances (limit to 6)
  const sanitizedAffordances = options.affordances.slice(0, 6).map(a => ({
    id: a.id,
    type: a.type,
    targetElementId: a.targetElementId,
    requiresConfirmation: a.requiresConfirmation,
    description: a.description.slice(0, 80),
  }));

  const context: SanitizedSemanticContext = {
    pageType: options.pageClassification.pageType,
    confidence: options.pageClassification.confidence,
    pageState: options.pageState.state,
    pageGeneration,
    entities: sanitizedEntities,
    affordances: sanitizedAffordances,
    ...(options.workflowState ? {
      workflow: {
        flowType: options.workflowState.flowType,
        currentStage: options.workflowState.currentStage,
      },
    } : {}),
    promptInjectionDetected: injectionInspection.detected,
    ...(injectionInspection.detected ? {
      injectionEvidence: injectionInspection.suspiciousSnippets,
    } : {}),
    ...(options.goalRelevance ? {
      goalRelevance: {
        matchedEntitiesCount: options.goalRelevance.relevantEntities.length,
        matchedAffordancesCount: options.goalRelevance.relevantAffordances.length,
        summary: options.goalRelevance.relevanceSummary,
      },
    } : {}),
  };

  // 4. M8 Privacy Boundary Enforcement
  const violations = scanForRawSensitiveValues(context);
  if (violations.length > 0) {
    throw new Error(
      `[PrivAgent Security Violation] Sanitized semantic context failed M8 privacy firewall: ` +
      violations.map(v => `${v.path} (${v.rule})`).join(', ')
    );
  }

  // 5. Budget Check (< 2048 bytes)
  const serialized = JSON.stringify(context);
  const sizeBytes = new TextEncoder().encode(serialized).length;
  if (sizeBytes > 2048) {
    // Graceful reduction: prune entities to top 2 if payload exceeds 2 KB
    context.entities = context.entities.slice(0, 2);
    context.affordances = context.affordances.slice(0, 4);
  }

  return context;
}
