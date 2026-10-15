// The Profile Overview tab's side of the wire.
//
// Three calls: read how far along everyone's record is, run the reminder pass now rather than
// waiting for the daily cron, and populate the nudge list from the roster's member types. All are
// admin-only and the service enforces that; nothing here decides who may look.
//
// The roster read is paged: the Lab Overview holds the pages of its filtered list it has asked for,
// and My Desk holds each adoption column's head. The counts both pages show come from the service,
// taken over everybody, never from the rows held.
import type { DeskAdoptionCounts } from "../../../../../extensions/adminbot/src/workflows/members/profile-overview-filter.js";
import { t } from "../../../i18n/index.ts";
import type { UiSettings } from "../../storage.ts";
import {
  fetchMemberProfileOverview,
  runMandatoryFieldsReminder,
  seedNudgeList,
  type MemberAdoptionSummary,
  type MemberProfileOverviewRow,
} from "../api/members.ts";
import { fetchEscalatedNudges, type EscalatedNudgeRow } from "../api/nudges.ts";
import { fetchPiReviewQueue, type PiReviewRow } from "../api/paper-admin.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";
import {
  appendPage,
  currentListVersion,
  EMPTY_PAGED_LIST,
  isCurrentListVersion,
  nextListVersion,
  type PagedListState,
} from "../load-more.ts";

/**
 * Where the held rows stand. `view` says which question they answer -- the Lab Overview's filtered
 * list or My Desk's column heads -- so opening the other tab knows to ask again.
 */
export type ProfileOverviewPageState = PagedListState & {
  view: "list" | "desk";
  /** The Remind button's reach under the list's filter, over every page. Null from an older service. */
  remindCount: number | null;
  /** My Desk's exact column lengths. Null until a desk read answers, or from an older service. */
  desk: DeskAdoptionCounts | null;
};

export const EMPTY_PROFILE_OVERVIEW_PAGE: ProfileOverviewPageState = {
  ...EMPTY_PAGED_LIST,
  view: "list",
  remindCount: null,
  desk: null,
};

const LIST = "profile-overview";

export type AdminBotProfileOverviewHost = {
  settings: UiSettings;
  adminBotProfileOverview: MemberProfileOverviewRow[];
  adminBotProfileOverviewPage: ProfileOverviewPageState;
  /** How many fields count as complete. Zero until the first read answers. */
  adminBotProfileOverviewFieldCount: number;
  /** The lab-wide adoption roll-up. Null until the first read answers. */
  adminBotProfileAdoption?: MemberAdoptionSummary | null;
  adminBotProfileOverviewLoading: boolean;
  adminBotProfileOverviewError: string | null;
  adminBotProfileOverviewLoadedAt: number | null;
  adminBotProfileOverviewReminding: boolean;
  adminBotProfileOverviewNotice: string | null;
  /** Nudges raised to the head professor and still unanswered. Empty until the first read. */
  adminBotEscalatedNudges: EscalatedNudgeRow[];
  adminBotPiReview: PiReviewRow[];
  adminBotPiReviewError: string | null;
};

function failureText(result: { kind: string; message?: string }, baseUrl: string): string {
  if (result.kind === "unreachable") {
    return t("profileOverview.error.unreachable", { url: baseUrl });
  }
  if (result.kind === "forbidden") {
    return t("profileOverview.error.forbidden");
  }
  return result.message ?? t("profileOverview.error.failed");
}

function session(host: AdminBotProfileOverviewHost): { token: string; baseUrl: string } | null {
  const stored = loadStoredMemberSession();
  return stored
    ? { token: stored.sessionToken, baseUrl: resolveAdminBotBaseUrl(host.settings) }
    : null;
}

function sameSession(token: string): boolean {
  return loadStoredMemberSession()?.sessionToken === token;
}

/**
 * Page 1 of whichever question `query` asks: `view=desk` for My Desk, the filter otherwise.
 *
 * Versioned, so a slow answer to an earlier filter cannot land over a newer one. The escalation
 * and PI-review queues ride along with the desk read only -- the Lab Overview does not show them,
 * and a filter change should not re-ask for them.
 */
