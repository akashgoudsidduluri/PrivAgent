/**
 * PHASE 18.7 / A2 — THE EVIDENCE LEDGER.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until now, evidence was implicit: a `SemanticFact` existed for exactly one
 * perception and was then thrown away. Nothing carried provenance, so nothing
 * could be cited, and nothing could be checked for freshness. The reasoner had
 * a flat list of strings with no way to say "this was observed on THIS page at
 * THIS generation".
 *
 * That is why an information task could never be completed truthfully. The
 * model could see the facts but had no verifiable thing to answer FROM, so the
 * only progress it could express was another browser action.
 *
 * WHAT THIS IS NOT
 * ----------------
 * This is NOT a second privacy boundary. Every string written here is screened
 * by the SAME authoritative `scanForRawSensitiveValues` used by the world-model
 * choke point, and injection shaping is judged by the SAME
 * `isInjectionShapedText` used by semantic observation. Adding a weaker scan
 * here would create exactly the second-path divergence I-7 exists to prevent,
 * so there is deliberately only one detector in the system.
 *
 * It is also NOT an authority. The ledger records what was OBSERVED. It never
 * decides a goal is met, never promotes a proposal, and grants nothing.
 *
 * INVARIANTS
 * ----------
 *  1. APPEND-ONLY. Records are never mutated in place except to be invalidated
 *     by a page-generation advance, which is a monotonic safety operation.
 *  2. BOUNDED. A ring buffer, so a long task cannot grow the context without
 *     limit.
 *  3. DETERMINISTIC IDS. Derived from (sourceUrl, generation, key), so the same
 *     observation twice produces one record, and two different pages do not.
 *  4. CONFLICTS ARE RETAINED, NEVER MERGED. Two different values for one key are
 *     both kept and both marked CONFLICTED, because silently picking one is how
 *     a system ends up asserting something unverified.
 *  5. STALE NEVER BECOMES CURRENT. Advancing the generation invalidates, it does
 *     not refresh.
 *  6. NO RAW VALUES. Raw DOM, raw OCR, screenshot pixels and credential-shaped
 *     strings are rejected at WRITE time, not filtered at egress.
 */
import { scanForRawSensitiveValues } from '../privacy/rawValueScanner';
import { isInjectionShapedText } from '../semanticUnderstanding/semanticContext';
import type { SemanticFact, SemanticObservation } from '../semanticObservation/types';

export type EvidenceType = 'PAGE_TEXT' | 'TABLE_CELL' | 'ATTR' | 'OCR' | 'SEMANTIC_FACT' | 'VISUAL';

/** SANITIZED passed the authoritative raw-value screen at write time. */
export type EvidencePrivacyStatus = 'SANITIZED' | 'QUARANTINED_INJECTION' | 'REJECTED_SENSITIVE';

/** CURRENT belongs to the live page generation. STALE does not. */
export type EvidenceFreshness = 'CURRENT' | 'STALE';

/**
 * Verification is LOCAL and evidence-driven only. Nothing here is ever set by
 * the model, and nothing here is ever set by dispatch history.
 */
export type EvidenceVerification = 'UNVERIFIED' | 'VERIFIED' | 'CONFLICTED' | 'INVALIDATED';

export interface EvidenceRecord {
  /** Deterministic: hash(sourceUrl | pageGeneration | key). */
  readonly id: string;
  /** Sanitized, bounded, word-boundary-truncated claim text. */
  readonly claim: string;
  /** Normalized subject term, for matching the user's own question wording. */
  readonly key: string;
  readonly sourceUrl: string;
  readonly pageGeneration: number;
  readonly evidenceType: EvidenceType;
  /**
   * Provenance-weighted confidence in [0,1]. Derived from the OBSERVED source,
   * never from a model-reported number.
   */
  readonly confidence: number;
  readonly privacyStatus: EvidencePrivacyStatus;
  readonly freshness: EvidenceFreshness;
  readonly verificationStatus: EvidenceVerification;
  readonly observedAt: number;
  /** Ids of records that carry a DIFFERENT claim for the same key. */
  readonly conflictsWith: readonly string[];
}

