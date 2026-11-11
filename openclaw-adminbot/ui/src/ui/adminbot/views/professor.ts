// The professor's morning page: the things that are hers to do, on one screen.
//
// Everything here is already somewhere else -- the rec-letter queue is on Requests, the adoption
// columns head Profile Completeness and Time Availability. That is the point. Those pages are each
// built for working through one kind of thing, and the question this page answers is the one nobody
// could answer without opening all of them: what is waiting on me.
//
// So it aggregates and links; it does not re-implement. Every section is a count and the few rows
// worth seeing, where each row is itself the way through to the page that does the work and the rest
// of the queue is one press away. No section grows its own editing: that would be a second place to
// do the same job, drifting from the first. Linking harder is not that -- it is the same
// aggregation, reachable.
//
// Two one-click answers are the exception, because they are the answers the PI gives most and the
// paper page made her open a whole workspace to give them: "Submitted" on a rec letter, and
// "Feedback done" / "Approve publication" on a paper. Neither is a second implementation. Each
// calls the same controller and the same endpoint as the page it would otherwise open, and the
// service -- not this page -- decides who may make that write.
//
// Each queue also has a search box, matched by the same function the Requests page's paged search
// uses on the service (contracts/desk-search.ts), so "jane" finds the same letters on both.
//
// The broadcast box at the top is the one exception, and it is not a second place: the composer was
// *moved* here out of Lab Sharing rather than copied, so there is still exactly one surface that
// writes it. It belongs here because it is the only thing on this page that is hers to *author*
// rather than to work through -- every other section is a queue somebody else filled -- and because
// the page it used to live on is the one members read, where an editor only she could see was three
// controls of dead weight for everybody else.
import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import {
  allLettersSubmitted,
  hasImplausibleDeadlineYear,
  isPlausibleDeadlineYear,
  requestDeadlineDetails,
} from "../../../../../extensions/adminbot/logistics-api.js";
import { adminBotLogisticsSettledStatuses } from "../../../../../extensions/adminbot/src/contracts/actions.js";
import {
  letterRequestSearchFields,
  matchesSearch,
  paperReviewSearchFields,
  searchTokens,
} from "../../../../../extensions/adminbot/src/contracts/desk-search.js";
import {
  incompleteProfiles,
  thinTimelines,
  unattendedProjects,
  type DeskAdoptionCounts,
} from "../../../../../extensions/adminbot/src/workflows/members/profile-overview-filter.js";
import { t } from "../../../i18n/index.ts";
import { icons } from "../../icons.ts";
import type { Tab } from "../../navigation.ts";
import type { LabBroadcast } from "../api/lab-sharing.ts";
import type { LogisticsRequest } from "../api/logistics.ts";
import type { MemberProfileOverviewRow } from "../api/members.ts";
import { escalatedNudgeTotal, type EscalatedNudgeRow } from "../api/nudges.ts";
import { piReviewCategoryLabels, type PiReviewRow } from "../api/paper-admin.ts";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";
import { renderDateControl } from "../date-control.ts";
import { historyToggle } from "./history-toggle.ts";

export type ProfessorViewProps = {
  requests: LogisticsRequest[];
  requestsLoading: boolean;
  papers: AdminBotPaperRecord[];
  profiles: MemberProfileOverviewRow[];
  /**
   * The adoption columns' lengths over the whole roster, from the service. `profiles` carries only
   * each column's head, so counting it would stop at twenty. Absent, the rows are counted.
   */
  adoptionCounts?: DeskAdoptionCounts | null;
  /**
   * Nudges the lab already gave up on chasing automatically.
   *
   * The one section here that is not a view onto another page: every other queue links somewhere
   * built for working through it, and this one has nowhere to go, because the next move is her
   * writing to a person. Which is exactly why it never existed -- the escalation pass stamped
   * these every weekday, said them once in Slack, and kept no list.
   */
  escalated: EscalatedNudgeRow[];
  /**
   * Papers whose arXiv package is prepared and which are waiting on her explicit yes.
   *
   * The gate PaperFlow calls GT -- "prepared is not permission". It is here because until now
   * nothing asked her at all: the nudge sweep computed the item and the send path refused to
   * message the head professor, so a prepared paper reached the gate with nobody told. This queue
   * is the asking, and ticking the box is still hers to do on the paper.
   */
  piReview: PiReviewRow[];
  /**
   * What has left that queue: feedback she has given, camera-readies whose conference has been
   * held or whose cycle is past. Not hers to act on, so it is folded away under "History" rather
   * than listed -- but not deleted either, so "what happened to the EMNLP one" has an answer.
   */
  piReviewHistory?: readonly PiReviewRow[];
  onOpenPaper?: (paperId: string) => void;
  piReviewLoading?: boolean;
  piReviewError?: string | null;
  onRetryPiReview?: () => void;
  onOpen: (tab: Tab) => void;
  /**
   * Open one rec-letter request on its own page. Absent, a letter row opens the queue instead.
   * The row is about one student, so landing on the top of forty requests made her find it again.
   */
  onOpenLetterRequest?: (requestId: string) => void;
  /**
   * Row lists open past their preview cap, keyed by list id.
   *
   * Per list rather than per section, because the adoption section is three lists side by side and
   * opening "who has a blank profile" is not a request to open the two columns beside it.
   */
  expanded: ReadonlySet<string>;
  onToggleExpand: (id: string) => void;
  /** The live broadcast, or null when nothing is being said. */
  broadcast: LabBroadcast | null;
  /** The compose box's contents. Undefined means it has not been touched since the page loaded. */
  broadcastDraft?: string;
  broadcastExpiry?: string;
  broadcastAvailability?: string;
  broadcastTimezone?: string;
  broadcastBusy?: boolean;
  broadcastNotice?: { kind: "success" | "error"; text: string } | null;
  onBroadcastDraftChange: (value: string) => void;
  onBroadcastExpiryChange: (value: string) => void;
  onBroadcastAvailabilityChange: (value: string) => void;
  onBroadcastTimezoneChange?: (value: string) => void;
  /** Post what is in the box, or take the current broadcast down with null. */
  onBroadcastPublish: (
    draft: { message: string; availability: string; expiresOn: string; timezone?: string } | null,
  ) => void;
  /** Each queue's search text, keyed by section id ("letters", "pi-review"). */
  search?: Readonly<Record<string, string>>;
  onSearchChange?: (id: string, value: string) => void;
  /**
   * Mark a letter submitted (true) or take that back (false). Absent, the rows carry no button.
   * The write is the admin-only status change the Requests page makes; the service enforces it.
   */
  onLetterSubmitted?: (request: LogisticsRequest, submitted: boolean) => void;
  /** The letter whose status is being written, so only its button is held. */
  letterBusyId?: string | null;
  letterError?: string | null;
  /** Letters marked submitted from this page, with the status each had before, by request id. */
  letterUndo?: Readonly<Record<string, string>>;
  /** Give a paper row's one-click answer. Absent, the rows carry no button. */
  onPaperAction?: (row: PiReviewRow, action: PiReviewQuickAction) => void;
  /** The paper whose slot is being written. */
  paperBusyId?: string | null;
  paperError?: string | null;
};

/** How many rows a section shows before it stops being a summary. */
const PREVIEW_ROWS = 5;

/**
 * How many rows an opened list shows.
 *
 * Opening a list asks for the rest of it, not for all two hundred: past this the page stops being
 * something read top to bottom, and the queue's own page -- which filters and sorts -- is the
 * better answer. So the cap stays, the line under the list says what is still held back, and the
 * link to that page sits right beneath it.
 */
const EXPANDED_ROWS = 20;

