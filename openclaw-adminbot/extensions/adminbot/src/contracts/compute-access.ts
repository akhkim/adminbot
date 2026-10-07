// What compute a member is allowed onto, and who has to be told when that changes.
//
// A separate axis from `collaborator-subgroups.ts`, which is the other thing in this codebase
// called "access". That one answers "which Slack channels and Drive folders does a collaborator
// get" -- a question the lab settles by itself. This one answers "which cluster may this person
// log into", which is settled by somebody else's IT department: DCS sponsors the unix accounts,
// Vector sponsors its own, and the lab's part is to keep them correctly informed. The two never
// share a vocabulary and must not be merged, because a wrong answer here costs somebody else's
// compute budget rather than the lab's own tidiness.
//
// The vocabulary is deliberately a closed list rather than free text. These strings are written
// into a spreadsheet an external sysadmin acts on, and "UofT-H100" typed two ways is two rows she
// has to reconcile by hand.

/**
 * Access the lab grants today, and that the DCS sheet is allowed to name.
 *
 * Ordered least to most privileged, with the end state last. That order is what the sheet sorts
 * on, so a reader scanning a column sees the escalation rather than an alphabet.
 */
export const adminBotComputeAccessValues = [
  "UofT-slack-only",
  "UofT-cslab",
  "UofT-AI-Slurm",
  "UofT-RTX6000-maple-etc",
  "UofT-H100",
  "UofT-total-deletion",
] as const;

/**
 * Named in the source doc as allowable, but nothing provisions them yet.
 *
 * Carried here rather than left out so the sheet's validation does not reject a cell a human
 * fills in ahead of the automation. A value being listed is a statement about the vocabulary,
 * never a claim that AdminBot can grant it.
 */
export const adminBotReservedComputeAccessValues = [
  "vector-basic-A100",
  "vector-killarney",
  "compute-canada-def",
  "compute-canada-rrg",
  "mpi",
  "eth-schoelkopf",
  "eth-sachan",
  // The source doc names this only in its "safe for newcomers" line, never in the allowed-values
  // list, so whether it is a grant of its own or a narrower reading of UofT-RTX6000-maple-etc is
  // not settled. Reserved rather than live until somebody says which.
  "UofT-RTX6000-test",
] as const;

export type AdminBotComputeAccess =
  | (typeof adminBotComputeAccessValues)[number]
  | (typeof adminBotReservedComputeAccessValues)[number];

export const adminBotAllComputeAccessValues: readonly AdminBotComputeAccess[] = [
  ...adminBotComputeAccessValues,
  ...adminBotReservedComputeAccessValues,
];

/** Whose sysadmin acts on the row. Decides which partner sheet a change is reported on. */
export type AdminBotComputeProvider = "dcs" | "vector" | "compute_canada" | "mpi" | "eth";

export type AdminBotComputeAccessDefinition = {
  provider: AdminBotComputeProvider;
  label: string;
  /** Whether the lab grants it today. Reserved values are vocabulary only. */
  provisioned: boolean;
  /**
   * Whether handing this to somebody brand new can cost anybody else anything.
   *
   * The distinction the source doc draws, and the reason it is a property rather than a second
   * list: "compute-canada-def shares a credit pool" is the fact that decides whether a newcomer
   * gets it on day one, and it has to travel with the value to every surface that offers it.
   * A separate list would be a second place for the answer to drift.
   */
  newcomerSafe: boolean;
  /** Why misuse reaches other people, when it does. Empty when nothing is shared. */
  sharedCost?: string;
  /**
   * Not a grant: the row is being removed outright.
   *
   * Kept inside the same vocabulary because it is what the `permission` cell says when an account
   * is retired, and a separate "deleted" flag would let a row claim an access level and a deletion
   * at once.
   */
  terminal?: true;
  note?: string;
};

export const adminBotComputeAccessRegistry: Record<
  AdminBotComputeAccess,
  AdminBotComputeAccessDefinition
