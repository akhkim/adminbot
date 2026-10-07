import {
  normalizeCalendarTimezone,
  requestDeadlineDetails,
} from "../../../../../extensions/adminbot/logistics-api.js";
import type {
  LogisticsRequest,
  LogisticsRequestKind,
  LogisticsRequestStatus,
} from "../api/logistics.ts";
import { isSettledRequest } from "./logistics-requests.ts";

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

const STATUS_ORDER = ["submitted", "in_progress", "completed", "declined", "withdrawn"];

export function selectLogisticsQueue(
  requests: readonly LogisticsRequest[],
  options: LogisticsQueueOptions,
  showSettled: boolean,
): LogisticsRequest[] {
  const query = options.search.trim().toLocaleLowerCase();
  // Resolve each deadline only once, including for old records whose cached deadline used an application date.
  return requests
    .filter(
      (request) =>
        (showSettled || options.status !== "all" || !isSettledRequest(request)) &&
        (options.kind === "all" || request.kind === options.kind) &&
        (options.status === "all" || request.status === options.status) &&
        (!query ||
          [request.member_name, ...(request.schools ?? []).map((school) => school.school)].some(
            (value) => value.toLocaleLowerCase().includes(query),
          )),
    )
    .map((request) => ({ request, deadline: requestDeadlineDetails(request)?.at }))
    .toSorted((left, right) => {
      let comparison = 0;
      if (options.sortBy === "deadline") {
        if (!left.deadline || !right.deadline) {
          if (left.deadline !== right.deadline) {
            return left.deadline ? -1 : 1;
          }
        } else {
          comparison = Date.parse(left.deadline) - Date.parse(right.deadline);
        }
      } else if (options.sortBy === "submitted") {
        comparison = Date.parse(left.request.submitted_at) - Date.parse(right.request.submitted_at);
      } else if (options.sortBy === "user") {
        comparison = left.request.member_name.localeCompare(right.request.member_name, undefined, {
          sensitivity: "base",
        });
      } else {
        comparison =
          STATUS_ORDER.indexOf(left.request.status) - STATUS_ORDER.indexOf(right.request.status);
      }
      return (
        comparison * (options.sortDirection === "asc" ? 1 : -1) ||
        right.request.submitted_at.localeCompare(left.request.submitted_at) ||
        left.request.id.localeCompare(right.request.id)
      );
    })
    .map(({ request }) => request);
}