/** Steps at or before submission: the window in which reading the draft still changes it. */
const PRE_SUBMISSION_STEPS = new Set(["brainstorming_docs", "overleaf_writing", "submission"]);

const SETTLED = new Set<string>(adminBotLogisticsSettledStatuses);

/**
 * Rec letter requests still waiting on the lab, soonest first.
 *
 * `deadline_at` is derived on write from whichever school row is soonest, so this sorts by the same
 * instant the Requests queue does -- two orderings of one queue is how a letter gets missed.
 */
export function recLetterQueue(
  requests: readonly LogisticsRequest[],
  now: Date = new Date(),
): LogisticsRequest[] {
  return requests
    .filter(
      (request) =>
        request.kind === "recommendation_letters" &&
        !SETTLED.has(request.status) &&
        !allLettersSubmitted(request),
    )
    .map((request) => {
      // Undated or unparseable sorts last, never first: "no deadline" is not the earliest one.
      const ms = Date.parse(letterDeadlineAt(request, now) ?? "");
      return { request, ms: Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY };
    })
    .toSorted((left, right) => (left.ms === right.ms ? 0 : left.ms < right.ms ? -1 : 1))
    .map(({ request }) => request);
}

/**
 * The instant a letter is due, resolved the way the service resolves it.
 *
 * Read from the schools rather than trusted from `deadline_at`, so a legacy deadline typed without
 * a year ("Dec 15") is the next Dec 15 here as well -- `Date.parse` alone files it in 2001. A stamp
 * the schools no longer explain is kept as the fallback rather than dropped.
 */
function letterDeadlineAt(request: LogisticsRequest, now: Date): string | undefined {
  return requestDeadlineDetails(request, { now })?.at ?? plausibleStoredDeadline(request);
}

/**
 * The stored `deadline_at`, unless its year is one no deadline can be in. A request written before
 * the service refused "0002-01-15" still carries that instant; read as a date it put the letter
 * 45,590 days overdue. It is no deadline, and the row asks for the year instead.
 */
function plausibleStoredDeadline(request: LogisticsRequest): string | undefined {
  return isPlausibleDeadlineYear(request.deadline_at) ? request.deadline_at : undefined;
}

/** Whether any date on the request is in a year no deadline can be in: a typo to ask about. */
function letterDeadlineYearLooksWrong(request: LogisticsRequest): boolean {
  return (
    hasImplausibleDeadlineYear(request.deadline_at) ||
    (request.schools ?? []).some((school) => hasImplausibleDeadlineYear(school.letter_deadline))
  );
}

/**
 * Open letter requests whose every school already reports the letter submitted.
 *
 * Nothing is left to write, so they leave the queue even before somebody closes the request; they
 * stay one press away in the letters' history so a status typed in error is still findable.
 */
export function recLettersAlreadyIn(requests: readonly LogisticsRequest[]): LogisticsRequest[] {
  return requests.filter(
    (request) =>
      request.kind === "recommendation_letters" &&
      !SETTLED.has(request.status) &&
      allLettersSubmitted(request),
  );
}

/**
 * How far off a letter is, as the four answers that change what she does about it.
 *
 * A sorted list already put the soonest letter at the top, which is not the same as saying it is
 * late. "2026-02-01" reads as a date whatever today is; "overdue" and "in 3 days" read as an
 * instruction. The names are relative windows rather than months so the section says the same thing
 * in November as it does in June.
 */
export const REC_LETTER_BUCKETS = ["overdue", "week", "month", "later", "undated"] as const;

export type RecLetterBucket = (typeof REC_LETTER_BUCKETS)[number];

/** Days out at which "soon" stops and the rest of the term begins. */
const REC_LETTER_WEEK_DAYS = 7;
const REC_LETTER_MONTH_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type RecLetterDue = {
  request: LogisticsRequest;
  bucket: RecLetterBucket;
  /**
   * Whole days between now and the deadline, negative once it is past.
   *
   * Absent when the request carries no deadline yet, which is a real state and not a zero: a
   * member who has not filled in a school's dates has still asked for the letter.
   */
  daysAway?: number;
  /** The resolved date (yyyy-mm-dd) the countdown is to, in the deadline's own timezone. */
  date?: string;
  /** The member typed only a month and day; the year was filled in as the next occurrence. */
  yearInferred?: boolean;
  /** The only date given is in a year no deadline can be in ("0002"): undated, and ask. */
  checkYear?: boolean;
};

/**
 * The letter queue with each request placed against today.
 *
 * Order is unchanged -- soonest first, undated last -- because it is the same queue the Requests
 * page serves and reordering it here would give the lab two answers to "what is next". The only
 * thing added is where each request falls relative to now, which is what the deadline was for.
 */
export function recLetterDeadlineQueue(
  requests: readonly LogisticsRequest[],
  now: Date = new Date(),
): RecLetterDue[] {
  const nowMs = now.getTime();
  return recLetterQueue(requests, now).map((request): RecLetterDue => {
    const details = requestDeadlineDetails(request, { now });
    const at = details?.at ?? plausibleStoredDeadline(request);
    const deadlineMs = at ? Date.parse(at) : Number.NaN;
    if (!Number.isFinite(deadlineMs)) {
      // An unparseable stamp is treated as no stamp rather than as the epoch, which would file a
      // typo at the top of the overdue list and bury the letters that really are late. A year no
      // deadline can be in is the same kind of typo, and the row says which part to fix.
      return letterDeadlineYearLooksWrong(request)
        ? { request, bucket: "undated", checkYear: true }
        : { request, bucket: "undated" };
    }
    const daysAway = Math.ceil((deadlineMs - nowMs) / DAY_MS);
    const bucket: RecLetterBucket =
      deadlineMs < nowMs
        ? "overdue"
        : daysAway <= REC_LETTER_WEEK_DAYS
          ? "week"
          : daysAway <= REC_LETTER_MONTH_DAYS
            ? "month"
            : "later";
    const due: RecLetterDue = { request, bucket, daysAway };
    if (details) {
      due.date = details.date;
    }
    if (details?.year_inferred) {
      due.yearInferred = true;
    }
    return due;
  });
}

/**
 * The letters one search asks for: "jane" is every open request Jane filed, at whatever school.
 *
 * Filters the bucketed queue rather than the raw requests so a match keeps its place and its
 * countdown -- the answer to "Jane's letters" is still soonest first.
 */
export function filterRecLetters(due: readonly RecLetterDue[], query: string): RecLetterDue[] {
  const tokens = searchTokens(query);
  return tokens.length
    ? due.filter((entry) => matchesSearch(letterRequestSearchFields(entry.request), tokens))
    : [...due];
}

/** The papers one search asks for, by title, author, venue or the kind of feedback asked. */
export function filterPiReview(papers: readonly PiReviewRow[], query: string): PiReviewRow[] {
  const tokens = searchTokens(query);
  return tokens.length
    ? papers.filter((row) => matchesSearch(paperReviewSearchFields(row), tokens))
    : [...papers];
}

/**
 * Letters the PI marked submitted from this page and can still take back.
 *
 * The desk reads open letters only, so a completed one is here only because it was just answered;
 * keeping it in a collapsed list, rather than letting it vanish, is what makes a mis-click
 * recoverable without a trip to the Requests page.
 */
export function recLettersSubmittedHere(
  requests: readonly LogisticsRequest[],
  undo: Readonly<Record<string, string>> | undefined,
): LogisticsRequest[] {
  return requests.filter(
    (request) =>
      request.kind === "recommendation_letters" &&
      request.status === "completed" &&
      Boolean(undo && request.id in undo),
  );
}

