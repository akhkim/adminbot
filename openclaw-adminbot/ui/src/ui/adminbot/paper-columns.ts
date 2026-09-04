// What a paper's sheet has a column for, and what each column reads and writes.
//
// Split out of `paper-grid.ts`, which draws them: the registry grew from eight link slots to
// every field the card carries plus the whole evidence checklist, and a file that both declares
// sixty columns and implements a spreadsheet is two files pretending to be one.
//
// The order here is the order on screen, and the bands (`COLUMN_GROUPS`) are the unit the sheet
// shows and hides.

import {
  adminBotNormalizePaperAlias,
  adminBotPaperSteps,
  type AdminBotPaperStep,
} from "../../../../extensions/adminbot/src/contracts/actions.js";
import {
  adminBotPaperSlotRegistry,
  adminBotPaperSlots,
  adminBotPosterPhysicalStates,
  type AdminBotPaperSlot,
} from "../../../../extensions/adminbot/src/contracts/paper-slots.js";
import { blockerLog, fileBlockerInput } from "./blockers.ts";
import type { AdminBotPaperRecord, AdminBotPaperSaveInput } from "./controllers/admin.ts";
import {
  canonicalVenueId,
  effectiveVenueTargets,
  formatVenueTargets,
  serializeVenueTargets,
  type VenueTarget,
} from "./venue-targets.ts";

type ArtifactKey = NonNullable<AdminBotPaperRecord["artifacts"]>;

/**
 * How a cell behaves.
 *
 * The grid began as eight columns of URLs, so "a cell" and "a URL input" were the same thing.
 * Carrying every field the card carries means that is no longer true: a step is a closed list, a
 * start date is a date, an accepted year is a number, and a blocker log is a structure no cell
 * should let anyone retype by hand.
 */
type ColumnKind = "url" | "text" | "date" | "number" | "select" | "readonly";

/**
 * The bands the columns are read in, and the order they appear.
 *
 * Sixty columns in one undifferentiated run is a worse surface than the ten it replaced: nothing
 * tells you where "what the venue said" ends and "what we have on file" begins, and a person
 * looking for one field scrolls past four unrelated subjects to reach it. The band is both a
 * heading over the header row and the unit the show/hide chips operate on, so a member who only
 * came to paste Overleaf links can put the other fifty away.
 */
export const COLUMN_GROUPS = [
  { id: "project", label: "Project" },
  { id: "people", label: "People" },
  { id: "venue", label: "Venue" },
  { id: "decision", label: "Decision" },
  { id: "links", label: "Links" },
  { id: "evidence", label: "Evidence" },
] as const;

export type ColumnGroup = (typeof COLUMN_GROUPS)[number]["id"];

export type Column = {
  /** Identity of the column: the `artifacts` key by default, otherwise just a stable name. */
  key: keyof ArtifactKey | string;
  /** Which band it belongs to. Decides where it is drawn and what hides it. */
  group: ColumnGroup;
  /**
   * The evidence row this cell is the other face of.
   *
   * A slot lives in `paper_slots`, one row per artifact per paper, and it is what the card's
   * checklist and every nudge read. Nine of the link columns below name one: those write both
   * places from one cell, because `artifacts.poster_url` and the `poster` slot are the same fact
   * and a grid that filled one while the card counted the other is exactly the split this change
   * is here to close.
   */
  slot?: AdminBotPaperSlot;
  /** Key on the save input. Absent means `apply` writes it, or that nothing does. */
  save?: keyof AdminBotPaperSaveInput;
  label: string;
  short: string;
  kind?: ColumnKind;
  /** Choices for `kind: "select"`. */
  options?: ReadonlyArray<{ value: string; label: string }>;
  /**
   * How the stored value is read off the record.
   *
   * Defaults to `artifacts[key]`, which is where the link slots live. The fields that arrived with
   * "the grid should carry what the card carries" mostly do not: title, alias, the step and the
   * acceptance answers are columns on the record itself.
   */
  read?: (paper: AdminBotPaperRecord) => string;
  /**
   * How a cell is written back onto the save input.
   *
   * Defaults to `input[save] = value`. Supplied for anything that is not a plain string on the
   * input -- an author list, a set of venue targets -- so the structure is rebuilt rather than
   * flattened.
   */
  apply?: (input: AdminBotPaperSaveInput, value: string, paper: AdminBotPaperRecord) => void;
  /** Overrides the built-in URL checking. Returns a reason, or undefined when the value is fine. */
  validate?: (value: string) => string | undefined;
  hosts?: string[];
  path?: RegExp;
  /** Not a URL — validated by pattern instead. */
  pattern?: RegExp;
  hint?: string;
  /**
   * The shape of an acceptable value, as a prefix.
   *
   * Deliberately not a complete link. A full example with a plausible document id reads as real
   * and invites being pasted -- which is how a sheet ends up with thirty rows pointing at the
   * same fictional document. A prefix answers "what goes here" and cannot be mistaken for an
   * answer to "what goes in this row".
   */
  format: string;
};

