// Progress follows evidence. All author-editable stages are available independently;
// backend dependencies still govern automated actions.
import { html, nothing } from "lit";
import {
  adminBotPaperFlowBranchNumber,
  adminBotPaperSlotChartOrder,
  adminBotPaperSlotRegistry,
  adminBotPaperSlots,
  isAdminBotPaperSlotSettled,
  type AdminBotPaperSlot,
  type AdminBotPaperSlotBranch,
} from "../../../../../extensions/adminbot/src/contracts/paper-slots.js";
import { icons } from "../../icons.ts";
import type { PaperSlotRow } from "../api/papers.ts";

/**
 * What one dot can be.
 *
 * `attention` outranks the rest: a value on file that the service rejected is not progress and
 * not absence, and folding it into either loses the only state the author can act on immediately.
 * `ready` is the frontier -- several lanes are usually ready at once, which is the fact the old
 * single track could not show.
 */
export type TimelineNodeState = "done" | "attention" | "ready" | "waiting";

export type TimelineNode = {
  /** PaperFlow node id (`BR`, `OV`, …), or `DC` for the synthetic venue decision. */
  id: string;
  label: string;
  state: TimelineNodeState;
  provided: number;
  total: number;
  /** The labels this node is still waiting on, for the tooltip. Empty unless `waiting`. */
  waitingOn: string[];
};

export type TimelineLane = {
  branch: AdminBotPaperSlotBranch;
  label: string;
  /** The chart's own "Branch 1".."Branch 4". `null` for the trunk. */
  branchNumber: number | null;
  nodes: TimelineNode[];
  /** The node this lane hangs off, when that node is not finished yet. */
  opensAfter?: string;
  /** Every node done. */
  complete: boolean;
};

const BRANCH_LABELS: Record<AdminBotPaperSlotBranch, string> = {
  core: "Writing",
  venue: "Venue",
  archive: "Archival",
  social: "Social",
  talk: "Presentation",
};

const BRANCH_ICONS: Record<AdminBotPaperSlotBranch, keyof typeof icons> = {
  core: "fileText",
  venue: "send",
  archive: "archive",
  social: "globe",
  talk: "monitor",
};

/**
 * A dot's caption: the chart's own node names, shortened to fit under one.
 *
 * Written out rather than read from the graph package, which the Control UI's own typecheck
 * cannot resolve (see next-step.ts and paperflow-map.ts, both red on the same import). The cost
 * is a table that could drift from the chart, so paper-timeline.test.ts asserts every node the
 * registry produces has an entry here -- a new slot with a new node fails that test rather than
 * rendering a bare id.
 */
const NODE_LABELS: Record<string, string> = {
  BR: "Brainstorm",
  OV: "Overleaf",
  PM: "PaperMentor",
  FX: "Fixes merged",
  PDF: "PDF ready",
  SL: "Slides",
  PO: "Poster",
  TV: "Talk video",
  XD: "X draft",
  LI: "LinkedIn draft",
  CP: "Coauthor feedback",
  SF: "Copy final",
  PS: "Posted",
  DA: "Drive PDF",
  AK: "Authors & acks",
  PK: "arXiv password",
  GT: "arXiv live",
  SB: "Submitted",
};

/** The synthetic node id for "what the venue said". Not slot-backed -- see `venueDecisionNode`. */
const DECISION_NODE = "DC";

function statusOf(slots: PaperSlotRow[], slot: AdminBotPaperSlot): PaperSlotRow["status"] {
  return slots.find((row) => row.slot === slot)?.status ?? "missing";
}

function settled(slots: PaperSlotRow[], slot: AdminBotPaperSlot): boolean {
  return isAdminBotPaperSlotSettled(statusOf(slots, slot));
}

/**
 * The required slots that are evidence for each chart node, in the order the work happens.
 *
 * Advisory slots are left out for the same reason they are left out of the progress count: a dot
 * that can never fill because nobody logged where the printed poster is stopped being a picture
 * of the paper's state.
 */
function nodeSlots(branch: AdminBotPaperSlotBranch): Map<string, AdminBotPaperSlot[]> {
  const grouped = new Map<string, AdminBotPaperSlot[]>();
  for (const slot of adminBotPaperSlots) {
    const definition = adminBotPaperSlotRegistry[slot];
    if (definition.branch !== branch || !definition.required) {
      continue;
    }
    const list = grouped.get(definition.node) ?? [];
    list.push(slot);
    grouped.set(definition.node, list);
  }
  return grouped;
}

/** Upstream slots that live outside this node -- the edges that actually gate it. */
function buildNode(id: string, members: AdminBotPaperSlot[], slots: PaperSlotRow[]): TimelineNode {
  const provided = members.filter((slot) => settled(slots, slot)).length;
  const invalid = members.some((slot) => statusOf(slots, slot) === "invalid");
  const label = NODE_LABELS[id] ?? adminBotPaperSlotRegistry[members[0] as AdminBotPaperSlot].label;
  const state: TimelineNodeState = invalid
    ? "attention"
    : provided === members.length
      ? "done"
      : "ready";
  return {
    id,
    label,
    state,
    provided,
    total: members.length,
    waitingOn: [],
  };
}

/**
 * What the venue said, as the last dot on the venue lane.
 *
 * Synthetic because there is no slot for it: the decision lives on the paper record, and the
 * stages under it are closed by the bcc loop rather than by anybody filling a field in. Without
 * it a rejected paper's lane would end on "Submitted" and read as still in flight.
 */
