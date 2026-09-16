// The professor's morning page: the things that are hers to do, on one screen.
//
// Everything here is already somewhere else -- the rec-letter queue is on Requests, the adoption
// columns head Profile Completeness and Time Availability. That is the point. Those pages are each
// built for working through one kind of thing, and the question this page answers is the one nobody
// could answer without opening all of them: what is waiting on me.
//
// So it aggregates and links; it does not re-implement. Every section is a count and the few rows
// worth seeing, where each row is itself the way through to the page that does the work and the rest
// of the queue is one press away. What no section carries is a control that changes something: one
// that grew its own editing would be a second place to do the same job, drifting from the first.
// Linking harder is not that -- it is the same aggregation, reachable.
//
// The broadcast box at the top is the one exception, and it is not a second place: the composer was
// *moved* here out of Lab Sharing rather than copied, so there is still exactly one surface that
// writes it. It belongs here because it is the only thing on this page that is hers to *author*
// rather than to work through -- every other section is a queue somebody else filled -- and because
// the page it used to live on is the one members read, where an editor only she could see was three
// controls of dead weight for everybody else.
import { html, nothing } from "lit";
import {
  adminBotIsAlumniMember,
  adminBotLogisticsSettledStatuses,
  adminBotTimelineEntryTarget,
} from "../../../../../extensions/adminbot/src/contracts/actions.js";
import { t } from "../../../i18n/index.ts";
import { icons } from "../../icons.ts";
import type { Tab } from "../../navigation.ts";
import type {
  EscalatedNudgeRow,
  LabBroadcast,
  LogisticsRequest,
  MemberProfileOverviewRow,
  PiReviewRow,
} from "../auth/session.ts";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";

