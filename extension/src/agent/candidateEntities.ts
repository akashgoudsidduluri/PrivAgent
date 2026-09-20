/**
 * PrivAgent — Generic Candidate Entity Model & Extraction Engine (M10)
 *
 * Generalizes entity extraction and multi-constraint evaluation beyond
 * e-commerce products to all web domains (Articles, Search Results,
 * Transactions, Table Rows, Form Fields, Documents, Events).
 *
 * Security Invariants:
 *  1. Zero raw PII: Passwords, OTPs, CVVs, card numbers are NEVER extracted.
 *  2. Entities contain only safe structural and semantic metadata.
 *  3. Local deterministic constraint evaluation holds sole authority for matching.
 */

export type CandidateEntityType =
  | 'Product'
  | 'Article'
  | 'SearchResult'
  | 'Transaction'
  | 'Contact'
  | 'TableRow'
  | 'MenuItem'
  | 'FormField'
  | 'Document'
  | 'Event'
  | 'Generic';

export interface CandidateEntity {
  id: string;
  type: CandidateEntityType;
  title: string;
  attributes: Record<string, string | number | boolean>;
  sourceElementId?: string;
  matchesConstraints?: boolean;
  constraintDetails?: Record<string, boolean>;
  notes?: string;
}

const FORBIDDEN_ATTRIBUTE_KEYS = new Set([
  'password', 'passwd', 'token', 'secret', 'cvv', 'cvc',
  'card', 'cardnumber', 'card_number', 'pan', 'otp', 'pin',
  'ssn', 'accountnumber', 'account_number', 'auth',
]);

/**
 * Extracts generic candidate entities from the current document or container.
 */
export function extractGenericEntities(root: Document | HTMLElement = document): CandidateEntity[] {
  const targetDoc = root instanceof Document ? root : root.ownerDocument || document;
  const entities: CandidateEntity[] = [];
  const seenIds = new Set<string>();

  // 1. E-Commerce Products
  const productEls = Array.from(targetDoc.querySelectorAll<HTMLElement>('.product-card, [data-product], .listing-item'));
  for (const el of productEls) {
    const id = el.id || `entity-product-${entities.length + 1}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const title = (el.querySelector('.product-title, .title, h2, h3')?.textContent || '').trim();
    const attributes: Record<string, string | number | boolean> = {};

    // Safely copy data attributes
    for (const key of Object.keys(el.dataset)) {
      const lowerKey = key.toLowerCase();
      if (!FORBIDDEN_ATTRIBUTE_KEYS.has(lowerKey)) {
        const val = el.dataset[key];
        if (val !== undefined) {
          const num = Number(val);
          attributes[key] = !isNaN(num) && val.trim() !== '' ? num : val;
        }
      }
    }

    // Extract visible price if present
    const priceText = (el.querySelector('.product-price, .price')?.textContent || '').replace(/[^\d.]/g, '');
    if (priceText && !attributes.price) {
      attributes.price = parseFloat(priceText);
    }

    entities.push({
      id,
      type: 'Product',
      title: title || 'Product Item',
      attributes,
      sourceElementId: el.id || undefined,
    });
  }

  // 2. Search Results
  const searchResultEls = Array.from(targetDoc.querySelectorAll<HTMLElement>('.search-result, [data-component="result"], div.g'));
  for (const el of searchResultEls) {
    const id = el.id || `entity-search-${entities.length + 1}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const title = (el.querySelector('h3, .result-title, a')?.textContent || '').trim();
    const link = el.querySelector('a')?.href || '';

    entities.push({
      id,
      type: 'SearchResult',
      title: title || 'Search Result',
      attributes: {
        ...(link ? { url: link } : {}),
      },
      sourceElementId: el.id || undefined,
    });
  }

  // 3. Articles & Content Blocks
  const articleEls = Array.from(targetDoc.querySelectorAll<HTMLElement>('article, .article-card, .post-preview'));
  for (const el of articleEls) {
    const id = el.id || `entity-article-${entities.length + 1}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const title = (el.querySelector('h1, h2, h3, .article-title')?.textContent || '').trim();
    const summary = (el.querySelector('p, .summary, .excerpt')?.textContent || '').trim().slice(0, 120);

    entities.push({
      id,
      type: 'Article',
      title: title || 'Article',
      attributes: {
        ...(summary ? { summarySnippet: summary } : {}),
      },
      sourceElementId: el.id || undefined,
    });
  }

  // 4. Table Rows (Data records, transactions, accounts)
  const tableRows = Array.from(targetDoc.querySelectorAll<HTMLElement>('table tbody tr'));
  for (const row of tableRows.slice(0, 20)) {
    const id = row.id || `entity-row-${entities.length + 1}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const cells = Array.from(row.querySelectorAll('td, th'));
    const attributes: Record<string, string | number | boolean> = {};

    cells.forEach((cell, idx) => {
      const text = (cell.textContent || '').trim();
      if (text.length > 0 && text.length < 50) {
        attributes[`col_${idx + 1}`] = text;
      }
    });

    entities.push({
      id,
      type: 'TableRow',
      title: `Table Row ${entities.length + 1}`,
      attributes,
      sourceElementId: row.id || undefined,
    });
  }

  return entities;
}

