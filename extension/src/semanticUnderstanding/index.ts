/**
 * PrivAgent 2.0 — Semantic Browser Understanding Master Entry Point (Phase 3)
 *
 * Coordinates full semantic browser comprehension:
 *   - Page Classification (P3.1)
 *   - Entity Understanding (P3.2)
 *   - Semantic Relationships (P3.3)
 *   - Action Affordances (P3.4)
 *   - Page State Detection (P3.5)
 *   - Workflow State Observation (P3.6)
 *   - Goal Relevance Scoring (P3.7)
 *   - Sanitized Semantic Context (P3.8)
 *   - Uncertainty Calibration (P3.9)
 *   - Stale Generation Invalidation (P3.10)
 *   - Prompt Injection Defense (P3.11)
 */

import { BrowserWorldModel } from '../worldModel/types';
import { classifyPageSemantics } from './pageClassifier';
import { extractSemanticEntities } from './entityUnderstanding';
import { buildSemanticRelationships } from './semanticRelations';
import { discoverActionAffordances } from './actionAffordance';
import { detectPageState } from './pageState';
import { observeWorkflowState } from './workflowState';
import { evaluateGoalRelevance } from './goalRelevance';
import {
  createSanitizedSemanticContext,
  inspectPageForPromptInjection,
} from './semanticContext';
import { SemanticUnderstandingOutput } from './semanticTypes';

export * from './semanticTypes';
export * from './pageClassifier';
export * from './entityUnderstanding';
export * from './semanticRelations';
export * from './actionAffordance';
export * from './pageState';
export * from './workflowState';
export * from './goalRelevance';
export * from './semanticContext';

export interface SemanticUnderstandingOptions {
  worldModel?: BrowserWorldModel;
  root?: Document | HTMLElement;
  pageGeneration?: number;
  userGoal?: string;
}

export function buildSemanticUnderstanding(
  options: SemanticUnderstandingOptions = {}
): SemanticUnderstandingOutput {
  const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const pageGeneration = options.pageGeneration ?? options.worldModel?.page?.pageGeneration ?? 1;

  // 1. Page Semantic Classification (P3.1)
  const pageClassification = classifyPageSemantics({
    worldModel: options.worldModel,
    root: options.root,
    pageGeneration,
  });

  // 2. Entity Understanding (P3.2)
  const entities = extractSemanticEntities({
    worldModel: options.worldModel,
    root: options.root,
    pageGeneration,
  });

  // 3. Semantic Relationships (P3.3)
  const relationships = buildSemanticRelationships({
    entities,
    worldModel: options.worldModel,
    root: options.root,
    pageGeneration,
  });

  // 4. Action Affordances (P3.4)
  const affordances = discoverActionAffordances({
    pageType: pageClassification.pageType,
    worldModel: options.worldModel,
    root: options.root,
    pageGeneration,
  });

  // 5. Page State Detection (P3.5)
  const pageState = detectPageState({
    worldModel: options.worldModel,
    root: options.root,
    pageGeneration,
  });

  // 6. Workflow State Observation (P3.6)
  const workflowState = observeWorkflowState({
    pageType: pageClassification.pageType,
    pageState: pageState.state,
    worldModel: options.worldModel,
    root: options.root,
    pageGeneration,
  });

  // 7. Goal Relevance Scoring (P3.7)
  const goalRelevance = options.userGoal
    ? evaluateGoalRelevance({
        userGoal: options.userGoal,
        entities,
        affordances,
      })
    : undefined;

  // 8. Prompt Injection Defense (P3.11)
  const promptInjection = inspectPageForPromptInjection(options.root, options.worldModel);

  // 9. Sanitized Semantic Context Assembly (P3.8)
  const sanitizedContext = createSanitizedSemanticContext({
    pageClassification,
    entities,
    affordances,
    pageState,
    workflowState,
    goalRelevance,
    root: options.root,
    pageGeneration,
  });

  const endTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const analysisDurationMs = Math.round((endTime - startTime) * 100) / 100;

  return {
    pageClassification,
    entities,
    relationships,
    affordances,
    pageState,
    workflowState,
    goalRelevance,
    promptInjection,
    sanitizedContext,
    analysisDurationMs,
  };
}
