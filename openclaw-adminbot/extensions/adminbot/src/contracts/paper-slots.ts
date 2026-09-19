// The evidence slots a paper collects on its way through PaperFlow, and the contract every
// surface agrees on. Revision 2.
//
// Four things live in four different places on purpose:
//
//   1. `papers` (contracts/actions.ts) holds the paper itself -- title, venue, deadline, which
//      step it is at, what the venue decided and, once it accepted, the acceptance details.
//   2. `paper_slots` holds one row per artifact per paper. Tall rather than wide, because
//      `provided_at` and `waived` are per-artifact and a wide table cannot carry them.
//   3. The cycle tables (contracts/paper-cycle.ts) hold the things that are lists rather than
//      single artifacts: social drafts and their consents, who is attending, who has been
//      reimbursed.
//   4. This registry is code, not data. It is a contract the server, the Control UI and the
//      PaperFlow graph must all agree on, and it changes when the graph changes rather than when
//      a paper does -- so a migration is the wrong tool for it.
//
// The rule that keeps the nudge function branch-free: `status` is universal. A bool slot is
// `provided` with no URL, a link slot is `provided` with one, a text slot is `provided` with a
// value. One column answers "is this done" for every kind, so nothing downstream has to ask what
// kind a slot is before it can ask whether it is finished.
//
// Two deliberate exceptions to "the column is the truth", both marked `derived` below: the social
// draft gates read their status from `paper_social_drafts` instead. A draft's content lives in
// that table because consent is asked against a specific draft, and a second copy of "is there an
// approved draft" in `paper_slots` would be free to disagree with it.

import {
  ADMINBOT_LAB_OVERLEAF_HOST,
  adminBotOverleafHosts,
  OVERLEAF_COM_HOST,
} from "./overleaf.js";
import type { OpenReviewIdentityReview } from "./paper-artifact-links.js";

/** Every artifact a paper can be asked for. Ordered roughly as the work happens. */
export const adminBotPaperSlots = [
  "project_folder",
  "overleaf_view",
  "overleaf_share",
  "overleaf_edit",
  "papermentor_review",
  "fixes_merged",
  "pdf_ready",
  "submission",
  "submission_id",
  // No `rebuttal_doc`. The rebuttal used to be a link somebody pasted; it is now one of the venue
  // stages the bcc loop closes (contracts/paperflow-stages.ts), and keeping both would give the
  // card two accounts of the same fact that are free to disagree.
  "drive_pdf_arxiv",
  "authors_ack",
  "arxiv_paper_password",
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
  "poster_physical",
  "talk_video",
  "backend_sheet",
] as const;

export type AdminBotPaperSlot = (typeof adminBotPaperSlots)[number];

/**
 * What a slot holds.
 *
 * `secret6` is a credential rather than an artifact and is redacted on read (see
 * `adminBotConfidentialPaperSlots`). `enum` carries a closed status plus a free-text note about
 * the physical world, which is why `paper_slots` has both `value_text` and `value_note`.
 */
export type AdminBotPaperSlotKind = "link" | "bool" | "text" | "secret6" | "enum";

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
 * able to rank a nudge without it. paper-slots.test.ts asserts the two agree.
 */
export type AdminBotPaperSlotBranch = "venue" | "core" | "archive" | "social" | "talk";

/** Lower sorts first. Venue deadlines outrank the writing, which outranks anything cosmetic. */
/**
 * Where each branch sits on the PaperFlow chart.
 *
 * `core` is the trunk -- the chart draws it top to bottom and everything else hangs off
 * "Compiled paper PDF ready" -- so it has no branch number. The other four carry the chart's own
 * "Branch 1".."Branch 4" edge labels, which is what lets the card be read side by side with the
 * diagram instead of asking somebody to hold a translation in their head.
 *
 * Deliberately separate from `adminBotPaperSlotBranchPriority`: that one is what to chase first,
 * this one is what to draw first, and they disagree on purpose. The venue branch has the hard
 * clocks and so outranks everything for nudging, but it is Branch 4 on the chart and reading it
 * first would put the card and the diagram in different orders.
 */
export const adminBotPaperFlowBranchNumber: Record<AdminBotPaperSlotBranch, number | null> = {
  core: null,
  talk: 1,
  social: 2,
  archive: 3,
  venue: 4,
};

