/**
 * PrivAgent 2.0 — WorldModelStore (Phase 1)
 *
 * Dedicated store decoupling active page generation from heavy world model payloads.
 *
 * Architecture:
 *  AgentTaskState holds:
 *    activeWorldModelRef: { pageGeneration: N, worldModelId: 'wm-N-...' } | null
 *  WorldModelStore holds:
 *    BrowserWorldModel instances indexed by worldModelId.
 *
 * Invariant:
 *  Target element validity is strictly bound to (worldModelId, pageGeneration).
 *  When page generation advances:
 *    Page Generation 41 -> WorldModel W41
 *    Action -> Page changes -> Generation 42
 *    state.activeWorldModelRef = null;
 *    W41 targets become automatically invalid and stale.
 */

import { BrowserWorldModel, ActiveWorldModelRef } from './types';

export class WorldModelStore {
  private models: Map<string, BrowserWorldModel> = new Map();
  private maxStoredModels: number;

  constructor(maxStoredModels: number = 10) {
    this.maxStoredModels = maxStoredModels;
  }

  /**
   * Registers a built world model and returns an active lightweight reference.
   */
  public registerWorldModel(model: BrowserWorldModel): ActiveWorldModelRef {
    this.models.set(model.id, model);

    // Evict oldest entries if capacity exceeded
    if (this.models.size > this.maxStoredModels) {
      const oldestKey = this.models.keys().next().value;
      if (oldestKey) {
        this.models.delete(oldestKey);
      }
    }

    return {
      pageGeneration: model.page.pageGeneration,
      worldModelId: model.id,
    };
  }

  /**
   * Look up a world model directly by its ID.
   */
  public getWorldModel(worldModelId: string): BrowserWorldModel | null {
    return this.models.get(worldModelId) ?? null;
  }

  /**
   * Resolves the active world model for a given reference.
   * Returns null if the reference is absent or if generation mismatch indicates stale reference.
   */
  public getActiveWorldModel(ref?: ActiveWorldModelRef | null): BrowserWorldModel | null {
    if (!ref || !ref.worldModelId) {
      return null;
    }
    const model = this.models.get(ref.worldModelId);
    if (!model) {
      return null;
    }
    if (model.page.pageGeneration !== ref.pageGeneration) {
      // Generation mismatch indicates stale target reference
      return null;
    }
    return model;
  }

  /**
   * Validates whether a target element ID is valid for the current active reference and page generation.
   * Immediately rejects targets from previous or mismatching generations.
   */
  public isTargetValid(
    ref: ActiveWorldModelRef | null | undefined,
    targetElementId: string,
    currentGeneration: number
  ): boolean {
    if (!ref || !ref.worldModelId) {
      return false;
    }
    if (ref.pageGeneration !== currentGeneration) {
      // Stale generation protection
      return false;
    }
    const model = this.getActiveWorldModel(ref);
    if (!model) {
      return false;
    }
    return model.elements.some((elem) => elem.id === targetElementId);
  }

  /**
   * Evicts models associated with a specific generation.
   */
  public invalidateGeneration(generation: number): void {
    for (const [id, model] of this.models.entries()) {
      if (model.page.pageGeneration === generation) {
        this.models.delete(id);
      }
    }
  }

  /**
   * Current number of stored models.
   */
  public size(): number {
    return this.models.size;
  }

  /**
   * Clears all models in the store.
   */
  public clear(): void {
    this.models.clear();
  }
}

/** Default singleton instance */
export const worldModelStore = new WorldModelStore();

/** Factory for testing */
export function createWorldModelStore(maxStoredModels?: number): WorldModelStore {
  return new WorldModelStore(maxStoredModels);
}
