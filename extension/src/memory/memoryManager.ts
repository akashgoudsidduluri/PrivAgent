/**
 * PrivAgent — Memory Managers (Phase 5)
 * Wraps MemoryStore and MemoryFirewall to provide specific lifecycles
 * for Working, Episodic, Semantic, and Failure memory classes.
 */

import { MemoryStore } from './memoryStore';
import { MemoryFirewall } from './memoryFirewall';
import { 
  AnyMemoryRecord, 
  WorkingMemoryRecord, 
  EpisodicMemoryRecord, 
  SemanticMemoryRecord, 
  FailureMemoryRecord,
  SiteScope
} from './memoryTypes';

// ============================================================================
// 1. Working Memory (Transient)
// ============================================================================

export class WorkingMemoryManager {
  private static store = new Map<string, WorkingMemoryRecord>();

  public static write(record: WorkingMemoryRecord): void {
    MemoryFirewall.assertSafeToWrite(record);
    this.store.set(record.id, record);
  }

  public static readByGoal(goalId: string): WorkingMemoryRecord[] {
    return Array.from(this.store.values()).filter(r => r.goalId === goalId);
  }

  public static clearForGoal(goalId: string): void {
    const toDelete = this.readByGoal(goalId).map(r => r.id);
    for (const id of toDelete) {
      this.store.delete(id);
    }
  }

  public static clearAll(): void {
    this.store.clear();
  }
}

// ============================================================================
// 2. Episodic Memory (Sanitized Historical Task Events)
// ============================================================================

export class EpisodicMemoryManager {
  public static async write(record: EpisodicMemoryRecord): Promise<boolean> {
    MemoryFirewall.assertSafeToWrite(record);
    return await MemoryStore.write(record);
  }

  public static async getRecent(limit: number = 10): Promise<EpisodicMemoryRecord[]> {
    const records = await MemoryStore.readClass('EPISODIC') as EpisodicMemoryRecord[];
    records.sort((a, b) => b.createdAt - a.createdAt); // Newest first
    return records.slice(0, limit);
  }
}

// ============================================================================
// 3. Semantic Memory (Reusable Knowledge/Facts)
// ============================================================================

export class SemanticMemoryManager {
  public static async write(record: SemanticMemoryRecord): Promise<boolean> {
    MemoryFirewall.assertSafeToWrite(record);
    return await MemoryStore.write(record);
  }

  public static async findRelevant(scope: SiteScope): Promise<SemanticMemoryRecord[]> {
    const records = await MemoryStore.readClass('SEMANTIC') as SemanticMemoryRecord[];
    const now = Date.now();
    
    // Filter active & scope matching
    return records.filter(r => {
      // 1. Expiry check (Confidence decay logic)
      if (r.expiresAt && now > r.expiresAt) return false;
      
      // 2. Scope match
      if (r.scope.origin !== scope.origin && r.scope.siteKey !== scope.siteKey) {
        return false;
      }
      return true;
    });
  }

  public static async invalidate(id: string): Promise<boolean> {
    const records = await MemoryStore.readClass('SEMANTIC');
    const existingIdx = records.findIndex(r => r.id === id);
    if (existingIdx >= 0) {
      // We overwrite it with an expired time or extremely low confidence.
      const record = records[existingIdx];
      if (record) {
        record.confidence = 0;
        record.expiresAt = Date.now() - 1000;
        return await MemoryStore.write(record);
      }
    }
    return false;
  }
}

// ============================================================================
// 4. Failure Memory (Sanitized Failure Patterns)
// ============================================================================

export class FailureMemoryManager {
  public static async write(record: FailureMemoryRecord): Promise<boolean> {
    MemoryFirewall.assertSafeToWrite(record);
    return await MemoryStore.write(record);
  }

  public static async findRelevant(scope: SiteScope, failureType?: string): Promise<FailureMemoryRecord[]> {
    const records = await MemoryStore.readClass('FAILURE') as FailureMemoryRecord[];
    const now = Date.now();
    
    return records.filter(r => {
      if (r.expiresAt && now > r.expiresAt) return false;
      if (r.scope.origin !== scope.origin && r.scope.siteKey !== scope.siteKey) return false;
      if (failureType && r.failureType !== failureType) return false;
      return true;
    });
  }
}
