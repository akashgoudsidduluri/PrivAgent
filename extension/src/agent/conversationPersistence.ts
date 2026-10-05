/**
 * PHASE 18.8 / B2 — CONVERSATION PERSISTENCE.
 *
 * ── Why it exists ───────────────────────────────────────────────────────────
 * An MV3 service worker is evicted when idle. Without persistence, "it" would
 * silently stop resolving the moment the worker was recycled — the user would be
 * told their own follow-up was unclear. The conversation therefore lives in
 * `chrome.storage.session`, the same MV3 area `longHorizonPersistence.ts` uses:
 * in-memory, never written to disk.
 *
 * ── Privacy ─────────────────────────────────────────────────────────────────
 * The serialized context is passed through the EXISTING `scanForRawSensitiveValues`
 * BEFORE it is written, and the write is REFUSED if it trips. That is the same
 * input-boundary defence the reliability record uses; it is not a new filter.
 * The context itself is already free of raw values, so this is defence in depth,
 * not the primary control.
 *
 * Degradation is EXPLICIT: when `chrome.storage.session` is genuinely absent the
 * store degrades to in-memory and says so through `persistenceAvailable`. It
 * never writes conversation state to disk and never pretends to have persisted.
 */
import {
  CONVERSATION_SCHEMA_VERSION,
  CONVERSATION_STORE_KEY,
  type ConversationContext,
} from './conversationContext';
import { scanForRawSensitiveValues } from '../privacy/rawValueScanner';

export const CONVERSATION_STORE_KEY_NAME = CONVERSATION_STORE_KEY;

export interface ConversationStore {
  readonly persistenceAvailable: boolean;
  load(): Promise<ConversationContext | null>;
  save(context: ConversationContext): Promise<void>;
  clear(): Promise<void>;
}

/** Minimal `chrome.storage.session` shape, so this module needs no chrome types. */
interface SessionArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

function sessionArea(): SessionArea | null {
  try {
    const area = (globalThis as unknown as { chrome?: { storage?: { session?: SessionArea } } }).chrome?.storage?.session;
    return area && typeof area.get === 'function' ? area : null;
  } catch {
    return null;
  }
}

/**
 * Fields whose values are OPAQUE STRUCTURAL data, not user content: an 8-char
 * digest, a conversation id, a canonical URL, an identifier. They are still
 * scanned for the STRONG PII rules (email, PAN, account number) — only the
 * token-shape heuristic is waived, because a digest IS token-shaped by design.
 *
 * The object is walked field by field on purpose. Scanning the serialized text
 * instead would join neighbouring fields into one token-shaped run and reject a
 * perfectly clean context.
 */
const CONVERSATION_STRUCTURAL_KEYS: readonly string[] = [
  'conversationid',
  'identitykey',
  'intentdigest',
  'selectedidentitykey',
  'canonicalurl',
  'productid',
  'origin',
];

/** Every raw-value violation in a conversation context. Empty ⇒ clean. */
export function conversationPrivacyViolations(context: unknown) {
  return scanForRawSensitiveValues(context, { extraStructuralKeys: CONVERSATION_STRUCTURAL_KEYS });
}

/** Refuse to write anything whose structure trips the raw-value scanner. */
function isSafeToPersist(context: ConversationContext): boolean {
  return conversationPrivacyViolations(context).length === 0;
}

function isConversationContext(value: unknown): value is ConversationContext {
  if (!value || typeof value !== 'object') return false;
  const c = value as Partial<ConversationContext>;
  return (
    c.schemaVersion === CONVERSATION_SCHEMA_VERSION &&
    typeof c.conversationId === 'string' &&
    typeof c.contextGeneration === 'number' &&
    Array.isArray(c.turns) &&
    Array.isArray(c.candidates)
  );
}

/** In-memory store: the default, and the only one available off-device. */
export function createMemoryConversationStore(): ConversationStore {
  let current: ConversationContext | null = null;
  return {
    persistenceAvailable: false,
    async load() {
      return current;
    },
    async save(context) {
      if (!isSafeToPersist(context)) return;
      current = context;
    },
    async clear() {
      current = null;
    },
  };
}

/**
 * Session-backed store with an explicit in-memory fallback. A malformed or
 * foreign record is DISCARDED rather than merged: a corrupt context is not a
 * context.
 */
export function createConversationStore(): ConversationStore {
  const area = sessionArea();
  const memory = createMemoryConversationStore();
  return {
    persistenceAvailable: area !== null,
    async load() {
      if (!area) return memory.load();
      try {
        const bag = await area.get(CONVERSATION_STORE_KEY_NAME);
        const raw = bag?.[CONVERSATION_STORE_KEY_NAME];
        if (!isConversationContext(raw)) return null;
        return raw;
      } catch {
        return null;
      }
    },
    async save(context) {
      if (!isSafeToPersist(context)) return;
      if (!area) return memory.save(context);
      try {
        await area.set({ [CONVERSATION_STORE_KEY_NAME]: context });
      } catch {
        /* storage refused; the in-memory copy is still the live context */
      }
    },
    async clear() {
      await memory.clear();
      if (!area) return;
      try {
        await area.remove(CONVERSATION_STORE_KEY_NAME);
      } catch {
        /* nothing further to do */
      }
    },
  };
}