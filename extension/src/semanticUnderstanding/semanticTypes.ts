/**
 * PrivAgent 2.0 — Semantic Browser Understanding Types (Phase 3)
 *
 * Core contracts for semantic page classification, entity models,
 * typed relationships, action affordances, page/workflow states,
 * and sanitized semantic context for LLM reasoning.
 */

import { PerceptionSource } from '../visualPerception/visualTypes';

export type SemanticPageType =
  | 'SEARCH'
  | 'LOGIN'
  | 'ARTICLE'
  | 'LISTING'
  | 'FORM'
  | 'CHECKOUT'
  | 'SETTINGS'
  | 'DASHBOARD'
  | 'ERROR'
  | 'UNKNOWN';

export interface PageClassificationResult {
  pageType: SemanticPageType;
  confidence: number;
  evidence: string[];
  pageGeneration: number;
  secondaryCandidates?: Array<{
    type: SemanticPageType;
    confidence: number;
  }>;
}

export type SemanticEntityType =
  | 'Product'
  | 'Article'
  | 'SearchResult'
  | 'Transaction'
  | 'TableRow'
  | 'Form'
  | 'UserProfile'
  | 'NavigationItem'
  | 'Category'
  | 'Image'
  | 'Video'
  | 'GenericEntity';

export interface SemanticEntity {
  id: string;
  type: SemanticEntityType;
  label: string;
  confidence: number;
  bbox?: [number, number, number, number];
  source: PerceptionSource;
  associatedInteractiveElements: string[];
  pageGeneration: number;
  safeAttributes: Record<string, string | number | boolean>;
}

export type TypedSemanticRelation =
  | 'HAS_PRICE'
  | 'HAS_IMAGE'
  | 'HAS_ACTION'
  | 'BELONGS_TO_CATEGORY'
  | 'HAS_AUTHOR'
  | 'HAS_DATE'
  | 'HAS_LINK'
  | 'HAS_FIELD'
  | 'HAS_SUBMIT_ACTION'
  | 'REQUIRES_AUTHENTICATION'
  | 'REPRESENTS_ENTITY'
  | 'CONTAINS_VALUE';

export interface SemanticRelationship {
  sourceId: string;
  targetId: string;
  relation: TypedSemanticRelation;
  confidence: number;
  evidence: string;
  pageGeneration: number;
}

export type ActionAffordanceType =
  // Search
  | 'ENTER_QUERY'
  | 'SUBMIT_SEARCH'
  | 'SELECT_RESULT'
  | 'PAGINATE'
  | 'SCROLL'
  // Product
  | 'SELECT_VARIANT'
  | 'ADD_TO_CART'
  | 'BUY_NOW'
  | 'NAVIGATE_IMAGES'
  | 'VIEW_DETAILS'
  // Login
  | 'ENTER_USERNAME'
  | 'ENTER_PASSWORD_LOCAL'
  | 'SUBMIT_LOGIN'
  // Form
  | 'FILL_FIELD'
  | 'SELECT_OPTION'
  | 'SUBMIT_FORM'
  | 'CANCEL_FORM'
  // Checkout
  | 'REVIEW_ORDER'
  | 'SELECT_ADDRESS'
  | 'SELECT_PAYMENT'
  | 'SUBMIT_ORDER'
  // Generic
  | 'GENERIC_CLICK';

export interface ActionAffordance {
  id: string;
  type: ActionAffordanceType;
  targetElementId?: string;
  confidence: number;
  description: string;
  requiresConfirmation: boolean;
  pageGeneration: number;
  source: PerceptionSource;
}

export type SemanticPageState =
  | 'loading'
  | 'loaded'
  | 'empty'
  | 'populated'
  | 'error'
  | 'modal_open'
  | 'login_required'
  | 'results_available'
  | 'no_results'
  | 'form_incomplete'
  | 'form_complete'
  | 'checkout_ready'
  | 'confirmation_required';

export interface PageStateResult {
  state: SemanticPageState;
  confidence: number;
  evidence: string[];
  pageGeneration: number;
  isFormReady?: boolean;
  hasModal?: boolean;
}

export type WorkflowFlowType =
  | 'SEARCH'
  | 'SHOPPING'
  | 'LOGIN'
  | 'FORM_SUBMISSION'
  | 'GENERAL_BROWSING';

export type WorkflowStage =
  | 'INITIAL'
  | 'QUERY_ENTERED'
  | 'SEARCH_SUBMITTED'
  | 'RESULTS_LOADED'
  | 'RESULT_SELECTED'
  | 'LISTING_VIEWED'
  | 'PRODUCT_OPENED'
  | 'VARIANT_SELECTED'
  | 'CART_UPDATED'
  | 'CHECKOUT_STAGE'
  | 'LOGIN_PAGE'
  | 'CREDENTIALS_ENTERED_LOCAL'
  | 'SUBMISSION_PENDING'
  | 'AUTHENTICATED'
  | 'FORM_FILLING'
  | 'FORM_SUBMITTED';

export interface WorkflowObservation {
  flowType: WorkflowFlowType;
  currentStage: WorkflowStage;
  confidence: number;
  evidence: string[];
  pageGeneration: number;
}

export interface GoalRelevanceResult {
  matchedGoalTerms: string[];
  relevantEntities: SemanticEntity[];
  relevantAffordances: ActionAffordance[];
  confidence: number;
  relevanceSummary: string;
  isGoalPotentiallySatisfied: boolean;
}

export interface PromptInjectionInspection {
  detected: boolean;
  suspiciousSnippets: string[];
  confidence: number;
  quarantinedText: string[];
}

export interface SanitizedSemanticContext {
  pageType: SemanticPageType;
  confidence: number;
  pageState: SemanticPageState;
  pageGeneration: number;
  entities: Array<{
    id: string;
    type: SemanticEntityType;
    label: string;
    confidence: number;
    actionIds: string[];
    safeAttributes?: Record<string, string | number | boolean>;
  }>;
  affordances: Array<{
    id: string;
    type: ActionAffordanceType;
    targetElementId?: string;
    requiresConfirmation: boolean;
    description: string;
  }>;
  workflow?: {
    flowType: WorkflowFlowType;
    currentStage: WorkflowStage;
  };
  promptInjectionDetected: boolean;
  injectionEvidence?: string[];
  goalRelevance?: {
    matchedEntitiesCount: number;
    matchedAffordancesCount: number;
    summary: string;
  };
}

export interface SemanticUnderstandingOutput {
  pageClassification: PageClassificationResult;
  entities: SemanticEntity[];
  relationships: SemanticRelationship[];
  affordances: ActionAffordance[];
  pageState: PageStateResult;
  workflowState: WorkflowObservation;
  goalRelevance?: GoalRelevanceResult;
  promptInjection: PromptInjectionInspection;
  sanitizedContext: SanitizedSemanticContext;
  analysisDurationMs: number;
}
