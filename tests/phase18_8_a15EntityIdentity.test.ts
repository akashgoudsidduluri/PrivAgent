/**
 * PHASE 18.8 / A15 — CROSS-PAGE ENTITY IDENTITY.
 *
 * A DOM detection id is page-local, so identity must come from OBSERVED safe
 * attributes. These tests hold identity stable across page generations,
 * navigation, changed detection ids, changed layout and equivalent URLs — and
 * hold it FAILS CLOSED when the entity cannot be re-established: no silent
 * substitution, no raw value as an identity key.
 */
import { describe, it, expect } from 'vitest';

import {
  buildIdentity,
  canonicalizeUrl,
  createCandidate,
  identifierFromUrl,
  type EntityCandidate,
} from '../extension/src/agent/conversationContext';
import {
  candidatesFromWorldModel,
  candidateAt,
  revalidateAgainstRecorded,
  revalidateSelection,
} from '../extension/src/agent/entityIdentity';
import { conversationPrivacyViolations } from '../extension/src/agent/conversationPersistence';
import type { BrowserWorldModel, WorldEntity } from '../extension/src/worldModel/types';

const NOW = 1_760_000_000_000;
const CATALOG = 'https://shop.example.com/catalog';
const DETAIL = 'https://shop.example.com/product?id=xyz-9';
const PAN = '4111 1111 1111 1111';

function entity(over: Partial<WorldEntity> & { id: string; title: string }): WorldEntity {
  return {
    type: 'Product',
    bbox: [100, 100, 200, 40],
    associatedElementIds: [],
    attributes: {},
    confidence: 0.9,
    pageGeneration: 2,
    ...over,
  } as WorldEntity;
}

function worldModel(entities: WorldEntity[], pageUrl = CATALOG, pageGeneration = 2): BrowserWorldModel {
  return {
    page: { url: pageUrl, pageGeneration, pageType: 'listing' },
    entities,
  } as unknown as BrowserWorldModel;
}

function selectionOf(candidate: EntityCandidate) {
  return { identityKey: candidate.identity.identityKey, ordinal: candidate.ordinal, identity: candidate.identity };
}

describe('A15-1 identity is observed, not page-local', () => {
  it('1.1 the same product keeps its identity when every detection id changes', () => {
    const first = candidatesFromWorldModel(
      worldModel([entity({ id: 'el-17', title: 'XYZ Wireless Headphones' })]),
      NOW
    );
    const second = candidatesFromWorldModel(
      worldModel([entity({ id: 'zz-9001', title: 'XYZ Wireless Headphones' })], CATALOG, 5),
      NOW + 10
    );
    expect(second[0]!.identity.identityKey).toBe(first[0]!.identity.identityKey);
    // The page-local id is NOT part of identity.
    expect(first[0]!.identity.identityKey).not.toContain('el-17');
  });

  it('1.2 identity survives a page generation change and a re-layout', () => {
    const before = candidatesFromWorldModel(
      worldModel([
        entity({ id: 'a', title: 'Alpha', bbox: [10, 10, 10, 10] }),
        entity({ id: 'b', title: 'Beta', bbox: [10, 60, 10, 10] }),
      ]),
      NOW
    );
    // A re-layout that REVERSES the visual order.
    const after = candidatesFromWorldModel(
      worldModel([
        entity({ id: 'x', title: 'Beta', bbox: [300, 50, 10, 10], pageGeneration: 9 }),
        entity({ id: 'y', title: 'Alpha', bbox: [300, 400, 10, 10], pageGeneration: 9 }),
      ], CATALOG, 9),
      NOW + 5
    );
    const alphaBefore = before.find((c) => c.identity.normalizedTitle === 'alpha')!;
    const alphaAfter = after.find((c) => c.identity.normalizedTitle === 'alpha')!;
    expect(alphaAfter.identity.identityKey).toBe(alphaBefore.identity.identityKey);
    // Ordinals follow OBSERVED order, so they legitimately change with the layout.
    expect(alphaAfter.ordinal).not.toBe(alphaBefore.ordinal);
  });

  it('1.3 equivalent canonical URLs produce one identity', () => {
    const variants = [
      'https://shop.example.com/product?id=xyz-9',
      'https://Shop.Example.com:443/product/?id=XYZ-9',
      'https://www.shop.example.com/product?id=xyz-9&utm_source=email',
    ];
    const keys = new Set(variants.map((url) => buildIdentity({ entityType: 'PRODUCT', title: 'X', url })!.identityKey));
    expect(keys.size).toBe(1);
    expect(canonicalizeUrl(variants[2]!)).toBe('https://shop.example.com/product?id=xyz-9');
  });

  it('1.4 different products never collide', () => {
    const a = buildIdentity({ entityType: 'PRODUCT', title: 'XYZ Wireless Headphones', url: DETAIL })!;
    const b = buildIdentity({ entityType: 'PRODUCT', title: 'XYZ Wireless Headphones Pro', url: DETAIL })!;
    expect(a.identityKey).not.toBe(b.identityKey);
  });

  it('1.5 observed attributes travel with identity but do not define it', () => {
    // Identity is kind + title + canonical URL + identifier. A price change must
    // NOT break identity (the same product is still the same product), and the
    // observed price is carried as bounded, screened context for A16 to judge
    // freshness against.
    const cheap = buildIdentity({
      entityType: 'PRODUCT',
      title: 'XYZ Wireless Headphones',
      url: DETAIL,
      attributes: { price: 899, rating: 4.4 },
    })!;
    const dear = buildIdentity({
      entityType: 'PRODUCT',
      title: 'XYZ Wireless Headphones',
      url: DETAIL,
      attributes: { price: 1299, rating: 4.1 },
    })!;
    expect(cheap.identityKey).toBe(dear.identityKey);
    expect(cheap.attributes.price).toBe(899);
    expect(dear.attributes.price).toBe(1299);
    expect(Object.keys(cheap.attributes).length).toBeLessThanOrEqual(6);
  });

  it('1.6 a catalog identifier in a data attribute defines identity', () => {
    const fromAttribute = buildIdentity({
      entityType: 'PRODUCT',
      title: 'XYZ Wireless Headphones',
      url: CATALOG,
      attributes: { 'data-product-id': 'xyz-9', price: 899 },
    })!;
    expect(fromAttribute.productId).toBe('xyz-9');
    expect(identifierFromUrl(DETAIL)).toBe('xyz-9');
  });
});

