/**
 * Upstream resolution: given a blocked node, find the nodes that are actually actionable.
 *
 * Never nudge the blocked task itself — "Publish X and LinkedIn is overdue" is useless to
 * someone who cannot publish. Walk back to whatever is really in the way.
 *
 * Returns a **set**, never a single node: an AND-join legitimately has several actionable
 * ancestors, and nudging only the first leaves the other side starved indefinitely.
 */

import type { Graph, NodeId, Status } from "../types.ts";
import { nodeById, predecessors } from "./graph-ops.ts";

export type StatusMap = Map<NodeId, Status>;

export function resolveActionable(
  graph: Graph,
  target: NodeId,
  status: StatusMap,
  visited: Set<NodeId> = new Set(),
): Set<NodeId> {
  // The visited guard is belt-and-braces. Given Rule 0 the dependency graph is acyclic, so
  // this can never actually fire — but a future edge added with the wrong kind would turn
  // an infinite recursion into a merely incomplete answer, which is the better failure.
  if (visited.has(target)) return new Set();

  const current = status.get(target);
  if (current === "complete" || current === "not_applicable") return new Set();

  visited.add(target);

  const node = nodeById(graph).get(target);
  const preds = predecessors(graph, target).filter((p) => status.get(p) !== "not_applicable");
  const missing = preds.filter((p) => status.get(p) !== "complete");

  // An OR-join with one path already satisfied is itself the actionable step. Recursing
  // into its *other*, incomplete predecessor would send someone up a branch nobody needs —
  // e.g. asking for Camera ready when the preprint path already cleared the way.
  if (node?.cls === "or_join" && preds.some((p) => status.get(p) === "complete")) {
    return new Set([target]);
  }

  // Nothing missing upstream — this node is itself the thing to do.
  if (missing.length === 0) return new Set([target]);

  // An OR-join only needs one path satisfied, so nudging every upstream branch would be
  // asking for work nobody needs. Pick the cheapest route: fewest actionable steps.
  if (node?.cls === "or_join") {
    const options = missing
      .map((p) => resolveActionable(graph, p, status, new Set(visited)))
      .filter((s) => s.size > 0)
      .sort((a, b) => a.size - b.size);
    return options[0] ?? new Set();
  }

  const out = new Set<NodeId>();
  for (const p of missing) {
    for (const id of resolveActionable(graph, p, status, visited)) out.add(id);
  }
  return out;
}

/**
 * Human-facing answer to "why is X stuck?" — the chain from the blocked node down to each
 * thing that would actually move it.
 */
export function explainBlocked(
  graph: Graph,
  target: NodeId,
  status: StatusMap,
): { target: NodeId; blocked: boolean; actionable: NodeId[] } {
  const s = status.get(target);
  if (s === "complete") return { target, blocked: false, actionable: [] };
  if (s === "not_applicable") return { target, blocked: false, actionable: [] };

  const actionable = [...resolveActionable(graph, target, status)];
  return { target, blocked: actionable.length > 0 && !actionable.includes(target), actionable };
}
