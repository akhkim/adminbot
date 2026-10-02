// The moments in a paper's venue cycle that AdminBot chases by email, and the evidence that
// closes them.
//
// These are deliberately not `paper_slots`. A slot is an artifact somebody in the lab produces
// and can be asked to paste a link to; a stage here is an event the *venue* causes, which nobody
// in the lab controls and nobody can be asked to produce. The only thing an author can do is tell
// us it happened -- and the way the lab tells AdminBot is by forwarding the venue mail from an
// address on the member's profile. So the unit of state is "have we seen that mail yet", which is
// a different question from "is this artifact on file" and gets its own table.
//
// The stages mirror PaperFlow's venue branch (packages/nudge-engine/src/graph/paperflow.ts):
// RV -> RB/RS -> DC -> AC -> CM and CA. Ids are the PaperFlow node names lowercased so the two
// can be read side by side.

/**
 * The chased stages, in the order a paper passes through them.
 *
 * Order is load-bearing: `openPaperflowStages` only ever asks about the earliest unevidenced
 * stage on a paper, so a paper whose reviews have not landed is never simultaneously asked
 * whether the decision came out.
 */
export const adminBotPaperflowStages = [
  "reviews_out",
  "rebuttal",
  "decision",
  "camera_ready",
  "conference",
] as const;

export type AdminBotPaperflowStage = (typeof adminBotPaperflowStages)[number];

export function isAdminBotPaperflowStage(value: unknown): value is AdminBotPaperflowStage {
  return (
    typeof value === "string" && (adminBotPaperflowStages as readonly string[]).includes(value)
  );
}

export type AdminBotPaperflowStageDefinition = {
  /** The PaperFlow node this stage stands for. */
  node: string;
  /** What the subject line and the message call it. */
  label: string;
  /** The one sentence the nudge opens with. Written as a question, because it is one. */
  question: string;
  /** What evidence the author is asked to forward from an address on their AdminBot profile. */
  handoffAsk: string;
  /** Lower sorts first. The venue branch outranks everything, and a hard clock outranks that. */
  priority: number;
  /**
   * A stage whose window closes: missing it is irreversible, so it escalates rather than waiting
   * for the next sweep.
   */
  deadlineBearing: boolean;
};

export const adminBotPaperflowStageRegistry: Record<
  AdminBotPaperflowStage,
  AdminBotPaperflowStageDefinition
> = {
  reviews_out: {
    node: "RV",
    label: "Reviews",
    question: "Have the reviews come back yet?",
    handoffAsk: "forward the review notification the venue sent",
    priority: -1,
    deadlineBearing: false,
  },
  rebuttal: {
    node: "RB",
    label: "Rebuttal window",
    question: "Is there a rebuttal window open on this, and when does it close?",
    // The rebuttal is the one stage where the useful artifact is ours rather than the venue's,
    // so the ask is for the thread rather than for a notification.
    handoffAsk: "send either the rebuttal you filed or a note that no rebuttal is due",
    priority: -2,
    deadlineBearing: true,
  },
  decision: {
    node: "DC",
    label: "Decision",
    question: "Has the decision come out yet?",
    handoffAsk: "forward the decision email the venue sent",
    priority: -1,
    deadlineBearing: false,
  },
  camera_ready: {
    node: "CM",
    label: "Camera ready",
    question: "Is the camera-ready in, and when is it due?",
    handoffAsk: "forward the camera-ready confirmation",
    priority: -2,
    deadlineBearing: true,
  },
  conference: {
    node: "CA",
    label: "Conference attendance",
    question: "Is the conference registration and travel booked?",
    // Travel is the one stage with several receipts rather than one notification, and the
    // reimbursement flow needs them anyway -- so ask for whichever lands first rather than
    // for a complete set that would keep the stage open for weeks.
    handoffAsk: "forward the registration or booking confirmation",
    priority: -2,
    deadlineBearing: true,
  },
};

/**
 * One sighting of the mail that closes a stage.
 *
 * Keyed by (paper, stage) rather than by message: a stage closes once, and a second bcc on the
 * same stage is a duplicate rather than a second fact. `message_id` is kept so the row can be
 * traced back to the mail a human can still read, and `recorded_by` distinguishes the classifier
 * from an admin who closed it by hand.
 */
export type AdminBotPaperflowEvidenceRecord = {
  paper_id: string;
  stage: AdminBotPaperflowStage;
  /** The Gmail message id of the bcc'd mail. Empty when an admin closed the stage manually. */
  message_id?: string;
  /** The bcc'd mail's subject, so the Control UI can show what closed the stage. */
  subject?: string;
  /** Who the bcc came from, normalized. */
  sender?: string;
  recorded_at: string;
  recorded_by: "email_bcc" | "admin";
  /** The classifier's confidence, for the admin reviewing a stage that closed itself. */
  confidence?: number;
};

/** The ledger id for one chased stage. */
export function adminBotPaperflowSubjectId(paperId: string, stage: AdminBotPaperflowStage): string {
  return `${paperId}:${stage}`;
}

/**
 * How confident the classifier must be before a bcc closes a stage on its own.
 *
 * High on purpose. A false positive silently stops the chase on a paper whose decision nobody has
 * actually seen, and the failure is invisible -- there is no message that does not arrive to
 * notice. Anything below this lands in the needs-review pile instead, which costs a human thirty
 * seconds and cannot lose a paper.
 */
export const adminBotPaperflowEvidenceMinConfidence = 0.75;