function venueDecisionNode(decision: string | undefined, submitted: boolean): TimelineNode {
  if (decision === "accept") {
    return {
      id: DECISION_NODE,
      label: "Accepted",
      state: "done",
      provided: 1,
      total: 1,
      waitingOn: [],
    };
  }
  if (decision === "reject") {
    // Done as in answered, not as in good. The lane stops here until the paper is re-aimed, and
    // the card's summary says so in words rather than leaving a green tick to imply success.
    return {
      id: DECISION_NODE,
      label: "Rejected",
      state: "attention",
      provided: 1,
      total: 1,
      waitingOn: [],
    };
  }
  return {
    id: DECISION_NODE,
    label: "Venue decision",
    state: submitted ? "ready" : "waiting",
    provided: 0,
    total: 1,
    waitingOn: submitted ? [] : ["Submitted to venue"],
  };
}

/**
 * The whole chart for one paper: the trunk, then the four branches in the chart's own order.
 *
 * Pure, and exported on its own so the card, its tests and anything else that wants "where is
 * this paper" all read the same computation rather than three approximations of it.
 */
export function buildPaperTimeline(
  slots: PaperSlotRow[],
  paper: { venue_decision?: string } = {},
): TimelineLane[] {
  return adminBotPaperSlotChartOrder.map((branch) => {
    const grouped = nodeSlots(branch);
    const nodes = [...grouped].map(([id, members]) => buildNode(id, members, slots));
    if (branch === "venue") {
      nodes.push(venueDecisionNode(paper.venue_decision, settled(slots, "submission_id")));
    }
    // A branch is gated by whatever its first node is gated by, which is how the lane can say
    // "opens once the PDF compiles" instead of showing four dead dots with no reason given.
    const first = nodes[0];
    const opensAfter = first?.state === "waiting" ? first.waitingOn[0] : undefined;
    return {
      branch,
      label: BRANCH_LABELS[branch],
      branchNumber: adminBotPaperFlowBranchNumber[branch],
      nodes,
      ...(opensAfter ? { opensAfter } : {}),
      complete: nodes.length > 0 && nodes.every((node) => node.state === "done"),
    };
  });
}

function nodeTitle(node: TimelineNode): string {
  switch (node.state) {
    case "done":
      return `${node.label} — done`;
    case "attention":
      return `${node.label} — needs attention`;
    case "waiting":
      return `${node.label} — waiting on ${node.waitingOn.join(" and ")}`;
    default:
      return node.total > 1
        ? `${node.label} — ready, ${node.provided} of ${node.total} in`
        : `${node.label} — ready to do now`;
  }
}

function renderLane(paperId: string, lane: TimelineLane) {
  if (lane.nodes.length === 0) {
    return nothing;
  }
  return html`
    <section
      class=${`ptl__lane ptl__lane--${lane.branch} ${
        lane.branchNumber === null ? "ptl__lane--trunk" : ""
      } ${lane.opensAfter ? "is-shut" : ""}`}
      data-testid=${`paper-timeline-lane-${paperId}-${lane.branch}`}
    >
      <h5 class="ptl__lane-title">
        <span class="ptl__lane-icon" aria-hidden="true">${icons[BRANCH_ICONS[lane.branch]]}</span>
        <span class="ptl__lane-name">${lane.label}</span>
        ${lane.opensAfter
          ? html`<span class="ptl__lane-gate">opens after ${lane.opensAfter}</span>`
          : lane.complete
            ? html`<span class="ptl__lane-gate ptl__lane-gate--done">done</span>`
            : nothing}
      </h5>
      <ol class="ptl__track">
        ${lane.nodes.map(
          (node) => html`
            <li
              class=${`ptl__step ptl__step--${node.state}`}
              data-testid=${`paper-timeline-node-${paperId}-${node.id}`}
              data-state=${node.state}
              title=${nodeTitle(node)}
            >
              <span class="ptl__dot" aria-hidden="true">
                ${node.state === "done" ? "✓" : node.state === "attention" ? "!" : nothing}
              </span>
              <span class="ptl__label">${node.label}</span>
              <span class="sr-only">${nodeTitle(node)}</span>
            </li>
          `,
        )}
      </ol>
    </section>
  `;
}

export type PaperTimelineProps = {
  paperId: string;
  slots: PaperSlotRow[];
  paper?: { venue_decision?: string };
};

export function renderPaperTimeline(props: PaperTimelineProps) {
  // A card whose slots have not arrived yet gets nothing rather than a timeline of empty dots:
  // "nothing is done" and "nothing is loaded" look identical and only one of them is true.
  if (props.slots.length === 0) {
    return nothing;
  }
  const lanes = buildPaperTimeline(props.slots, props.paper ?? {});
  const ready = lanes.flatMap((lane) => lane.nodes).filter((node) => node.state === "ready").length;
  return html`
    <div class="ptl" data-testid=${`paper-timeline-${props.paperId}`}>
      <p class="ptl__head">
        <span class="ptl__head-title">Where this paper is</span>
        <span class="ptl__head-hint">
          ${ready > 1 ? `${ready} things can move in parallel` : "Read off the evidence below"}
        </span>
      </p>
      ${lanes.map((lane) => renderLane(props.paperId, lane))}
    </div>
  `;
}
