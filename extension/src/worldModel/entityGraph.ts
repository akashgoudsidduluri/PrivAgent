/**
 * PrivAgent 2.0 — Deterministic Entity & Semantic Relationship Graph (Phase 1)
 *
 * Derives high-level web entities (Products, Search Results, Form Sections,
 * Table Rows, Articles) and builds deterministic semantic relationships
 * between entities and interactive controls.
 *
 * Security & Privacy Invariants:
 *  1. ZERO raw PII: Entities contain only structural, non-credential data.
 *  2. Semantic links are computed deterministically via DOM ancestry and geometry.
 *  3. No LLM hallucination: Relations are strictly derived from real DOM state.
 */

import { WorldEntity, SemanticRelationship, SemanticRelationType, DomWorldElement } from './types';
import { extractGenericEntities, CandidateEntity } from '../agent/candidateEntities';

function getBbox(el: HTMLElement): [number, number, number, number] {
  if (typeof el.getBoundingClientRect !== 'function') return [0, 0, 0, 0];
  const rect = el.getBoundingClientRect();
  const scrollX = typeof window !== 'undefined' ? window.scrollX || 0 : 0;
  const scrollY = typeof window !== 'undefined' ? window.scrollY || 0 : 0;
  return [
    Math.round(rect.left + scrollX),
    Math.round(rect.top + scrollY),
    Math.round(rect.width),
    Math.round(rect.height),
  ];
}

/**
 * Builds entities and semantic relationships from candidate entities and DOM elements.
 */
export function buildEntityGraph(
  elements: DomWorldElement[],
  root: Document | HTMLElement = document,
  pageGeneration: number = 1
): { entities: WorldEntity[]; relationships: SemanticRelationship[] } {
  const candidateEntities: CandidateEntity[] = extractGenericEntities(root);
  const entities: WorldEntity[] = [];
  const relationships: SemanticRelationship[] = [];

  const targetDoc = root
    ? 'defaultView' in root
      ? (root as Document)
      : root.ownerDocument || document
    : document;

  candidateEntities.forEach((cEntity) => {
    // Find container element if sourceElementId is provided or by ID
    let containerEl: HTMLElement | null = null;
    if (cEntity.sourceElementId) {
      containerEl = targetDoc.getElementById(cEntity.sourceElementId);
    }
    if (!containerEl) {
      containerEl = targetDoc.getElementById(cEntity.id);
    }

    const bbox: [number, number, number, number] = containerEl ? getBbox(containerEl) : [0, 0, 0, 0];
    const associatedIds: string[] = [];

    // If container element exists, discover associated constituent DOM elements
    if (containerEl) {
      // 1. Actions (Buttons or Links inside entity)
      const actionEls = Array.from(containerEl.querySelectorAll<HTMLElement>('button, a[href], input[type="submit"]'));
      actionEls.forEach((actEl) => {
        if (actEl.id) {
          associatedIds.push(actEl.id);
          relationships.push({
            sourceId: cEntity.id,
            targetId: actEl.id,
            relation: 'HAS_ACTION',
            confidence: 1.0,
          });
        }
      });

      // 2. Titles (Headings inside entity)
      const titleEl = containerEl.querySelector<HTMLElement>('h1, h2, h3, h4, .title, .product-title, .result-title');
      if (titleEl && titleEl.id) {
        associatedIds.push(titleEl.id);
        relationships.push({
          sourceId: cEntity.id,
          targetId: titleEl.id,
          relation: 'HAS_TITLE',
          confidence: 1.0,
        });
      }

      // 3. Images inside entity
      const imgEl = containerEl.querySelector<HTMLElement>('img');
      if (imgEl && imgEl.id) {
        associatedIds.push(imgEl.id);
        relationships.push({
          sourceId: cEntity.id,
          targetId: imgEl.id,
          relation: 'HAS_IMAGE',
          confidence: 1.0,
        });
      }

      // 4. Price element
      const priceEl = containerEl.querySelector<HTMLElement>('.price, .product-price');
      if (priceEl && priceEl.id) {
        associatedIds.push(priceEl.id);
        relationships.push({
          sourceId: cEntity.id,
          targetId: priceEl.id,
          relation: 'HAS_PRICE',
          confidence: 1.0,
        });
      }
    }

    // Also link any DomWorldElement whose bbox is geometrically INSIDE this entity
    elements.forEach((domEl) => {
      if (domEl.id === cEntity.id) return;
      if (containerEl && containerEl.contains(targetDoc.getElementById(domEl.id))) {
        if (!associatedIds.includes(domEl.id)) {
          associatedIds.push(domEl.id);
          relationships.push({
            sourceId: cEntity.id,
            targetId: domEl.id,
            relation: 'CONTAINS' as any,
            confidence: 0.95,
          });
        }
      }
    });

    entities.push({
      id: cEntity.id,
      type: cEntity.type,
      title: cEntity.title,
      bbox,
      associatedElementIds: Array.from(new Set(associatedIds)),
      attributes: cEntity.attributes || {},
      confidence: 1.0,
      pageGeneration,
    });
  });

  // 5. Form input and label relationships
  elements.forEach((el) => {
    if (el.tag === 'input' || el.tag === 'select' || el.tag === 'textarea') {
      const labelEl = targetDoc.querySelector<HTMLElement>(`label[for="${el.id}"]`);
      if (labelEl && labelEl.id) {
        relationships.push({
          sourceId: labelEl.id,
          targetId: el.id,
          relation: 'LABEL_FOR',
          confidence: 1.0,
        });
      }

      // Form submit association
      const form = targetDoc.getElementById(el.id)?.closest('form');
      if (form) {
        const submitBtn = form.querySelector<HTMLElement>('button[type="submit"], input[type="submit"]');
        if (submitBtn && submitBtn.id && submitBtn.id !== el.id) {
          relationships.push({
            sourceId: el.id,
            targetId: submitBtn.id,
            relation: 'SUBMIT_FOR',
            confidence: 0.9,
          });
        }
      }
    }
  });

  return { entities, relationships };
}