/**
 * The one answer a paper row can give in place, or null when the row needs the paper opened.
 *
 * A feedback request not yet reviewed can be marked done -- with no written note, which the paper
 * page still takes. A plain arXiv-release row (nothing else asked of her) can be approved. A
 * proofreading, OpenReview or deadline row is a read, not a yes: when the service handed it an
 * `ackKey` it can be marked reviewed, which puts it in History until something about it changes.
 * A safety-impact row has neither: its answer is given on the paper.
 * The payload is built exactly as the paper page builds it, so the service sees the same write.
 */
export type PiReviewQuickAction =
  | { kind: "feedback"; slot: string; valueText: string }
  | { kind: "approve"; slot: "pi_approval" }
  | { kind: "ack"; key: string; reviewed: boolean };

export function piReviewQuickAction(row: PiReviewRow): PiReviewQuickAction | null {
  const answer = piReviewAnswer(row);
  if (answer) {
    return answer;
  }
  return row.ackKey ? { kind: "ack", key: row.ackKey, reviewed: true } : null;
}

function piReviewAnswer(row: PiReviewRow): PiReviewQuickAction | null {
  if (row.feedback) {
    if (row.feedback.reviewed) {
      return null;
    }
    const { label: _label, slot, ...request } = row.feedback;
    return {
      kind: "feedback",
      slot,
      valueText: JSON.stringify({ ...request, reviewed: true, review_note: "" }),
    };
  }
  if (row.impact || row.proofreading || row.openreview) {
    return null;
  }
  return !row.category || row.category === "arxiv_release"
    ? { kind: "approve", slot: "pi_approval" }
    : null;
}

export type RecLetterGroup = {
  bucket: RecLetterBucket;
  /** Everything in the bucket, which is not the same as everything drawn: see `rows`. */
  total: number;
  /** The slice this section has room for, already taken from the front of the whole queue. */
  rows: RecLetterDue[];
};

/**
 * The queue as buckets, capped as one list rather than bucket by bucket.
 *
 * The cap is taken across the whole queue before grouping, so a term with eleven letters due next
 * month cannot push an overdue one off the screen, and `total` still reports the real size of each
 * bucket -- a heading that said "3" while listing 3 of 11 would be the lie the cap exists to avoid.
 * Empty buckets are dropped: "Overdue 0" is a row of furniture, and the count above the section
 * already says when there is nothing at all.
 */
export function recLetterGroups(
  due: readonly RecLetterDue[],
  limit = PREVIEW_ROWS,
): RecLetterGroup[] {
  const shown = due.slice(0, limit);
  return REC_LETTER_BUCKETS.map((bucket) => ({
    bucket,
    total: due.filter((entry) => entry.bucket === bucket).length,
    rows: shown.filter((entry) => entry.bucket === bucket),
  })).filter((group) => group.total > 0);
}

/** "in 3 days" / "2 days ago" / "today", or nothing at all when there is no deadline to describe. */
export function recLetterDueLabel(due: RecLetterDue): string {
  if (due.checkYear) {
    return t("professor.letters.due.checkYear");
  }
  if (due.daysAway === undefined) {
    return t("professor.letters.due.none");
  }
  if (due.daysAway === 0) {
    return t("professor.letters.due.today");
  }
  return due.daysAway > 0
    ? t("professor.letters.due.in", { count: String(due.daysAway) })
    : t("professor.letters.due.ago", { count: String(-due.daysAway) });
}

export type OverleafRead = {
  paper: AdminBotPaperRecord;
  url: string;
  deadline: string;
};

/**
 * Drafts that are readable and not yet submitted.
 *
 * A link and a deadline, because those are the two facts that decide whether to open it now. A
 * paper past submission is excluded: reading it then is a different, slower kind of useful, and
 * mixing the two makes the urgent half unreadable.
 */
export function overleafReadingQueue(papers: readonly AdminBotPaperRecord[]): OverleafRead[] {
  return papers
    .flatMap((paper) => {
      const url =
        paper.artifacts?.overleaf_edit_url?.trim() || paper.artifacts?.overleaf_view_url?.trim();
      if (!url || !PRE_SUBMISSION_STEPS.has(paper.current_step)) {
        return [];
      }
      return [{ paper, url, deadline: paper.deadline?.trim() ?? "" }];
    })
    .toSorted(
      (left, right) =>
        (left.deadline || "9999").localeCompare(right.deadline || "9999") ||
        left.paper.title.localeCompare(right.paper.title),
    );
}

// The adoption columns' membership and order live with the service, which sends the desk only
// each column's head; re-exported so this page and its tests keep importing them from here.
export {
  adoptionCandidates,
  incompleteProfiles,
  thinTimelines,
  unattendedProjects,
} from "../../../../../extensions/adminbot/src/workflows/members/profile-overview-filter.js";

type AdoptionColumn = {
  id: "profile" | "timeline" | "papers";
  label: string;
  rows: MemberProfileOverviewRow[];
  /** The column's length over the whole roster; `rows` is its head. */
  total: number;
  detail: (row: MemberProfileOverviewRow) => string;
};

/**
 * The three columns, with the settled ones last.
 *
 * A column nobody has to act on is still worth showing -- it is how you see that the answer is
 * "nobody" rather than "not loaded yet" -- but it should not sit between two columns that do need
 * work.
 */
export function adoptionColumns(
  profiles: readonly MemberProfileOverviewRow[],
  counts?: DeskAdoptionCounts | null,
): AdoptionColumn[] {
  const columns: Array<Omit<AdoptionColumn, "total">> = [
    {
      id: "profile",
      label: t("professor.adoption.column.profile"),
      rows: incompleteProfiles(profiles),
      detail: (row) =>
        t("professor.adoption.missing", { count: String(row.missing_fields.length) }),
    },
    {
      id: "timeline",
      label: t("professor.adoption.column.timeline"),
      rows: thinTimelines(profiles),
      detail: (row) => t("professor.adoption.entries", { count: String(row.timeline.total) }),
    },
    {
      id: "papers",
      label: t("professor.adoption.column.papers"),
      rows: unattendedProjects(profiles),
      detail: (row) =>
        t("professor.adoption.papersDetail", {
          count: String(row.projects.total - row.projects.self_updated),
          total: String(row.projects.total),
        }),
    },
  ];
  // The service's counts when it sent them: the rows are only each column's head.
  return columns
    .map((column) => ({ ...column, total: counts?.[column.id] ?? column.rows.length }))
    .toSorted((left, right) => Number(!left.total) - Number(!right.total));
}

function section(params: {
  id: string;
  title: string;
  /**
   * One line saying what this queue is *for*.
   *
   * Three of these sections are "a list of papers with your name against them", and the titles
   * alone did not say which question each was asking -- approve the finished thing, read the
   * unfinished thing, or go and ask somebody for something. Which one you are looking at decides
   * whether you open it now, so it is worth a line rather than left to be inferred from the rows.
   */
  blurb?: string;
  count: number | null;
  tab: Tab;
  linkLabel: string;
  onOpen: (tab: Tab) => void;
  body: unknown;
}) {
  return html`
    <section
      class="professor__section"
      data-testid=${`professor-${params.id}`}
      data-section=${params.id}
    >
      <div class="professor__head">
        <div class="card-title">${params.title}</div>
        <span class="professor__count ab-num" data-empty=${params.count === 0 ? "true" : "false"}
          >${params.count ?? "—"}</span
        >
      </div>
      ${params.blurb ? html`<p class="professor__blurb">${params.blurb}</p>` : nothing}
      ${params.body}
      <button
        class="btn btn--sm btn--ghost professor__open"
        type="button"
        data-testid=${`professor-open-${params.id}`}
        @click=${() => params.onOpen(params.tab)}
      >
        ${params.linkLabel}
        <span aria-hidden="true">${icons.chevronRight}</span>
      </button>
    </section>
  `;
}

