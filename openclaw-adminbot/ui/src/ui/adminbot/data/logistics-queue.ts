import {
  normalizeCalendarTimezone,
  requestDeadlineDetails,
  selectLogisticsQueue as selectSharedQueue,
  type LogisticsQueueQuery,
} from "../../../../../extensions/adminbot/logistics-api.js";
import type {
  LogisticsRequest,
  LogisticsRequestKind,
  LogisticsRequestStatus,
} from "../api/logistics.ts";

export type LogisticsQueueOptions = {
  search: string;
  kind: LogisticsRequestKind | "all";
  status: LogisticsRequestStatus | "all";
  sortBy: "submitted" | "user" | "deadline" | "status";
  sortDirection: "asc" | "desc";
};

export const DEFAULT_LOGISTICS_QUEUE_OPTIONS: LogisticsQueueOptions = {
  search: "",
  kind: "all",
  status: "all",
  sortBy: "deadline",
  sortDirection: "asc",
};

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
  return `${date}, ${deadline.time} ${zone}`;
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
): LogisticsQueueQuery {
  return {
    status: options.status !== "all" ? options.status : showSettled ? "all" : "open",
    ...(options.kind !== "all" ? { kind: options.kind } : {}),
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
): LogisticsRequest[] {
  return selectSharedQueue(requests, logisticsQueueQueryFor(options, showSettled));
}
