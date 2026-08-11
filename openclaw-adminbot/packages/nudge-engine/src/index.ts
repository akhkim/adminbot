/**
 * @jinesis/nudge-engine — public API.
 *
 * A stateless frontier resolver over the PaperFlow DAG. Give it a graph and a status
 * snapshot; it tells you who to nudge about what, and why.
 */

export type {
  Diagnostic,
  Edge,
  EdgeKind,
  Graph,
  GraphNode,
  NodeClass,
  NodeId,
  Nudge,
  NudgeBatch,
  NudgeKind,
  PaperState,
  Role,
  Status,
  TickOutcome,
  TickResult,
} from "./types.ts";

export { paperflow, resetScope, branchPriority } from "./graph/paperflow.ts";
export { validateGraph, hasErrors } from "./graph/validate.ts";

export { tick, whyBlocked, type TickOptions } from "./nudge.ts";

export { frontier, predecessorsSatisfied, unblockedBy } from "./resolver/frontier.ts";
export { resolveActionable, explainBlocked } from "./resolver/resolve.ts";
export { prune, effectiveStatus } from "./resolver/prune.ts";
export { routeFrontier, batchByRecipient } from "./resolver/route.ts";
export {
  dependencyEdges,
  isAcyclic,
  isDependencyEdge,
  isLeaf,
  nodeById,
  predecessors,
  reachableFrom,
  successors,
} from "./resolver/graph-ops.ts";

export { nudgeText, batchText } from "./messages.ts";
export {
  applyEvidence,
  applyReset,
  emptyState,
  type EvidenceBundle,
  type StatusSource,
} from "./adapters/backend.ts";