/** Bounds — a long task must not grow the model-facing context without limit. */
export const MAX_EVIDENCE_RECORDS = 60;
export const MAX_EVIDENCE_CLAIM_CHARS = 120;

function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}

/** Word-boundary-safe truncation, matching the A4 fact contract. */
export function truncateClaim(value: string, maxChars = MAX_EVIDENCE_CLAIM_CHARS): string {
  const text = value.trim();
  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, maxChars);
  const lastSpace = clipped.lastIndexOf(' ');
  const cut = lastSpace > maxChars * 0.5 ? clipped.slice(0, lastSpace) : clipped;
  return cut.replace(/[\s\-,;:.]+$/, '');
}

/** Deterministic key: lowercased, alphanumeric/spacing only, bounded. */
export function evidenceKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

export interface LedgerSnapshot {
  readonly records: readonly EvidenceRecord[];
  readonly byId: ReadonlyMap<string, EvidenceRecord>;
  readonly currentGeneration: number;
}

/**
 * The single evidence store for a task. Owned by the AgentLoop.
 *
 * There is exactly ONE ledger per task and it is the ONLY place evidence is
 * held — no parallel store, no per-subsystem copy.
 */
export class EvidenceLedger {
  private records: EvidenceRecord[] = [];
  private byId = new Map<string, EvidenceRecord>();
  private generation = 0;
  private url = '';

  constructor(private readonly maxRecords: number = MAX_EVIDENCE_RECORDS) {}

  /** Reject anything that must never become evidence, at WRITE time. */
  private screen(claim: string): EvidencePrivacyStatus | 'REJECTED' {
    if (claim.length === 0) return 'REJECTED';
    // The SAME authoritative detector the world-model choke point uses. Not a
    // second, weaker scan — a divergence here would be a privacy bypass.
    if (scanForRawSensitiveValues(claim).length > 0) return 'REJECTED';
    if (isInjectionShapedText(claim)) return 'QUARANTINED_INJECTION';
    return 'SANITIZED';
  }

  /**
   * Record one observation. Returns the record, or null when the claim was
   * rejected outright. Idempotent for the same (url, generation, key, claim).
   */
  record(input: {
    claim: string;
    key: string;
    sourceUrl: string;
    pageGeneration: number;
    evidenceType: EvidenceType;
    confidence: number;
    observedAt?: number;
  }): EvidenceRecord | null {
    const claim = truncateClaim(input.claim);
    const status = this.screen(claim);
    if (status === 'REJECTED') return null;

    const key = input.key || evidenceKey(claim);
    if (!key) return null;

    const id = stableHash(`${input.sourceUrl}|${input.pageGeneration}|${key}`);
    const existing = this.byId.get(id);
    if (existing) {
      // Deterministic dedup. An identical claim for the same key on the same
      // generation is the SAME piece of evidence, however many times observed.
      if (existing.claim === claim) return existing;
      // Same key, different claim, same page: a genuine conflict. BOTH are kept
      // and both are marked, because silently choosing one would let an
      // unverified value pose as an observed one.
      const conflictId = stableHash(`${input.sourceUrl}|${input.pageGeneration}|${key}|${claim}`);
      if (this.byId.has(conflictId)) return this.byId.get(conflictId)!;
      const conflicting: EvidenceRecord = {
        id: conflictId,
        claim,
        key,
        sourceUrl: input.sourceUrl,
        pageGeneration: input.pageGeneration,
        evidenceType: input.evidenceType,
        confidence: Math.max(0, Math.min(1, input.confidence)),
        privacyStatus: status,
        freshness: 'CURRENT',
        verificationStatus: 'CONFLICTED',
        observedAt: input.observedAt ?? Date.now(),
        conflictsWith: [id],
      };
      this.push(conflicting);
      // Mark the original as conflicted too, without mutating its content.
      this.markConflicted(id, conflictId);
      return conflicting;
    }

    const record: EvidenceRecord = {
      id,
      claim,
      key,
      sourceUrl: input.sourceUrl,
      pageGeneration: input.pageGeneration,
      evidenceType: input.evidenceType,
      confidence: Math.max(0, Math.min(1, input.confidence)),
      privacyStatus: status,
      freshness: 'CURRENT',
      verificationStatus: status === 'QUARANTINED_INJECTION' ? 'UNVERIFIED' : 'UNVERIFIED',
      observedAt: input.observedAt ?? Date.now(),
      conflictsWith: [],
    };
    this.push(record);
    return record;
  }

