/**
 * The actionable frontier: incomplete nodes whose predecessors are all satisfied.
 *
 * Joins and decisions are deliberately allowed onto the frontier here, and filtered out
 * by the router, which resolves through them. Keeping that split means `frontier()` stays
 * a pure graph question and `route()` owns all the "who hears about it" policy.
 */

import type { Graph, NodeId, Status } from "../types.ts";
import { nodeById, predecessors } from "./graph-ops.ts";

export type StatusMap = Map<NodeId, Status>;

/**
 * Are a node's dependencies satisfied?
 *
 * `or_join` needs one; everything else needs all. Predecessors that are `not_applicable`
 * are ignored rather than counted as blocking — a pruned branch must not hold a live node
 * hostage.
 */
export function predecessorsSatisfied(graph: Graph, id: NodeId, status: StatusMap): boolean {
  const node = nodeById(graph).get(id);
  const preds = predecessors(graph, id).filter((p) => status.get(p) !== "not_applicable");

  if (preds.length === 0) return true; // a root, or every path pruned

  if (node?.cls === "or_join") {
    return preds.some((p) => status.get(p) === "complete");
  }
  return preds.every((p) => status.get(p) === "complete");
}

export function frontier(graph: Graph, status: StatusMap): NodeId[] {
  return graph.nodes
    .filter((n) => {
      const s = status.get(n.id);
      if (s === "complete" || s === "not_applicable") return false;
      return predecessorsSatisfied(graph, n.id, status);
    })
    .map((n) => n.id);
}

/**
 * Successors that become actionable once `id` completes. Named in the nudge message so
 * the recipient can see what their step releases.
 */
export function unblockedBy(graph: Graph, id: NodeId, status: StatusMap): NodeId[] {
  const after: StatusMap = new Map(status);
  after.set(id, "complete");

  const before = new Set(frontier(graph, status));
  return frontier(graph, after).filter((n) => !before.has(n) && n !== id);
}