/**
 * One row, drawn as the control it already looked like.
 *
 * Every row here is about something -- a request, a paper, a person -- and what you want on seeing
 * it is that thing, not the top of the queue it came out of. So the row is the button and the
 * footer link is the fallback, where before the footer link was the only way off the page and the
 * five rows above it were decoration.
 *
 * `action` is the section's own "open" label said again for a screen reader: the visible row is
 * facts, and facts do not say that pressing them goes anywhere. `aside` is for a row with a second,
 * different destination -- it sits outside the button, because a link inside a button is reachable
 * by neither.
 */
function rowButton(params: { action: string; onOpen: () => void; body: unknown; aside?: unknown }) {
  return html`<li>
    <button class="professor__row" type="button" @click=${params.onOpen}>
      <span class="professor__row-body">${params.body}</span>
      <span class="sr-only">${params.action}</span>
      <span class="professor__row-go" aria-hidden="true">${icons.chevronRight}</span>
    </button>
    ${params.aside ?? nothing}
  </li>`;
}

/** A row whose subject lives outside AdminBot, so the whole row is the link out to it. */
function rowLink(params: { href: string; body: unknown }) {
  return html`<li>
    <a class="professor__row" href=${params.href} target="_blank" rel="noreferrer noopener">
      <span class="professor__row-body">${params.body}</span>
      <span class="sr-only">${t("professor.newTab")}</span>
      <span class="professor__row-go" aria-hidden="true">${icons.externalLink}</span>
    </a>
  </li>`;
}

/**
 * The line that used to read "+3 more", which looked like a control and was not one.
 *
 * Now it is the one it was imitating: pressing it opens the rest of the list where it already is,
 * which is what somebody reaching for it wanted -- those rows, here, clickable -- and not a trip to
 * another page to go and find them. Keyboard users reach it at all for the first time; as a muted
 * `<li>` it sat outside the tab order, and a screen reader read it as one more row of the queue.
 *
 * When an opened list is still holding rows back the button says "Show fewer" and the note beside it
 * says how many of how many are drawn: a list that quietly stops at twenty of forty-three would be
 * the same lie the bucket counts are careful not to tell.
 */
function moreToggle(params: {
  id: string;
  controls: string;
  open: boolean;
  shown: number;
  hidden: number;
  total: number;
  onToggleExpand: (id: string) => void;
}) {
  return html`<div class="professor__more">
    <button
      class="professor__more-btn"
      type="button"
      aria-expanded=${params.open ? "true" : "false"}
      aria-controls=${params.controls}
      data-testid=${`professor-more-${params.id}`}
      @click=${() => params.onToggleExpand(params.id)}
    >
      <span class="professor__more-chevron" aria-hidden="true"
        >${params.open ? icons.chevronDown : icons.chevronRight}</span
      >
      ${params.open
        ? t("professor.showFewer")
        : t("professor.showMore", { count: String(params.hidden) })}
    </button>
    ${params.open && params.hidden > 0
      ? html`<span class="professor__more-note muted"
          >${t("professor.showing", {
            shown: String(params.shown),
            total: String(params.total),
          })}</span
        >`
      : nothing}
  </div>`;
}

function rows(params: {
  id: string;
  items: unknown[];
  /** The whole list's size when only a page of it was read; the items' count otherwise. */
  total?: number;
  empty: string;
  expanded: ReadonlySet<string>;
  onToggleExpand: (id: string) => void;
}) {
  if (!params.items.length) {
    // An empty message of "" is a list a search emptied; the search's own line already said so.
    return params.empty ? html`<p class="professor__empty">${params.empty}</p>` : nothing;
  }
  const open = params.expanded.has(params.id);
  const shown = params.items.slice(0, open ? EXPANDED_ROWS : PREVIEW_ROWS);
  const listId = `professor-list-${params.id}`;
  const total = Math.max(params.total ?? 0, params.items.length);
  return html`<ul id=${listId} class="professor__list" data-open=${open ? "true" : "false"}>
      ${shown}
    </ul>
    ${total > PREVIEW_ROWS
      ? moreToggle({
          id: params.id,
          controls: listId,
          open,
          shown: shown.length,
          hidden: total - shown.length,
          total,
          onToggleExpand: params.onToggleExpand,
        })
      : nothing}`;
}

/**
 * A queue's search box. Typing filters the rows already on the page; nothing is fetched.
 *
 * `type="search"` gives the browser's own clear affordance and Escape-to-clear; the visible label
 * is the placeholder plus an accessible name, because a labelled field above every queue would
 * cost a line per section on a page that is read top to bottom.
 */
function searchBox(params: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onSearchChange?: (id: string, value: string) => void;
}) {
  if (!params.onSearchChange) {
    return nothing;
  }
  const onSearchChange = params.onSearchChange;
  return html`<div class="professor__search">
    <input
      class="professor__search-input"
      type="search"
      data-testid=${`professor-search-${params.id}`}
      aria-label=${params.label}
      placeholder=${params.placeholder}
      .value=${live(params.value)}
      @input=${(event: Event) =>
        onSearchChange(params.id, (event.target as HTMLInputElement).value)}
    />
  </div>`;
}

/** "3 open requests matching “jane”", or that nothing does. Said only while a search is typed. */
function searchSummary(params: { query: string; count: number; matches: string }) {
  if (!params.query.trim()) {
    return nothing;
  }
  return html`<p
    class="professor__search-summary"
    role="status"
    data-testid="professor-search-summary"
  >
    ${params.count ? params.matches : t("professor.search.noMatch", { query: params.query.trim() })}
  </p>`;
}

/**
 * A row's one-click answer, sat beside the row rather than in it -- the row is already a button
 * that opens the thing, and a button inside a button is reachable by neither.
 */