/**
 * Names are joined with semicolons, not commas.
 *
 * "Yook, Joeun" is how a BibTeX paste spells one person. Splitting that list on commas turns one
 * author into two, and the second one is a first name nobody on the roster answers to.
 */
const NAME_SEPARATOR = "; ";

/**
 * Who is typing, for a blocker filed from a cell.
 *
 * A blocker carries the name of whoever raised it, because "who do I go ask about this" is the
 * next question the admin board is asked. The grid is a pure renderer over columns declared at
 * module scope, so the name is set once per render from the props rather than threaded through
 * `apply` -- an unattributed blocker is worth less than an ugly module variable.
 */
let viewerName = "";

/** Set once per render by the sheet, which is the only thing that knows who is looking. */
export function setBlockerAuthor(name: string): void {
  viewerName = name;
}

function splitNames(value: string): string[] {
  return value
    .split(";")
    .map((name) => name.trim())
    .filter(Boolean);
}

/**
 * Rebuilds the author list from retyped names, keeping who each one is.
 *
 * `author_links` is the answer somebody recorded when they picked an author off the roster, and it
 * is what decides whose My Projects page a paper appears on. A grid cell holds names and nothing
 * else, so writing one back naively would replace every link with a bare name and quietly detach
 * the paper from its authors.
 *
 * A name that survives the edit keeps its link. A name that does not is a new, unlinked author --
 * which is the honest result, and the card's own picker is where it gets linked to a member.
 */
export function mergeAuthorLinks(
  paper: AdminBotPaperRecord,
  typedNames: string[],
): Array<{ name: string; member_id?: string; email?: string }> {
  const priorByName = new Map(
    (paper.author_links ?? []).map((link) => [link.name.trim().toLowerCase(), link]),
  );
  return typedNames.map((name) => {
    const prior = priorByName.get(name.toLowerCase());
    return prior ? { ...prior, name } : { name };
  });
}

/** "80% ICLR 2027 · 50% ARR October" back into the rows the record stores. */
export function parseVenueTargets(value: string): VenueTarget[] | undefined {
  const parts = value
    .split("·")
    .map((part) => part.trim())
    .filter(Boolean);
  const targets: VenueTarget[] = [];
  for (const part of parts) {
    const match = /^(\d{1,3})%\s*(.+)$/u.exec(part);
    if (!match) {
      return undefined;
    }
    const confidence = Number(match[1]);
    const label = (match[2] ?? "").trim();
    if (!label || confidence < 0 || confidence > 100) {
      return undefined;
    }
    targets.push({ venue_id: canonicalVenueId(label), label, confidence });
  }
  return targets;
}

// Columns follow the slot registry in fields_update.md. `arxiv_paper_password` is listed
// because the layout is part of the design being reviewed, but it has no field on the record
// yet, so it is rendered disabled rather than accepting text this UI would then drop.
const STEP_OPTIONS = adminBotPaperSteps.map((step) => ({
  value: step,
  label: step.replaceAll("_", " "),
}));

const DECISION_OPTIONS = [
  { value: "pending", label: "Not heard yet" },
  { value: "accept", label: "Accepted" },
  { value: "reject", label: "Rejected" },
];

const ARCHIVAL_OPTIONS = [
  { value: "", label: "Not said" },
  { value: "true", label: "Archival" },
  { value: "false", label: "Non-archival" },
];

