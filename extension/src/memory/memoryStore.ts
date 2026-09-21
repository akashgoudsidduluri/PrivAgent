/**
 * PrivAgent — Memory Store (Phase 5)
 * Persistence layer for Agent Memory using chrome.storage.local.
 * Implements strict bounds, schema validation, deterministic eviction, and corruption handling.
 */

import { AnyMemoryRecord, MemoryClass } from './memoryTypes';
import { validateEgressPayload } from '../security/egressFirewall';
import { SecurityDecision } from '../security/types';

const MAX_MEMORY_ITEMS = {
  WORKING: 0, // In-memory only, should not be persisted here, but we set to 0.
  EPISODIC: 50,
  SEMANTIC: 200,
  FAILURE: 50,
};

// Global byte limit for the entire memory store ~2MB out of the 5MB extension limit
const MAX_GLOBAL_BYTES = 2 * 1024 * 1024; 

const STORE_KEY = 'privagent_memory_store';

export class MemoryStore {
  /**
   * Initializes or verifies the memory store.
   */
  public static async initialize(): Promise<void> {
    const data = await this.readAll();
    if (!data) {
      await chrome.storage.local.set({ [STORE_KEY]: { EPISODIC: [], SEMANTIC: [], FAILURE: [] } });
    }
  }

  /**
   * Writes a memory record after validating bounds and schema.
   */
  public static async write(record: AnyMemoryRecord): Promise<boolean> {
    if (record.class === 'WORKING') {
      console.warn('Working memory should not be persisted to chrome.storage.local.');
      return false;
    }

    // 1. Memory Egress Isolation Check
    const egressDecision = validateEgressPayload(record, 'LOCAL_STORAGE');
    if (egressDecision.directive === 'BLOCK') {
      console.warn(`Memory Egress Blocked: ${egressDecision.reason}`);
      return false;
    }

    // Atomic-ish update using a mutex or just read-modify-write in extension background
    // In chrome extensions, concurrent writes to the same key can overwrite each other,
    // but typically agent execution is serialized per tab.
    
    try {
      const data = await this.readAllSafe();
      const list = data[record.class] as AnyMemoryRecord[];
      
      // Duplicate detection / Upsert based on ID
      const existingIdx = list.findIndex(r => r.id === record.id);
      if (existingIdx >= 0) {
        list[existingIdx] = record;
      } else {
        list.push(record);
      }

      // Enforce limits (deterministic eviction - oldest first by createdAt, or lowest confidence)
      const maxItems = MAX_MEMORY_ITEMS[record.class as 'EPISODIC' | 'SEMANTIC' | 'FAILURE'];
      if (list.length > maxItems) {
        // Sort by createdAt ascending (oldest first)
        list.sort((a, b) => a.createdAt - b.createdAt);
        // Evict oldest
        while(list.length > maxItems) {
          list.shift();
        }
      }

      data[record.class] = list;
      
      // Check byte bounds before saving
      const serialized = JSON.stringify(data);
      if (new Blob([serialized]).size > MAX_GLOBAL_BYTES) {
        console.error('MemoryStore exceeded global byte limit.');
        // We could implement aggressive eviction here, but failing closed is safer for now.
        return false;
      }

      await chrome.storage.local.set({ [STORE_KEY]: data });
      return true;
    } catch (e) {
      console.error('Corruption handling: Failed to write memory', e);
      return false;
    }
  }

  /**
   * Retrieves all records for a specific memory class.
   */
  public static async readClass(mClass: 'EPISODIC' | 'SEMANTIC' | 'FAILURE'): Promise<AnyMemoryRecord[]> {
    const data = await this.readAllSafe();
    return data[mClass] || [];
  }

  /**
   * Clear memory store (mainly for testing).
   */
  public static async clear(): Promise<void> {
    await chrome.storage.local.remove([STORE_KEY]);
  }

  /**
   * Read all data with corruption handling.
   */
  private static async readAllSafe(): Promise<Record<string, AnyMemoryRecord[]>> {
    const raw = await this.readAll();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { EPISODIC: [], SEMANTIC: [], FAILURE: [] };
    }
    // Basic schema validation for corruption handling
    const safeData: Record<string, AnyMemoryRecord[]> = { EPISODIC: [], SEMANTIC: [], FAILURE: [] };
    
    for (const key of ['EPISODIC', 'SEMANTIC', 'FAILURE']) {
      if (Array.isArray(raw[key])) {
        // Validate each record has an ID and matches the class
        safeData[key] = raw[key].filter((r: any) => r && typeof r.id === 'string' && r.class === key);
      }
    }
    return safeData;
  }

  private static async readAll(): Promise<any> {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORE_KEY], (result) => {
        resolve(result[STORE_KEY]);
      });
    });
  }
}