function rowAction(params: {
  testId: string;
  label: string;
  busyLabel: string;
  title?: string;
  ariaLabel?: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return html`<button
    class="btn btn--sm professor__row-action"
    type="button"
    data-testid=${params.testId}
    title=${params.title ?? nothing}
    aria-label=${params.ariaLabel ?? nothing}
    ?disabled=${params.disabled}
    @click=${params.onClick}
  >
    ${params.busy ? params.busyLabel : params.label}
  </button>`;
}

/**
 * Where a letter is going, by name when the names are short enough to read on one line.
 *
 * A search for one student lists all of her requests, and three rows each saying "2 school(s)"
 * cannot be told apart; the school names can. Past three the count says the rest.
 */
function letterSchoolsText(request: LogisticsRequest): string {
  const names = (request.schools ?? [])
    .map((school) => school.school?.trim() ?? "")
    .filter(Boolean);
  if (!names.length) {
    return t("professor.letters.schools", { count: String(request.schools?.length ?? 0) });
  }
  return names.length > 3
    ? `${names.slice(0, 3).join(", ")} +${names.length - 3}`
    : names.join(", ");
}

/**
 * The letter queue drawn as its deadline buckets.
 *
 * Every row still names the member and how many schools are on the request -- that has not changed,
 * and it is what decides how long the letter takes to write. What is new is the heading it sits
 * under and the relative date beside it, so "Overdue" is answerable at a glance instead of being
 * something she works out from four ISO dates.
 */
/** One letter's own request when the page can open it, else the queue it sits in. */
function openLetter(
  props: Pick<ProfessorViewProps, "onOpen" | "onOpenLetterRequest">,
  requestId: string,
) {
  if (props.onOpenLetterRequest) {
    props.onOpenLetterRequest(requestId);
    return;
  }
  props.onOpen("adminbotRecLetters");
}

function letterBody(
  due: readonly RecLetterDue[],
  props: Pick<
    ProfessorViewProps,
    | "onOpen"
    | "onOpenLetterRequest"
    | "expanded"
    | "onToggleExpand"
    | "onLetterSubmitted"
    | "letterBusyId"
    | "letterUndo"
    | "requests"
  >,
  searching = false,
) {
  if (!due.length) {
    return searching
      ? nothing
      : html`<p class="professor__empty">${t("professor.letters.empty")}</p>`;
  }
  // One switch for the whole section rather than one per bucket: the cap is taken across the queue
  // before grouping, so "the rest of it" is a fact about the queue and not about "Next 30 days".
  // A search is a request to see every match, so it opens the list as far as it ever opens.
  const open = searching || props.expanded.has("letters");
  const busyId = props.letterBusyId ?? null;
  const groups = recLetterGroups(due, open ? EXPANDED_ROWS : PREVIEW_ROWS);
  const shown = groups.reduce((sum, group) => sum + group.rows.length, 0);
  return html`<div
      class="professor__buckets"
      id="professor-list-letters"
      data-open=${open ? "true" : "false"}
    >
      ${groups.map(
        (group) => html`<div
          class="professor__bucket"
          data-testid=${`professor-letters-${group.bucket}`}
          data-bucket=${group.bucket}
        >
          <div class="professor__column-head">
            <span>${t(`professor.letters.bucket.${group.bucket}`)}</span>
            <span class="ab-num">${group.total}</span>
          </div>
          ${group.rows.length
            ? html`<ul class="professor__list">
                ${group.rows.map((entry) =>
                  rowButton({
                    action: t("professor.letters.open"),
                    onOpen: () => openLetter(props, entry.request.id),
                    body: html`<strong>${entry.request.member_name}</strong>
                      <span class="muted"
                        >${entry.request.schools?.length
                          ? letterSchoolsText(entry.request)
                          : t("professor.letters.noSchools")}</span
                      >
                      <span class="professor__when" data-testid="professor-letter-when"
                        >${recLetterDueLabel(entry)}${entry.date
                          ? html` ·
                            ${entry.date}${entry.yearInferred
                              ? html` <span
                                  class="muted"
                                  data-testid="professor-letter-year-assumed"
                                  >(${t("professor.letters.yearAssumed")})</span
                                >`
                              : nothing}`
                          : nothing}</span
                      >`,
                    aside: props.onLetterSubmitted
                      ? rowAction({
                          testId: "professor-letter-submitted",
                          label: t("professor.letters.submit"),
                          busyLabel: t("professor.letters.saving"),
                          ariaLabel: t("professor.letters.submitFor", {
                            name: entry.request.member_name,
                          }),
                          busy: busyId === entry.request.id,
                          disabled: busyId !== null,
                          onClick: () => props.onLetterSubmitted?.(entry.request, true),
                        })
                      : undefined,
                  }),
                )}
              </ul>`
            : nothing}
        </div>`,
      )}
    </div>
    ${due.length > PREVIEW_ROWS && !searching
      ? moreToggle({
          id: "letters",
          controls: "professor-list-letters",
          open,
          shown,
          hidden: due.length - shown,
          total: due.length,
          onToggleExpand: props.onToggleExpand,
        })
      : nothing}`;
}

/**
 * Open requests whose letters are all in, behind the letters' history fold. Read-only: they are
 * resolved by the schools' statuses, which the Requests page owns.
 */
function lettersAlreadyInList(
  requests: readonly LogisticsRequest[],
  props: Pick<ProfessorViewProps, "onOpen" | "onOpenLetterRequest">,
) {
  return historyToggle({
    testId: "professor-letters-history",
    className: "professor__done",
    listClassName: "professor__list",
    label: t("professor.letters.history.title", { count: String(requests.length) }),
    items: requests.map(
      (request) => html`<span
        class="professor__row-body professor__done-row"
        data-testid="professor-letter-history-row"
      >
        <strong>${request.member_name}</strong>
        <span class="muted">${letterSchoolsText(request)}</span>
        <span>${t("professor.letters.history.allSubmitted")}</span>
        <button type="button" class="btn btn--sm" @click=${() => openLetter(props, request.id)}>
          ${t("professor.letters.open")}
        </button>
      </span>`,
    ),
  });
}

/**
 * Letters marked submitted from this page, folded away under one line.
 *
 * Out of the open queue -- that is the point of answering them -- but not gone: the undo puts each
 * back to the status it had, which is the only safe thing for a one-click write to offer.
 */
function letterDoneList(
  done: readonly LogisticsRequest[],
  props: Pick<ProfessorViewProps, "onLetterSubmitted" | "letterBusyId">,
) {
  if (!done.length || !props.onLetterSubmitted) {
    return nothing;
  }
  const busyId = props.letterBusyId ?? null;
  return html`<details class="professor__done" data-testid="professor-letters-done">
    <summary>${t("professor.letters.done.title", { count: String(done.length) })}</summary>
    <ul class="professor__list">
      ${done.map(
        (request) => html`<li>
          <span class="professor__row-body professor__done-row">
            <strong>${request.member_name}</strong>
            <span class="muted">${letterSchoolsText(request)}</span>
          </span>
          ${rowAction({
            testId: "professor-letter-undo",
            label: t("professor.letters.done.undo"),
            busyLabel: t("professor.letters.saving"),
            busy: busyId === request.id,
            disabled: busyId !== null,
            onClick: () => props.onLetterSubmitted?.(request, false),
          })}
        </li>`,
      )}
    </ul>
  </details>`;
}

function adoptionBody(
  profiles: readonly MemberProfileOverviewRow[],
  props: Pick<ProfessorViewProps, "onOpen" | "expanded" | "onToggleExpand" | "adoptionCounts">,
) {
  return html`<details class="professor__fold" data-testid="professor-fold-adoption">
    <summary>${t("professor.adoption.show")}</summary>
    <div class="professor__columns">
      ${adoptionColumns(profiles, props.adoptionCounts).map(
        (column) => html`<div
          class="professor__column"
          data-testid=${`professor-adoption-${column.id}`}
          data-empty=${column.total === 0 ? "true" : "false"}
        >
          <div class="professor__column-head">
            <span>${column.label}</span>
            <span class="ab-num">${column.total}</span>
          </div>
          ${rows({
            id: `adoption-${column.id}`,
            total: column.total,
            items: column.rows.map((row) =>
              rowButton({
                action: t("professor.adoption.open"),
                onOpen: () => props.onOpen("adminbotProfileOverview"),
                body: html`<strong>${row.name}</strong>
                  <span class="muted">${column.detail(row)}</span>`,
              }),
            ),
            empty: t("professor.adoption.empty"),
            expanded: props.expanded,
            onToggleExpand: props.onToggleExpand,
          })}
        </div>`,
      )}
    </div>
  </details>`;
}

const AVAILABILITY_CHOICES = ["away", "busy", "available", "unknown"] as const;

/**
 * The box she types the lab's broadcast into.
 *
 * A plain textarea and a post button, not a form: the thing being written is one paragraph of
 * prose, and the three-field dialog it replaces asked for an availability enum and an RFC3339
 * expiry before it would take a sentence.
 *
 * The box starts holding whatever is live, so the common edit -- "same message, one date changed"
 * -- is a correction rather than a retype, and posting replaces rather than appends. `undefined`
 * rather than `""` is the untouched sentinel, because an empty box is a real state: it is what
 * clearing leaves behind, and it must not silently refill itself from the broadcast just taken down.
 *
 * No confirm step. Posting is one click and so is taking it back down, the text is visible in the
 * box before either, and the alternative -- a modal between her and a sentence she rewrites weekly
 * -- is the kind of friction that gets routed around by not using the feature.
 */
function broadcastBox(props: ProfessorViewProps) {
  const liveBroadcast = props.broadcast;
  const draft = props.broadcastDraft ?? liveBroadcast?.message ?? "";
  const expiresOn =
    props.broadcastExpiry ??
    (liveBroadcast ? liveBroadcast.expires_at.slice(0, 10) : defaultExpiryDate());
  const availability = props.broadcastAvailability ?? liveBroadcast?.availability ?? "away";
  const timezone = props.broadcastTimezone ?? liveBroadcast?.timezone ?? "";
  const busy = Boolean(props.broadcastBusy);
  const dirty =
    draft.trim() !== (liveBroadcast?.message ?? "").trim() ||
    availability !== liveBroadcast?.availability ||
    timezone.trim() !== (liveBroadcast?.timezone ?? "");

  // Folded to one line by default: the live sentence and its end date are what she needs to see on
  // arrival, and the compose box is a weekly errand. It opens itself while there is something to
  // finish -- an edit not yet posted, or the result of the last post.
  const startOpen = Boolean(props.broadcastNotice) || (props.broadcastDraft !== undefined && dirty);
  return html`
    <details
      class="professor__section professor__broadcast"
      data-testid="professor-broadcast"
      ?open=${startOpen}
    >
      <summary class="professor__broadcast-bar">
        <span class="professor__broadcast-label">${t("professor.broadcast.title")}</span>
        <span class="professor__broadcast-live" data-testid="professor-broadcast-live"
          >${liveBroadcast
            ? liveBroadcast.message
            : html`<span class="muted">${t("professor.broadcast.none")}</span>`}</span
        >
        ${liveBroadcast
          ? html`<span class="professor__when" data-testid="professor-broadcast-until"
              >${t("professor.broadcast.until", {
                date: liveBroadcast.expires_at.slice(0, 10),
              })}</span
            >`
          : nothing}
        <span class="professor__broadcast-edit"
          >${liveBroadcast ? t("professor.broadcast.edit") : t("professor.broadcast.write")}</span
        >
      </summary>

      <p class="professor__empty">${t("professor.broadcast.hint")}</p>

      <textarea
        class="professor__broadcast-box"
        data-testid="professor-broadcast-text"
        rows="4"
        maxlength="500"
        .value=${draft}
        placeholder=${t("professor.broadcast.placeholder")}
        ?disabled=${busy}
        @input=${(event: Event) =>
          props.onBroadcastDraftChange((event.target as HTMLTextAreaElement).value)}
      ></textarea>

      <div class="professor__broadcast-controls">
        <label class="professor__broadcast-field">
          <span>${t("professor.broadcast.showsUntil")}</span>
          ${renderDateControl(
            html`<input
              type="date"
              data-testid="professor-broadcast-expiry"
              .value=${live(expiresOn)}
              ?disabled=${busy}
              @input=${(event: Event) =>
                props.onBroadcastExpiryChange((event.target as HTMLInputElement).value)}
            />`,
            expiresOn,
          )}
        </label>
        <label class="professor__broadcast-field">
          <span>${t("professor.broadcast.availability")}</span>
          <select
            data-testid="professor-broadcast-availability"
            ?disabled=${busy}
            @change=${(event: Event) =>
              props.onBroadcastAvailabilityChange((event.target as HTMLSelectElement).value)}
          >
            ${AVAILABILITY_CHOICES.map(
              (value) =>
                html`<option value=${value} ?selected=${value === availability}>
                  ${t(`professor.broadcast.availability_${value}`)}
                </option>`,
            )}
          </select>
        </label>
        <label class="professor__broadcast-field">
          <span>${t("professor.broadcast.timezone")}</span>
          <input
            type="text"
            data-testid="professor-broadcast-timezone"
            .value=${timezone}
            placeholder="America/Toronto"
            ?disabled=${busy}
            @input=${(event: Event) =>
              props.onBroadcastTimezoneChange?.((event.target as HTMLInputElement).value)}
          />
        </label>
        <div class="professor__broadcast-actions">
          <button
            class="btn btn--sm primary"
            type="button"
            data-testid="professor-broadcast-post"
            ?disabled=${busy ||
            !draft.trim() ||
            (!dirty && !!liveBroadcast && expiresOn === liveBroadcast.expires_at.slice(0, 10))}
            @click=${() =>
              props.onBroadcastPublish({
                message: draft,
                availability,
                expiresOn,
                ...(timezone.trim() ? { timezone: timezone.trim() } : {}),
              })}
          >
            ${liveBroadcast ? t("professor.broadcast.update") : t("professor.broadcast.post")}
          </button>
          ${liveBroadcast
            ? html`<button
                class="btn btn--sm"
                type="button"
                data-testid="professor-broadcast-clear"
                ?disabled=${busy}
                @click=${() => props.onBroadcastPublish(null)}
              >
                ${t("professor.broadcast.takeDown")}
              </button>`
            : nothing}
        </div>
      </div>

      ${props.broadcastNotice
        ? html`<p
            class=${`professor__broadcast-notice professor__broadcast-notice--${props.broadcastNotice.kind}`}
            role=${props.broadcastNotice.kind === "error" ? "alert" : "status"}
            data-testid="professor-broadcast-notice"
          >
            ${props.broadcastNotice.text}
          </p>`
        : nothing}
    </details>
  `;
}

/** A week out, which is the span "broadcast from Zhijing for this week" actually means. */
/**
 * A row's hard deadline with how long is left, so the urgency is the first thing read: "Due Nov
 * 27, 2026 -- 23 days left", or how far past it is.
 */
export function renderHardDeadline(row: Pick<PiReviewRow, "hardDeadline" | "daysLeft">) {
  if (!row.hardDeadline) {
    return nothing;
  }
  const date = new Date(row.hardDeadline).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZoneName: "short",
  });
  const days = row.daysLeft;
  const left =
    days === undefined
      ? ""
      : days < 0
        ? ` — ${-days} day${days === -1 ? "" : "s"} overdue`
        : days === 0
          ? " — due today"
          : ` — ${days} day${days === 1 ? "" : "s"} left`;
  return html`<strong data-testid="pi-review-hard-deadline">Due ${date}${left}</strong>`;
}