  private push(record: EvidenceRecord): void {
    this.records.push(record);
    this.byId.set(record.id, record);
    // Bounded ring. Oldest evidence is dropped first, and dropping is honest:
    // it is gone, not silently retained.
    while (this.records.length > this.maxRecords) {
      const dropped = this.records.shift();
      if (dropped) this.byId.delete(dropped.id);
    }
  }

  private markConflicted(id: string, otherId: string): void {
    const rec = this.byId.get(id);
    if (!rec) return;
    this.byId.set(id, { ...rec, verificationStatus: 'CONFLICTED', conflictsWith: [...rec.conflictsWith, otherId] });
    this.records = this.records.map((r) => (r.id === id ? this.byId.get(id)! : r));
  }

  /**
   * Ingest a fresh semantic observation.
   *
   * This is the ONLY ingestion path for model-visible evidence, and it takes
   * facts that have ALREADY passed the world-model choke point and the M8 scan,
   * so the ledger does not widen what the privacy boundary admits.
   */
  ingestObservation(observation: SemanticObservation, sourceUrl: string): number {
    // Evidence originates ONLY from a genuinely OBSERVED probe. An
    // UNAVAILABLE / STALE / NOT_APPLICABLE observation contributes nothing, so
    // there is no path by which absence becomes evidence.
    if (observation.state !== 'OBSERVED' || !observation.provenance) return 0;

    const generation = observation.provenance.pageGeneration;
    const observedAt = observation.provenance.observedAt;
    // The authoritative document URL is the real provenance; a caller-supplied
    // origin is only a fallback for fixtures.
    const url = observation.provenance.documentUrl || sourceUrl;

    this.advance(generation, url);
    let added = 0;
    for (const fact of observation.facts as readonly SemanticFact[]) {
      const rec = this.record({
        claim: fact.displayText || fact.label,
        key: fact.key,
        sourceUrl: url,
        pageGeneration: generation,
        evidenceType: 'SEMANTIC_FACT',
        // Provenance-weighted: a directly-read DOM region is stronger than an
        // inferred attribute. Never model-reported.
        confidence: Math.max(0, Math.min(1, fact.confidence ?? 0.9)),
        observedAt,
      });
      if (rec) {
        added += 1;
        //
        // PHASE 18.8 / A10-F1 — THE VERIFICATION PROMOTION.
        //
        // Until this call existed, NOTHING in production called `verify()`:
        // every record stayed UNVERIFIED, `citable().filter(VERIFIED)` was
        // always empty, and a terminal ANSWER could never be accepted (it
        // downgraded to NEEDS_INFORMATION forever). The missing piece was never
        // a model check; it is this provenance check.
        //
        // A fact reaches this line ONLY from a genuinely OBSERVED
        // `SemanticObservation` (the guard above), carrying real provenance,
        // observed at the live generation, having already passed the
        // world-model choke point, the write-time privacy screen and the
        // injection screen. That is the DEVICE'S OWN reading of the live
        // document, so it is verifiable evidence.
        //
        // The promotion is delegated to `verify()` itself, so the one
        // promotion gate — not a second copy of its rules — decides: a record
        // that is conflicted, stale, non-sanitized or out-of-generation is
        // refused here exactly as it is refused on any other path. Emphatically
        // NOT model-driven: the model cannot reach this method, and the status
        // is never read from a proposal, a dispatch outcome or a goal verdict.
        this.verify(rec.id);
      }
    }
    return added;
  }

