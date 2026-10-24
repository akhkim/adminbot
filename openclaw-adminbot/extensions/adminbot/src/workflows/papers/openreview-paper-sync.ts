// Paper records follow the PI's OpenReview submissions.
//
// OpenReview is the ground truth for whether a lab paper was submitted and what the venue
// decided, and it is read from OpenReview itself:
//
//   - the author-results snapshot (scripts/adminbot-openreview.py author-results), which reads
//     every submission the PI authored, with its decision, track, presentation and every title it
//     has carried;
//   - the citation-watch table, whose venue ids say whether a submission is active, rejected or
//     withdrawn, and which is only a fallback.
//
// The PI's notification e-mails were a source too, and were dropped: an e-mail is frozen at the
// title and status it was sent with, so a retitled paper stopped matching, a status moved on
// without a new e-mail, and none of them said oral or poster.
//
// This module is pure: it turns those reports into evidence, matches evidence to one paper the
// way the paper sheet export does, and plans the change. The service applies the plan through
// its normal write path and records the fingerprint it applied, so a human who corrects a field
// afterwards is not overwritten again until OpenReview itself says something new.

import type {
  AdminBotPaperOpenReviewSync,
  AdminBotPaperPresentationType,
  AdminBotPaperRecord,
  AdminBotPaperRecordInput,
} from "../../contracts/actions.js";
import { parsePaperFeedback } from "../../contracts/paper-feedback.js";
import {
  isAdminBotPaperSlotSettled,
  type AdminBotPaperSlot,
  type AdminBotPaperSlotRecord,
} from "../../contracts/paper-slots.js";

export type OpenReviewOutcome =
  | "accepted"
  | "under_review"
  | "rejected"
  | "desk_rejected"
  | "withdrawn";

export type OpenReviewEvidenceSource = "author_results" | "citation_checks";

export type OpenReviewEvidence = {
  source: OpenReviewEvidenceSource;
  status: OpenReviewOutcome;
  title: string;
  /** Every title the submission has carried, current first; a retitled paper matches by any. */
  titles?: string[];
  /** The submission note id, when the source knows it. */
  submission_id?: string;
  /** Every forum id the source ties to this submission (the note's own and its review forum). */
  forums: string[];
  venue_id?: string;
  /** The venue's own label, used only when the venue id does not name a venue. */
  venue_label?: string;
  track?: "main" | "findings";
  presentation?: "oral" | "spotlight" | "poster";
  /** When the submission note was created: the later of two attempts in one cycle wins. */
  submitted_at?: string;
  /** For a venue commitment, the venue id of the ARR submission it was committed from. */
  arr_venue_id?: string;
  /** When this report was true: when the snapshot was taken, or the citation check ran. */
  observed_at?: string;
  /** The submission note id, for the audit trail. */
  reference?: string;
};

const OUTCOMES = new Set<OpenReviewOutcome>([
  "accepted",
  "under_review",
  "rejected",
  "desk_rejected",
  "withdrawn",
]);
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
// When two sources describe the same submission at the same moment, the richer one wins.
const SOURCE_RANK: Record<OpenReviewEvidenceSource, number> = {
  author_results: 1,
  citation_checks: 0,
};

