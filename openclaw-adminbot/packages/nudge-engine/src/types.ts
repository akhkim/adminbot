/**
 * The vocabulary shared by the graph, the resolver and the frontend.
 *
 * Every type here is data. Nothing in this package holds mutable workflow state — see
 * `nudge.ts` for why that matters.
 */

export type NodeId = string;

/**
 * How a node behaves when the resolver reaches it. This is the single switch that decides
 * whether a node can be nudged, who hears about it, and whether it resolves through.
 */
export type NodeClass =
  /** A person does something. The normal case. */
  | "action"
  /** A designated approver must act. Preparation never satisfies it. */
  | "approval"
  /** AND-join. Every non-pruned predecessor must be complete. Never nudged itself. */
  | "join"
  /** OR-join. Any one non-pruned predecessor is enough. */
  | "or_join"
  /** Owned by a third party's clock. Nudge to *observe*, never to produce. */
  | "external_wait"
  /** Derived from a recorded outcome. Nobody completes it. Never nudged. */
  | "decision"
  /** Never blocks a successor, never escalates. */
  | "optional";

/**
 * Read from the backend. `not_applicable` is derived here, never stored — see `prune.ts`.
 */
export type Status = "complete" | "incomplete" | "waiting_external" | "not_applicable";

/**
 * `reset` and `retry` are control edges, not dependencies. They are never traversed
 * upstream — that exclusion is what makes the graph acyclic. See `edgesForTraversal`.
 */
export type EdgeKind = "requires" | "gate" | "reset" | "retry";

export type Edge = {
  from: NodeId;
  to: NodeId;
  kind: EdgeKind;
  /** The label as drawn in PaperFlow, carried through so messages can quote it. */
  label?: string;
};

/** Roles, not people. The consumer maps a role to a human. */
export type Role = "first_author" | "coauthors" | "pi" | "admin";

export type GraphNode = {
  id: NodeId;
  label: string;
  cls: NodeClass;
  /**
   * Required for every class except `decision`. An unowned actionable node is a config
   * error and makes the whole graph refuse to emit nudges.
   */
  owner?: Role;
  /** Which parallel branch this belongs to, for grouping and priority. */
  branch?: string;
  /**
   * An artifact whose existence proves completion. These should be detected, never asked
   * of a human — otherwise people ignore nudges for work they already did.
   */
  evidence?: string;
  /** Re-armed by a new version rather than completed once per paper. */
  versioned?: boolean;
  /** Missing this is irreversible, so it escalates before the date, not after. */
  hardDeadline?: boolean;
};

export type Graph = {
  root: NodeId;
  nodes: GraphNode[];
  edges: Edge[];
};

/**
 * Everything the resolver reads. Supplied by the caller from the backend on every tick;
 * the engine keeps no copy.
 */
export type PaperState = {
  paperId: string;
  /** Increments on every `reset` traversal. Status is scoped to it. */
  attempt: number;
  /** Which artifact version the versioned gates currently apply to. */
  version: string;
  status: Partial<Record<NodeId, Status>>;
  /**
   * decision node -> the successor(s) actually taken. Absent means undecided.
   *
   * An array when one outcome opens several branches: `AC = Accept` starts both `CM`
   * (camera ready) and, for a first or co-first author, `CA` (conference attendance).
   */
  decisions: Partial<Record<NodeId, NodeId | NodeId[]>>;
  /** ISO dates for `external_wait` nodes, used to decide when to nudge for observation. */
  expectedDates?: Partial<Record<NodeId, string>>;
};

export type NudgeKind =
  | "action"
  | "approval"
  | "observe"
  | "optional"
  | "escalate";

export type Nudge = {
  node: NodeId;
  nodeLabel: string;
  kind: NudgeKind;
  recipient: Role;
  /** Why this person is hearing about it now. */
  reason: string;
  /** Successors that become actionable once this is done. Named in the message. */
  unblocks: NodeId[];
  /**
   * For joins: the other input and whether it is already waiting. Without this, both
   * sides assume the other owes something.
   */
  sibling?: { node: NodeId; label: string; complete: boolean };
  /** Present on versioned nodes so the approver knows which version is being asked about. */
  version?: string;
  /** Lower sorts first. Deadline-bearing branches outrank cosmetic ones. */
  priority: number;
};

/** One message per person, however many nodes it covers. */
export type NudgeBatch = {
  recipient: Role;
  nudges: Nudge[];
};

export type Diagnostic = {
  level: "error" | "warn";
  code: string;
  message: string;
  node?: NodeId;
};

/**
 * `config_error` and `stall` both mean a human must look. They are deliberately distinct
 * from `done` and `quiet`, because silence that could mean either is the failure mode
 * that makes a nudger untrustworthy.
 */
export type TickOutcome = "nudges" | "done" | "quiet" | "stall" | "config_error";

export type TickResult = {
  outcome: TickOutcome;
  batches: NudgeBatch[];
  frontier: NodeId[];
  diagnostics: Diagnostic[];
};