/** Trunk first, then the chart's own branch numbering. The reading order of a paper card. */
export const adminBotPaperSlotChartOrder: readonly AdminBotPaperSlotBranch[] = [
  "core",
  "talk",
  "social",
  "archive",
  "venue",
];

export const adminBotPaperSlotBranchPriority: Record<AdminBotPaperSlotBranch, number> = {
  venue: 0,
  core: 1,
  archive: 2,
  social: 3,
  talk: 4,
};

/**
 * The closed set a `poster_physical` slot may hold, alongside a free-text note saying where the
 * thing actually is. Backend bookkeeping: there is no printing workflow behind it.
 */
export const adminBotPosterPhysicalStates = [
  "not_needed",
  "to_print",
  "printed",
  "with_author",
  "shipped",
] as const;

export type AdminBotPosterPhysicalState = (typeof adminBotPosterPhysicalStates)[number];

export type AdminBotPaperSlotDefinition = {
  kind: AdminBotPaperSlotKind;
  /** The PaperFlow node this slot is evidence for. */
  node: string;
  owner: AdminBotPaperSlotOwner;
  /** The pipeline step this slot releases. `null` when nothing waits on it. */
  gates: string | null;
  branch: AdminBotPaperSlotBranch;
  /** Human string, used verbatim in the nudge. */
  label: string;
  /**
   * Slots that must be provided-or-waived before this one can be filled in at all. Without this
   * the card would offer an arXiv link on a paper that has not been submitted.
   */
  upstream: AdminBotPaperSlot[];
  /**
   * Slots that must be settled before the lab starts *asking* for this one. Defaults to
   * `upstream`, which is the honest answer for almost every slot: a field becomes fillable and
   * becomes chaseable at the same moment.
   *
   * The two come apart where work may legitimately start early but is nobody's next move. The
   * social drafts are the case that forced the split: an announcement is written from the paper,
   * so it can be drafted the moment the PDF compiles -- but until there is an arXiv link there is
   * nothing to announce, and a nudge for it would outrank the submission work that has to happen
   * first. Opening the field without opening the nudge is what "you may, but nobody is waiting"
   * looks like.
   */
  chaseAfter?: AdminBotPaperSlot[];
  /**
   * Whether the lab chases this one.
   *
   * `required` decides whether a slot appears in a nudge -- it does **not** block a step move.
   * Nothing in AdminBot hard-gates the stepper, and that is the answer to the review's own
   * question 3: a hard gate on an artifact a paper legitimately never has (a workshop paper with
   * no poster, a venue that issues no submission id) deadlocks the paper, and the person who
   * could clear it is exactly the person the deadlock is blocking. Advisory slots are shown and
   * never chased; genuinely inapplicable required ones are waived, which is a decision with a
   * name and a reason on it.
   */
  required: boolean;
  /** Whether a venue deadline makes this one urgent enough to escalate. */
  deadlineBearing: boolean;
  /**
   * A real specimen of the answer, shown greyed in the empty field.
   *
   * "https://…" tells someone the shape of a URL, which they already knew, and nothing about
   * which URL. A worked example does: it is the difference between "a link" and "the /abs/ page
   * of the arXiv listing, not the PDF".
   */
  example?: string;
  /**
   * Status comes from somewhere else and this slot rejects direct writes. Only the two social
   * draft gates, which read `paper_social_drafts`.
   */
  derived?: true;
  /** `link` slots only: accepted hosts. Empty means any https URL. */
  urlHosts?: readonly string[];
  /** `link` slots only: a path the URL must contain. Any one of them satisfies it. */
  urlPath?: readonly string[];
  /**
   * `link` slots only: a pattern the whole pathname must match.
   *
   * For the one link shape `urlPath` cannot describe. A substring rule works when the meaningful
   * part of a URL sits behind a fixed prefix -- `/project/`, `/read/`, `/abs/` -- and an Overleaf
   * share link has no prefix at all: the token *is* the path. The rule that matters there is
   * "exactly one segment", which is also what keeps this from quietly accepting the other two
   * Overleaf shapes, since both of those have two.
   */
  urlPathPattern?: RegExp;
  /**
   * Render this slot inside another one's row rather than as a row of its own.
   *
   * Four pairs of slots are two halves of one PaperFlow node -- the two Overleaf links are both
   * `OV`, the submission page and its id are both `SB` -- and showing them as separate rows made
   * the card claim more steps than the chart has. They stay separate slots because the service
   * validates them separately and each carries its own status; only the drawing changes.
   */
  subOf?: AdminBotPaperSlot;
  /**
   * The heading for the row when this slot has children. Without it a merged row would be titled
   * after whichever half happens to be the parent, which reads as the other half being an
   * afterthought rather than the two being one thing.
   */
  groupLabel?: string;
  /** A line under the control, for slots whose point is not guessable from the label. */
  hint?: string;
};