const FORUM_ID_RE = /openreview\.net\/(?:forum|pdf)\?(?:[^#\s]*&)?id=([A-Za-z0-9_-]+)/gu;

export function forumIdsIn(text: string | undefined): string[] {
  return text ? [...text.matchAll(FORUM_ID_RE)].map((match) => match[1]) : [];
}

export function normalizedTitle(title: string | undefined): string {
  return String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
}

/**
 * A venue id as people say it: 'aclweb.org/ACL/ARR/2026/October/Submission' is
 * 'ARR October 2026' and 'ICLR.cc/2027/Conference' is 'ICLR 2027'. Same rules as the sheet.
 */
export function venueFromId(venueId: string | undefined): string {
  const parts = String(venueId ?? "")
    .split("/")
    .filter(Boolean);
  const arr = parts.indexOf("ARR");
  if (arr >= 0 && parts.length >= arr + 3) {
    return `ARR ${parts[arr + 2]} ${parts[arr + 1]}`;
  }
  const year = parts.findIndex((part) => /^\d{4}$/u.test(part));
  if (year < 0) {
    return String(venueId ?? "");
  }
  const rest = parts
    .slice(year + 1)
    .filter((part) => part !== "Conference" && !part.endsWith("Submission"))
    .map((part) => part.replaceAll("_", " "));
  // 'aclweb.org/ACL/2026' and 'eacl.org/EACL/2027' name the venue just before the year.
  const name =
    year > 1 && !parts[year - 1].includes(".") ? parts[year - 1] : parts[0].split(".")[0];
  return [name, parts[year], ...rest].join(" ");
}

/** (year, month) of a submission's cycle, so the newest cycle wins a match. */
export function cycleKey(evidence: Pick<OpenReviewEvidence, "venue_id" | "venue_label">): number {
  const words = `${evidence.venue_id ?? ""} ${evidence.venue_label ?? ""}`
    .split(/[\s/_]+/u)
    .map((word) => word.toLowerCase());
  const year = words.find((word) => /^20\d{2}$/u.test(word));
  const month = words.findIndex((word) => MONTHS.includes(word));
  return (year ? Number(year) : 0) * 100 + (month >= 0 ? MONTHS.indexOf(words[month]) + 1 : 0);
}

function venueLabelOf(evidence: OpenReviewEvidence): string {
  const fromId = evidence.venue_id ? venueFromId(evidence.venue_id) : "";
  // A bare domain ("OpenReview.net") names no venue; the label is then the better guess.
  if (fromId && /\d{4}/u.test(fromId)) {
    return fromId;
  }
  return (evidence.venue_label ?? "").replace(/^submitted to\s+/iu, "").trim() || fromId;
}

function yearOf(label: string): number | undefined {
  const match = /\b(20\d{2})\b/u.exec(label);
  return match ? Number(match[1]) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function trackOf(value: unknown): OpenReviewEvidence["track"] {
  const text = asText(value).toLowerCase();
  return text === "main" || text === "findings" ? text : undefined;
}

function presentationOf(value: unknown): OpenReviewEvidence["presentation"] {
  const text = asText(value).toLowerCase();
  return text === "oral" || text === "spotlight" || text === "poster" ? text : undefined;
}

function compact(evidence: OpenReviewEvidence): OpenReviewEvidence {
  return Object.fromEntries(
    Object.entries(evidence).filter(([, value]) => value !== undefined && value !== ""),
  ) as OpenReviewEvidence;
}

/** The author-results snapshot, as evidence. Entries the bridge could not classify are dropped. */
export function evidenceFromAuthorResults(snapshot: unknown): OpenReviewEvidence[] {
  const root = asRecord(snapshot);
  const fetchedAt = asText(root.fetched_at) || undefined;
  const submissions = Array.isArray(root.submissions) ? root.submissions : [];
  return submissions.flatMap((raw) => {
    const entry = asRecord(raw);
    const status = asText(entry.status) as OpenReviewOutcome;
    const title = asText(entry.title);
    if (!OUTCOMES.has(status) || !title) {
      return [];
    }
    const forums = [entry.id, entry.forum, entry.review_forum].map(asText).filter(Boolean);
    const titles = (Array.isArray(entry.titles) ? entry.titles : []).map(asText).filter(Boolean);
    return [
      compact({
        source: "author_results",
        status,
        title,
        titles: titles.length ? [...new Set([title, ...titles])] : undefined,
        submission_id: asText(entry.forum) || asText(entry.id) || undefined,
        forums: [...new Set(forums)],
        venue_id: asText(entry.venue_id) || undefined,
        venue_label: asText(entry.venue) || undefined,
        track: status === "accepted" ? trackOf(entry.track) : undefined,
        presentation: status === "accepted" ? presentationOf(entry.presentation) : undefined,
        submitted_at: asText(entry.submitted_at) || undefined,
        arr_venue_id: asText(entry.arr_venue_id) || undefined,
        observed_at: fetchedAt,
        reference: asText(entry.id) || undefined,
      }),
    ];
  });
}

/** Rows of the citation-watch table. Its venue id is the only outcome it carries. */
export function evidenceFromCitationChecks(
  rows: ReadonlyArray<{
    submission_id: string;
    title: string;
    venue_id: string;
    checked_at?: string;
  }>,
): OpenReviewEvidence[] {
  return rows.flatMap((row) => {
    const venueId = row.venue_id.toLowerCase();
    const status: OpenReviewOutcome | undefined = venueId.includes("withdraw")
      ? "withdrawn"
      : venueId.includes("desk_reject")
        ? "desk_rejected"
        : venueId.includes("reject")
          ? "rejected"
          : venueId.endsWith("/submission")
            ? "under_review"
            : undefined;
    if (!status || !row.title.trim()) {
      return [];
    }
    return [
      compact({
        source: "citation_checks",
        status,
        title: row.title.trim(),
        submission_id: row.submission_id,
        forums: [row.submission_id],
        venue_id: row.venue_id,
        observed_at: row.checked_at,
        reference: row.submission_id,
      }),
    ];
  });
}

/** Every OpenReview forum id the paper already points at: its slots, then its links. */
export function paperForumIds(
  paper: Pick<AdminBotPaperRecord, "artifacts">,
  slots: readonly AdminBotPaperSlotRecord[],
): Set<string> {
  const texts = [
    ...slots.flatMap((row) => [row.url, row.slot === "submission_id" ? undefined : row.value_text]),
    ...Object.values(paper.artifacts ?? {}),
  ];
  const ids = new Set(texts.flatMap((text) => forumIdsIn(typeof text === "string" ? text : "")));
  // A bare id in the submission-id slot names the forum directly.
  const typed = slots.find((row) => row.slot === "submission_id")?.value_text?.trim();
  if (typed && /^[A-Za-z0-9_-]{6,}$/u.test(typed)) {
    ids.add(typed);
  }
  return ids;
}

/**
 * The evidence that speaks for this paper, if any.
 *
 * Forum ids the paper already holds win over a title match (on any title the submission has
 * carried), the citation-watch table only speaks when nothing else does, and among the candidates
 * the newest cycle wins (a resubmission supersedes the attempt before it), then the later
 * submission inside one cycle, then the newer report.
 */
export function matchPaperEvidence(
  paper: Pick<AdminBotPaperRecord, "title" | "artifacts">,
  slots: readonly AdminBotPaperSlotRecord[],
  evidence: readonly OpenReviewEvidence[],
): OpenReviewEvidence | undefined {
  const forums = paperForumIds(paper, slots);
  const byForum = evidence.filter((item) => item.forums.some((forum) => forums.has(forum)));
  const title = normalizedTitle(paper.title);
  const candidates = byForum.length
    ? byForum
    : title
      ? evidence.filter((item) =>
          [item.title, ...(item.titles ?? [])].some((other) => normalizedTitle(other) === title),
        )
      : [];
  return candidates.toSorted(compareEvidence).at(-1);
}

function compareEvidence(left: OpenReviewEvidence, right: OpenReviewEvidence): number {
  const fallback = (item: OpenReviewEvidence) => (item.source === "citation_checks" ? 0 : 1);
  return (
    // As on the sheet: the citation-watch table is a stale fallback and loses to any other report.
    fallback(left) - fallback(right) ||
    cycleKey(left) - cycleKey(right) ||
    (left.submitted_at ?? "").localeCompare(right.submitted_at ?? "") ||
    (left.observed_at ?? "").localeCompare(right.observed_at ?? "") ||
    SOURCE_RANK[left.source] - SOURCE_RANK[right.source]
  );
}

export type OpenReviewFieldChange = { field: string; from: unknown; to: unknown };

export type OpenReviewSlotWrite = {
  slot: AdminBotPaperSlot;
  url?: string;
  value_text?: string;
  verified_title?: string;
};

export type OpenReviewSyncPlan = {
  /** What was observed, recorded on the paper once applied. */
  sync: AdminBotPaperOpenReviewSync;
  /** True when this exact observation was applied before: nothing is re-applied. */
  unchanged: boolean;
  /** Why a matched observation changes nothing, when it does not. */
  kept?: string;
  changes: OpenReviewFieldChange[];
  /** Fields to write through upsertPaper; empty when the record already agrees. */
  patch: Partial<AdminBotPaperRecordInput>;
  slotWrites: OpenReviewSlotWrite[];
  /** Feedback requests the submission answered, with the note to close them with. */
  feedbackClosures: Array<{ slot: AdminBotPaperSlot; value_text: string }>;
};

function fingerprintOf(evidence: OpenReviewEvidence, venue: string): string {
  return [
    evidence.submission_id ?? normalizedTitle(evidence.title),
    evidence.status,
    venue,
    evidence.track ?? "",
    evidence.presentation ?? "",
  ].join("|");
}

/**
 * Whether the record's venue is a plan made after this submission, which the sync must not
 * overwrite: a later year, or a later month of the same year. A record naming a different venue
 * of the same year is ambiguous and is treated as a plan too, because overwriting a plan loses
 * work while leaving a stale venue only leaves the card one field behind.
 */
export function isLaterPlan(paperVenue: string | undefined, evidence: OpenReviewEvidence): boolean {
  const planned = (paperVenue ?? "").trim();
  if (!planned || normalizedTitle(planned) === normalizedTitle(venueLabelOf(evidence))) {
    return false;
  }
  const plan = cycleKey({ venue_label: planned });
  const submitted = cycleKey(evidence);
  if (plan < 100 || submitted < 100) {
    return false;
  }
  const [planYear, submittedYear] = [Math.floor(plan / 100), Math.floor(submitted / 100)];
  if (planYear !== submittedYear) {
    return planYear > submittedYear;
  }
  return plan % 100 === 0 || submitted % 100 === 0 || plan % 100 > submitted % 100;
}

/**
 * Whether the record claims an acceptance, as the sheet reads it: a decision of accept, or an
 * accepted venue on a record nobody marked rejected.
 */
function claimsAcceptance(paper: AdminBotPaperRecord): boolean {
  return (
    paper.venue_decision === "accept" ||
    (Boolean(paper.accepted_venue?.trim()) && paper.venue_decision !== "reject")
  );
}

/** Whether the record's acceptance is at this venue: same series, and same year when both say. */
function acceptedAtVenue(paper: AdminBotPaperRecord, label: string): boolean {
  const accepted = paper.accepted_venue ?? "";
  const series = /[a-z]+/u.exec(accepted.toLowerCase())?.[0];
  const year = paper.accepted_year ? String(paper.accepted_year) : String(yearOf(accepted) ?? "");
  const venueYear = String(yearOf(label) ?? "");
  return (
    Boolean(series) &&
    label.toLowerCase().startsWith(series as string) &&
    (!year || !venueYear || year === venueYear)
  );
}

/** The venue name without its year, which is what accepted_venue holds next to accepted_year. */
function venueName(label: string): string {
  return label.replace(/\s*\b20\d{2}\b\s*/gu, " ").trim() || label;
}

/**
 * The submission closes a feedback request made for it: an ARR feedback request filed before the
 * cycle's deadline month ended is about this submission, one filed later is about a revision. A
 * venue commitment is judged by the ARR cycle it was committed from.
 */
function closesFeedbackRequest(
  row: AdminBotPaperSlotRecord,
  evidence: OpenReviewEvidence,
): boolean {
  if (!row.provided_at) {
    return true;
  }
  const key = cycleKey(evidence.arr_venue_id ? { venue_id: evidence.arr_venue_id } : evidence);
  const cutoff =
    key % 100 > 0
      ? new Date(Date.UTC(Math.floor(key / 100), key % 100, 2)).toISOString()
      : evidence.observed_at
        ? new Date(Date.parse(evidence.observed_at) + 86_400_000).toISOString()
        : undefined;
  return cutoff === undefined || row.provided_at <= cutoff;
}

export function planOpenReviewSync(
  paper: AdminBotPaperRecord,
  slots: readonly AdminBotPaperSlotRecord[],
  evidence: OpenReviewEvidence,
  nowIso: string,
): OpenReviewSyncPlan {
  const label = venueLabelOf(evidence);
  const year = yearOf(label) ?? yearOf(evidence.venue_id ?? "");
  const sync: AdminBotPaperOpenReviewSync = {
    fingerprint: fingerprintOf(evidence, label),
    status: evidence.status,
    source: evidence.source,
    venue: label,
    ...(evidence.submission_id ? { submission_id: evidence.submission_id } : {}),
    ...(evidence.observed_at ? { observed_at: evidence.observed_at } : {}),
    ...(evidence.reference ? { reference: evidence.reference } : {}),
    applied_at: nowIso,
  };
  const plan: OpenReviewSyncPlan = {
    sync,
    unchanged: paper.openreview_sync?.fingerprint === sync.fingerprint,
    changes: [],
    patch: {},
    slotWrites: [],
    feedbackClosures: [],
  };
  if (plan.unchanged) {
    return plan;
  }

  const set = <K extends keyof AdminBotPaperRecordInput>(
    field: K,
    to: AdminBotPaperRecordInput[K],
  ) => {
    const from = paper[field];
    if ((from ?? "") === (to ?? "")) {
      return;
    }
    plan.patch[field] = to ?? ("" as AdminBotPaperRecordInput[K]);
    plan.changes.push({ field, from, to: to ?? null });
  };
  const setTrack = (track: string) => {
    const from = paper.artifacts?.publication_track;
    if ((from ?? "") !== track) {
      plan.patch.artifacts = { ...plan.patch.artifacts, publication_track: track };
      plan.changes.push({ field: "artifacts.publication_track", from, to: track });
    }
  };
  const clearAcceptance = () => {
    set("accepted_venue", undefined);
    set("accepted_year", undefined);
  };

  // An acceptance from a later year than this submission is a different, newer outcome.
  const claimed = claimsAcceptance(paper);
  const laterAcceptance =
    claimed &&
    typeof paper.accepted_year === "number" &&
    year !== undefined &&
    paper.accepted_year > year;
  if (laterAcceptance) {
    plan.kept = `accepted in ${paper.accepted_year}, after this ${year} submission`;
    return plan;
  }

  const stored = new Map(slots.map((row) => [row.slot, row]));
  const forum = evidence.submission_id ?? evidence.forums[0];
  const fillSubmission = () => {
    if (!forum) {
      return;
    }
    // Never over a value a person gave or waived: a typed submission page is theirs.
    const page = stored.get("submission");
    if (!page || !isAdminBotPaperSlotSettled(page.status)) {
      plan.slotWrites.push({
        slot: "submission",
        url: `https://openreview.net/forum?id=${forum}`,
        verified_title: evidence.title || undefined,
      });
    }
    const id = stored.get("submission_id");
    if (!id || !isAdminBotPaperSlotSettled(id.status)) {
      plan.slotWrites.push({ slot: "submission_id", value_text: forum });
    }
  };

  switch (evidence.status) {
    case "accepted": {
      set("venue_decision", "accept");
      set("accepted_venue", venueName(label));
      if (year !== undefined) {
        set("accepted_year", year);
      }
      if (evidence.track) {
        setTrack(evidence.track);
      }
      if (evidence.presentation) {
        set("presentation_type", evidence.presentation as AdminBotPaperPresentationType);
      }
      if (!paper.venue?.trim()) {
        set("venue", label);
      }
      fillSubmission();
      break;
    }
    case "under_review": {
      // A venue the record already marks rejected is a past attempt, not a plan to protect.
      if (paper.venue_decision === "reject" || !isLaterPlan(paper.venue, evidence)) {
        set("venue", label);
      }
      // Under review again: an earlier rejection is about a past attempt. An acceptance stands,
      // as on the sheet: a workshop paper sent on to a conference is still accepted at the workshop.
      if (!claimed && paper.venue_decision === "reject") {
        set("venue_decision", "pending");
      }
      fillSubmission();
      for (const row of slots) {
        if (row.slot !== "feedback_arr" || row.status !== "provided" || !row.value_text) {
          continue;
        }
        const feedback = parsePaperFeedback(row.value_text);
        if (feedback && !feedback.reviewed && closesFeedbackRequest(row, evidence)) {
          plan.feedbackClosures.push({
            slot: row.slot,
            value_text: JSON.stringify({
              ...feedback,
              reviewed: true,
              review_note: [feedback.review_note, `Submitted to ${label} (per OpenReview).`]
                .filter(Boolean)
                .join("\n"),
            }),
          });
          plan.changes.push({ field: `${row.slot}.reviewed`, from: false, to: true });
        }
      }
      break;
    }
    default: {
      // Rejected, desk rejected or withdrawn. As on the sheet, only an acceptance claimed at this
      // same venue is withdrawn; one elsewhere stands. A record whose venue already names a later
      // plan is not closed by an older submission's outcome, and a withdrawal closes nothing: it
      // is not a verdict, and the paper usually goes on to another venue.
      if (claimed && !acceptedAtVenue(paper, label)) {
        plan.kept = `accepted at ${paper.accepted_venue}, not ${label}`;
        break;
      }
      const sameSubmission = !isLaterPlan(paper.venue, evidence);
      if (claimed) {
        clearAcceptance();
      }
      if (sameSubmission && evidence.status !== "withdrawn") {
        set("venue_decision", "reject");
        if (!paper.venue?.trim()) {
          set("venue", label);
        }
      } else if (paper.venue_decision === "accept") {
        set("venue_decision", "pending");
      }
      if (!sameSubmission && !plan.changes.length) {
        plan.kept = `the record plans ${paper.venue}, not ${label}`;
      }
      break;
    }
  }
  return plan;
}
