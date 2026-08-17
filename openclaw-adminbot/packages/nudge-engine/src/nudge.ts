/**
 * The pipeline. One pure function, run per tick.
 *
 * Stateless by construction: everything it knows arrives in `state`, everything it
 * produces is returned. Re-running it at any moment gives the same answer, so restarts,
 * redeploys and double-fired timers are harmless.
 */

import type { Graph, NodeId, PaperState, TickResult } from "./types.ts";
import { validateGraph, hasErrors } from "./graph/validate.ts";
import { prune, effectiveStatus } from "./resolver/prune.ts";
import { frontier } from "./resolver/frontier.ts";
import { batchByRecipient, routeFrontier, type RouteOptions } from "./resolver/route.ts";
import { explainBlocked, resolveActionable } from "./resolver/resolve.ts";
import { nodeById } from "./resolver/graph-ops.ts";
import { branchPriority } from "./graph/paperflow.ts";

export type TickOptions = RouteOptions & {
  /** Ask about one blocked node instead of sweeping the whole graph. */
  target?: NodeId;
};

export function tick(graph: Graph, state: PaperState, options: TickOptions = {}): TickResult {
  // 1. Validate. A broken graph emits nothing at all.
  const diagnostics = validateGraph(graph);
  if (hasErrors(diagnostics)) {
    return { outcome: "config_error", batches: [], frontier: [], diagnostics };
  }

  // 2. Prune by reachability, recomputed every tick and never stored.
  const pruned = prune(graph, state);
  const status = effectiveStatus(graph, state, pruned);

  // 3. Frontier, or the upstream walk if a specific blocked node was named.
  const ids = options.target
    ? [...resolveActionable(graph, options.target, status)]
    : frontier(graph, status);

  // 4. Empty frontier is three different things. Collapsing them is what makes a nudger
  //    untrustworthy — "nothing to say" must never look the same as "I am broken".
  if (ids.length === 0) {
    const anyTerminalComplete = graph.nodes.some(
      (n) => status.get(n.id) === "complete" && graph.edges.every((e) => e.from !== n.id || e.kind === "reset"),
    );
    if (anyTerminalComplete) {
      return { outcome: "done", batches: [], frontier: [], diagnostics };
    }
    const waiting = graph.nodes.some((n) => status.get(n.id) === "waiting_external");
    if (waiting) {
      return { outcome: "quiet", batches: [], frontier: [], diagnostics };
    }
    return {
      outcome: "stall",
      batches: [],
      frontier: [],
      diagnostics: [
        ...diagnostics,
        {
          level: "error",
          code: "stall",
          message: "Nothing is actionable and nothing is finished — the graph or the status feed is wrong",
        },
      ],
    };
  }

  // 5. Route, then batch so each person gets one message however many nodes they own.
  const nudges = routeFrontier(graph, ids, status, state, {
    branchPriority,
    ...options,
  });
  const batches = batchByRecipient(nudges);

  return {
    outcome: nudges.length > 0 ? "nudges" : "quiet",
    batches,
    frontier: ids,
    diagnostics,
  };
}

/** "Why is X stuck?" — the answer a person actually wants. */
export function whyBlocked(graph: Graph, state: PaperState, target: NodeId) {
  const pruned = prune(graph, state);
  const status = effectiveStatus(graph, state, pruned);
  const result = explainBlocked(graph, target, status);
  const byId = nodeById(graph);

  return {
    ...result,
    targetLabel: byId.get(target)?.label ?? target,
    actionableLabels: result.actionable.map((id) => byId.get(id)?.label ?? id),
  };
}