const PRESENTATION_OPTIONS = [
  { value: "", label: "Not said" },
  ...["poster", "findings", "main", "spotlight", "oral", "award"].map((type) => ({
    value: type,
    label: `${type[0]?.toUpperCase() ?? ""}${type.slice(1)}`,
  })),
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * Every field the card can edit, in the order a person reads a paper: what it is, who wrote it,
 * where it is going, what the venue said, the links, then the evidence.
 *
 * The grid and the card now carry the same set and write it to the same places -- one row in
 * `adminbot_papers` through `PUT /papers/:id`, and one row per artifact in `paper_slots` through
 * `PUT /papers/:id/slots/:slot`, whichever surface typed it.
 *
 * One field stays read-only rather than being dropped: the blocker *log*. Filing a blocker is a
 * cell below (`blocker`), because that is a sentence somebody types; the log beside it carries an
 * author and a timestamp per entry and a cell that let it be retyped would erase the history of
 * everything already in it.
 */
const RECORD_COLUMNS: Column[] = [
  {
    key: "title",
    group: "project",
    kind: "text",
    save: "title",
    read: (paper) => paper.title ?? "",
    validate: (value) => (value.trim() ? undefined : "a paper needs a title"),
    label: "Title",
    short: "Title",
    format: "The paper's title",
    hint: "Renaming here renames it everywhere",
  },
  {
    key: "alias",
    group: "project",
    kind: "text",
    save: "alias",
    read: (paper) => paper.alias ?? "",
    // Same rule the card and the create form apply: it becomes a Slack channel either way.
    validate: (value) =>
      !value.trim() || adminBotNormalizePaperAlias(value)
        ? undefined
        : "letters, digits and hyphens only",
    label: "Short name",
    short: "Short name",
    format: "cais",
    hint: "Names the project's Slack channel",
  },
  {
    key: "started_on",
    group: "project",
    kind: "date",
    save: "startedOn",
    read: (paper) => paper.started_on ?? "",
    validate: (value) => (!value.trim() || ISO_DATE.test(value.trim()) ? undefined : "YYYY-MM-DD"),
    label: "Started on",
    short: "Started",
    format: "2026-09-01",
  },
  {
    key: "current_step",
    group: "project",
    kind: "select",
    options: STEP_OPTIONS,
    save: "currentStep",
    read: (paper) => paper.current_step ?? "",
    label: "Current step",
    short: "Step",
    format: "One of the pipeline steps",
  },
  {
    key: "topic",
    group: "project",
    kind: "text",
    save: "topic",
    label: "Topic",
    short: "Topic",
    format: "The safety area this sits in",
  },
  {
    key: "completed_at",
    group: "project",
    kind: "date",
    save: "completedAt",
    // The card writes a timestamp when somebody presses "This one is finished"; a date cell is
    // the same answer at the resolution a sheet can offer. Clearing it reopens the paper, which
    // is what the card's Reopen button does.
    read: (paper) => (paper.artifacts?.completed_at ?? "").slice(0, 10),
    validate: (value) => (!value.trim() || ISO_DATE.test(value.trim()) ? undefined : "YYYY-MM-DD"),
    label: "Completed on",
    short: "Completed",
    format: "2027-04-12",
    hint: "The day it was presented and closed out — clear it to reopen the paper",
  },
  {
    key: "blocker",
    group: "project",
    kind: "text",
    // Appends. `apply` builds the new log from the stored one, so filing a blocker from the sheet
    // keeps every entry already on the paper, along with who raised each and when.
    read: () => "",
    apply: (input, value, paper) => {
      const title = value.trim();
      if (!title) {
        return;
      }
      const filed = fileBlockerInput(paper, {
        stage: paper.current_step ?? "",
        title,
        note: "",
        by: viewerName,
      });
      input.blockerLog = filed.blockerLog;
    },
    label: "Report a blocker",
    short: "New blocker",
    format: "What is stuck, in a few words",
    hint: "Typing here files a new blocker at the paper's current step — it never edits an old one",
  },
  {
    key: "blocker_log",
    group: "project",
    kind: "readonly",
    // Shown, not editable. Each entry carries who raised it and when, and the card's form is what
    // keeps that true -- a cell holding the JSON would let one paste erase the history.
    read: (paper) => {
      const open = blockerLog(paper).filter((entry) => !entry.resolved_at);
      return open.length ? open.map((entry) => entry.title).join(NAME_SEPARATOR) : "";
    },
    label: "Open blockers",
    short: "Blockers",
    format: "Raised here or on the card",
    hint: "Read-only — resolved on the card, where the whole entry is visible",
  },
  {
    key: "authors",
    group: "people",
    kind: "text",
    read: (paper) =>
      (paper.author_links ?? []).length
        ? (paper.author_links ?? []).map((link) => link.name).join(NAME_SEPARATOR)
        : (paper.authors ?? []).join(NAME_SEPARATOR),
    apply: (input, value, paper) => {
      const names = splitNames(value);
      input.authors = names;
      // Rebuilt rather than replaced, so an author who was already matched to a roster member
      // stays matched. See mergeAuthorLinks.
      input.authorLinks = mergeAuthorLinks(paper, names);
    },
    validate: (value) =>
      !value.trim() || splitNames(value).length ? undefined : "separate names with ;",
    label: "Authors",
    short: "Authors",
    format: "Ada Lovelace; Yook, Joeun",
    hint: "Semicolons, because a BibTeX name already has a comma in it",
  },
  {
    key: "author_roles",
    group: "people",
    kind: "text",
    save: "authorRoles",
    read: (paper) => paper.author_roles ?? "",
    label: "Author roles",
    short: "Roles",
    format: "Who does what on the paper",
  },
  {
    key: "feedback_givers",
    group: "people",
    kind: "text",
    read: (paper) => (paper.feedback_givers ?? []).join(NAME_SEPARATOR),
    apply: (input, value) => {
      input.feedbackGivers = splitNames(value);
    },
    label: "Feedback givers",
    short: "Feedback",
    format: "Ada Lovelace; Rahul Shrestha",
    hint: "People asked to read the draft",
  },
  {
    key: "venue",
    group: "venue",
    kind: "text",
    save: "venue",
    read: (paper) => paper.venue ?? "",
    label: "Target venue",
    short: "Venue",
    format: "ICLR 2027",
    hint: "What the stage nudges quote and the deadline board matches on",
  },
  {
    key: "venue_targets",
    group: "venue",
    kind: "text",
    read: (paper) => formatVenueTargets(effectiveVenueTargets(paper)),
    apply: (input, value) => {
      input.venueTargets = serializeVenueTargets(parseVenueTargets(value) ?? []);
    },
    validate: (value) =>
      !value.trim() || parseVenueTargets(value) ? undefined : "use 80% ICLR 2027 · 50% ARR October",
    label: "Target venues, with odds",
    short: "Targets",
    format: "80% ICLR 2027 · 50% ARR October",
    hint: "Highest bet first, separated by ·",
  },
  // ── what the venue said ─────────────────────────────────────────────────────────────────
  //
  // These five are the card's acceptance block, and they are the authors' own report of what the
  // venue answered: `OWN_PAPER_EDITABLE_FIELDS` takes all five from the member write path, so a
  // cell here saves for the author whose paper it is as well as for an admin filling in a sheet
  // of decisions. The workflow fields beside them on the record -- who gets nudged, which attempt
  // this is, the dormancy exemption -- stay privileged and have no column.
  //
  // Only a *typed* cell is ever sent either way: `pendingSaves` reads the edit map, not the
  // record, so a row nobody touched these in never carries them and a stored answer is never
  // rewritten by somebody editing the Overleaf link beside it.
  {
    key: "venue_decision",
    group: "decision",
    kind: "select",
    options: DECISION_OPTIONS,
    save: "venueDecision",
    read: (paper) => paper.venue_decision ?? "pending",
    label: "Venue decision",
    short: "Decision",
    format: "Whether the venue has answered",
    hint: "The venue's answer, as the authors report it — the same control the card carries",
  },
  {
    key: "accepted_venue",
    group: "decision",
    kind: "text",
    save: "acceptedVenue",
    read: (paper) => paper.accepted_venue ?? "",
    label: "Accepted venue",
    short: "Accepted at",
    format: "ICLR 2027",
  },
  {
    key: "accepted_year",
    group: "decision",
    kind: "number",
    save: "acceptedYear",
    read: (paper) => (paper.accepted_year === undefined ? "" : String(paper.accepted_year)),
    validate: (value) =>
      !value.trim() || /^\d{4}$/u.test(value.trim()) ? undefined : "a four-digit year",
    label: "Accepted year",
    short: "Year",
    format: "2027",
  },
  {
    key: "is_archival",
    group: "decision",
    kind: "select",
    options: ARCHIVAL_OPTIONS,
    save: "isArchival",
    read: (paper) => (paper.is_archival === undefined ? "" : String(paper.is_archival)),
    label: "Archival?",
    short: "Archival",
    format: "Whether it counts as a publication",
  },
  {
    key: "presentation_type",
    group: "decision",
    kind: "select",
    options: PRESENTATION_OPTIONS,
    save: "presentationType",
    read: (paper) => paper.presentation_type ?? "",
    label: "Presentation",
    short: "Presented as",
    format: "Poster, oral, and so on",
  },
  {
    key: "brainstorming_doc_url",
    group: "links",
    slot: "project_folder",
    format: "https://docs.google.com/document/… or https://drive.google.com/drive/folders/…",
    save: "brainstormingDocUrl",
    label: "Project doc / folder",
    short: "Project",
    hosts: ["docs.google.com", "drive.google.com"],
    hint: "A doc or a Drive folder",
  },
  {
    key: "overleaf_view_url",
    group: "links",
    slot: "overleaf_view",
    format: "https://www.overleaf.com/read/…",
    save: "overleafViewUrl",
    label: "Overleaf (view)",
    short: "Overleaf view",
    hosts: ["overleaf.com", "www.overleaf.com"],
    hint: "The read-only share link",
  },
  {
    key: "overleaf_edit_url",
    group: "links",
    slot: "overleaf_edit",
    format: "https://www.overleaf.com/project/…",
    save: "overleafEditUrl",
    label: "Overleaf (edit)",
    short: "Overleaf edit",
    hosts: ["overleaf.com", "www.overleaf.com"],
    hint: "The project link coauthors can write in",
  },
  {
    key: "submission_url",
    group: "links",
    slot: "submission",
    format: "https://openreview.net/forum?id=… or the venue's own site",
    save: "submissionUrl",
    label: "Submission",
    short: "Submission",
    hint: "Where the submission itself lives",
  },
  {
    key: "google_drive_pdf_url",
    group: "links",
    slot: "drive_pdf_arxiv",
    format: "https://drive.google.com/file/…",
    save: "googleDrivePdfUrl",
    label: "Drive PDF (arXiv version)",
    short: "Drive PDF",
    hosts: ["drive.google.com", "docs.google.com"],
    hint: "The PDF as posted to arXiv",
  },
  {
    key: "arxiv_url",
    group: "links",
    slot: "arxiv",
    format: "https://arxiv.org/abs/…",
    save: "arxivUrl",
    label: "arXiv",
    short: "arXiv",
    hosts: ["arxiv.org", "www.arxiv.org"],
    path: /^\/abs\//u,
    hint: "The /abs/ page, not the PDF",
  },
  {
    key: "arxiv_paper_password",
    group: "links",
    slot: "arxiv_paper_password",
    kind: "text",
    format: "Six letters or digits",
    save: "arxivPaperPassword",
    label: "arXiv paper password",
    short: "arXiv pw",
    pattern: /^[A-Za-z0-9]{6}$/u,
    hint: "Six characters — stored in plain text on the record every coauthor can read",
  },
  {
    key: "google_slides_url",
    group: "links",
    slot: "slides",
    format: "https://docs.google.com/presentation/…",
    save: "googleSlidesUrl",
    label: "Slides",
    short: "Slides",
    hosts: ["docs.google.com"],
    path: /^\/presentation\//u,
    hint: "A Google Slides deck",
  },
  {
    key: "poster_url",
    group: "links",
    slot: "poster",
    format: "https://… (any site)",
    save: "posterUrl",
    label: "Poster",
    short: "Poster",
    hint: "Any https link — Drive, Overleaf, wherever it lives",
  },
];

// ── the evidence checklist, as columns ────────────────────────────────────────────────────
//
// The other half of what a card can be asked for. These do not live on the paper: each is a row
// in `paper_slots`, which is what the card's "0/21 artifacts" bar counts and what every nudge
// reads, and they are written one at a time through the slot endpoint rather than with the row.
//
// Generated from the registry rather than listed, because the registry is the contract the
// service, the card and the PaperFlow graph already share -- a slot added there appears here on
// the next build instead of being a column somebody forgets to add.

/** Short headers. The registry's labels are sentences; a column heading is not. */
const SLOT_SHORT: Partial<Record<AdminBotPaperSlot, string>> = {
  papermentor_review: "Review done",
  fixes_merged: "Fixes merged",
  pdf_ready: "PDF compiles",
  submission_id: "Submission ID",
  authors_ack: "Authors final",
  pi_approval: "PI approval",
  x_draft: "X draft",
  linkedin_draft: "LinkedIn draft",
  coauthor_feedback: "Coauthor feedback",
  social_final: "Social final",
  x_post: "X post",
  linkedin_post: "LinkedIn post",
  poster_physical: "Physical poster",
  talk_video: "Talk video",
  backend_sheet: "Tracking sheet",
};

/** A yes/no gate, as a two-choice cell. Blank is "not yet", which is also how it clears. */
const DONE_OPTIONS = [
  { value: "", label: "Not yet" },
  { value: "yes", label: "Done" },
];

const POSTER_STATE_OPTIONS = [
  { value: "", label: "Not said" },
  ...adminBotPosterPhysicalStates.map((state) => ({
    value: state,
    label: state.replaceAll("_", " "),
  })),
];

/**
 * The registry's worked example, cut back to a shape.
 *
 * The card can afford a complete specimen: it shows one paper, and the example sits under the one
 * field it belongs to. A sheet cannot -- a full link in a column header is a thing thirty rows
 * can be filled with in one drag, which is the failure the `format` rule exists to prevent. So a
 * URL example keeps its host and its first path segment and stops there; anything that is not a
 * URL is already a shape and is used as it stands.
 */
function formatFrom(example: string | undefined, label: string): string {
  if (!example) {
    return label;
  }
  if (!example.startsWith("https://")) {
    return example;
  }
  try {
    const url = new URL(example);
    const [first] = url.pathname.split("/").filter(Boolean);
    return `${url.origin}/${first ? `${first}/` : ""}…`;
  } catch {
    return label;
  }
}

function slotColumn(slot: AdminBotPaperSlot): Column {
  const definition = adminBotPaperSlotRegistry[slot];
  const base = {
    key: `slot:${slot}`,
    group: "evidence" as const,
    slot,
    label: definition.label,
    short: SLOT_SHORT[slot] ?? definition.label,
    format: formatFrom(definition.example, definition.label),
    ...(definition.hint ? { hint: definition.hint } : {}),
  };
  // The two social-draft gates read `paper_social_drafts` and reject a direct write: a draft is a
  // body somebody consented to, not a tick. Shown so the sheet says what the paper holds, and
  // pointed at the card, which is where the draft is written.
  if (definition.derived) {
    return {
      ...base,
      kind: "readonly",
      hint: "Written on the card — the gate opens when a draft is circulated and approved",
    };
  }
  switch (definition.kind) {
    case "bool":
      return { ...base, kind: "select", options: DONE_OPTIONS };
    case "enum":
      return { ...base, kind: "select", options: POSTER_STATE_OPTIONS };
    case "secret6":
      return { ...base, kind: "text", pattern: /^[A-Za-z0-9]{6}$/u };
    case "text":
      return { ...base, kind: "text" };
    default:
      return { ...base, kind: "url" };
  }
}

/** Slots a link column above already carries. Listed once, and read by both halves. */
const MIRRORED_SLOTS = new Set<AdminBotPaperSlot>(
  RECORD_COLUMNS.flatMap((column) => (column.slot ? [column.slot] : [])),
);

/**
 * Every column, in the order it is drawn.
 *
 * Exported for the sheet, which measures and addresses cells by index; `gridColumns()` is the
 * read-only view everything else should use.
 */
export const COLUMNS: Column[] = [
  ...RECORD_COLUMNS,
  ...adminBotPaperSlots.filter((slot) => !MIRRORED_SLOTS.has(slot)).map(slotColumn),
];

/**
 * Where a column sits, by name.
 *
 * Exported for the tests, which used to address columns by literal index -- so removing the
 * Submission column silently repointed every one of them at its neighbour and six assertions
 * started testing the wrong field. A name survives the next column being added or dropped.
 */
export function gridColumns(): readonly Column[] {
  return COLUMNS;
}

export function columnIndexOf(key: string): number {
  return COLUMNS.findIndex((column) => String(column.key) === key);
}
