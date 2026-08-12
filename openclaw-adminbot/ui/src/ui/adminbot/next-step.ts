// "What is actually next on this paper", computed rather than typed.
//
// The nudge rules live in packages/nudge-engine and are shared with the spec and its tests; this
// file is only the bridge between AdminBot's paper record and that engine. Nothing here writes:
// it reads the record and returns a sentence, so it cannot affect the service or the ledger.
//
// Two sources of truth, in increasing order of confidence:
//
//   1. `current_step` — a single pipeline pointer. Coarse: it places the paper in one of eight
//      phases but cannot say which artifact inside that phase is missing.
//   2. `artifacts` — one URL per deliverable. A link that exists is proof the thing exists, so
//      these pin individual nodes exactly. It is the same "evidence" idea the graph declares on
//      its nodes, and it is why the nudge can say "slides are done, the poster is not" rather
//      than "you are somewhere in presentation".
//
// Evidence wins where it exists; the step pointer fills the gaps.

import {
  nudgeText,
  paperflow,
  predecessors,
  tick,
  type NodeId,
  type PaperState,
  type Status,
} from "@openclaw/nudge-engine";
// Read the step vocabulary from the contract rather than from views/admin.ts: that view now
// imports this file, and going through the shared contract keeps the two from forming a cycle.
import { adminBotPaperSteps } from "../../../../extensions/adminbot/src/contracts/actions.js";
import type { AdminBotPaperRecord } from "./controllers/admin.ts";

/**
 * Which PaperFlow nodes each AdminBot pipeline step covers.
 *
 * `adminBotPaperSteps` is the lab's vocabulary and PaperFlow is the dependency graph; this is the
 * one place the two are tied together, so a change to either is a change to exactly this table.
 */
const STEP_NODES: Record<string, NodeId[]> = {
  brainstorming_docs: ["BR"],
  overleaf_writing: ["OV", "PM", "FX", "PDF"],
  submission: ["CK", "SB"],
  google_drive_pdf: ["DR", "DS", "DA"],
  arxiv_polish: ["AK", "PK", "GT"],
  social_posts: ["XD", "LI", "CP", "SF", "PS"],
  slide_making: ["SL"],
  poster_making: ["PO"],
};

/**
 * A stored artifact link proves its node is done.
 *
 * Only unambiguous mappings are listed. `google_drive_pdf_url` maps to `DR` (a Drive PDF exists)
 * and deliberately not to `DS`/`DA`, because one URL cannot say whether it is the submitted
 * version or the arXiv version — guessing there would report work as finished that nobody did.
 */
const ARTIFACT_NODES: Array<[keyof NonNullable<AdminBotPaperRecord["artifacts"]>, NodeId]> = [
  ["brainstorming_doc_url", "BR"],
  ["overleaf_view_url", "OV"],
  ["overleaf_edit_url", "OV"],
  ["google_drive_pdf_url", "DR"],
  // A public arXiv URL means the gate was passed *and* the package posted. It is the strongest
  // single signal in the record.
  ["arxiv_url", "GT"],
  ["submission_url", "SB"],
  ["twitter_draft_url", "XD"],
  ["linkedin_draft_url", "LI"],
  ["google_slides_url", "SL"],
  ["poster_url", "PO"],
];

const NODES_BY_ID = new Map(paperflow.nodes.map((node) => [node.id, node]));

/**
 * Mark a node complete, and everything it depends on with it.
 *
 * A slides URL proves the paper compiled; a submission URL proves the checks were done. Without
 * this closure the frontier would offer steps that demonstrably already happened.
 *
 * Two places the walk deliberately stops:
 *   - at an OR-join it follows only the *first* declared inbound edge, the preprint path. Walking
 *     both would mark Camera ready done on a paper that was never accepted.
 *   - at a decision node, because "the venue accepted this" is not something an artifact proves.
 */
function completeWithAncestors(id: NodeId, status: Partial<Record<NodeId, Status>>): void {
  const queue: NodeId[] = [id];
  const seen = new Set<NodeId>();

  while (queue.length > 0) {
    const current = queue.shift() as NodeId;
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);

    const node = NODES_BY_ID.get(current);
    if (node?.cls === "decision") {
      continue;
    }
    status[current] = "complete";

    const preds = predecessors(paperflow, current);
    if (node?.cls === "or_join") {
      const primary = preds[0];
      if (primary) {
        queue.push(primary);
      }
      continue;
    }
    queue.push(...preds);
  }
}

