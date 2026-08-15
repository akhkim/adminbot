/**
 * Graph primitives. Everything else in the package goes through these, so the Rule 0
 * exclusion of `reset`/`retry` edges is enforced in exactly one place.
 */

import type { Edge, Graph, GraphNode, NodeId } from "../types.ts";

/**
 * The only edges that express a dependency. `reset` and `retry` mean "go round again",
 * not "this is required first" — traversing them would reintroduce the two cycles and
 * make the frontier undefined.
 */
export function isDependencyEdge(edge: Edge): boolean {
  return edge.kind === "requires" || edge.kind === "gate";
}

export function dependencyEdges(graph: Graph): Edge[] {
  return graph.edges.filter(isDependencyEdge);
}

export function nodeById(graph: Graph): Map<NodeId, GraphNode> {
  return new Map(graph.nodes.map((n) => [n.id, n]));
}

export function predecessors(graph: Graph, id: NodeId): NodeId[] {
  return dependencyEdges(graph)
    .filter((e) => e.to === id)
    .map((e) => e.from);
}

export function successors(graph: Graph, id: NodeId): NodeId[] {
  return dependencyEdges(graph)
    .filter((e) => e.from === id)
    .map((e) => e.to);
}

export function edgeBetween(graph: Graph, from: NodeId, to: NodeId): Edge | undefined {
  return graph.edges.find((e) => e.from === from && e.to === to);
}

/** Nodes with no dependency successors. They block nothing, so they nudge differently. */
export function isLeaf(graph: Graph, id: NodeId): boolean {
  return successors(graph, id).length === 0;
}

/**
 * Reachable set from `root` over dependency edges, minus any edge the caller has ruled
 * out. This single function does the pruning work — see `prune.ts` for why reachability
 * is the correct rule rather than "everything downstream of the untaken branch".
 */
export function reachableFrom(
  graph: Graph,
  root: NodeId,
  excluded: ReadonlySet<string> = new Set(),
): Set<NodeId> {
  const out = new Set<NodeId>([root]);
  const queue: NodeId[] = [root];
  const edges = dependencyEdges(graph);

  while (queue.length > 0) {
    const current = queue.shift() as NodeId;
    for (const edge of edges) {
      if (edge.from !== current) continue;
      if (excluded.has(edgeKey(edge.from, edge.to))) continue;
      if (out.has(edge.to)) continue;
      out.add(edge.to);
      queue.push(edge.to);
    }
  }
  return out;
}

export function edgeKey(from: NodeId, to: NodeId): string {
  return `${from}->${to}`;
}

/**
 * True when the dependency subgraph is acyclic. Used at validation time: if this ever
 * returns false, Rule 0 has been broken by a new edge and the frontier is meaningless.
 */
export function isAcyclic(graph: Graph): boolean {
  const edges = dependencyEdges(graph);
  const state = new Map<NodeId, 0 | 1 | 2>();

  const visit = (id: NodeId): boolean => {
    const seen = state.get(id);
    if (seen === 1) return false; // back-edge → cycle
    if (seen === 2) return true;
    state.set(id, 1);
    for (const edge of edges) {
      if (edge.from !== id) continue;
      if (!visit(edge.to)) return false;
    }
    state.set(id, 2);
    return true;
  };

  return graph.nodes.every((n) => visit(n.id));
}
