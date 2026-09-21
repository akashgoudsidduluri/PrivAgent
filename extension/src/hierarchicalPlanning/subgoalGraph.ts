/**
 * PrivAgent — Subgoal Dependency DAG & Graph Manager (Phase 4.3)
 *
 * Manages the directed acyclic graph (DAG) of subgoals, validates dependency prerequisites,
 * detects cycles to prevent deadlocks, and updates ready states dynamically as subgoals complete.
 */

import {
  Subgoal,
  SubgoalState,
  SubgoalDependencyEdge,
  SubgoalGraphData,
} from './hierarchicalTypes';

export class SubgoalGraph {
  private subgoals: Map<string, Subgoal> = new Map();
  private goalId: string;

  constructor(goalId: string, initialSubgoals: Subgoal[] = []) {
    this.goalId = goalId;
    for (const sg of initialSubgoals) {
      this.subgoals.set(sg.id, { ...sg });
    }
    this.validateAndRefreshReadyStates();
  }

  public getGoalId(): string {
    return this.goalId;
  }

  public getSubgoal(id: string): Subgoal | undefined {
    return this.subgoals.get(id);
  }

  public getAllSubgoals(): Subgoal[] {
    return Array.from(this.subgoals.values()).sort((a, b) => a.index - b.index);
  }

  public size(): number {
    return this.subgoals.size;
  }

  /**
   * Adds a new subgoal to the graph, validating that it introduces no cyclic dependencies.
   */
  public addSubgoal(subgoal: Subgoal): boolean {
    if (this.subgoals.has(subgoal.id)) {
      return false;
    }
    this.subgoals.set(subgoal.id, { ...subgoal });
    if (this.hasCycle()) {
      // Revert if cycle introduced
      this.subgoals.delete(subgoal.id);
      throw new Error(`Adding subgoal "${subgoal.id}" introduced a cyclic dependency in SubgoalGraph.`);
    }
    this.validateAndRefreshReadyStates();
    return true;
  }

  /**
   * Returns all dependency edges in the graph.
   */
  public getEdges(): SubgoalDependencyEdge[] {
    const edges: SubgoalDependencyEdge[] = [];
    for (const sg of this.subgoals.values()) {
      for (const prereqId of sg.prerequisites) {
        edges.push({ fromSubgoalId: prereqId, toSubgoalId: sg.id });
      }
    }
    return edges;
  }

  /**
   * Detects whether the dependency graph contains any cycles using DFS.
   */
  public hasCycle(): boolean {
    const visited = new Set<string>();
    const recStack = new Set<string>();

    const dfs = (nodeId: string): boolean => {
      visited.add(nodeId);
      recStack.add(nodeId);

      const node = this.subgoals.get(nodeId);
      if (node) {
        for (const prereqId of node.prerequisites) {
          if (!visited.has(prereqId)) {
            if (dfs(prereqId)) return true;
          } else if (recStack.has(prereqId)) {
            return true;
          }
        }
      }

      recStack.delete(nodeId);
      return false;
    };

    for (const id of this.subgoals.keys()) {
      if (!visited.has(id)) {
        if (dfs(id)) return true;
      }
    }
    return false;
  }

  /**
   * Computes a topological sort of the subgoals.
   * Throws an error if a cycle is detected.
   */
  public getTopologicalOrder(): Subgoal[] {
    if (this.hasCycle()) {
      throw new Error('Cannot compute topological order: SubgoalGraph contains a cycle.');
    }

    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const id of this.subgoals.keys()) {
      inDegree.set(id, 0);
      adjacency.set(id, []);
    }

    for (const sg of this.subgoals.values()) {
      for (const prereq of sg.prerequisites) {
        if (adjacency.has(prereq)) {
          adjacency.get(prereq)!.push(sg.id);
          inDegree.set(sg.id, (inDegree.get(sg.id) || 0) + 1);
        }
      }
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(id);
    }

    const sortedIds: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      sortedIds.push(current);