export async function loadAdminBotProfileOverview(
  host: AdminBotProfileOverviewHost,
  query: URLSearchParams,
): Promise<void> {
  const wire = session(host);
  if (!wire) {
    host.adminBotProfileOverviewError = t("profileOverview.error.signIn");
    host.adminBotPiReviewError = host.adminBotProfileOverviewError;
    return;
  }
  const view = query.get("view") === "desk" ? "desk" : "list";
  const version = nextListVersion(host, LIST);
  // Rows answering the other tab's question would draw as this one's until the answer came.
  if (host.adminBotProfileOverviewPage.view !== view) {
    host.adminBotProfileOverview = [];
  }
  host.adminBotProfileOverviewPage = {
    ...host.adminBotProfileOverviewPage,
    view,
    query: query.toString(),
    loadingMore: false,
  };
  const current = () => sameSession(wire.token) && isCurrentListVersion(host, LIST, version);
  host.adminBotProfileOverviewLoading = true;
  host.adminBotProfileOverviewError = null;
  host.adminBotPiReviewError = null;
  try {
    const result = await fetchMemberProfileOverview(wire.token, wire.baseUrl, query);
    if (!current()) {
      return;
    }
    if (!result.ok) {
      host.adminBotProfileOverview = [];
      host.adminBotProfileOverviewError = failureText(result, wire.baseUrl);
      host.adminBotPiReviewError = host.adminBotProfileOverviewError;
      return;
    }
    host.adminBotProfileOverview = result.value.members;
    host.adminBotProfileOverviewFieldCount = result.value.mandatoryFieldCount;
    host.adminBotProfileAdoption = result.value.adoption;
    host.adminBotProfileOverviewPage = {
      ...host.adminBotProfileOverviewPage,
      total: result.value.total,
      nextCursor: result.value.nextCursor,
      remindCount: result.value.remindCount,
      ...(view === "desk" ? { desk: result.value.desk } : {}),
    };
    if (view !== "desk") {
      return;
    }
    // Loaded alongside rather than on its own: the escalation queue and the adoption columns are
    // read by the same person on the same page, and a second spinner for four rows is worse than
    // waiting for them together. A failure here does not blank the page it rides on -- the columns
    // are the reason someone opened it, so the queue simply stays empty.
    const escalated = await fetchEscalatedNudges(wire.token, wire.baseUrl);
    if (!current()) {
      return;
    }
    host.adminBotEscalatedNudges = escalated.ok ? escalated.value : [];
    // An unavailable queue is unknown, not evidence that nobody is waiting.
    const piReview = await fetchPiReviewQueue(wire.token, wire.baseUrl);
    if (!current()) {
      return;
    }
    host.adminBotPiReview = piReview.ok ? piReview.value : [];
    host.adminBotPiReviewError = piReview.ok ? null : failureText(piReview, wire.baseUrl);
  } finally {
    if (current()) {
      host.adminBotProfileOverviewLoading = false;
    }
  }
}

/**
 * The Lab Overview's next page, asked with the same filter the held pages answered.
 *
 * A row already held is dropped rather than drawn twice: a member who closes a gap between two
 * reads shifts everyone after them back by one.
 */
