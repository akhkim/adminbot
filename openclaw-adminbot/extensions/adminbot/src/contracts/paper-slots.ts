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

/** Every artifact a paper can be asked for. Ordered roughly as the work happens. */
export const adminBotPaperSlots = [
  "project_folder",
  "overleaf_view",
  "overleaf_edit",
  "papermentor_review",
  "fixes_merged",
  "pdf_ready",
  "submission",
  "submission_id",
  "rebuttal_doc",
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
   * Slots that must be provided-or-waived before this one is worth asking for. Without this the
   * nudge would chase an author for an arXiv link on a paper that has not been submitted.
   */
  upstream: AdminBotPaperSlot[];
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
  /** A line under the control, for slots whose point is not guessable from the label. */
  hint?: string;
};

/**
 * The registry.
 *
 * `gates` names the step a slot releases, so "what is this for" is answerable from the row rather
 * than from the graph. `upstream` is the dependency edge the nudge walk actually follows.
 */
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
    urlHosts: ["overleaf.com"],
    urlPath: ["/read/"],
    hint: "Overleaf's read-only share link. Safe to paste in a channel — nobody can edit the paper with it.",
    example: "https://overleaf.com/read/xzqvbnmklpqr",
  },
  overleaf_edit: {
    kind: "link",
    node: "OV",
    owner: "first_author",
    gates: "submission",
    branch: "core",
    label: "Overleaf project link",
    upstream: ["project_folder"],
    required: true,
    deadlineBearing: true,
    urlHosts: ["overleaf.com"],
    urlPath: ["/project/"],
    hint: "The URL in your address bar while editing. Hands over write access, so keep it to coauthors.",
    example: "https://overleaf.com/project/65f2a1c9d4e3b7a801f6",
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
    kind: "text",
    node: "SB",
    owner: "first_author",
    gates: "google_drive_pdf",
    branch: "venue",
    label: "Submission id",
    upstream: ["submission"],
    required: true,
    deadlineBearing: true,
    hint: "The identifier the venue assigned you. Read it off the submission page you just pasted.",
    example: "Ax7Kq2Lm9P",
  },
  rebuttal_doc: {
    kind: "link",
    node: "RS",
    owner: "first_author",
    gates: null,
    branch: "venue",
    label: "Rebuttal doc",
    // The rebuttal window is a hard clock the venue sets, so this is deadline-bearing even though
    // it releases no step of ours.
    upstream: ["submission_id"],
    required: true,
    deadlineBearing: true,
    urlHosts: ["docs.google.com", "drive.google.com"],
    urlPath: ["/document/", "/drive/folders/"],
    hint: "The doc where you are drafting the rebuttal, so coauthors can write in it before it is submitted.",
    example: "https://docs.google.com/document/d/1Rb2Tt…",
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
    upstream: ["arxiv"],
    required: true,
    deadlineBearing: false,
    derived: true,
    hint: "Provided once an approved X draft exists. Write it with the drafting tool.",
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
    derived: true,
    hint: "Provided once an approved LinkedIn draft exists. Write it with the drafting tool.",
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
 * is stale the moment it passes.
 */
export function validateAdminBotPaperSlotUrl(
  slot: AdminBotPaperSlot,
  raw: string,
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
  const hosts = definition.urlHosts;
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
    return { ok: false, reason: "the password is exactly 6 letters and digits" };
  }
  if (!/[A-Za-z]/u.test(value) || !/[0-9]/u.test(value)) {
    return { ok: false, reason: "the password mixes letters and digits" };
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