/** Undo on a row she marked reviewed from the desk; other history rows have nothing to undo. */
function historyUndo(
  row: PiReviewRow,
  onPaperAction: ProfessorViewProps["onPaperAction"],
  busyId: string | null,
) {
  const key = row.ackKey;
  if (row.historyReason !== "reviewed" || !key || !onPaperAction) {
    return nothing;
  }
  return html`<button
    type="button"
    class="btn btn--sm"
    data-testid="pi-review-history-undo"
    ?disabled=${busyId !== null}
    @click=${() => onPaperAction(row, { kind: "ack", key, reviewed: false })}
  >
    ${busyId === key ? t("professor.piReview.saving") : t("professor.piReview.undoReviewed")}
  </button>`;
}

/**
 * The PI queue's history, folded: one read-only line per row that left the queue, with why it
 * left. A search narrows it with the same match the open queue uses, so "emnlp" finds the held
 * camera-ready in history as well as anything still open.
 */
function piReviewHistoryList(
  history: readonly PiReviewRow[],
  query: string,
  props: Pick<ProfessorViewProps, "onOpenPaper" | "onOpen" | "onPaperAction" | "paperBusyId">,
) {
  const shown = filterPiReview(history, query);
  const busyId = props.paperBusyId ?? null;
  return historyToggle({
    testId: "professor-pi-review-history",
    className: "professor__done",
    listClassName: "professor__list",
    label: t("professor.piReview.history.title", { count: String(shown.length) }),
    items: shown.map(
      (row) => html`<span
        class="professor__row-body professor__done-row"
        data-testid="pi-review-history-row"
      >
        ${row.category
          ? html`<span class="pill">${piReviewCategoryLabels[row.category]}</span>`
          : nothing}
        <strong>${row.title}</strong>
        ${row.venue ? html`<span class="muted">${row.venue}</span>` : nothing}
        ${row.historyReason
          ? html`<span data-testid="pi-review-history-reason"
              >${t(`professor.piReview.history.reason.${row.historyReason}`)}</span
            >`
          : nothing}
        ${row.hardDeadline || row.feedback?.hard_deadline
          ? html`<span class="professor__when"
              >${t("professor.piReview.history.due", {
                date: (row.hardDeadline ?? row.feedback?.hard_deadline ?? "").slice(0, 10),
              })}</span
            >`
          : nothing}
        ${historyUndo(row, props.onPaperAction, busyId)}
        <button
          type="button"
          class="btn btn--sm"
          @click=${() =>
            props.onOpenPaper ? props.onOpenPaper(row.paperId) : props.onOpen("adminbotPapers")}
        >
          ${t("professor.piReview.history.open")}
        </button>
      </span>`,
    ),
  });
}