export async function loadMoreAdminBotProfileOverview(
  host: AdminBotProfileOverviewHost,
): Promise<void> {
  const page = host.adminBotProfileOverviewPage;
  const wire = session(host);
  if (
    !wire ||
    !page.nextCursor ||
    page.loadingMore ||
    page.view !== "list" ||
    host.adminBotProfileOverviewLoading
  ) {
    return;
  }
  // The version page 1 was read under, not a new one: a fresh page 1 started meanwhile makes this
  // page stale, but this page does not make page 1 stale.
  const version = currentListVersion(host, LIST);
  const query = new URLSearchParams(page.query);
  query.set("cursor", page.nextCursor);
  host.adminBotProfileOverviewPage = { ...page, loadingMore: true };
  const current = () => sameSession(wire.token) && isCurrentListVersion(host, LIST, version);
  try {
    const result = await fetchMemberProfileOverview(wire.token, wire.baseUrl, query);
    if (!current()) {
      return;
    }
    if (!result.ok) {
      host.adminBotProfileOverviewError = failureText(result, wire.baseUrl);
      return;
    }
    host.adminBotProfileOverview = appendPage(host.adminBotProfileOverview, result.value.members);
    host.adminBotProfileOverviewPage = {
      ...host.adminBotProfileOverviewPage,
      total: result.value.total,
      nextCursor: result.value.nextCursor,
      remindCount: result.value.remindCount,
    };
  } finally {
    if (current()) {
      host.adminBotProfileOverviewPage = {
        ...host.adminBotProfileOverviewPage,
        loadingMore: false,
      };
    }
  }
}

/**
 * Sends the reminder now, for whatever the page is filtered to.
 *
 * The message is still composed entirely by the service from roster state -- this button chooses
 * words for nobody. What the scope adds is subtraction: `include` picks which of the two gaps to
 * chase and the filter narrows to the people the page is showing, and the service re-derives both
 * from the roster, so neither can address somebody it does not already consider owed a reminder.
 * The filter travels rather than ids because the page holds only the pages it has asked for. The
 * service also keeps its own cadence, so a second press within the window sends nothing.
 */
export async function remindAdminBotIncompleteProfiles(
  host: AdminBotProfileOverviewHost,
  scope?: { include: "profile" | "timeline" | "both"; memberIds: string[] },
  filter?: URLSearchParams,
): Promise<void> {
  const wire = session(host);
  if (!wire) {
    host.adminBotProfileOverviewError = t("profileOverview.error.signIn");
    return;
  }
  host.adminBotProfileOverviewReminding = true;
  host.adminBotProfileOverviewError = null;
  host.adminBotProfileOverviewNotice = null;
  try {
    const result = await runMandatoryFieldsReminder(wire.token, wire.baseUrl, scope, filter);
    if (!sameSession(wire.token)) {
      return;
    }
    if (!result.ok) {
      host.adminBotProfileOverviewError = failureText(result, wire.baseUrl);
      return;
    }
    host.adminBotProfileOverviewNotice = result.value.created
      ? t("profileOverview.reminded", { count: String(result.value.created) })
      : t("profileOverview.remindedNone");
    // Re-read so the "last reminded" column reflects what just happened.
    host.adminBotProfileOverviewLoadedAt = null;
  } finally {
    if (sameSession(wire.token)) {
      host.adminBotProfileOverviewReminding = false;
    }
  }
}

/**
 * Apply the lab's access design to the nudge list, for a lab that has never had one.
 *
 * Shares the reminder's busy flag and notice line: they are the two write buttons on this page and
 * only one of them should ever be in flight, since this changes who the reminder would reach.
 */
export async function seedAdminBotNudgeList(host: AdminBotProfileOverviewHost): Promise<void> {
  const wire = session(host);
  if (!wire) {
    host.adminBotProfileOverviewError = t("profileOverview.error.signIn");
    return;
  }
  host.adminBotProfileOverviewReminding = true;
  host.adminBotProfileOverviewError = null;
  host.adminBotProfileOverviewNotice = null;
  try {
    const result = await seedNudgeList(wire.token, wire.baseUrl, false);
    if (!sameSession(wire.token)) {
      return;
    }
    if (!result.ok) {
      host.adminBotProfileOverviewError = failureText(result, wire.baseUrl);
      return;
    }
    host.adminBotProfileOverviewNotice =
      result.value.added || result.value.silenced
        ? t("profileOverview.nudgeList.seeded", {
            count: String(result.value.added),
            silenced: String(result.value.silenced),
          })
        : t("profileOverview.nudgeList.seededNone");
    host.adminBotProfileOverviewLoadedAt = null;
  } finally {
    if (sameSession(wire.token)) {
      host.adminBotProfileOverviewReminding = false;
    }
  }
}
