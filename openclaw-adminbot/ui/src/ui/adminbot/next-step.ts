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
  successors,
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
  google_drive_pdf: ["DR", "DA"],
  arxiv_polish: ["AK", "PK", "GT"],
  social_posts: ["XD", "LI", "CP", "SF", "PS"],
  slide_making: ["SL"],
  poster_making: ["PO"],
};

/**
 * A stored artifact link proves its node is done.
 *
 * `google_drive_pdf_url` maps to `DR` (a Drive PDF exists). It used to stop there, because the
 * graph carried both a submitted-version and an arXiv-version node and one URL could not say
 * which it was. There is only one Drive PDF now, so the ambiguity that forced the caution is
 * gone -- but this table stays conservative and lets the slot rows, which record the version
 * explicitly, be the thing that closes `DA`.
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

/** Which parallel track a task belongs to, for the grouping label on each card. */
const BRANCH_LABELS: Record<string, string> = {
  core: "Writing",
  talk: "Presentation",
  social: "Social",
  archive: "Archival",
  venue: "Venue",
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
  if (isDormant(paper)) {
    return undefined;
  }
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

/**
 * Human phrasing for every node, because the graph's own labels are written for the graph.
 *
 * "Both inputs present" is a join condition, not something a person does, and "arXiv package
 * prepared" names a state rather than an action. Each entry is an instruction plus one line
 * saying what it means, so someone reading the card alone knows what to go and do.
 */
const TASK_COPY: Record<string, { title: string; hint: string }> = {
  BR: {
    title: "Write the brainstorm doc",
    hint: "A short write-up of the idea, so it can be registered with AdminBot.",
  },
  OV: { title: "Start the Overleaf draft", hint: "Create the project and get the skeleton in." },
  PM: {
    title: "Get PaperMentor feedback",
    hint: "Run the draft past PaperMentor and collect its comments.",
  },
  FX: { title: "Merge the easy fixes", hint: "Apply the low-cost suggestions from the review." },
  PDF: {
    title: "Compile a clean PDF",
    hint: "The draft has to build without errors before anything else starts.",
  },
  SL: { title: "Make the slides", hint: "Talk slides for the venue." },
  PO: { title: "Make the poster", hint: "Poster version, if the venue asks for one." },
  TV: { title: "Record the talk video", hint: "Short recorded version of the talk." },
  XD: { title: "Draft the X post", hint: "A short thread announcing the paper." },
  LI: { title: "Adapt it for LinkedIn", hint: "Longer version of the X post." },
  CP: {
    title: "Collect coauthor feedback",
    hint: "Send the draft posts round and wait for replies.",
  },
  SF: {
    title: "Finalise the social copy",
    hint: "Fold the coauthor comments into a final version.",
  },
  DR: { title: "Upload the PDF to Drive", hint: "The lab's own copy of the paper." },
  DA: { title: "Save the arXiv version", hint: "The version you intend to post publicly." },
  AK: {
    title: "Finalise authors and acknowledgements",
    hint: "Check the author list and thank-yous before packaging.",
  },
  PK: {
    title: "Prepare the arXiv package",
    hint: "Build the upload bundle. Preparing it is not permission to post.",
  },
  GT: {
    title: "Get Zhijing's OK to post",
    hint: "An explicit yes is needed before anything goes public.",
  },
  BE: {
    title: "Update the tracking spreadsheet",
    hint: "Optional bookkeeping. Nothing waits on it.",
  },
  CK: {
    title: "Run the submission checks",
    hint: "Formatting, page limit, anonymity, references.",
  },
  SB: { title: "Submit to the venue", hint: "Upload, and keep the submission id." },
  RV: { title: "Wait for reviews", hint: "The venue's clock. Nothing to do until they arrive." },
  RS: { title: "Write the rebuttal", hint: "Respond inside the rebuttal window. Hard deadline." },
  DC: {
    title: "Record the decision",
    hint: "Log accept or reject so the rest of the flow continues.",
  },
  CM: { title: "Prepare the camera-ready", hint: "Final version for publication." },
  CA: {
    title: "Register and book travel",
    hint: "Read the reimbursement policy first, then register, flights and hotel.",
  },
  RM: {
    title: "File your reimbursement",
    hint: "After the conference, once you have the receipts.",
  },
  RJ: {
    title: "Record the rejection",
    hint: "Log it so the paper can be revised for another venue.",
  },
  PS: {
    title: "Publish on X and LinkedIn",
    hint: "Both the social copy and the public link are ready.",
  },
};

/**
 * Nodes that exist for the graph rather than for people. A join is a condition being met, so once
 * it is satisfied the real work is whatever it unlocks -- show that instead.
 */
const LOGIC_ONLY = new Set<NodeId>(["JN"]);

/**
 * A paper this old is not "late", it is dormant, and nudging it every week trains people to
 * ignore nudges for the papers that are moving. Two years is deliberately generous: it is long
 * enough that nothing on a normal submission cycle trips it.
 */
const DORMANT_MONTHS = 24;

/** Admin-only escape hatch. `checks` is rejected from member writes, so only a PI can set it. */
const NUDGE_OVERRIDE = "nudge_override";

/**
 * Should this paper be left alone?
 *
 * Silent by design: the rule is internal, so nobody games the clock. The card still says the
 * paper is dormant, because a card with no next step and no explanation reads as a bug.
 */
export function isDormant(paper: AdminBotPaperRecord, now = Date.now()): boolean {
  if (paper.checks?.[NUDGE_OVERRIDE]) {
    return false;
  }
  const started = Date.parse(paper.created_at ?? "");
  if (!Number.isFinite(started)) {
    return false;
  }
  const months = (now - started) / (1000 * 60 * 60 * 24 * 30.44);
  return months > DORMANT_MONTHS;
}

/** How many parallel tasks to surface. Beyond this it reads as a backlog, not a next step. */
const MAX_TASKS = 3;

/** One actionable task on the frontier, ready to render as a card. */
export type NextTask = {
  node: NodeId;
  label: string;
  hint: string;
  waitingOn: string;
  unblocks: string[];
  isApproval: boolean;
  optional: boolean;
  branch: string;
};

/**
 * Every task that is actionable right now, not just the top one.
 *
 * The graph fans out -- once the PDF compiles, slides, social and archival open simultaneously --
 * so collapsing the frontier to a single "next" hid the fact that three people could be working
 * at once. Returning the whole frontier lets the UI show parallel work as parallel.
 */
export function nextTasksFor(paper: AdminBotPaperRecord): NextTask[] {
  if (isDormant(paper)) {
    return [];
  }
  const result = tick(paperflow, paperToState(paper));
  if (result.outcome !== "nudges") {
    return [];
  }
  const byId = new Map(paperflow.nodes.map((node) => [node.id, node]));

  const seen = new Set<NodeId>();
  const out: NextTask[] = [];

  const add = (id: NodeId, recipient: string, kind: string, unblocks: NodeId[]) => {
    // A satisfied join is a condition, not a task: nobody "does" Both inputs present. Show what
    // it unlocks instead, or the card tells the reader to do something that is not a thing.
    if (LOGIC_ONLY.has(id)) {
      for (const next of successors(paperflow, id)) {
        add(next, recipient, kind, successors(paperflow, next));
      }
      return;
    }
    if (seen.has(id)) {
      return;
    }
    seen.add(id);
    const node = byId.get(id);
    const copy = TASK_COPY[id];
    out.push({
      node: id,
      label: copy?.title ?? node?.label ?? id,
      hint: copy?.hint ?? "",
      waitingOn: ROLE_LABELS[recipient] ?? recipient,
      unblocks: unblocks.map((each) => NODE_LABELS.get(each) ?? each),
      isApproval: kind === "approval",
      optional: kind === "optional",
      branch: BRANCH_LABELS[node?.branch ?? ""] ?? "",
    });
  };

  for (const nudge of result.batches.flatMap((batch) => batch.nudges)) {
    add(nudge.node, nudge.recipient, nudge.kind, nudge.unblocks);
  }

  // Show at most a handful. The engine is right that five things are unblocked, but a person
  // reading their own paper wants the next move, not a backlog -- and a task that unblocks
  // something is more urgent than a leaf that ends its branch.
  // Rank by how near the work is to where the paper actually is. The frontier is technically
  // correct that a poster is unblocked, but telling someone still writing the draft to make a
  // poster is noise -- near work first, then things that unblock something, optional last.
  const currentIndex = Math.max(
    0,
    adminBotPaperSteps.indexOf(paper.current_step as (typeof adminBotPaperSteps)[number]),
  );
  const stepIndexOf = (id: NodeId) =>
    adminBotPaperSteps.findIndex((step) => (STEP_NODES[step] ?? []).includes(id));

  return out
    .sort((left, right) => {
      const weight = (task: NextTask) => {
        const index = stepIndexOf(task.node);
        const distance = index < 0 ? 9 : Math.abs(index - currentIndex);
        return distance * 10 + (task.optional ? 50 : 0) + (task.unblocks.length ? 0 : 3);
      };
      return weight(left) - weight(right);
    })
    .slice(0, MAX_TASKS);
}
