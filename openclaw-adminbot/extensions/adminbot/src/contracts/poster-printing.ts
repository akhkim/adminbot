// Printing the lab's conference posters in one batch, by one person, before every conference.
//
// Before this, the `poster_physical` slot recorded "to print" on a paper and nothing read it: the
// person with a free printer (MPI Tübingen, a department plotter) collected files from a Drive
// folder and a Slack thread, the deadline lived in somebody's head, and whoever had not seen the
// thread found out at the venue. The question is about a conference -- "which NeurIPS posters do I
// print, at what size, by when" -- and every record was about a paper.
//
// So the batch is per conference site and almost entirely derived. A site is one city: most
// conferences have one, but NeurIPS 2026 runs in Sydney, Paris and Atlanta at once, and a printer
// in Tübingen prints for Paris, not for Atlanta. A paper's site is the one its first author picked
// when answering, else the site their trip is booked for. Which papers owe a poster comes from
// the accepted papers (including the ones the OpenReview sync accepted), who answers comes from the
// first author, when to print comes from the conference's start date in the deadline dataset, and
// who prints comes from the lab default. A conference therefore has a working batch the moment a
// lab paper is accepted at it, with nobody creating one. What is stored is only what a person
// decided: an admin overriding the printer or the deadline for one conference, and each first
// author's answer for their paper.

/** The `conference_key` of the row that holds the lab-wide defaults rather than one conference. */
export const ADMINBOT_POSTER_PRINT_DEFAULTS_KEY = "default";

/** Days before the conference starts that posters are due to the printer, unless overridden. */
export const ADMINBOT_POSTER_PRINT_DEFAULT_LEAD_DAYS = 14;

/**
 * A first author's answer for one paper.
 *
 * `lab_print` puts it in the batch. `self_print` is the author printing it themselves (a local
 * shop, a fabric poster) -- worth recording so they stop being reminded, and so the printer's list
 * does not look one short. `no_poster` means the paper is not presenting one at all, which also
 * waives the paper's `poster_physical` slot.
 */
export const adminBotPosterPrintChoices = ["lab_print", "self_print", "no_poster"] as const;
export type AdminBotPosterPrintChoice = (typeof adminBotPosterPrintChoices)[number];

/**
 * Paper sizes a printer is asked for. A0 and A1 cover nearly every venue; anything else goes in
 * `custom_size` as free text ("36x48 in"), because a closed list of every venue's rule would be
 * wrong within a year.
 */
export const adminBotPosterPrintSizes = ["A0", "A1", "custom"] as const;
export type AdminBotPosterPrintSize = (typeof adminBotPosterPrintSizes)[number];

export const adminBotPosterOrientations = ["portrait", "landscape"] as const;
export type AdminBotPosterOrientation = (typeof adminBotPosterOrientations)[number];

/**
 * Per-site settings, or the lab defaults when `conference_key` is
 * ADMINBOT_POSTER_PRINT_DEFAULTS_KEY. Every field is optional: an absent field falls through to
 * the defaults row, then to the built-in lead time.
 */
export type AdminBotPosterPrintBatchRecord = {
  conference_key: string;
  /** Who prints. Receives the aggregated list on the deadline. */
  printer_member_id?: string;
  /** Where the printing happens ("MPI Tübingen"), so authors know where their poster will be. */
  print_location?: string;
  /** Explicit deadline, YYYY-MM-DD. Wins over `lead_days`. Per-conference rows only. */
  deadline_on?: string;
  /** Days before the conference start. Mostly set on the defaults row. */
  lead_days?: number;
  /** Shown to authors next to the deadline: how posters travel to the venue, file rules. */
  notes?: string;
  updated_at: string;
  updated_by?: string;
};

/**
 * One first author's answer for one paper at one conference. `conference_key` is the paper's
 * conference (`neurips:2026`), so the row survives a site being added to the dataset later;
 * `site_key` says which city, and is required for `lab_print` at a multi-site conference.
 */
export type AdminBotPosterPrintRequestRecord = {
  conference_key: string;
  paper_id: string;
  choice: AdminBotPosterPrintChoice;
  site_key?: string;
  size?: AdminBotPosterPrintSize;
  /** Free text when `size` is `custom`. */
  custom_size?: string;
  orientation?: AdminBotPosterOrientation;
  /** Usually 1; a paper presented at a workshop as well wants two. */
  copies?: number;
  notes?: string;
  updated_at: string;
  updated_by?: string;
};

/**
 * Where one paper stands in the batch. `unanswered` and `missing_file` are the two states that
 * earn a reminder; the rest are settled.
 */