/** The paper row's one-click answer, when it has one and the page was given a way to send it. */
function paperActionButton(
  row: PiReviewRow,
  props: Pick<ProfessorViewProps, "onPaperAction">,
  busyId: string | null,
) {
  const action = props.onPaperAction ? piReviewQuickAction(row) : null;
  if (!action) {
    return nothing;
  }
  const ack = action.kind === "ack";
  return rowAction({
    testId: ack
      ? "professor-paper-reviewed"
      : action.kind === "feedback"
        ? "professor-paper-feedback-done"
        : "professor-paper-approve",
    label: ack
      ? t("professor.piReview.reviewed")
      : action.kind === "feedback"
        ? t("professor.piReview.feedbackDone")
        : t("professor.piReview.approve"),
    busyLabel: t("professor.piReview.saving"),
    title: ack ? t("professor.piReview.reviewedHint") : t("professor.piReview.actionHint"),
    busy: busyId === (ack ? action.key : row.paperId),
    disabled: busyId !== null,
    onClick: () => props.onPaperAction?.(row, action),
  });
}

/**
 * The page's first line: each queue with something in it, as a jump to that section.
 *
 * Five sections stacked is a long page, and what she wants on arrival is "how much is there and
 * where" -- answered before the first scroll, in the same order the sections below are in.
 */