      for (const neighbor of adjacency.get(current) || []) {
        const newDeg = (inDegree.get(neighbor) || 1) - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) queue.push(neighbor);
      }
    }

    return sortedIds.map((id) => this.subgoals.get(id)!);
  }

  /**
   * Retrieves all subgoals currently eligible for execution (all prerequisites are COMPLETED or SKIPPED).
   */
  public getReadySubgoals(): Subgoal[] {
    const ready: Subgoal[] = [];
    for (const sg of this.subgoals.values()) {
      if (sg.state === 'READY') {
        ready.push(sg);
      } else if (sg.state === 'PENDING' && this.arePrerequisitesMet(sg)) {
        sg.state = 'READY';
        ready.push(sg);
      }
    }
    return ready.sort((a, b) => a.index - b.index);
  }

  /**
   * Checks if all prerequisite subgoals for a given subgoal have completed or skipped.
   */
  public arePrerequisitesMet(subgoal: Subgoal): boolean {
    for (const prereqId of subgoal.prerequisites) {
      const prereq = this.subgoals.get(prereqId);
      if (!prereq) return false;
      if (prereq.state !== 'COMPLETED' && prereq.state !== 'SKIPPED') {
        return false;
      }
    }
    return true;
  }

  /**
   * Transitions a subgoal to IN_PROGRESS.
   */
  public startSubgoal(id: string): boolean {
    const sg = this.subgoals.get(id);
    if (!sg || (sg.state !== 'READY' && sg.state !== 'PENDING')) return false;
    sg.state = 'IN_PROGRESS';
    return true;
  }

  /**
   * Transitions a subgoal to COMPLETED and refreshes dependent subgoals to READY.
   */
  public completeSubgoal(id: string): boolean {
    const sg = this.subgoals.get(id);
    if (!sg) return false;
    sg.state = 'COMPLETED';
    this.validateAndRefreshReadyStates();
    return true;
  }

  /**
   * Transitions a subgoal to FAILED.
   */
  public failSubgoal(id: string, reason: string): boolean {
    const sg = this.subgoals.get(id);
    if (!sg) return false;
    sg.state = 'FAILED';
    sg.failureReason = reason;
    return true;
  }

  /**
   * Skips a subgoal and refreshes dependencies.
   */
  public skipSubgoal(id: string, reason?: string): boolean {
    const sg = this.subgoals.get(id);
    if (!sg) return false;
    sg.state = 'SKIPPED';
    if (reason) sg.failureReason = reason;
    this.validateAndRefreshReadyStates();
    return true;
  }

  /**
   * Cancels a list of subgoals (e.g. during replanning).
   */
  public cancelSubgoals(ids: string[]): void {
    for (const id of ids) {
      const sg = this.subgoals.get(id);
      if (sg && sg.state !== 'COMPLETED') {
        sg.state = 'SKIPPED';
        sg.failureReason = 'Cancelled by dynamic replanner';
      }
    }
    this.validateAndRefreshReadyStates();
  }

  /**
   * Splices new subgoals into the graph, connecting dependencies safely.
   */
  public spliceSubgoals(newSubgoals: Subgoal[], replaceFromIndex?: number): void {
    if (replaceFromIndex !== undefined) {
      for (const sg of this.subgoals.values()) {
        if (sg.index >= replaceFromIndex && sg.state !== 'COMPLETED') {
          sg.state = 'SKIPPED';
          sg.failureReason = 'Replaced by dynamic replanning';
        }
      }
    }
    for (const sg of newSubgoals) {
      this.subgoals.set(sg.id, { ...sg });
    }
    if (this.hasCycle()) {
      throw new Error('Splicing subgoals created a dependency cycle in SubgoalGraph.');
    }
    this.validateAndRefreshReadyStates();
  }

  /**
   * Checks if all subgoals in the graph have completed or been skipped.
   */
  public isAllCompleted(): boolean {
    for (const sg of this.subgoals.values()) {
      if (sg.state !== 'COMPLETED' && sg.state !== 'SKIPPED') {
        return false;
      }
    }
    return true;
  }

  /**
   * Checks if any critical subgoal has permanently failed without recovery.
   */
  public hasUnrecoveredFailure(): boolean {
    for (const sg of this.subgoals.values()) {
      if (sg.state === 'FAILED' && sg.retryCount >= sg.maxRetries) {
        return true;
      }
    }
    return false;
  }

  /**
   * Re-evaluates all pending subgoals and transitions them to READY if their prerequisites are fulfilled.
   */
  public validateAndRefreshReadyStates(): void {
    for (const sg of this.subgoals.values()) {
      if (sg.state === 'PENDING' && this.arePrerequisitesMet(sg)) {
        sg.state = 'READY';
      }
    }
  }

  /**
   * Serializes the graph data structure for telemetry or inspection.
   */
  public toData(): SubgoalGraphData {
    const subgoalsRecord: Record<string, Subgoal> = {};
    for (const [id, sg] of this.subgoals.entries()) {
      subgoalsRecord[id] = { ...sg };
    }
    return {
      goalId: this.goalId,
      subgoals: subgoalsRecord,
      edges: this.getEdges(),
    };
  }
}
