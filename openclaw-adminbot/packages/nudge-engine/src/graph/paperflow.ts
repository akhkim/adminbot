/**
 * PaperFlow as data.
 *
 * Node ids match the PaperFlow chart exactly (`BR`, `OV`, `PM`, …) so this file and the
 * diagram can be read side by side with no translation step. Edge labels are the chart's
 * own words, kept so nudge messages can quote them back.
 *
 * Two edges are `reset`/`retry` rather than `requires`. They are the only cycles in the
 * graph, and excluding them from traversal is what makes everything else well-defined.
 */

import type { Graph } from "../types.ts";

export const paperflow: Graph = {
  root: "BR",

  nodes: [
    // ── core writing ────────────────────────────────────────────────────────────
    { id: "BR", label: "Brainstorm doc", cls: "action", owner: "first_author", branch: "core" },
    { id: "OV", label: "Overleaf draft", cls: "action", owner: "first_author", branch: "core" },
    { id: "PM", label: "PaperMentor review", cls: "action", owner: "first_author", branch: "core" },
    { id: "FX", label: "Fixes merged", cls: "action", owner: "first_author", branch: "core" },
    { id: "PDF", label: "Compiled paper PDF ready", cls: "action", owner: "first_author", branch: "core" },

    // ── branch 1: talk artifacts ────────────────────────────────────────────────
    { id: "SL", label: "Slides", cls: "action", owner: "first_author", branch: "talk" },
    { id: "PO", label: "Poster", cls: "action", owner: "first_author", branch: "talk" },
    { id: "TV", label: "Talk video", cls: "action", owner: "first_author", branch: "talk" },
    {
      id: "LG",
      label: "Links logged in shared folder",
      cls: "join",
      owner: "first_author",
      branch: "talk",
      evidence: "shared_folder_links",
    },

    // ── branch 2: social ────────────────────────────────────────────────────────
    // XD and LI are drafted in PARALLEL, both straight off the PDF. LinkedIn used to hang off
    // X ("adapt and lengthen"), which made a 280-character thread the source text for a
    // 900-2200 character post and blocked LinkedIn on work it does not need. They are separate
    // pieces of writing from the same abstract, so they are separate branches from the same node.
    { id: "XD", label: "X post draft", cls: "action", owner: "first_author", branch: "social" },
    { id: "LI", label: "LinkedIn post draft", cls: "action", owner: "first_author", branch: "social" },
    { id: "CP", label: "Coauthor feedback", cls: "action", owner: "coauthors", branch: "social" },
    { id: "SF", label: "Final social draft", cls: "action", owner: "first_author", branch: "social" },

    // ── branch 3: archival and arXiv ────────────────────────────────────────────
    { id: "DR", label: "Internal Drive PDF", cls: "action", owner: "first_author", branch: "archive" },
    {
      id: "DS",
      label: "Drive PDF, submitted version",
      cls: "action",
      owner: "first_author",
      branch: "archive",
      evidence: "drive_file",
    },
    {
      id: "DA",
      label: "Drive PDF, arXiv version",
      cls: "action",
      owner: "first_author",
      branch: "archive",
      evidence: "drive_file",
    },
    { id: "AK", label: "Author list and acknowledgements", cls: "action", owner: "first_author", branch: "archive" },
    {
      // OR-join: the preprint path (AK) alone is enough. Under AND, a reject prunes CM and
      // this branch would deadlock permanently and silently.
      id: "PK",
      label: "arXiv package prepared",
      cls: "or_join",
      owner: "first_author",
      branch: "archive",
      versioned: true,
    },
    {
      // The only approval gate in the graph. "Prepared is not permission."
      id: "GT",
      label: "Zhijing explicit yes",
      cls: "approval",
      owner: "pi",
      branch: "archive",
      versioned: true,
      evidence: "public_url",
    },
    {
      id: "BE",
      label: "Backend spreadsheet updated",
      cls: "optional",
      owner: "admin",
      branch: "archive",
    },

    // ── branch 4: venue ─────────────────────────────────────────────────────────
    { id: "CK", label: "Final submission checks", cls: "action", owner: "first_author", branch: "venue" },
    {
      id: "SB",
      label: "Submitted to venue",
      cls: "action",
      owner: "first_author",
      branch: "venue",
      evidence: "submission_id",
    },
    {
      // The venue's clock. Nobody can be nudged to make reviews appear — but somebody must
      // be nudged to *report* that they did, or this freezes the whole branch silently.
      id: "RV",
      label: "Reviews out",
      cls: "external_wait",
      owner: "first_author",
      branch: "venue",
    },
    { id: "RB", label: "Rebuttal window", cls: "decision", branch: "venue" },
    {
      id: "RS",
      label: "Rebuttal submitted",
      cls: "action",
      owner: "first_author",
      branch: "venue",
      hardDeadline: true,
    },
    { id: "DC", label: "Decision recorded", cls: "action", owner: "first_author", branch: "venue" },
    { id: "AC", label: "Accepted", cls: "decision", branch: "venue" },
    { id: "CM", label: "Camera ready", cls: "action", owner: "first_author", branch: "venue" },
    {
      // Travel is triggered by acceptance and runs *parallel* to camera ready, not after
      // it — chaining it behind CM would delay booking until flights are expensive.
      // Only opened for a first or co-first author, expressed as a decision outcome.
      id: "CA",
      label: "Conference attendance",
      cls: "action",
      owner: "first_author",
      branch: "venue",
      hardDeadline: true,
    },
    {
      // Separate from CA rather than a bullet on it: reimbursement cannot start until the
      // receipts exist, so it is genuinely sequential.
      id: "RM",
      label: "Reimbursement reminders",
      cls: "action",
      owner: "first_author",
      branch: "venue",
    },
    { id: "RJ", label: "Rejected", cls: "action", owner: "first_author", branch: "venue" },

    // ── convergence ─────────────────────────────────────────────────────────────
    { id: "JN", label: "Both inputs present", cls: "join", owner: "first_author", branch: "social" },
    { id: "PS", label: "Publish X and LinkedIn", cls: "action", owner: "first_author", branch: "social" },
  ],

  edges: [
    { from: "BR", to: "OV", kind: "requires", label: "Register with AdminBot" },
    { from: "OV", to: "PM", kind: "requires" },
    { from: "PM", to: "FX", kind: "requires", label: "Merge low cost fixes" },
    { from: "FX", to: "PDF", kind: "requires", label: "Compiles cleanly" },

    { from: "PDF", to: "SL", kind: "requires", label: "Branch 1" },
    { from: "PDF", to: "XD", kind: "requires", label: "Branch 2" },
    { from: "PDF", to: "LI", kind: "requires", label: "Branch 2" },
    { from: "PDF", to: "DR", kind: "requires", label: "Branch 3" },
    { from: "PDF", to: "CK", kind: "requires", label: "Branch 4" },

    { from: "SL", to: "PO", kind: "requires" },
    { from: "SL", to: "TV", kind: "requires" },
    { from: "PO", to: "LG", kind: "requires" },
    { from: "TV", to: "LG", kind: "requires" },

    { from: "XD", to: "CP", kind: "requires", label: "Email round" },
    { from: "LI", to: "CP", kind: "requires", label: "Email round" },
    { from: "CP", to: "SF", kind: "requires" },

    { from: "DR", to: "DS", kind: "requires" },
    { from: "DR", to: "DA", kind: "requires" },
    { from: "DA", to: "AK", kind: "requires" },
    { from: "AK", to: "PK", kind: "requires" },
    { from: "PK", to: "GT", kind: "gate", label: "Prepared is not permission" },
    // C2 — RETRY. Never traversed upstream.
    { from: "GT", to: "PK", kind: "retry", label: "Not yet" },
    { from: "GT", to: "JN", kind: "gate", label: "Public URL" },
    { from: "GT", to: "BE", kind: "requires" },

    { from: "CK", to: "SB", kind: "requires" },
    { from: "SB", to: "RV", kind: "requires", label: "Submission id registered" },
    { from: "RV", to: "RB", kind: "requires" },
    { from: "RB", to: "RS", kind: "requires", label: "Yes" },
    { from: "RB", to: "DC", kind: "requires", label: "No" },
    { from: "RS", to: "DC", kind: "requires" },
    { from: "DC", to: "AC", kind: "requires" },
    { from: "AC", to: "CM", kind: "requires", label: "Accept" },
    { from: "AC", to: "CA", kind: "requires", label: "Accept, first or co-first author" },
    { from: "CA", to: "RM", kind: "requires", label: "After conference" },
    { from: "AC", to: "RJ", kind: "requires", label: "Reject" },
    { from: "CM", to: "PK", kind: "requires", label: "Still needs the gate" },
    // C1 — RESET. Never traversed upstream. Opens attempt n+1.
    { from: "RJ", to: "OV", kind: "reset", label: "Revise, new venue, same record" },

    { from: "SF", to: "JN", kind: "requires" },
    { from: "JN", to: "PS", kind: "requires", label: "Yes" },
  ],
};

/**
 * Which nodes a rejection re-opens, and which it must leave alone. Resetting everything
 * destroys valid work; resetting nothing leaves the paper falsely "done".
 */
export const resetScope = {
  /** Cleared and re-run on the next attempt. */
  cleared: ["CK", "SB", "RV", "RB", "RS", "DC", "AC", "CM", "CA", "RM", "RJ"],
  /** Re-opened for revision. */
  reopened: ["OV", "PM", "FX", "PDF"],
  /** Untouched — this work stays valid across attempts. */
  survives: ["SL", "PO", "TV", "LG", "XD", "LI", "CP", "SF", "DR", "DS", "DA", "AK"],
} as const;

/** Branch ordering for nudge priority. Deadline-bearing work outranks cosmetic work. */
export const branchPriority: Record<string, number> = {
  venue: 0,
  core: 1,
  archive: 2,
  social: 3,
  talk: 4,
};
