/**
 * Load-time graph validation.
 *
 * An invalid graph emits **zero** nudges rather than a partial set. Partial nudging on a
 * broken graph is worse than none: it looks like the system is working while a step is
 * silently never asked for.
 */

import type { Diagnostic, Graph } from "../types.ts";
import { isAcyclic, nodeById, reachableFrom, successors } from "../resolver/graph-ops.ts";

export function validateGraph(graph: Graph): Diagnostic[] {
  const out: Diagnostic[] = [];
  const byId = nodeById(graph);

  // Edges must point at nodes that exist.
  for (const edge of graph.edges) {
    if (!byId.has(edge.from)) {
      out.push({ level: "error", code: "unknown_edge_source", message: `Edge from unknown node ${edge.from}`, node: edge.from });
    }
    if (!byId.has(edge.to)) {
      out.push({ level: "error", code: "unknown_edge_target", message: `Edge to unknown node ${edge.to}`, node: edge.to });
    }
  }

  // Every node that can be nudged needs exactly one accountable owner. An unowned node is
  // silently skipped by the router, so the step simply never happens.
  for (const node of graph.nodes) {
    if (node.cls === "decision") continue;
    if (!node.owner) {
      out.push({ level: "error", code: "missing_owner", message: `${node.id} (${node.label}) has no owner`, node: node.id });
    }
  }

  // Rule 0 must hold, or the frontier is meaningless.
  if (!isAcyclic(graph)) {
    out.push({
      level: "error",
      code: "cycle",
      message: "Dependency subgraph has a cycle — a reset/retry edge is probably typed as requires/gate",
    });
  }

  // Unreachable nodes can never be nudged.
  const reachable = reachableFrom(graph, graph.root);
  for (const node of graph.nodes) {
    if (!reachable.has(node.id)) {
      out.push({ level: "error", code: "unreachable", message: `${node.id} is unreachable from ${graph.root}`, node: node.id });
    }
  }

  // Joins that only ever have one input are not joins, and the sibling messaging will be
  // wrong. Warn rather than fail — it is a modelling smell, not a breakage.
  for (const node of graph.nodes) {
    if (node.cls !== "join" && node.cls !== "or_join") continue;
    const inbound = graph.edges.filter((e) => e.to === node.id && (e.kind === "requires" || e.kind === "gate"));
    if (inbound.length < 2) {
      out.push({ level: "warn", code: "degenerate_join", message: `${node.id} is a join with ${inbound.length} inbound edge(s)`, node: node.id });
    }
  }

  // A leaf that nothing depends on is fine, but it should be deliberate.
  for (const node of graph.nodes) {
    if (successors(graph, node.id).length === 0 && node.cls === "join") {
      out.push({ level: "warn", code: "join_leaf", message: `${node.id} is a join with no successors`, node: node.id });
    }
  }

  return out;
}

export function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((d) => d.level === "error");
}