function summaryStrip(sections: ReadonlyArray<{ id: string; count: number | null }>) {
  const waiting = sections.filter((entry) => entry.count);
  const jump = (event: Event, id: string) => {
    (event.currentTarget as HTMLElement)
      .closest(".professor")
      ?.querySelector(`[data-section="${id}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return html`<nav
    class="professor__summary"
    data-testid="professor-summary"
    aria-label=${t("professor.summary.label")}
  >
    ${waiting.length
      ? waiting.map(
          (entry) => html`<button
            type="button"
            class="professor__jump"
            data-testid=${`professor-jump-${entry.id}`}
            @click=${(event: Event) => jump(event, entry.id)}
          >
            <span class="ab-num">${entry.count}</span>
            ${t(`professor.summary.${entry.id}`)}
          </button>`,
        )
      : html`<span class="muted">${t("professor.summary.clear")}</span>`}
  </nav>`;
}

function defaultExpiryDate(now = new Date()): string {
  return new Date(now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
}

export function renderProfessorView(props: ProfessorViewProps) {
  const letters = recLetterDeadlineQueue(props.requests);
  const letterQuery = props.search?.letters ?? "";
  const shownLetters = filterRecLetters(letters, letterQuery);
  const lettersDone = recLettersSubmittedHere(props.requests, props.letterUndo);
  const lettersIn = recLettersAlreadyIn(props.requests);
  const paperQuery = props.search?.["pi-review"] ?? "";
  const shownPapers = filterPiReview(props.piReview, paperQuery);
  const searchingPapers = searchTokens(paperQuery).length > 0;
  const paperBusyId = props.paperBusyId ?? null;
  const drafts = overleafReadingQueue(props.papers);
  // Somebody short on two counts is still one person to remind, so the headline number is people,
  // not rows.
  const toRemind =
    props.adoptionCounts?.people ??
    new Set(adoptionColumns(props.profiles).flatMap((column) => column.rows.map((row) => row.id)))
      .size;

  const sections: Array<{
    id: string;
    count: number | null;
    settled: boolean;
    /** Fixed at the foot of the page, in this order, whatever is in it. */
    pinned?: number;
    body: unknown;
  }> = [
    {
      id: "pi-review",
      count: props.piReviewLoading || props.piReviewError ? null : props.piReview.length,
      settled: !props.piReviewLoading && !props.piReviewError && props.piReview.length === 0,
      body: section({
        id: "pi-review",
        title: t("professor.piReview.title"),
        blurb: t("professor.piReview.blurb"),
        count: props.piReviewLoading || props.piReviewError ? null : props.piReview.length,
        // The paper card is where the yes is given, so that is where this points.
        tab: "adminbotPapers",
        linkLabel: t("professor.piReview.open"),
        onOpen: props.onOpen,
        body: props.piReviewLoading
          ? html`<p role="status">Loading PI review queue…</p>`
          : props.piReviewError
            ? html`<p role="alert">
                  Could not load the PI review queue. Approval status is unknown.
                  ${props.piReviewError}
                </p>
                <button class="btn btn--sm" type="button" @click=${props.onRetryPiReview}>
                  Retry PI review queue
                </button>`
            : html`${searchBox({
                id: "pi-review",
                label: t("professor.piReview.searchLabel"),
                placeholder: t("professor.piReview.searchPlaceholder"),
                value: paperQuery,
                onSearchChange:
                  props.piReview.length || paperQuery ? props.onSearchChange : undefined,
              })}
              ${searchSummary({
                query: paperQuery,
                count: shownPapers.length,
                matches: t("professor.piReview.matches", {
                  count: String(shownPapers.length),
                  query: paperQuery.trim(),
                }),
              })}
              ${props.paperError
                ? html`<p class="professor__error" role="alert" data-testid="professor-paper-error">
                    ${props.paperError}
                  </p>`
                : nothing}
              ${rows({
                id: "pi-review",
                // A search asks for every match, so it opens the list as far as a list opens.
                expanded: searchingPapers
                  ? new Set([...props.expanded, "pi-review"])
                  : props.expanded,
                items: shownPapers.map((row) =>
                  rowButton({
                    action: t("professor.piReview.open"),
                    onOpen: () =>
                      props.onOpenPaper
                        ? props.onOpenPaper(row.paperId)
                        : props.onOpen("adminbotPapers"),
                    body: html`${row.category
                        ? html`<span class="pill" data-testid="pi-review-category"
                            >${piReviewCategoryLabels[row.category]}</span
                          >`
                        : nothing}
                      <strong>${row.title}</strong>
                      <span class="muted">${row.authors.join(", ")}</span>
                      ${row.hardDeadline ? renderHardDeadline(row) : nothing}
                      ${row.openreview
                        ? html`<span>${row.openreview.note}</span>`
                        : row.proofreading
                          ? html`<span data-testid="pi-review-proofreading"
                              >${row.proofreading.note}</span
                            >`
                          : row.impact
                            ? html`<strong
                                  ><span class="pill" data-testid="pi-review-high-priority"
                                    >High priority</span
                                  >
                                  Safety impact statement</strong
                                >
                                <span>${row.impact.statement?.risk ?? ""}</span>
                                <span class="muted"
                                  >${row.impact.source === "override"
                                    ? "Marked AI-safety related by hand"
                                    : `Looks AI-safety related: ${row.impact.reasons.join(", ")}`}</span
                                >`
                            : row.feedback
                              ? html`<strong>${row.feedback.label}</strong
                                  ><span>${row.feedback.reason}</span>
                                  <span
                                    >Feedback by (soft):
                                    ${row.feedback.soft_deadline
                                      ? new Date(row.feedback.soft_deadline).toLocaleString(
                                          undefined,
                                          {
                                            timeZoneName: "short",
                                          },
                                        )
                                      : "Not specified"}</span
                                  >
                                  <span
                                    >Submission cutoff (hard):
                                    ${row.feedback.hard_deadline
                                      ? new Date(row.feedback.hard_deadline).toLocaleString(
                                          undefined,
                                          {
                                            timeZoneName: "short",
                                          },
                                        )
                                      : "Not specified"}</span
                                  >
                                  ${row.feedback.hard_deadline &&
                                  Date.parse(row.feedback.hard_deadline) < Date.now()
                                    ? html`<strong
                                        >Past submission cutoff — soft submission</strong
                                      >`
                                    : nothing} `
                              : html`<span>Publication approval</span>`}
                      ${row.packageComplete
                        ? nothing
                        : html`<span class="muted">${t("professor.piReview.incomplete")}</span>`}
                      ${row.waitingSince
                        ? html`<span class="professor__when"
                            >${t("professor.piReview.since", {
                              date: row.waitingSince.slice(0, 10),
                            })}</span
                          >`
                        : nothing}`,
                    // Reading the PDF and giving the yes are two different errands, so the PDF keeps its
                    // own target rather than being swallowed by the row.
                    aside: html`${row.drivePdfUrl
                      ? html`<a
                          class="professor__row-aside"
                          href=${row.drivePdfUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          >${row.openreview
                            ? "Open on OpenReview"
                            : row.feedback
                              ? "Open manuscript"
                              : t("professor.piReview.pdf")}</a
                        >`
                      : nothing}
                    ${paperActionButton(row, props, paperBusyId)}`,
                  }),
                ),
                empty: searchingPapers ? "" : t("professor.piReview.empty"),
                onToggleExpand: props.onToggleExpand,
              })}
              ${piReviewHistoryList(props.piReviewHistory ?? [], paperQuery, props)}`,
      }),
    },
    {
      id: "escalated",
      count: escalatedNudgeTotal(props.escalated),
      settled: props.escalated.length === 0,
      // Pinned last whether or not it has anything in it. Everything above is a queue she works
      // through on her own; this one is the lab asking her to go and chase a person, which is the
      // slowest and least frequent thing on the page and should not sit between two reading lists.
      pinned: 1,
      body: section({
        id: "escalated",
        title: t("professor.escalated.title"),
        blurb: t("professor.escalated.blurb"),
        count: escalatedNudgeTotal(props.escalated),
        // Announcements is where she writes to somebody, which is the whole point of an
        // escalation: the automatic chasing is finished and it now wants a person.
        tab: "adminbotAnnouncements",
        linkLabel: t("professor.escalated.open"),
        onOpen: props.onOpen,
        body: rows({
          id: "escalated",
          total: escalatedNudgeTotal(props.escalated),
          items: props.escalated.map((row) =>
            rowButton({
              action: t("professor.escalated.open"),
              onOpen: () => props.onOpen("adminbotAnnouncements"),
              body: html`<strong>${row.name}</strong>
                <span class="muted"
                  >${row.items.length === 1
                    ? (row.items[0]?.title ?? "")
                    : t("professor.escalated.items", { count: String(row.items.length) })}</span
                >
                ${row.escalatedAt
                  ? html`<span class="professor__when">${row.escalatedAt.slice(0, 10)}</span>`
                  : nothing}`,
            }),
          ),
          empty: t("professor.escalated.empty"),
          expanded: props.expanded,
          onToggleExpand: props.onToggleExpand,
        }),
      }),
    },
    {
      id: "letters",
      count: props.requestsLoading ? null : letters.length,
      // A queue still loading is not an empty one, so it holds its place rather than sinking.
      settled:
        !props.requestsLoading &&
        letters.length === 0 &&
        lettersDone.length === 0 &&
        lettersIn.length === 0,
      body: section({
        id: "letters",
        title: t("professor.letters.title"),
        count: letters.length,
        tab: "adminbotRecLetters",
        linkLabel: t("professor.letters.open"),
        onOpen: props.onOpen,
        body: props.requestsLoading
          ? html`<p class="professor__empty">${t("professor.loading")}</p>`
          : html`${searchBox({
              id: "letters",
              label: t("professor.letters.searchLabel"),
              placeholder: t("professor.letters.searchPlaceholder"),
              value: letterQuery,
              onSearchChange: letters.length || letterQuery ? props.onSearchChange : undefined,
            })}
            ${searchSummary({
              query: letterQuery,
              count: shownLetters.length,
              matches: t("professor.letters.matches", {
                count: String(shownLetters.length),
                query: letterQuery.trim(),
              }),
            })}
            ${props.letterError
              ? html`<p class="professor__error" role="alert" data-testid="professor-letter-error">
                  ${props.letterError}
                </p>`
              : nothing}
            ${letterBody(shownLetters, props, searchTokens(letterQuery).length > 0)}
            ${letterDoneList(lettersDone, props)} ${lettersAlreadyInList(lettersIn, props)}`,
      }),
    },
    {
      id: "drafts",
      count: drafts.length,
      settled: drafts.length === 0,
      body: section({
        id: "drafts",
        title: t("professor.drafts.title"),
        blurb: t("professor.drafts.blurb"),
        count: drafts.length,
        tab: "adminbotPapers",
        linkLabel: t("professor.drafts.open"),
        onOpen: props.onOpen,
        // The draft itself is the destination here -- the row is the link, title to deadline,
        // rather than a line of text with a link at the front of it.
        body: rows({
          id: "drafts",
          items: drafts.map((draft) =>
            rowLink({
              href: draft.url,
              body: html`<strong>${draft.paper.title}</strong>
                <span class="muted">${draft.paper.authors.join(", ")}</span>
                ${draft.deadline
                  ? html`<span class="professor__when">${draft.deadline}</span>`
                  : nothing}`,
            }),
          ),
          empty: t("professor.drafts.empty"),
          expanded: props.expanded,
          onToggleExpand: props.onToggleExpand,
        }),
      }),
    },
    {
      id: "adoption",
      count: toRemind,
      settled: toRemind === 0,
      // Pinned to the foot of the page and folded: who has not filled in a profile is worth a
      // glance once in a while, not the first screen of every visit. Below even the escalations:
      // those want a word from her, this only wants a reminder sent by somebody.
      pinned: 2,
      body: section({
        id: "adoption",
        title: t("professor.adoption.title"),
        count: toRemind,
        tab: "adminbotProfileOverview",
        linkLabel: t("professor.adoption.open"),
        onOpen: props.onOpen,
        body: adoptionBody(props.profiles, props),
      }),
    },
  ];

  // Settled sections keep their relative order but sink below the ones with something in them: the
  // page is read top down, and nothing outstanding should not cost the first screen. A pinned
  // section sits below both -- its place on the page is fixed, so it is not somewhere different
  // depending on how her week is going.
  const sorted = sections.toSorted(
    (left, right) =>
      (left.pinned ?? 0) - (right.pinned ?? 0) || Number(left.settled) - Number(right.settled),
  );
  return html`
    <div class="professor">
      ${broadcastBox(props)} ${summaryStrip(sorted)} ${sorted.map((entry) => entry.body)}
    </div>
  `;
}