export type ProfessorViewProps = {
  requests: LogisticsRequest[];
  requestsLoading: boolean;
  papers: AdminBotPaperRecord[];
  profiles: MemberProfileOverviewRow[];
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
  onOpen: (tab: Tab) => void;
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
  broadcastBusy?: boolean;
  broadcastNotice?: { kind: "success" | "error"; text: string } | null;
  onBroadcastDraftChange: (value: string) => void;
  onBroadcastExpiryChange: (value: string) => void;
  onBroadcastAvailabilityChange: (value: string) => void;
  /** Post what is in the box, or take the current broadcast down with null. */
  onBroadcastPublish: (
    draft: { message: string; availability: string; expiresOn: string } | null,
  ) => void;
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
export function recLetterQueue(requests: readonly LogisticsRequest[]): LogisticsRequest[] {
  return requests
    .filter((request) => request.kind === "recommendation_letters" && !SETTLED.has(request.status))
    .toSorted((left, right) =>
      (left.deadline_at ?? "9999").localeCompare(right.deadline_at ?? "9999"),
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
  return recLetterQueue(requests).map((request) => {
    const deadlineMs = request.deadline_at ? Date.parse(request.deadline_at) : Number.NaN;
    if (!Number.isFinite(deadlineMs)) {
      // An unparseable stamp is treated as no stamp rather than as the epoch, which would file a
      // typo at the top of the overdue list and bury the letters that really are late.
      return { request, bucket: "undated" };
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
    return { request, bucket, daysAway };
  });
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

/**
 * Who is still on the hook for using AdminBot themselves.
 *
 * Alumni are out of every adoption column: they have left, so a row of theirs that stays blank is
 * not a reminder anybody is going to send. Everyone else stays, external collaborators included --
 * the lab does chase them, and dropping them would quietly shrink the count this section exists to
 * show.
 *
 * Asked through `adminBotIsAlumniMember`, which reads `member_type` as well as `status`. Testing
 * `status` alone -- which this did -- let 22 of the lab's 24 alumni back into the list: the roster
 * was imported from a spreadsheet that spells it in the type, and those 22 carry no status at all.
 * They are the rows least likely to ever be filled in, so they sorted straight to the top of every
 * column, which is how a reminder list ends up led by people who have left.
 */
export function adoptionCandidates(
  profiles: readonly MemberProfileOverviewRow[],
): MemberProfileOverviewRow[] {
  return profiles.filter((row) => !adminBotIsAlumniMember(row));
}

/** Members with mandatory profile fields still blank, emptiest record first. */
export function incompleteProfiles(
  profiles: readonly MemberProfileOverviewRow[],
): MemberProfileOverviewRow[] {
  return adoptionCandidates(profiles)
    .filter((row) => row.missing_fields.length > 0)
    .toSorted((left, right) => right.missing_fields.length - left.missing_fields.length);
}

/** Members whose timeline is thinner than the lab asks for. The list Time Availability is for. */
export function thinTimelines(
  profiles: readonly MemberProfileOverviewRow[],
): MemberProfileOverviewRow[] {
  return adoptionCandidates(profiles)
    .filter((row) => row.timeline.total < adminBotTimelineEntryTarget)
    .toSorted((left, right) => left.timeline.total - right.timeline.total);
}

/**
 * Members with a paper carrying no update they wrote themselves.
 *
 * Somebody with no papers at all is not behind on anything, so they are not in this column.
 */
export function unattendedProjects(
  profiles: readonly MemberProfileOverviewRow[],
): MemberProfileOverviewRow[] {
  const behind = (row: MemberProfileOverviewRow) => row.projects.total - row.projects.self_updated;
  return adoptionCandidates(profiles)
    .filter((row) => row.projects.total > 0 && behind(row) > 0)
    .toSorted((left, right) => behind(right) - behind(left));
}

type AdoptionColumn = {
  id: "profile" | "timeline" | "papers";
  label: string;
  rows: MemberProfileOverviewRow[];
  detail: (row: MemberProfileOverviewRow) => string;
};

/**
 * The three columns, with the settled ones last.
 *
 * A column nobody has to act on is still worth showing -- it is how you see that the answer is
 * "nobody" rather than "not loaded yet" -- but it should not sit between two columns that do need
 * work.
 */
export function adoptionColumns(profiles: readonly MemberProfileOverviewRow[]): AdoptionColumn[] {
  const columns: AdoptionColumn[] = [
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
  return columns.toSorted((left, right) => Number(!left.rows.length) - Number(!right.rows.length));
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
  count: number;
  tab: Tab;
  linkLabel: string;
  onOpen: (tab: Tab) => void;
  body: unknown;
}) {
  return html`
    <section class="professor__section" data-testid=${`professor-${params.id}`}>
      <div class="professor__head">
        <div class="card-title">${params.title}</div>
        <span class="professor__count ab-num" data-empty=${params.count === 0 ? "true" : "false"}
          >${params.count}</span
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
  empty: string;
  expanded: ReadonlySet<string>;
  onToggleExpand: (id: string) => void;
}) {
  if (!params.items.length) {
    return html`<p class="professor__empty">${params.empty}</p>`;
  }
  const open = params.expanded.has(params.id);
  const shown = params.items.slice(0, open ? EXPANDED_ROWS : PREVIEW_ROWS);
  const listId = `professor-list-${params.id}`;
  return html`<ul id=${listId} class="professor__list" data-open=${open ? "true" : "false"}>
      ${shown}
    </ul>
    ${params.items.length > PREVIEW_ROWS
      ? moreToggle({
          id: params.id,
          controls: listId,
          open,
          shown: shown.length,
          hidden: params.items.length - shown.length,
          total: params.items.length,
          onToggleExpand: params.onToggleExpand,
        })
      : nothing}`;
}

/**
 * The letter queue drawn as its deadline buckets.
 *
 * Every row still names the member and how many schools are on the request -- that has not changed,
 * and it is what decides how long the letter takes to write. What is new is the heading it sits
 * under and the relative date beside it, so "Overdue" is answerable at a glance instead of being
 * something she works out from four ISO dates.
 */
function letterBody(
  due: readonly RecLetterDue[],
  props: Pick<ProfessorViewProps, "onOpen" | "expanded" | "onToggleExpand">,
) {
  if (!due.length) {
    return html`<p class="professor__empty">${t("professor.letters.empty")}</p>`;
  }
  // One switch for the whole section rather than one per bucket: the cap is taken across the queue
  // before grouping, so "the rest of it" is a fact about the queue and not about "Next 30 days".
  const open = props.expanded.has("letters");
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
                    onOpen: () => props.onOpen("adminbotRecLetters"),
                    body: html`<strong>${entry.request.member_name}</strong>
                      <span class="muted"
                        >${entry.request.schools?.length
                          ? t("professor.letters.schools", {
                              count: String(entry.request.schools.length),
                            })
                          : t("professor.letters.noSchools")}</span
                      >
                      <span class="professor__when">${recLetterDueLabel(entry)}</span>`,
                  }),
                )}
              </ul>`
            : nothing}
        </div>`,
      )}
    </div>
    ${due.length > PREVIEW_ROWS
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

function adoptionBody(
  profiles: readonly MemberProfileOverviewRow[],
  props: Pick<ProfessorViewProps, "onOpen" | "expanded" | "onToggleExpand">,
) {
  return html`<div class="professor__columns">
    ${adoptionColumns(profiles).map(
      (column) => html`<div
        class="professor__column"
        data-testid=${`professor-adoption-${column.id}`}
        data-empty=${column.rows.length === 0 ? "true" : "false"}
      >
        <div class="professor__column-head">
          <span>${column.label}</span>
          <span class="ab-num">${column.rows.length}</span>
        </div>
        ${rows({
          id: `adoption-${column.id}`,
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
  </div>`;
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
  const live = props.broadcast;
  const draft = props.broadcastDraft ?? live?.message ?? "";
  const expiresOn =
    props.broadcastExpiry ?? (live ? live.expires_at.slice(0, 10) : defaultExpiryDate());
  const availability = props.broadcastAvailability ?? live?.availability ?? "away";
  const busy = Boolean(props.broadcastBusy);
  const dirty = draft.trim() !== (live?.message ?? "").trim();

  return html`
    <section class="professor__section professor__broadcast" data-testid="professor-broadcast">
      <div class="professor__head">
        <div class="card-title">${t("professor.broadcast.title")}</div>
        ${live
          ? html`<span class="professor__when" data-testid="professor-broadcast-until"
              >${t("professor.broadcast.until", { date: live.expires_at.slice(0, 10) })}</span
            >`
          : html`<span class="professor__when muted">${t("professor.broadcast.none")}</span>`}
      </div>

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
          <input
            type="date"
            data-testid="professor-broadcast-expiry"
            .value=${expiresOn}
            ?disabled=${busy}
            @input=${(event: Event) =>
              props.onBroadcastExpiryChange((event.target as HTMLInputElement).value)}
          />
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
        <div class="professor__broadcast-actions">
          <button
            class="btn btn--sm primary"
            type="button"
            data-testid="professor-broadcast-post"
            ?disabled=${busy ||
            !draft.trim() ||
            (!dirty && !!live && expiresOn === live.expires_at.slice(0, 10))}
            @click=${() => props.onBroadcastPublish({ message: draft, availability, expiresOn })}
          >
            ${live ? t("professor.broadcast.update") : t("professor.broadcast.post")}
          </button>
          ${live
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
    </section>
  `;
}

/** A week out, which is the span "broadcast from Zhijing for this week" actually means. */
function defaultExpiryDate(now = new Date()): string {
  return new Date(now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
}

export function renderProfessorView(props: ProfessorViewProps) {
  const letters = recLetterDeadlineQueue(props.requests);
  const drafts = overleafReadingQueue(props.papers);
  // Somebody short on two counts is still one person to remind, so the headline number is people,
  // not rows.
  const toRemind = new Set(
    adoptionColumns(props.profiles).flatMap((column) => column.rows.map((row) => row.id)),
  );

  const sections: Array<{ settled: boolean; pinned?: boolean; body: unknown }> = [
    {
      settled: props.piReview.length === 0,
      body: section({
        id: "pi-review",
        title: t("professor.piReview.title"),
        blurb: t("professor.piReview.blurb"),
        count: props.piReview.length,
        // The paper card is where the yes is given, so that is where this points.
        tab: "adminbotPapers",
        linkLabel: t("professor.piReview.open"),
        onOpen: props.onOpen,
        body: rows({
          id: "pi-review",
          items: props.piReview.map((row) =>
            rowButton({
              action: t("professor.piReview.open"),
              onOpen: () => props.onOpen("adminbotPapers"),
              body: html`<strong>${row.title}</strong>
                <span class="muted">${row.authors.join(", ")}</span>
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
              aside: row.drivePdfUrl
                ? html`<a
                    class="professor__row-aside"
                    href=${row.drivePdfUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    >${t("professor.piReview.pdf")}</a
                  >`
                : undefined,
            }),
          ),
          empty: t("professor.piReview.empty"),
          expanded: props.expanded,
          onToggleExpand: props.onToggleExpand,
        }),
      }),
    },
    {
      settled: props.escalated.length === 0,
      // Pinned last whether or not it has anything in it. Everything above is a queue she works
      // through on her own; this one is the lab asking her to go and chase a person, which is the
      // slowest and least frequent thing on the page and should not sit between two reading lists.
      pinned: true,
      body: section({
        id: "escalated",
        title: t("professor.escalated.title"),
        blurb: t("professor.escalated.blurb"),
        count: props.escalated.length,
        // Announcements is where she writes to somebody, which is the whole point of an
        // escalation: the automatic chasing is finished and it now wants a person.
        tab: "adminbotAnnouncements",
        linkLabel: t("professor.escalated.open"),
        onOpen: props.onOpen,
        body: rows({
          id: "escalated",
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
      // A queue still loading is not an empty one, so it holds its place rather than sinking.
      settled: !props.requestsLoading && letters.length === 0,
      body: section({
        id: "letters",
        title: t("professor.letters.title"),
        count: letters.length,
        tab: "adminbotRecLetters",
        linkLabel: t("professor.letters.open"),
        onOpen: props.onOpen,
        body: props.requestsLoading
          ? html`<p class="professor__empty">${t("professor.loading")}</p>`
          : letterBody(letters, props),
      }),
    },
    {
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
      settled: toRemind.size === 0,
      body: section({
        id: "adoption",
        title: t("professor.adoption.title"),
        count: toRemind.size,
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
  return html`
    <div class="professor">
      ${broadcastBox(props)}
      ${sections
        .toSorted(
          (left, right) =>
            Number(Boolean(left.pinned)) - Number(Boolean(right.pinned)) ||
            Number(left.settled) - Number(right.settled),
        )
        .map((entry) => entry.body)}
    </div>
  `;
}