/**
 * The registry.
 *
 * `gates` names the step a slot releases, so "what is this for" is answerable from the row rather
 * than from the graph. `upstream` is the dependency edge the nudge walk actually follows.
 */
/**
 * The Overleaf hosts both project slots accept, as literals.
 *
 * Static rather than resolved from the environment, because this registry is shared code: the
 * Control UI imports it to validate a cell as it is typed, and a browser has no environment to
 * read. `validateAdminBotPaperSlotUrl` layers this deployment's configured instance on top when
 * it runs service-side, so a deployment that moved its Overleaf is still checked correctly where
 * the check is authoritative.
 */
const OVERLEAF_HOSTS = [OVERLEAF_COM_HOST, ADMINBOT_LAB_OVERLEAF_HOST] as const;

export const adminBotPaperSlotRegistry: Record<AdminBotPaperSlot, AdminBotPaperSlotDefinition> = {
  project_folder: {
    kind: "link",
    node: "BR",
    owner: "first_author",
    gates: "overleaf_writing",
    branch: "core",
    label: "Project folder or brainstorm doc",
    upstream: [],
    required: true,
    deadlineBearing: false,
    urlHosts: ["docs.google.com", "drive.google.com"],
    urlPath: ["/document/", "/drive/folders/"],
    // This is also where the talk materials end up, which is why there is no separate
    // "links logged in shared folder" slot: it is the same folder, already linked.
    hint: "The Drive folder or doc where this paper lives. Slides, poster and video end up here too.",
    example: "https://drive.google.com/drive/folders/1aBcD…",
  },
  overleaf_view: {
    subOf: "overleaf_edit",
    kind: "link",
    node: "OV",
    owner: "first_author",
    gates: "submission",
    branch: "core",
    label: "Overleaf read-only link",
    upstream: ["project_folder"],
    // Advisory, and deliberately so -- the review's own question 6. Both Overleaf links gate the
    // same step, so making both hard would stall every project that only ever circulates the edit
    // link. The edit link is the one the paper cannot proceed without; this one is the courtesy
    // you paste into a channel.
    required: false,
    deadlineBearing: false,
    urlHosts: OVERLEAF_HOSTS,
    urlPath: ["/read/"],
    hint: "Overleaf's read-only share link. Safe to paste in a channel — nobody can edit the paper with it.",
    example: `https://${ADMINBOT_LAB_OVERLEAF_HOST}/read/xzqvbnmklpqr`,
  },
  overleaf_share: {
    subOf: "overleaf_edit",
    kind: "link",
    node: "OV",
    owner: "first_author",
    // Nothing waits on it. The project link is what the paper cannot proceed without; this is a
    // second way to hand out the same write access, so gating a step on it would let a paper be
    // held up by the absence of a convenience.
    gates: null,
    branch: "core",
    label: "Overleaf share edit link",
    upstream: ["project_folder"],
    // Advisory, and never chased. Asking an author for this one would be asking them to mint a
    // credential they may have had no reason to create -- see the hint.
    required: false,
    deadlineBearing: false,
    urlHosts: OVERLEAF_HOSTS,
    // One segment, which is the whole distinction: `/project/<id>` and `/read/<token>` both have
    // two, so the shapes cannot collide. Length is bounded rather than pinned to the 22 characters
    // Overleaf currently mints, since a fork is free to size its tokens differently.
    urlPathPattern: /^\/[A-Za-z0-9]{12,64}\/?$/u,
    hint:
      "Overleaf's “Anyone with this link can edit” URL. This one is a credential, not an " +
      "address: it grants write access to whoever holds it, without an invitation and without " +
      "appearing in the project's member list. Everyone who can read this paper's record can use " +
      "it. Prefer the project link above and invite coauthors by name where you can.",
    example: `https://${OVERLEAF_COM_HOST}/1234567890abcdefghijkl#a1b2c3`,
  },
  overleaf_edit: {
    groupLabel: "Overleaf",
    kind: "link",
    node: "OV",
    owner: "first_author",
    gates: "submission",
    branch: "core",
    label: "Overleaf project link",
    upstream: ["project_folder"],
    required: true,
    deadlineBearing: true,
    urlHosts: OVERLEAF_HOSTS,
    urlPath: ["/project/"],
    // Both hosts are accepted and only one of them can be reviewed, which is why the hint names
    // the lab's own: every paper is now reviewed by PaperMentor before submission, and PaperMentor
    // only sees projects on the instance it is built into. A draft on overleaf.com is not refused
    // -- that is a real paper, and refusing the link would only cost the lab the record of it.
    hint: `This project URL identifies the paper for PaperMentor; it does not grant sharing access. To share, open Overleaf’s Share menu, enable link sharing, and copy the edit or view link. Papers are reviewed by PaperMentor before submission, which can only read projects on ${ADMINBOT_LAB_OVERLEAF_HOST}.`,
    example: `https://${ADMINBOT_LAB_OVERLEAF_HOST}/project/65f2a1c9d4e3b7a801f6`,
  },
  papermentor_review: {
    kind: "bool",
    node: "PM",
    owner: "first_author",
    gates: "submission",
    branch: "core",
    label: "PaperMentor review done",
    upstream: ["overleaf_edit"],
    required: true,
    deadlineBearing: true,
    hint: "Tick once PaperMentor has run over the draft and you have its comments back.",
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
    hint: "Tick once you have applied the low-cost suggestions from that review. Not every suggestion — the cheap ones.",
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
    hint: "Tick when Overleaf compiles with no errors and the PDF is the one you would submit.",
  },
  submission: {
    groupLabel: "Submitted to venue",
    kind: "link",
    node: "SB",
    owner: "first_author",
    gates: "google_drive_pdf",
    branch: "venue",
    label: "Submission page",
    upstream: ["pdf_ready"],
    required: true,
    deadlineBearing: true,
    hint: "Your paper's page on the venue's system — the OpenReview forum, or CMT/HotCRP elsewhere.",
    example: "https://openreview.net/forum?id=Ax7Kq2Lm9P",
  },
  submission_id: {
    subOf: "submission",
    kind: "text",
    node: "SB",
    owner: "first_author",
    gates: "google_drive_pdf",
    branch: "venue",
    label: "Submission ID",
    upstream: ["submission"],
    required: true,
    deadlineBearing: true,
    hint: "The identifier the venue assigned you. Read it off the submission page you just pasted.",
    example: "Ax7Kq2Lm9P",
  },
  drive_pdf_arxiv: {
    kind: "link",
    node: "DA",
    owner: "first_author",
    gates: "arxiv_polish",
    branch: "archive",
    label: "Drive copy of the paper PDF",
    upstream: ["pdf_ready"],
    required: true,
    deadlineBearing: false,
    urlHosts: ["drive.google.com", "docs.google.com"],
    hint: "The lab's own copy of the exact PDF you intend to post publicly.",
    example: "https://drive.google.com/file/d/1PdF9x…",
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
    hint: "Tick once the author list and the thank-yous are final and everyone named has seen them.",
  },
  arxiv_paper_password: {
    kind: "secret6",
    node: "PK",
    owner: "first_author",
    gates: "arxiv_polish",
    branch: "archive",
    label: "arXiv paper password",
    upstream: ["authors_ack"],
    required: true,
    deadlineBearing: false,
    hint: "The six-character code arXiv issues so coauthors can claim the paper. Letters and digits mixed.",
    example: "k7m2q9",
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
    hint: "Only Zhijing ticks this. It is the explicit yes to post publicly — preparing the package is not permission.",
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
    hint: "The /abs/ listing page, not the /pdf/ file. This is the link the announcements will point at.",
    example: "https://arxiv.org/abs/2306.05836",
  },
  x_draft: {
    kind: "bool",
    node: "XD",
    owner: "first_author",
    gates: "social_posts",
    branch: "social",
    label: "X post drafted",
    // Written from the paper, not from the arXiv listing, so it opens with the rest of Branch 2
    // when the PDF compiles -- the same edge the chart draws (PDF -> XD). The arXiv link is what
    // makes it worth *chasing*, not what makes it possible.
    upstream: ["pdf_ready"],
    chaseAfter: ["arxiv"],
    required: true,
    deadlineBearing: false,
    derived: true,
    hint: "Provided once an approved X draft exists. Write it with the drafting tool — you can start as soon as the PDF compiles, it does not wait for the arXiv link.",
  },
  linkedin_draft: {
    kind: "bool",
    node: "LI",
    owner: "first_author",
    gates: "social_posts",
    branch: "social",
    label: "LinkedIn post drafted",
    // Parallel to the X draft rather than behind it, which is what the chart says (PDF -> LI) and
    // why: a 280-character thread is the wrong source text for a 900-character post, so making
    // one wait on the other blocked it on work it does not need.
    upstream: ["pdf_ready"],
    chaseAfter: ["arxiv"],
    required: true,
    deadlineBearing: false,
    derived: true,
    hint: "Provided once an approved LinkedIn draft exists. Write it with the drafting tool — you can start as soon as the PDF compiles, it does not wait for the arXiv link.",
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
    hint: "Tick once the draft posts have gone round the coauthors and you have their replies.",
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
    hint: "Tick once the coauthors' comments are folded in and the copy is what you will actually post.",
  },
  x_post: {
    groupLabel: "Published",
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
    hint: "The published thread, after it is live. Paste the link to the first post.",
    example: "https://x.com/JinesisLab/status/1839274650192837",
  },
  linkedin_post: {
    groupLabel: "Published",
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
    hint: "The published post, after it is live. Open it on LinkedIn and copy the address.",
    example: "https://www.linkedin.com/posts/jinesis-lab_activity-7239182736450",
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
    hint: "The talk slides for this venue, as a Google Slides deck.",
    example: "https://docs.google.com/presentation/d/1Sl1De…",
  },
  poster: {
    groupLabel: "Poster",
    kind: "link",
    node: "PO",
    owner: "first_author",
    gates: null,
    branch: "talk",
    label: "Poster",
    upstream: ["slides"],
    // Plenty of papers never have one, and the venue decides. Waive it on a paper that is not
    // presenting a poster rather than leaving it open forever.
    required: true,
    deadlineBearing: false,
    hint: "The poster file, wherever it lives. Any https link is fine.",
    example: "https://drive.google.com/file/d/1Po5t3r…",
  },
  poster_physical: {
    subOf: "poster",
    kind: "enum",
    node: "PO",
    owner: "first_author",
    gates: null,
    branch: "talk",
    label: "Physical poster",
    upstream: ["poster"],
    // Bookkeeping about an object in the world. Useful to know, never worth a Slack message.
    required: false,
    deadlineBearing: false,
    hint: "Whether the poster is printed yet, and where the physical copy is right now.",
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
    hint: "The recorded talk, if the venue asked for one or the lab wants a copy.",
    example: "https://drive.google.com/file/d/1V1De0…",
  },
  backend_sheet: {
    kind: "bool",
    node: "BE",
    owner: "admin",
    gates: null,
    branch: "archive",
    label: "Tracking spreadsheet updated",
    upstream: [],
    required: false,
    deadlineBearing: false,
    hint: "Admin bookkeeping in the tracking spreadsheet. Optional — nothing waits on it.",
  },
};