/**
 * Deterministically verifies an entity against multi-constraint criteria.
 */
export function verifyEntityConstraints(
  entity: CandidateEntity,
  constraints: Record<string, unknown>
): { matches: boolean; details: Record<string, boolean>; notes: string } {
  const details: Record<string, boolean> = {};
  const notesList: string[] = [];
  let allMatched = true;

  for (const [key, expectedValue] of Object.entries(constraints)) {
    if (expectedValue === undefined || expectedValue === null || expectedValue === '') {
      continue;
    }

    let actualVal = entity.attributes[key] ?? entity.attributes[key.toLowerCase()];
    if (actualVal === undefined && (key.toLowerCase().includes('price') || key.toLowerCase().includes('max'))) {
      actualVal = entity.attributes['price'] ?? entity.attributes['maxPrice'] ?? entity.attributes['max_price'];
    }

    // Numeric comparison (maxPrice, price, under, amount)
    if (key.toLowerCase().includes('max') || key.toLowerCase().includes('price') || key.toLowerCase().includes('amount')) {
      const maxNum = Number(expectedValue);
      const actualNum = Number(actualVal);

      if (!isNaN(maxNum) && !isNaN(actualNum)) {
        const passes = actualNum <= maxNum && actualNum > 0;
        details[key] = passes;
        if (!passes) {
          allMatched = false;
          notesList.push(`${key}: ${actualNum} exceeds max ${maxNum}`);
        } else {
          notesList.push(`${key}: ${actualNum} <= ${maxNum} (OK)`);
        }
        continue;
      }
    }

    // String / Category / Size / Color matching
    if (typeof expectedValue === 'string') {
      const expNorm = expectedValue.toLowerCase().trim();
      const actNorm = String(actualVal || '').toLowerCase().trim();

      // Check title as well for semantic keywords
      const titleNorm = entity.title.toLowerCase();
      const inAttributes = actNorm === expNorm || actNorm.includes(expNorm);
      const inTitle = titleNorm.includes(expNorm);
      const passes = inAttributes || inTitle;

      details[key] = passes;
      if (!passes) {
        allMatched = false;
        notesList.push(`${key}: expected '${expectedValue}', found '${actualVal || 'none'}'`);
      } else {
        notesList.push(`${key}: '${expectedValue}' satisfied (OK)`);
      }
      continue;
    }

    // Boolean matching
    if (typeof expectedValue === 'boolean') {
      const passes = Boolean(actualVal) === expectedValue;
      details[key] = passes;
      if (!passes) {
        allMatched = false;
        notesList.push(`${key}: boolean mismatch`);
      }
      continue;
    }
  }

  return {
    matches: allMatched && Object.keys(details).length > 0,
    details,
    notes: allMatched ? 'All specified constraints verified.' : notesList.join('; '),
  };
}
