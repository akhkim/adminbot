// The evidence slots a paper collects on its way through PaperFlow, and the contract every
// surface agrees on.
//
// Three things live in three different places on purpose:
//
//   1. `papers` (contracts/actions.ts) holds the paper itself -- title, venue, deadline, which
//      step it is at, whether the venue decided.
//   2. `paper_slots` (persistence) holds one row per artifact per paper. Tall rather than wide,
//      because `provided_at`, `waived` and the nudge counters are per-artifact and a wide table
//      cannot carry them.
//   3. This registry is code, not data. It is a contract the server, the Control UI and the
//      PaperFlow graph must all agree on, and it changes when the graph changes rather than when
//      a paper does -- so a migration is the wrong tool for it.
//
// The single rule that keeps the nudge function branch-free: `status` is universal. A bool slot
// is `provided` with no URL, a link slot is `provided` with one, a text slot is `provided` with a
// value. One column answers "is this done" for every kind, so nothing downstream has to ask what
// kind a slot is before it can ask whether it is finished.

/** Every artifact a paper can be asked for. Ordered roughly as the work happens. */
export const adminBotPaperSlots = [
  "brainstorm_doc",
  "overleaf",
  "papermentor_review",
  "fixes_merged",
  "pdf_ready",
  "submission",
  "submission_id",
  "drive_pdf_submitted",
  "drive_pdf_arxiv",
  "authors_ack",
  "pi_approval",
  "arxiv",
  "x_draft",
  "linkedin_draft",
  "coauthor_feedback",
  "social_final",
  "x_post",
  "linkedin_post",
  "slides",
  "poster",
  "talk_video",
  "shared_folder",
  "backend_sheet",
] as const;

export type AdminBotPaperSlot = (typeof adminBotPaperSlots)[number];

/**
 * What a slot holds.
 *
 * Drafts are booleans and posts are links, deliberately. Going in, all that matters is that a
 * draft exists -- the text itself lives in the proposal and the audit trail, never here. Coming
 * out, the published URL is the artifact of record.
 */
export type AdminBotPaperSlotKind = "link" | "bool" | "text";

/** Who is asked for it. Resolved to a person by the service, never named here. */
export type AdminBotPaperSlotOwner = "first_author" | "coauthors" | "pi" | "admin";

/**
 * Universal truth for every slot kind. `invalid` is a provided value that failed shape
 * validation: it is not missing (someone answered) and not done (the answer cannot be used), and
 * collapsing it into either loses the reason the author needs to see.
 */
export type AdminBotPaperSlotStatus = "missing" | "provided" | "invalid" | "waived";

/**
 * Which parallel track a slot belongs to, mirroring the `branch` on its PaperFlow node.
 *
 * Duplicated rather than imported: the graph package is a UI dependency and the service must be
 * able to rank a nudge without it. The registry test asserts the two agree.
 */
export type AdminBotPaperSlotBranch = "venue" | "core" | "archive" | "social" | "talk";

/** Lower sorts first. Venue deadlines outrank the writing, which outranks anything cosmetic. */
export const adminBotPaperSlotBranchPriority: Record<AdminBotPaperSlotBranch, number> = {
  venue: 0,
  core: 1,
  archive: 2,
  social: 3,
  talk: 4,
};

export type AdminBotPaperSlotDefinition = {
  kind: AdminBotPaperSlotKind;
  /** The PaperFlow node this slot is evidence for. */
  node: string;
  owner: AdminBotPaperSlotOwner;
  /** The pipeline step this slot gates. `null` when nothing waits on it. */
  gates: string | null;
  branch: AdminBotPaperSlotBranch;
  /** Human string, used verbatim in the nudge. */
  label: string;
  /**
   * Slots that must be provided-or-waived before this one is worth asking for. Without this the
   * nudge would chase an author for an arXiv link on a paper that has not been submitted.
   */
  upstream: AdminBotPaperSlot[];
  /** A hard gate, or advisory. Advisory slots never escalate and never block a step. */
  required: boolean;
  /** Whether a venue deadline makes this one urgent enough to escalate. */
  deadlineBearing: boolean;
  /** `link` slots only: accepted hosts. Empty means any https URL. */
  urlHosts?: readonly string[];
  /** `link` slots only: a path the URL must contain, as a prefix of one of its segments. */
  urlPath?: readonly string[];
};

/**
 * The registry.
 *
 * `gates` names the step a slot releases, so "what is this for" is answerable from the row rather
 * than from the graph. `upstream` is the dependency edge the nudge walk actually follows.
 */