/**
 * Slots whose value is a credential, not an artifact.
 *
 * Redacted on read for anyone who is not an author of the paper or an admin, and kept out of
 * nudge text and audit details entirely. Same rule, and the same delete-the-key implementation,
 * as `adminBotConfidentialMemberFields`: blanking would still tell a reader whether one exists.
 */
export const adminBotConfidentialPaperSlots: readonly AdminBotPaperSlot[] = [
  "arxiv_paper_password",
];

export function isConfidentialPaperSlot(slot: AdminBotPaperSlot): boolean {
  return adminBotConfidentialPaperSlots.includes(slot);
}

/** One stored slot row. */
/**
 * What can confirm a slot without taking anybody's word for it.
 *
 * The distinction this whole field exists for: a slot is *validated* when its value is the right
 * shape, and *verified* when something outside the lab's own claim says the artifact is really
 * there. A Drive link that parses is validated; a Drive link whose file the lab account can open
 * is verified. Most slots have no verifier and never will -- "the author list is final" is a
 * judgement, not a fact a machine can check -- and that is the point of the map below being
 * partial rather than a column with a default.
 */
export const adminBotPaperSlotVerifiers = [
  "google_drive",
  "papermentor",
  "arxiv",
  "openreview",
  /** AdminBot posted it itself, so the execution record is the evidence. */
  "adminbot_post",
] as const;