/**
 * The paper record as node statuses: the step pointer sets the floor, artifacts pin what is
 * actually finished.
 */
export function paperToState(paper: AdminBotPaperRecord): PaperState {
  const status: Partial<Record<NodeId, Status>> = {};

  // 1. Everything before the current step is done. The current step is what is being worked on,
  //    so its own nodes stay open unless an artifact proves otherwise.
  const index = adminBotPaperSteps.indexOf(
    paper.current_step as (typeof adminBotPaperSteps)[number],
  );
  if (index > 0) {
    for (const step of adminBotPaperSteps.slice(0, index)) {
      for (const node of STEP_NODES[step] ?? []) {
        status[node] = "complete";
      }
    }
  }

  // 2. Artifacts pin individual nodes, and imply their prerequisites.
  const artifacts = paper.artifacts ?? {};
  for (const [field, node] of ARTIFACT_NODES) {
    const value = artifacts[field];
    if (typeof value === "string" && value.trim()) {
      completeWithAncestors(node, status);
    }
  }

  // 3. The reviewer checklist is the only signal for PaperMentor review, which has no artifact.
  if (paper.checks?.paper_mentor_checked) {
    completeWithAncestors("PM", status);
  }

  return {
    paperId: paper.id,
    attempt: 1,
    version: "current",
    status,
    // Venue outcomes are not in the paper record, so nothing is decided and no branch is pruned.
    // That errs toward showing a step that may not apply rather than hiding one that does.
    decisions: {},
  };
}

export type NextStep = {
  /** Short label for the single most important thing to do next. */
  headline: string;
  /** What finishing it releases, already phrased for a person. */
  unblocks: string;
  /** Everything else currently open, most urgent first. */
  alsoOpen: string[];
  /** True when the engine found nothing to do. */
  done: boolean;
  /**
   * Who the step is waiting on. The admin view needs this more than the member view does:
   * "waiting on Zhijing" and "waiting on the author" are different problems, and only one of
   * them is the author's to fix.
   */
  waitingOn: string;
  /** True when the blocker is an approval rather than work — it reads differently. */
  isApproval: boolean;
  /**
   * The message to actually send, composed by the engine so the wording matches the rules
   * rather than being retyped per surface.
   */
  message: string;
  /** How many nodes are proven done by a stored link, for the confidence hint. */
  evidenceCount: number;
};

const ROLE_LABELS: Record<string, string> = {
  first_author: "the first author",
  coauthors: "the coauthors",
  pi: "Zhijing",
  admin: "an admin",
};

const NODE_LABELS = new Map(paperflow.nodes.map((node) => [node.id, node.label]));

/** How many artifact links this paper has — drives the precision hint in the UI. */
export function evidenceCountFor(paper: AdminBotPaperRecord): number {
  const artifacts = paper.artifacts ?? {};
  return ARTIFACT_NODES.filter(([field]) => {
    const value = artifacts[field];
    return typeof value === "string" && value.trim().length > 0;
  }).length;
}

/**
 * The frontier for one paper, phrased for the person looking at it.
 *
 * Returns `undefined` when there is nothing useful to say, so the caller can render nothing at
 * all rather than an empty box.
 */
export function nextStepFor(paper: AdminBotPaperRecord): NextStep | undefined {
  const result = tick(paperflow, paperToState(paper));
  const evidenceCount = evidenceCountFor(paper);

  if (result.outcome === "done") {
    return {
      headline: "",
      unblocks: "",
      alsoOpen: [],
      done: true,
      waitingOn: "",
      isApproval: false,
      message: "",
      evidenceCount,
    };
  }
  // `stall` and `config_error` mean the graph or the mapping is wrong, not that the member has
  // work to do. Saying nothing is better than inventing a task.
  if (result.outcome !== "nudges") {
    return undefined;
  }

  const nudges = result.batches.flatMap((batch) => batch.nudges);
  const [first, ...rest] = nudges;
  if (!first) {
    return undefined;
  }

  const unblocks = first.unblocks
    .map((id) => NODE_LABELS.get(id) ?? id)
    .slice(0, 3)
    .join(", ");

  return {
    headline: first.nodeLabel,
    unblocks,
    alsoOpen: rest.map((nudge) => nudge.nodeLabel),
    done: false,
    waitingOn: ROLE_LABELS[first.recipient] ?? first.recipient,
    isApproval: first.kind === "approval",
    message: nudgeText(paperflow, first),
    evidenceCount,
  };
}