describe('A15-2 revalidation across navigation', () => {
  it('2.1 the detail page of the selected entity REVALIDATES it', () => {
    const listing = candidatesFromWorldModel(
      worldModel([entity({ id: 'el-3', title: 'XYZ Wireless Headphones', attributes: { 'data-product-id': 'xyz-9' } })]),
      NOW
    );
    const recorded = listing[0]!;
    expect(recorded.identity.productId).toBe('xyz-9');
    // The detail page no longer lists the product as a candidate.
    const detail = candidatesFromWorldModel(worldModel([], DETAIL, 7), NOW + 20);
    const result = revalidateAgainstRecorded(recorded.identity, detail, DETAIL);
    expect(result.verdict).toBe('REVALIDATED');
    expect(result.identity?.identityKey).toBe(recorded.identity.identityKey);
  });

  it('2.2 an unrelated page does NOT revalidate it — and never substitutes', () => {
    const listing = candidatesFromWorldModel(worldModel([entity({ id: 'el-3', title: 'XYZ Wireless Headphones' })]), NOW);
    const recorded = listing[0]!;
    const elsewhere = candidatesFromWorldModel(
      worldModel([entity({ id: 'q', title: 'Completely Other Item' })], 'https://other.example.com/catalog?id=z-1', 8),
      NOW + 30
    );
    const result = revalidateSelection(selectionOf(recorded), elsewhere, 'https://other.example.com/catalog?id=z-1');
    expect(result.verdict).toBe('NOT_FOUND');
    expect(result.identity).toBeNull();
    expect(result.ordinal).toBeNull();
  });

  it('2.3 the same title with a DIFFERENT identifier is a conflict, not a match', () => {
    const recorded = buildIdentity({
      entityType: 'PRODUCT',
      title: 'XYZ Wireless Headphones',
      url: 'https://shop.example.com/product?id=aaa-1',
    })!;
    const other = [
      createCandidate({
        ordinal: 1,
        identity: buildIdentity({
          entityType: 'PRODUCT',
          title: 'XYZ Wireless Headphones',
          url: 'https://shop.example.com/product?id=bbb-2',
        })!,
        pageGeneration: 4,
        observedAt: NOW,
      }),
    ];
    expect(revalidateAgainstRecorded(recorded, other, 'https://shop.example.com/product?id=bbb-2').verdict).toBe(
      'UNCONFIRMED'
    );
  });

  it('2.4 two candidates with the same title are ambiguous, not a pick', () => {
    const recorded = buildIdentity({ entityType: 'PRODUCT', title: 'Twin Pack', url: DETAIL })!;
    const twins = ['https://shop.example.com/product?id=t-1', 'https://shop.example.com/product?id=t-2'].map(
      (url, i) =>
        createCandidate({
          ordinal: i + 1,
          identity: buildIdentity({ entityType: 'PRODUCT', title: 'Twin Pack', url })!,
          pageGeneration: 4,
          observedAt: NOW,
        })
    );
    expect(revalidateAgainstRecorded(recorded, twins, 'https://shop.example.com/product?id=t-1').code).toBe(
      'IDENTITY_CONFLICT'
    );
  });

  it('2.5 an empty observation never re-targets a selection', () => {
    const listing = candidatesFromWorldModel(worldModel([entity({ id: 'el-3', title: 'XYZ Wireless Headphones' })]), NOW);
    expect(revalidateSelection(selectionOf(listing[0]!), [], DETAIL).verdict).toBe('NOT_FOUND');
  });

  it('2.6 staying on the same page keeps the identity', () => {
    const listing = candidatesFromWorldModel(worldModel([entity({ id: 'el-3', title: 'XYZ Wireless Headphones' })]), NOW);
    const result = revalidateSelection(selectionOf(listing[0]!), listing, CATALOG);
    expect(result.verdict).toBe('REVALIDATED');
    expect(result.ordinal).toBe(1);
  });

  it('2.7 a selection with NO recorded identity never resolves to anything', () => {
    const elsewhere = candidatesFromWorldModel(
      worldModel([entity({ id: 'q', title: 'Some Other Item' })], 'https://other.example.com/c?id=z-2', 8),
      NOW + 40
    );
    // No identity recorded: identityKey alone must not authorize a match.
    expect(revalidateSelection({ identityKey: 'deadbeef', ordinal: 2 }, elsewhere, 'https://other.example.com/c?id=z-2')).toEqual({
      verdict: 'NOT_FOUND',
      identity: null,
      ordinal: null,
      code: 'IDENTITY_ABSENT',
    });
  });

  it('2.8 candidateAt never clamps out-of-range ordinals', () => {
    const listing = candidatesFromWorldModel(
      worldModel([
        entity({ id: 'a', title: 'Alpha' }),
        entity({ id: 'b', title: 'Beta', bbox: [10, 200, 10, 10] }),
      ]),
      NOW
    );
    expect(candidateAt(listing, 2)?.identity.normalizedTitle).toBe('beta');
    expect(candidateAt(listing, 3)).toBeNull();
    expect(candidateAt(listing, 0)).toBeNull();
  });
});