export type AdminBotPaperSlotVerifier = (typeof adminBotPaperSlotVerifiers)[number];

/**
 * Which slots something can confirm, and what confirms them.
 *
 * Deliberately small, and deliberately not aspirational: a slot appears here when the check is
 * built, because the stage walk records which evidence was machine-confirmed and a verifier named
 * but not wired would make that record a claim about a check nobody runs.
 */
export const adminBotPaperSlotVerifier: Partial<
  Record<AdminBotPaperSlot, AdminBotPaperSlotVerifier>
> = {
  project_folder: "google_drive",
  drive_pdf_arxiv: "google_drive",
  slides: "google_drive",
  poster: "google_drive",
  // Both come from the reviewer itself: the review slot from the run being ingested at all, the
  // fixes from a later run that no longer finds anything serious. See workflows/papers/papermentor.
  papermentor_review: "papermentor",
  fixes_merged: "papermentor",
  // The public record. arXiv can be asked outright; OpenReview can only ever confirm, never deny,
  // because a blind submission is invisible to an anonymous reader -- see the probe's own note.
  arxiv: "arxiv",
  submission: "openreview",
  // The two the lab does not have to check at all, because AdminBot published them: the URL comes
  // back from the connector that posted, so the slot is filled by the act rather than reported
  // afterwards by the person who watched it happen.
  x_post: "adminbot_post",
  linkedin_post: "adminbot_post",
};