export const adminBotPaperSlotRegistry: Record<AdminBotPaperSlot, AdminBotPaperSlotDefinition> = {
  brainstorm_doc: {
    kind: "link",
    node: "BR",
    owner: "first_author",
    gates: "overleaf_writing",
    branch: "core",
    label: "Brainstorm doc",
    upstream: [],
    required: true,
    deadlineBearing: false,
  },
  overleaf: {
    kind: "link",
    node: "OV",
    owner: "first_author",
    gates: "submission",
    branch: "core",
    label: "Overleaf project",
    upstream: ["brainstorm_doc"],
    required: true,
    deadlineBearing: true,
    urlHosts: ["overleaf.com"],
    urlPath: ["/project/", "/read/"],
  },
  papermentor_review: {
    kind: "bool",
    node: "PM",
    owner: "first_author",
    gates: "submission",
    branch: "core",
    label: "PaperMentor review done",
    upstream: ["overleaf"],
    required: true,
    deadlineBearing: true,
  },
  fixes_merged: {
    kind: "bool",
    node: "FX",
    owner: "first_author",
    gates: "submission",
    branch: "core",
    label: "Review fixes merged",
    upstream: ["papermentor_review"],
    required: true,
    deadlineBearing: true,
  },
  pdf_ready: {
    kind: "bool",
    node: "PDF",
    owner: "first_author",
    gates: "submission",
    branch: "core",
    label: "Paper PDF compiles cleanly",
    upstream: ["fixes_merged"],
    required: true,
    deadlineBearing: true,
  },
  submission: {
    kind: "link",
    node: "SB",
    owner: "first_author",
    gates: "google_drive_pdf",
    branch: "venue",
    label: "Submission page",
    upstream: ["pdf_ready"],
    required: true,
    deadlineBearing: true,
  },
  submission_id: {
    kind: "text",
    node: "SB",
    owner: "first_author",
    gates: "google_drive_pdf",
    branch: "venue",
    label: "Submission id",
    upstream: ["submission"],
    required: true,
    deadlineBearing: true,
  },
  drive_pdf_submitted: {
    kind: "link",
    node: "DS",
    owner: "first_author",
    gates: "arxiv_polish",
    branch: "archive",
    label: "Drive copy of the submitted PDF",
    upstream: ["submission"],
    required: true,
    deadlineBearing: false,
    urlHosts: ["drive.google.com", "docs.google.com"],
  },
  drive_pdf_arxiv: {
    kind: "link",
    node: "DA",
    owner: "first_author",
    gates: "arxiv_polish",
    branch: "archive",
    label: "Drive copy of the arXiv PDF",
    upstream: ["pdf_ready"],
    required: true,
    deadlineBearing: false,
    urlHosts: ["drive.google.com", "docs.google.com"],
  },
  authors_ack: {
    kind: "bool",
    node: "AK",
    owner: "first_author",
    gates: "arxiv_polish",
    branch: "archive",
    label: "Author list and acknowledgements final",
    upstream: ["drive_pdf_arxiv"],
    required: true,
    deadlineBearing: false,
  },
  pi_approval: {
    kind: "bool",
    node: "GT",
    owner: "pi",
    gates: "arxiv_polish",
    branch: "archive",
    label: "PI approval to post",
    upstream: ["authors_ack"],
    required: true,
    deadlineBearing: false,
  },
  arxiv: {
    kind: "link",
    node: "GT",
    owner: "first_author",
    gates: "social_posts",
    branch: "archive",
    label: "arXiv abstract page",
    upstream: ["pi_approval"],
    required: true,
    deadlineBearing: false,
    urlHosts: ["arxiv.org"],
    urlPath: ["/abs/"],
  },
  x_draft: {
    kind: "bool",
    node: "XD",
    owner: "first_author",
    gates: "social_posts",
    branch: "social",
    label: "X post drafted",
    upstream: ["arxiv"],
    required: true,
    deadlineBearing: false,
  },
  linkedin_draft: {
    kind: "bool",
    node: "LI",
    owner: "first_author",
    gates: "social_posts",
    branch: "social",
    label: "LinkedIn post drafted",
    upstream: ["x_draft"],
    required: true,
    deadlineBearing: false,
  },
  coauthor_feedback: {
    kind: "bool",
    node: "CP",
    owner: "coauthors",
    gates: "social_posts",
    branch: "social",
    label: "Coauthor feedback collected",
    upstream: ["x_draft", "linkedin_draft"],
    required: true,
    deadlineBearing: false,
  },
  social_final: {
    kind: "bool",
    node: "SF",
    owner: "first_author",
    gates: "social_posts",
    branch: "social",
    label: "Social copy finalized",
    upstream: ["coauthor_feedback"],
    required: true,
    deadlineBearing: false,
  },
  x_post: {
    kind: "link",
    node: "PS",
    owner: "first_author",
    gates: null,
    branch: "social",
    label: "Published X post",
    upstream: ["social_final"],
    required: true,
    deadlineBearing: false,
    urlHosts: ["x.com", "twitter.com"],
    urlPath: ["/status/"],
  },
  linkedin_post: {
    kind: "link",
    node: "PS",
    owner: "first_author",
    gates: null,
    branch: "social",
    label: "Published LinkedIn post",
    upstream: ["social_final"],
    required: true,
    deadlineBearing: false,
    urlHosts: ["linkedin.com"],
    urlPath: ["/posts/", "/feed/update/"],
  },
  slides: {
    kind: "link",
    node: "SL",
    owner: "first_author",
    gates: "poster_making",
    branch: "talk",
    label: "Talk slides",
    upstream: ["pdf_ready"],
    required: true,
    deadlineBearing: false,
    urlHosts: ["docs.google.com"],
    urlPath: ["/presentation/"],
  },
  poster: {
    kind: "link",
    node: "PO",
    owner: "first_author",
    gates: null,
    branch: "talk",
    label: "Poster",
    upstream: ["slides"],
    required: true,
    deadlineBearing: false,
  },
  talk_video: {
    kind: "link",
    node: "TV",
    owner: "first_author",
    gates: null,
    branch: "talk",
    label: "Talk video",
    upstream: ["slides"],
    required: true,
    deadlineBearing: false,
  },
  shared_folder: {
    kind: "link",
    node: "LG",
    owner: "first_author",
    gates: null,
    branch: "talk",
    label: "Shared folder with the talk materials",
    upstream: ["slides"],
    required: true,
    deadlineBearing: false,
  },
  backend_sheet: {
    kind: "bool",
    node: "BE",
    owner: "admin",
    gates: null,
    branch: "archive",
    label: "Tracking spreadsheet updated",
    // Bookkeeping an admin does after the fact. Nothing waits on it, so it is advisory: it shows
    // on the card and never appears in a nudge.
    upstream: [],
    required: false,
    deadlineBearing: false,
  },
};