describe('A15-3 privacy of identity', () => {
  it('3.1 a sensitive title yields NO identity', () => {
    expect(buildIdentity({ entityType: 'PRODUCT', title: `card ${PAN}` })).toBeNull();
  });

  it('3.2 sensitive attributes and identifiers never enter identity', () => {
    const identity = buildIdentity({
      entityType: 'PRODUCT',
      title: 'XYZ Wireless Headphones',
      attributes: {
        cvv: '321',
        pin: '1234',
        accountNumber: PAN,
        password: 'hunter2',
        // Allow-listed KEYS carrying raw VALUES: the key filter alone must not
        // be what saves us here.
        brand: 'rachit.sharma@example.com',
        availability: PAN,
        price: 899,
      },
    })!;
    expect(conversationPrivacyViolations({ identity })).toEqual([]);
    expect(JSON.stringify(identity)).not.toContain(PAN);
    expect(JSON.stringify(identity)).not.toContain('hunter2');
    expect(JSON.stringify(identity)).not.toContain('example.com');
    expect(identity.attributes.price).toBe(899);
    expect(identity.attributes.availability).toBeUndefined();
    expect(identity.attributes.brand).toBeUndefined();
  });

  it('3.3 a URL carrying an email is not usable as identity', () => {
    expect(canonicalizeUrl('https://shop.example.com/p?email=rachit@example.com')).not.toContain('example.com@');
    const identity = buildIdentity({
      entityType: 'PRODUCT',
      title: 'XYZ',
      url: `https://shop.example.com/p?email=r${PAN.replace(/\s/g, '')}@example.com`,
    });
    expect(identity === null || !JSON.stringify(identity).includes(PAN.replace(/\s/g, ''))).toBe(true);
  });

  it('3.4 candidates built from a world model carry no raw value', () => {
    const candidates = candidatesFromWorldModel(
      worldModel([
        entity({ id: 'el-1', title: 'XYZ Wireless Headphones', attributes: { price: 899, card: PAN } }),
        entity({ id: 'el-2', title: `Account ${PAN}`, bbox: [10, 200, 10, 10] }),
      ]),
      NOW
    );
    expect(JSON.stringify(candidates)).not.toContain(PAN.replace(/\s/g, ''));
    expect(conversationPrivacyViolations({ candidates })).toEqual([]);
    // The unsafe title was refused entirely; the safe one survives.
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.identity.normalizedTitle).toBe('xyz wireless headphones');
  });

  // ── Real-Chrome defect, fixed at the source ──────────────────────────────
  // The first multiturn run observed `selectedProductId: null` on the catalog
  // page. `extractGenericEntities` had already coerced `data-product-id="3"`
  // to the NUMBER 3, and `buildIdentity` only read identifiers out of STRING
  // attributes — so the one value that survives the jump to the detail page
  // was thrown away, and identity had nothing to re-establish itself with.

  it('3.5 a NUMERIC catalog identifier becomes the entity product id', () => {
    const identity = buildIdentity({
      entityType: 'PRODUCT',
      title: 'Red Canvas Baggy Gym Bag',
      url: CATALOG,
      attributes: { productId: 3, price: 699 },
    });
    expect(identity?.productId).toBe('3');
  });

  it('3.6 the catalog id carries the entity across to its own detail page', () => {
    const listing = candidatesFromWorldModel(
      worldModel([
        entity({ id: 'product-red-bag-699', title: 'Red Canvas Baggy Gym Bag', attributes: { productId: 3 } }),
        entity({ id: 'product-blue-bag-950', title: 'XXL Blue Baggy Duffel Bag', attributes: { productId: 4 }, bbox: [10, 300, 10, 10] }),
      ]),
      NOW
    );
    const third = candidateAt(listing, 1)!;

    // A DIFFERENT page generation, a DIFFERENT DOM detection id, and a detail
    // URL whose path identifies nothing — only the catalog id is shared.
    const detail = candidatesFromWorldModel(
      worldModel(
        [entity({ id: 'product-detail-card', title: 'Red Canvas Baggy Gym Bag', attributes: { productId: 3 } })],
        'http://127.0.0.1:4174/product.html?id=3',
        9
      ),
      NOW + 5_000
    );

    expect(third.identity.identityKey).not.toBe(detail[0]!.identity.identityKey); // page-scoped hash
    expect(third.ordinal).toBe(1);
    expect(third.pageGeneration).not.toBe(detail[0]!.pageGeneration);

    const revalidated = revalidateSelection(
      { identityKey: third.identity.identityKey, ordinal: third.ordinal, identity: third.identity },
      detail,
      'http://127.0.0.1:4174/product.html?id=3'
    );
    expect(revalidated.verdict).toBe('REVALIDATED');
    expect(revalidated.identity?.productId).toBe('3');
    expect(revalidated.code).toBe('TITLE_AND_ID_MATCH');
  });

  it('3.7 a numeric identifier is still screened, never a raw value', () => {
    const identity = buildIdentity({
      entityType: 'PRODUCT',
      title: 'Gadget',
      url: CATALOG,
      attributes: { accountId: 4111111111111111, productId: 3 },
    });
    // The digit run is bounded out; the ordinary catalog id still stands.
    expect(identity?.productId).toBe('3');
    expect(JSON.stringify(identity)).not.toContain('4111111111111111');
  });

  it('3.8 a SHORT numeric attribute that trips the raw-value scanner is still refused', () => {
    // 10 digits fits the length bound, so the raw-value screen is the only
    // thing standing between a phone/account number and the identity.
    const identity = buildIdentity({
      entityType: 'PRODUCT',
      title: 'Gadget',
      url: CATALOG,
      attributes: { sku: 9876543210, productId: 3 },
    });
    expect(JSON.stringify(identity)).not.toContain('9876543210');
    expect(identity?.productId).toBe('3');
  });
});