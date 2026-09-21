import { MemoryStore } from './memoryStore';
import { MemoryFirewall } from './memoryFirewall';
import { WorkingMemoryManager, SemanticMemoryManager, EpisodicMemoryManager } from './memoryManager';
import { MemoryTrustLevel, WorkingMemoryRecord, SemanticMemoryRecord, EpisodicMemoryRecord } from './memoryTypes';

// Mock chrome.storage.local
const mockStorage: Record<string, any> = {};
(global as any).chrome = {
  storage: {
    local: {
      get: (keys: string[], cb: (res: any) => void) => {
        const res: any = {};
        keys.forEach(k => { if (mockStorage[k]) res[k] = mockStorage[k]; });
        cb(res);
      },
      set: (items: any, cb?: () => void) => {
        Object.assign(mockStorage, items);
        if (cb) cb();
        return Promise.resolve();
      },
      remove: (keys: string[], cb?: () => void) => {
        keys.forEach(k => delete mockStorage[k]);
        if (cb) cb();
        return Promise.resolve();
      }
    }
  }
};

describe('Phase 5 Agent Memory Subsystem', () => {
  beforeEach(async () => {
    WorkingMemoryManager.clearAll();
    await MemoryStore.clear();
    await MemoryStore.initialize();
  });

  describe('MemoryFirewall', () => {
    it('rejects WEBPAGE source trying to create high-trust memory', () => {
      const badMemory: SemanticMemoryRecord = {
        id: '1',
        class: 'SEMANTIC',
        type: 'SITE_KNOWLEDGE',
        scope: { origin: 'https://example.com', siteKey: 'ex' },
        trustLevel: MemoryTrustLevel.VERIFIED_MEMORY, // Too high for WEBPAGE
        confidence: 0.9,
        key: 'price',
        memoryContent: '100',
        observationCount: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        provenance: { source: 'WEBPAGE', timestamp: Date.now() }
      };

      expect(() => MemoryFirewall.assertSafeToWrite(badMemory)).toThrow(/Prompt Injection Defense/);
    });

    it('rejects PII in memory values via M8 scanner', () => {
      const piiMemory: WorkingMemoryRecord = {
        id: '2',
        class: 'WORKING',
        goalId: 'g1',
        key: 'user_data',
        memoryContent: 'My email is test@example.com',
        scope: { origin: 'https://example.com', siteKey: 'ex' },
        trustLevel: MemoryTrustLevel.CURRENT_VERIFIED_OBSERVATION,
        confidence: 1.0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        provenance: { source: 'SYSTEM', timestamp: Date.now() }
      };

      expect(() => MemoryFirewall.assertSafeToWrite(piiMemory)).toThrow(/Rejected by M8 Privacy Firewall/);
    });

    it('rejects executable content', () => {
      const execMemory: WorkingMemoryRecord = {
        id: '3',
        class: 'WORKING',
        goalId: 'g1',
        key: 'xss',
        memoryContent: '<script>alert(1)</script>',
        scope: { origin: 'https://example.com', siteKey: 'ex' },
        trustLevel: MemoryTrustLevel.CURRENT_VERIFIED_OBSERVATION,
        confidence: 1.0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        provenance: { source: 'SYSTEM', timestamp: Date.now() }
      };

      expect(() => MemoryFirewall.assertSafeToWrite(execMemory)).toThrow(/executable content/);
    });

    it('allows safe memory', () => {
      const safeMemory: WorkingMemoryRecord = {
        id: '4',
        class: 'WORKING',
        goalId: 'g1',
        key: 'cart_count',
        memoryContent: '3 items',
        scope: { origin: 'https://example.com', siteKey: 'ex' },
        trustLevel: MemoryTrustLevel.CURRENT_VERIFIED_OBSERVATION,
        confidence: 1.0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        provenance: { source: 'SYSTEM', timestamp: Date.now() }
      };

      expect(() => MemoryFirewall.assertSafeToWrite(safeMemory)).not.toThrow();
    });
  });

  describe('MemoryStore & Managers', () => {
    it('Working memory is transient and not persisted', async () => {
      const mem: WorkingMemoryRecord = {
        id: 'w1',
        class: 'WORKING',
        goalId: 'g1',
        key: 'step',
        memoryContent: '1',
        scope: { origin: 'https://ex.com', siteKey: 'ex' },
        trustLevel: MemoryTrustLevel.LOCAL_SECURITY_POLICY,
        confidence: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        provenance: { source: 'SYSTEM', timestamp: Date.now() }
      };

      WorkingMemoryManager.write(mem);
      expect(WorkingMemoryManager.readByGoal('g1')).toHaveLength(1);

      // Store should reject it
      const result = await MemoryStore.write(mem);
      expect(result).toBe(false);
    });

    it('Semantic memory persists and retrieves by scope', async () => {
      const mem: SemanticMemoryRecord = {
        id: 's1',
        class: 'SEMANTIC',
        type: 'USER_PREFERENCE',
        key: 'theme',
        memoryContent: 'dark',
        observationCount: 1,
        scope: { origin: 'https://ex.com', siteKey: 'ex' },
        trustLevel: MemoryTrustLevel.HIGH_CONFIDENCE_MEMORY,
        confidence: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        provenance: { source: 'USER', timestamp: Date.now() }
      };

      await SemanticMemoryManager.write(mem);
      
      const retrieved = await SemanticMemoryManager.findRelevant({ origin: 'https://ex.com', siteKey: 'ex' });
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0]!.memoryContent).toBe('dark');
    });

    it('Episodic memory respects bounds and deterministic eviction', async () => {
      // MAX_MEMORY_ITEMS for EPISODIC is 50. Let's write 55 items.
      for (let i = 0; i < 55; i++) {
        const mem: EpisodicMemoryRecord = {
          id: `e${i}`,
          class: 'EPISODIC',
          taskType: 'test',
          outcome: 'SUCCESS',
          sanitizedSummary: `Task ${i}`,
          scope: { origin: 'https://ex.com', siteKey: 'ex' },
          trustLevel: MemoryTrustLevel.VERIFIED_MEMORY,
          confidence: 1,
          createdAt: Date.now() + i, // ensure chronological ordering
          updatedAt: Date.now(),
          provenance: { source: 'SYSTEM', timestamp: Date.now() }
        };
        await EpisodicMemoryManager.write(mem);
      }

      const recent = await EpisodicMemoryManager.getRecent(100);
      expect(recent).toHaveLength(50);
      // The oldest (e0, e1, e2, e3, e4) should be evicted.
      expect(recent.find(r => r.id === 'e0')).toBeUndefined();
      expect(recent.find(r => r.id === 'e54')).toBeDefined();
    });
  });
});
