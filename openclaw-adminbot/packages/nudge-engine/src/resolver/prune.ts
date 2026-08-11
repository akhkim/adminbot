/**
 * Decision pruning.
 *
 * When a decision resolves, the branch not taken must become `not_applicable` rather than
 * staying `incomplete` — otherwise the nudger nags a dead branch forever.
 *
 * The rule is **reachability**, not "everything downstream of the untaken edge". That
 * distinction is load-bearing: `AC = Reject` removes the `AC → CM` edge, but `PK` is still
 * reachable through `AK`, so `PK` and everything after it stays live. A naive downstream
 * sweep would prune `PK GT JN PS BE` and silently deadlock the arXiv branch — the exact
 * cliff the OR-join exists to avoid.
 *
 * Pruning is recomputed on every tick and never persisted. A stored `not_applicable`
 * would be inherited by the next attempt, where the branch is live again.
 */

import type { Graph, NodeId, PaperState } from "../types.ts";
import { dependencyEdges, edgeKey, reachableFrom } from "./graph-ops.ts";

export type PruneResult = {
  /** Nodes unreachable under the decisions taken so far. */
  notApplicable: Set<NodeId>;
  /** Dependency edges removed by a decision. */
  prunedEdges: Set<string>;
};

export function prune(graph: Graph, state: PaperState): PruneResult {
  const prunedEdges = new Set<string>();

  for (const [decisionNode, taken] of Object.entries(state.decisions)) {
    if (!taken) continue; // undecided — every branch stays possible
    for (const edge of dependencyEdges(graph)) {
      if (edge.from !== decisionNode) continue;
      if (edge.to === taken) continue;
      prunedEdges.add(edgeKey(edge.from, edge.to));
    }
  }

  const reachable = reachableFrom(graph, graph.root, prunedEdges);
  const notApplicable = new Set<NodeId>();
  for (const node of graph.nodes) {
    if (!reachable.has(node.id)) notApplicable.add(node.id);
  }

  return { notApplicable, prunedEdges };
}

/**
 * Effective status: what the backend said, with pruning applied on top. This is the only
 * status any other module should read.
 */
export function effectiveStatus(
  graph: Graph,
  state: PaperState,
  pruned: PruneResult,
): Map<NodeId, "complete" | "incomplete" | "waiting_external" | "not_applicable"> {
  const out = new Map<NodeId, "complete" | "incomplete" | "waiting_external" | "not_applicable">();
  for (const node of graph.nodes) {
    if (pruned.notApplicable.has(node.id)) {
      out.set(node.id, "not_applicable");
      continue;
    }
    out.set(node.id, state.status[node.id] ?? "incomplete");
  }
  return out;
}
