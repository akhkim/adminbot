/**
 * The seam between the engine and whatever stores paper state.
 *
 * The engine never fetches, writes or caches. A host implements `StatusSource` and hands
 * the result in. That is what keeps the module stateless and testable without a backend.
 */

import type { Graph, NodeId, PaperState, Status } from "../types.ts";

export type StatusSource = {
  /** Read every node's completion status for one paper. */
  load(paperId: string): Promise<PaperState>;
};

/**
 * Artifacts the host can see. Nodes carrying an `evidence` key are completed from these
 * rather than from self-reporting — people do not log every step, and nagging someone for
 * work they already did is how a nudger loses its credibility.
 */
export type EvidenceBundle = Partial<Record<string, boolean>>;

export function applyEvidence(graph: Graph, state: PaperState, evidence: EvidenceBundle): PaperState {
  const status: Partial<Record<NodeId, Status>> = { ...state.status };

  for (const node of graph.nodes) {
    if (!node.evidence) continue;
    if (evidence[node.evidence]) status[node.id] = "complete";
  }

  return { ...state, status };
}

/**
 * A blank state: everything incomplete, nothing decided. Useful as a starting point and
 * for the demo.
 */
export function emptyState(paperId: string, version = "v1"): PaperState {
  return { paperId, attempt: 1, version, status: {}, decisions: {} };
}

/**
 * Apply a rejection: open the next attempt, clear the venue subtree, re-open the writing
 * nodes, and leave branches 1-3 alone. Resetting everything destroys valid work;
 * resetting nothing leaves the paper falsely finished.
 */
export function applyReset(
  state: PaperState,
  scope: { cleared: readonly NodeId[]; reopened: readonly NodeId[] },
): PaperState {
  const status: Partial<Record<NodeId, Status>> = { ...state.status };
  for (const id of [...scope.cleared, ...scope.reopened]) status[id] = "incomplete";

  return {
    ...state,
    attempt: state.attempt + 1,
    status,
    // Decisions belong to the attempt that made them.
    decisions: {},
  };
}