> = {
  "UofT-slack-only": {
    provider: "dcs",
    label: "Slack-only account",
    provisioned: true,
    newcomerSafe: true,
    note: "Can send email; no AI Slurm cluster and none of the private servers.",
  },
  "UofT-cslab": {
    provider: "dcs",
    label: "CSLab servers",
    provisioned: true,
    newcomerSafe: true,
    note: "Every sponsored unix account carried this under the pre-2026-08 arrangement; the doc states no current roster for it.",
  },
  "UofT-AI-Slurm": {
    provider: "dcs",
    label: "AI Slurm cluster",
    provisioned: true,
    // A scheduler queue: a runaway job costs other people wall-clock, not money.
    newcomerSafe: false,
    sharedCost: "Shares the AI Slurm queue with the rest of the department.",
  },
  "UofT-RTX6000-maple-etc": {
    provider: "dcs",
    label: "Private servers (maple, aurora, …)",
    provisioned: true,
    newcomerSafe: false,
    sharedCost: "The lab's own purchased machines; a runaway job displaces lab work.",
    note: "The doc separates major users, summer users, and hosting-only accounts, which this single value does not yet distinguish.",
  },
  "UofT-H100": {
    provider: "dcs",
    label: "concerto3 (H100)",
    provisioned: true,
    newcomerSafe: false,
    sharedCost: "One H100 box reserved for interp and post-training runs.",
    note: "concerto3 sits outside Slurm. The source doc's parenthetical is ambiguous about whether it attaches to this value or to the deletion below; read as this one, since the doc elsewhere calls concerto3 an H100.",
  },
  "UofT-total-deletion": {
    provider: "dcs",
    label: "Remove the account entirely",
    provisioned: true,
    newcomerSafe: true,
    terminal: true,
    note: "The monthly pass proposes this for people who have left projects and lost contact.",
  },
  "vector-basic-A100": {
    provider: "vector",
    label: "Vector basic A100",
    provisioned: false,
    newcomerSafe: true,
    note: "Has a priority queue, so a newcomer cannot starve anybody.",
  },
  "vector-killarney": {
    provider: "vector",
    label: "Vector Killarney",
    provisioned: false,
    newcomerSafe: false,
    sharedCost: "Invite-only large-compute allocation.",
  },
  "compute-canada-def": {
    provider: "compute_canada",
    label: "Compute Canada — default allocation",
    provisioned: false,
    newcomerSafe: false,
    sharedCost:
      "Draws on the group's shared credits. One person submitting thousands of jobs by accident spends everybody's.",
  },
  "compute-canada-rrg": {
    provider: "compute_canada",
    label: "Compute Canada — RRG allocation",
    provisioned: false,
    newcomerSafe: false,
    sharedCost: "A competitively awarded allocation held by the group.",
  },
  mpi: {
    provider: "mpi",
    label: "MPI cluster",
    provisioned: false,
    newcomerSafe: false,
    sharedCost: "Max Planck institute compute, sponsored per person.",
  },
  "eth-schoelkopf": {
    provider: "eth",
    label: "ETH — Schölkopf group",
    provisioned: false,
    newcomerSafe: false,
    sharedCost: "Another group's allocation, lent per person.",
  },
  "eth-sachan": {
    provider: "eth",
    label: "ETH — Sachan group",
    provisioned: false,
    newcomerSafe: false,
    sharedCost: "Another group's allocation, lent per person.",
  },
  "UofT-RTX6000-test": {
    provider: "dcs",
    label: "RTX6000 (small tests)",
    provisioned: false,
    newcomerSafe: true,
    note: "Named by the doc only as newcomer-safe; see the reserved list above for why it is not live.",
  },
};

/** Whether a string is access this deployment recognises at all, live or reserved. */
export function isAdminBotComputeAccess(value: string): value is AdminBotComputeAccess {
  return Object.hasOwn(adminBotComputeAccessRegistry, value);
}

/** Whether the lab can actually grant it today, as opposed to merely spell it. */
export function isProvisionedComputeAccess(value: string): boolean {
  return isAdminBotComputeAccess(value) && adminBotComputeAccessRegistry[value].provisioned;
}

/**
 * The access a newcomer can be given without anybody else bearing the cost of a mistake.
 *
 * The lab mentors around fifty short-term undergraduates, so "what is safe to hand out on day
 * one" is a question that gets asked constantly and should have one answer in code.
 */
export function newcomerSafeComputeAccess(): AdminBotComputeAccess[] {
  return adminBotAllComputeAccessValues.filter(
    (value) => adminBotComputeAccessRegistry[value].newcomerSafe,
  );
}

/**
 * A member's access, ordered and de-duplicated, with anything unrecognised dropped.
 *
 * Order comes from the vocabulary rather than from however the cells were typed, so two members
 * with the same access produce the same string and a diff against the sheet is not noise.
 */
export function normalizeComputeAccess(values: readonly string[]): AdminBotComputeAccess[] {
  const held = new Set(values.map((value) => value.trim()).filter(isAdminBotComputeAccess));
  return adminBotAllComputeAccessValues.filter((value) => held.has(value));
}

/**
 * How the `permission` cell is written, given a member's access.
 *
 * Multiple choices in one cell, comma-separated. A removal is written alone: an account being
 * deleted has no access level to also report, and a cell saying both would ask the sysadmin to
 * decide which half to act on.
 */
export function formatComputeAccessCell(values: readonly string[]): string {
  const access = normalizeComputeAccess(values);
  const terminal = access.find((value) => adminBotComputeAccessRegistry[value].terminal);
  return terminal ? terminal : access.join(", ");
}