/** One stored slot row. The nudge function reads exactly these columns plus the registry. */
export type AdminBotPaperSlotRecord = {
  paper_id: string;
  slot: AdminBotPaperSlot;
  status: AdminBotPaperSlotStatus;
  /** `link` slots only. */
  url?: string;
  /** `text` slots only. */
  value_text?: string;
  provided_by_member_id?: string;
  provided_at?: string;
  validated_at?: string;
  invalid_reason?: string;
  waived_by_member_id?: string;
  waived_reason?: string;
  last_nudged_at?: string;
  nudge_count: number;
  snoozed_until?: string;
};

/** What a member may write. Status is derived from the value, never accepted from input. */
export type AdminBotPaperSlotInput = {
  url?: string;
  value_text?: string;
  /** `bool` slots: true marks it provided, false clears it back to missing. */
  done?: boolean;
  /** Author-set, and bounded by the service -- see adminBotPaperSlotMaxSnoozeDays. */
  snoozed_until?: string;
};

/** How far ahead an author may push a nudge. Long enough for a conference week, no longer. */
export const adminBotPaperSlotMaxSnoozeDays = 14;

/** How many unanswered nudges before a deadline-bearing slot escalates to the PI. */
export const adminBotPaperSlotEscalateAfterNudges = 3;

export type AdminBotPaperSlotUrlCheck = { ok: true } | { ok: false; reason: string };

/**
 * Shape validation for a link slot: https, plus the host and path the registry names.
 *
 * Shape only, never a liveness fetch. Fetching would mean the service makes an outbound request
 * to an address a member typed, which is a request-forgery primitive in exchange for a check that
 * is stale the moment it passes.
 */
export function validateAdminBotPaperSlotUrl(
  slot: AdminBotPaperSlot,
  raw: string,
): AdminBotPaperSlotUrlCheck {
  const definition = adminBotPaperSlotRegistry[slot];
  if (definition.kind !== "link") {
    return { ok: false, reason: `${definition.label} does not take a link` };
  }
  const value = raw.trim();
  if (!value) {
    return { ok: false, reason: "a link is required" };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "that is not a URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "the link must start with https://" };
  }
  const hosts = definition.urlHosts;
  if (hosts?.length) {
    // Subdomains count: `www.overleaf.com` and `overleaf.com` are the same place, and rejecting
    // the copy-pasted one teaches people to edit URLs by hand until it is accepted.
    const host = url.hostname.toLowerCase();
    const matched = hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
    if (!matched) {
      return { ok: false, reason: `the link must be on ${hosts.join(" or ")}` };
    }
  }
  const paths = definition.urlPath;
  if (paths?.length && !paths.some((path) => url.pathname.includes(path))) {
    return {
      ok: false,
      reason: `the link must be a ${paths.join(" or ")} URL`,
    };
  }
  return { ok: true };
}

/** A slot counts as done when it is provided or an admin waived it. Everything else is open. */
export function isAdminBotPaperSlotSettled(status: AdminBotPaperSlotStatus): boolean {
  return status === "provided" || status === "waived";
}