export type AdminBotPosterPrintPaperState =
  | "unanswered"
  | "missing_file"
  | "ready"
  | "self_print"
  | "no_poster";

export type AdminBotPosterPrintPaper = {
  paper_id: string;
  title: string;
  presentation_type?: string;
  first_author?: { member_id: string; name: string };
  /** The paper's `poster` slot link, when one is filed. */
  poster_url?: string;
  request?: AdminBotPosterPrintRequestRecord;
  state: AdminBotPosterPrintPaperState;
  /**
   * How the paper landed at this site: the author's answer, their trip, the conference having
   * only one site, or `unknown` -- a multi-site conference nobody has placed the paper at yet,
   * listed under every site so each printer sees it might be theirs.
   */
  site_source: "request" | "trip" | "single" | "unknown";
  /** Whether the first author said they are going, so the printer knows who collects in person. */
  first_author_going: boolean;
};

/**
 * Where the batch is in its life. `collecting` until the deadline, then `due` until the list is
 * handed to the printer, then `sent`. `no_deadline` when the dataset has no start date and nobody
 * set one: the batch exists but nothing is chased, because a reminder with no date is noise.
 */
export type AdminBotPosterPrintBatchStatus = "no_deadline" | "collecting" | "due" | "sent";

export type AdminBotPosterPrintBatchView = {
  /** The site key (`neuripsparis:2026`), which is the conference key when there is one site. */
  conference_key: string;
  /** The paper-side conference key (`neurips:2026`). */
  group_key: string;
  multi_site: boolean;
  /** "NeurIPS 2026 — Paris". */
  label: string;
  conference_starts?: string;
  conference_location?: string;
  deadline_on?: string;
  /** `set` when an admin fixed the date, `lead_days` when derived from the start date. */
  deadline_source: "set" | "lead_days" | "none";
  days_left?: number;
  printer?: { member_id: string; name: string };
  print_location?: string;
  notes?: string;
  status: AdminBotPosterPrintBatchStatus;
  /** When the aggregated list was last handed over, from the handoff proposal. */
  sent_at?: string;
  papers: AdminBotPosterPrintPaper[];
  counts: Record<AdminBotPosterPrintPaperState, number>;
};

export function isAdminBotPosterPrintChoice(value: unknown): value is AdminBotPosterPrintChoice {
  return (adminBotPosterPrintChoices as readonly unknown[]).includes(value);
}

export function isAdminBotPosterPrintSize(value: unknown): value is AdminBotPosterPrintSize {
  return (adminBotPosterPrintSizes as readonly unknown[]).includes(value);
}

export function isAdminBotPosterOrientation(value: unknown): value is AdminBotPosterOrientation {
  return (adminBotPosterOrientations as readonly unknown[]).includes(value);
}

/** What `GET /poster-printing` returns: the batches the viewer may see, and what they may do. */
export type AdminBotPosterPrintOverview = {
  batches: AdminBotPosterPrintBatchView[];
  /**
   * Admins only: the stored settings rows (the lab defaults under "default"), so a form edits what
   * was set rather than what was inherited, and who can be picked as a printer.
   */
  settings?: AdminBotPosterPrintBatchRecord[];
  printer_candidates?: Array<{ member_id: string; name: string }>;
  /** Admins edit settings. */
  can_manage: boolean;
  /** Site keys the viewer may mark printed: every batch for an admin, their own for a printer. */
  printable: string[];
};

/** The paper page's "print with the lab batch" section. Absent when the paper owes no poster. */
export type AdminBotPosterPrintPaperOptions = {
  paper_id: string;
  /** The paper's conference (`neurips:2026`): the request's `conference_key`. */
  conference_key: string;
  conference_label: string;
  /** Cities still ahead. More than one means the author has to say which. */
  sites: Array<{ key: string; label: string; starts?: string }>;
  /** The site the paper is placed at now, and how (answer, trip, the only site). */
  site_key?: string;
  request?: AdminBotPosterPrintRequestRecord;
  state: AdminBotPosterPrintPaperState;
  deadline_on?: string;
  printer_name?: string;
  print_location?: string;
  notes?: string;
  status?: AdminBotPosterPrintBatchStatus;
};

export type AdminBotPosterPrintRequestInput = Pick<
  AdminBotPosterPrintRequestRecord,
  "choice" | "site_key" | "size" | "custom_size" | "orientation" | "copies" | "notes"
>;

export type AdminBotPosterPrintBatchInput = Pick<
  AdminBotPosterPrintBatchRecord,
  "printer_member_id" | "print_location" | "deadline_on" | "lead_days" | "notes"
>;