export type AdminBotPaperSlotRecord = {
  paper_id: string;
  slot: AdminBotPaperSlot;
  status: AdminBotPaperSlotStatus;
  /** `link` slots only. */
  url?: string;
  /** `text`, `secret6` and `enum` slots. For `enum` it holds the state. */
  value_text?: string;
  /** `enum` slots only: the free-text half, e.g. where the poster physically is. */
  value_note?: string;
  provided_by_member_id?: string;
  provided_at?: string;
  validated_at?: string;
  /**
   * What confirmed the artifact is really there, and when.
   *
   * Absent is not a failure and does not hold a paper up: most slots have no verifier, a check
   * can be unconfigured, and a deployment with no Google account wired reads every Drive link as
   * unconfirmed rather than as wrong. What a failed check produces is `invalid` with a reason,
   * the same as a value that never parsed -- so the thing that stops a paper is a contradiction,
   * never a silence.
   */
  verified_by?: AdminBotPaperSlotVerifier;
  verified_at?: string;
  /** Public metadata observed by the verifier, never supplied by a member. */
  verified_title?: string;
  previous_submission_id?: string;
  identity_review?: OpenReviewIdentityReview;
  invalid_reason?: string;
  waived_by_member_id?: string;
  waived_reason?: string;
};

/** What a member may write. Status is derived from the value, never accepted from input. */
export type AdminBotPaperSlotInput = {
  url?: string;
  value_text?: string;
  value_note?: string;
  /** `bool` slots: true marks it provided, false clears it back to missing. */
  done?: boolean;
};

/** How many unanswered nudges before a deadline-bearing slot escalates to the PI. */
export const adminBotPaperSlotEscalateAfterNudges = 3;

export type AdminBotPaperSlotValueCheck = { ok: true } | { ok: false; reason: string };

/**
 * Shape validation for a link slot: https, plus the host and path the registry names.
 *
 * Shape only, never a liveness fetch. Fetching would mean the service makes an outbound request
 * to an address a member typed, which is a request-forgery primitive in exchange for a check that
 * is stale the moment it passes. `contracts/overleaf.ts` is where a checked link becomes a project
 * id, which is the only part of one that is safe to build a request from.
 */
/** The two slots whose accepted hosts this deployment may have moved. */
const OVERLEAF_SLOTS = new Set<AdminBotPaperSlot>(["overleaf_view", "overleaf_edit"]);