  /**
   * Advance the page generation. Evidence from an EARLIER generation becomes
   * STALE and is invalidated — never refreshed, never promoted.
   */
  advance(pageGeneration: number, sourceUrl = ''): void {
    if (pageGeneration <= this.generation && this.records.length === 0) {
      this.generation = pageGeneration;
      this.url = sourceUrl || this.url;
      return;
    }
    this.generation = pageGeneration;
    this.url = sourceUrl || this.url;
    for (const rec of this.records) {
      if (rec.pageGeneration !== pageGeneration) {
        this.byId.set(rec.id, {
          ...rec,
          freshness: 'STALE',
          verificationStatus: 'INVALIDATED',
        });
      }
    }
    this.records = this.records.map((r) => this.byId.get(r.id) ?? r);
  }

  /** Only CURRENT, non-conflicted, non-injection records are citable. */
  citable(): EvidenceRecord[] {
    return this.records.filter(
      (r) =>
        r.freshness === 'CURRENT' &&
        r.verificationStatus !== 'CONFLICTED' &&
        r.verificationStatus !== 'INVALIDATED' &&
        r.privacyStatus === 'SANITIZED'
    );
  }

  /**
   * PHASE 18.8 / CLOSURE — the FRESHNESS WINDOW.
   *
   * `citable()` answers “has the ledger seen anything better than this?”; it
   * cannot answer “is this record still about the page the tab is ON?” because
   * the ledger only marks records STALE when the NEXT observation arrives
   * (`ingestObservation` → `advance`), while the LOOP's generation
   * (`state.currentPageGeneration`) has already moved on the moment a
   * navigation settles. In that interval — precisely where the post-action
   * verdict runs — page A's records are still `CURRENT` and still citable.
   *
   * Both sides already read ONE counter: the world model's monotonic
   * `pageGeneration`, stamped into every record's provenance at ingest and
   * adopted by the loop each perception. This method intersects `citable()`
   * with that generation, so a record must be citable AND belong to the
   * generation being judged. It only ever REMOVES records.
   *
   * A non-positive generation means “no generation information yet” (a caller
   * that has never perceived); the ledger's own freshness rules then apply
   * unchanged, which is the pre-window behaviour.
   */
  citableAt(generation: number | null | undefined): EvidenceRecord[] {
    const citable = this.citable();
    if (typeof generation !== 'number' || generation <= 0) return citable;
    return citable.filter((r) => r.pageGeneration === generation);
  }

  /**
   * The keys of VERIFIED records that belong to `generation` — the exact input
   * the information-success gate reads. Keys only: never claim text.
   */
  verifiedKeysAtGeneration(generation: number | null | undefined): string[] {
    return this.citableAt(generation)
      .filter((r) => r.verificationStatus === 'VERIFIED')
      .map((r) => r.key);
  }

  /**
   * Promote a citable record to VERIFIED. Local-only: it is driven by a
   * deterministic verifier, never by the model and never by dispatch history.
   */
  verify(id: string): boolean {
    const rec = this.byId.get(id);
    if (!rec || rec.freshness !== 'CURRENT' || rec.verificationStatus === 'CONFLICTED') return false;
    if (rec.privacyStatus !== 'SANITIZED') return false;
    this.byId.set(id, { ...rec, verificationStatus: 'VERIFIED' });
    this.records = this.records.map((r) => (r.id === id ? this.byId.get(id)! : r));
    return true;
  }

  /**
   * The MODEL-FACING projection. Re-screened at EGRESS with the same
   * authoritative detector, so a record can never become an egress path even if
   * its write-time screen is later shown to have missed something.
   */
  toModelFacing(): Array<{ id: string; key: string; claim: string; confidence: number; verification: EvidenceVerification }> {
    return this.records
      .filter((r) => r.privacyStatus === 'SANITIZED')
      .filter((r) => scanForRawSensitiveValues(r.claim).length === 0)
      .filter((r) => !isInjectionShapedText(r.claim))
      .map((r) => ({
        id: r.id,
        key: r.key,
        claim: r.claim,
        confidence: r.confidence,
        verification: r.verificationStatus,
      }));
  }

  snapshot(): LedgerSnapshot {
    return { records: this.records, byId: this.byId, currentGeneration: this.generation };
  }

  get size(): number { return this.records.length; }

  /** Read-only lookup. Never exposes the mutable map itself. */
  byIdSafe(id: string): EvidenceRecord | undefined { return this.byId.get(id); }
}