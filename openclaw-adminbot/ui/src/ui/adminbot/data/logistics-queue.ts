import {
  normalizeCalendarTimezone,
  requestDeadlineDetails,
  selectLogisticsQueue as selectSharedQueue,
  type LogisticsQueueQuery,
} from "../../../../../extensions/adminbot/logistics-api.js";
import { t } from "../../../i18n/index.ts";
import type { LogisticsTab } from "../../navigation.ts";
import type {
  LogisticsRequest,
  LogisticsRequestKind,
  LogisticsRequestStatus,
} from "../api/logistics.ts";

// No request-type control: each of the three "Requests to Zhijing" tabs is one kind of request, so
// the tab answers "which kind" and the queue only ever lists that kind. A type picker defaulting to
// "all" put meeting requests on the letters page under the letters' own "Submitted" wording.
export type LogisticsQueueOptions = {
  search: string;
  status: LogisticsRequestStatus | "all";
  sortBy: "submitted" | "user" | "deadline" | "status";
  sortDirection: "asc" | "desc";
};

// Frozen: every session starts from this one object, so it must never be written in place.
export const DEFAULT_LOGISTICS_QUEUE_OPTIONS: Readonly<LogisticsQueueOptions> = Object.freeze({
  search: "",
  status: "all",
  sortBy: "deadline",
  sortDirection: "asc",
});

/** Display the source clock and zone, never the viewer's local date. */
export function logisticsDeadlineText(request: LogisticsRequest): string {
  const deadline = requestDeadlineDetails(request);
  if (!deadline) {
    return "";
  }
  const date = new Date(`${deadline.date}T00:00:00Z`).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const zone =
    normalizeCalendarTimezone(deadline.timezone) === "Etc/GMT+12"
      ? "AoE (UTC−12)"
      : deadline.timezone;
  // A legacy deadline typed without a year shows the year it was resolved to, and says so.
  const assumed = deadline.year_inferred ? ` (${t("professor.letters.yearAssumed")})` : "";
  return `${date}, ${deadline.time} ${zone}${assumed}`;
}

/**
 * The question the queue's controls ask, as the service reads it.
 *
 * "Include finished requests" off is `status=open`, so a term of completed letters never pushes
 * open work off the first page; a specific status asks for exactly that one, as the filter always
 * did.
 */
export function logisticsQueueQueryFor(
  options: LogisticsQueueOptions,
  showSettled: boolean,
  kind?: LogisticsRequestKind,
): LogisticsQueueQuery {
  return {
    status: options.status !== "all" ? options.status : showSettled ? "all" : "open",
    ...(kind ? { kind } : {}),
    ...(options.search.trim() ? { q: options.search.trim() } : {}),
    sort: options.sortBy,
    dir: options.sortDirection,
  };
}

/**
 * The same selection the service made, over the rows this tab holds. Run again here so a request
 * whose status was just changed moves to its place -- or out of the filter -- without a re-read.
 */
export function selectLogisticsQueue(
  requests: readonly LogisticsRequest[],
  options: LogisticsQueueOptions,
  showSettled: boolean,
  kind?: LogisticsRequestKind,
): LogisticsRequest[] {
  return selectSharedQueue(requests, logisticsQueueQueryFor(options, showSettled, kind));
}

/** The kind of request each Requests tab holds. */
export const LOGISTICS_TAB_KIND = {
  adminbotSignatures: "document_signature",
  adminbotRecLetters: "recommendation_letters",
  adminbotMeetingRequests: "book_meeting",
} as const satisfies Record<LogisticsTab, LogisticsRequestKind>;