export function validateAdminBotPaperSlotUrl(
  slot: AdminBotPaperSlot,
  raw: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): AdminBotPaperSlotValueCheck {
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
  // The registry's literals, plus whatever instance this deployment configured. They are the same
  // list on the lab's own boxes; they differ only where `ADMINBOT_OVERLEAF_URL` names a third
  // host, and then the service -- which is the authoritative check -- is the side that knows.
  const hosts = OVERLEAF_SLOTS.has(slot)
    ? [...new Set([...(definition.urlHosts ?? []), ...adminBotOverleafHosts(options.env)])]
    : definition.urlHosts;
  if (hosts?.length) {
    // Subdomains count: `www.overleaf.com` and `overleaf.com` are the same place, and rejecting
    // the copy-pasted one teaches people to edit URLs by hand until it is accepted.
    const host = url.hostname.toLowerCase();
    if (!hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
      return { ok: false, reason: `the link must be on ${hosts.join(" or ")}` };
    }
  }
  const paths = definition.urlPath;
  if (paths?.length && !paths.some((path) => url.pathname.includes(path))) {
    return { ok: false, reason: `the link must be a ${paths.join(" or ")} URL` };
  }
  // Checked after the host, so a mistyped share link is told it is on the wrong Overleaf before it
  // is told its path is wrong -- the host is the fixable half.
  if (definition.urlPathPattern && !definition.urlPathPattern.test(url.pathname)) {
    return { ok: false, reason: `that is not a ${definition.label.toLowerCase()}` };
  }
  return { ok: true };
}

/**
 * The arXiv paper password: exactly six characters, and mixed.
 *
 * The mixed rule is arXiv's own -- an all-letter or all-digit string is not one of theirs, so
 * accepting it would store something that cannot work and only fail when somebody tries it.
 */
export function validateAdminBotPaperSecret(raw: string): AdminBotPaperSlotValueCheck {
  const value = raw.trim();
  if (!/^[A-Za-z0-9]{6}$/u.test(value)) {
    return {
      ok: false,
      reason: "the arXiv password must be exactly 6 characters, mixing letters and digits",
    };
  }
  if (!/[A-Za-z]/u.test(value) || !/[0-9]/u.test(value)) {
    return { ok: false, reason: "the arXiv password must mix letters and digits (e.g. ab12cd)" };
  }
  return { ok: true };
}

export function isAdminBotPosterPhysicalState(value: string): value is AdminBotPosterPhysicalState {
  return (adminBotPosterPhysicalStates as readonly string[]).includes(value);
}

/** A slot counts as done when it is provided or an admin waived it. Everything else is open. */
export function isAdminBotPaperSlotSettled(status: AdminBotPaperSlotStatus): boolean {
  return status === "provided" || status === "waived";
}

/**
 * Whether this paper is sitting at the PI's gate: the package is prepared and the yes is not given.
 *
 * `pi_approval` is the one slot the lab does not chase and cannot tick for itself, so "is it with
 * her" is a question two surfaces ask and must answer identically -- her own queue on My Desk
 * (workflows/papers/pi-review.ts) and the author's card under My Projects, which says the paper has
 * gone to her. Two copies of this condition is how a paper comes to be announced as sent on one
 * screen while never appearing on the other.
 *
 * The two upstream conditions are the graph's own, PK before GT: `authors_ack` is the last thing
 * the authors do to the package and `drive_pdf_arxiv` is the copy being approved. Requiring both is
 * requiring the package, rather than a single tick that could be ahead of the file it describes.
 *
 * Structural in its row type so the service's stored records and the Control UI's wire rows both
 * satisfy it without either side importing the other's shape.
 */
export function isAdminBotPaperAtPiGate(
  slots: readonly { slot: string; status: AdminBotPaperSlotStatus }[],
): boolean {
  const status = (slot: string) =>
    slots.find((row) => row.slot === slot)?.status ?? ("missing" as AdminBotPaperSlotStatus);
  if (isAdminBotPaperSlotSettled(status("pi_approval"))) {
    return false;
  }
  return (
    isAdminBotPaperSlotSettled(status("authors_ack")) &&
    isAdminBotPaperSlotSettled(status("drive_pdf_arxiv"))
  );
}
