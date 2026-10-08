// Which requests the Requests queue shows, and in what order -- one definition for both sides.
//
// The queue used to be filtered and sorted in the browser over every request the lab had ever
// filed. Now the service pages it, so the filter has to run before the page is cut: a search for
// a school must find a request that is not on the first page. The browser still runs the same
// function over the rows it holds, which keeps a request whose status was just changed in the right
// place without a re-read -- and because it is the same function, the two can never order the
// queue differently.
//
// Browser-safe: re-exported through logistics-api.ts, and imports nothing that reaches node.
import {
  adminBotLogisticsRequestKinds,
  adminBotLogisticsRequestStatuses,
  adminBotLogisticsSettledStatuses,
  type AdminBotLogisticsRequestInput,
  type AdminBotLogisticsRequestKind,
  type AdminBotLogisticsRequestStatus,
} from "../../contracts/actions.js";
import { requestDeadlineDetails } from "./requests.js";

export const LOGISTICS_QUEUE_SORTS = ["recent", "submitted", "user", "deadline", "status"] as const;
export type LogisticsQueueSort = (typeof LOGISTICS_QUEUE_SORTS)[number];

/**
 * A page's worth of question about the queue, as the query string carries it.
 *
 * `status: "open"` is everything nobody has finished with -- what the queue shows while "Include
 * finished requests" is off, and the reason open work can never be pushed off the first page by a
 * term's worth of completed letters.
 */
export type LogisticsQueueQuery = {
  status: "all" | "open" | AdminBotLogisticsRequestStatus;
  kind?: AdminBotLogisticsRequestKind;
  q?: string;
  sort: LogisticsQueueSort;
  dir: "asc" | "desc";
};

/** Recent first: what a list with no sort control of its own -- a member's own requests -- shows. */
export const DEFAULT_LOGISTICS_QUEUE_QUERY: LogisticsQueueQuery = {
  status: "all",
  sort: "recent",
  dir: "desc",
};

/** What the queue reads off each request. The list row and the full request both satisfy it. */
export type LogisticsQueueRow = AdminBotLogisticsRequestInput & {
  id: string;
  member_name: string;
  status: AdminBotLogisticsRequestStatus;
  submitted_at: string;
  updated_at?: string;
};

const SETTLED = new Set<string>(adminBotLogisticsSettledStatuses);
const STATUS_ORDER: readonly string[] = adminBotLogisticsRequestStatuses;

export function isSettledLogisticsStatus(status: string): boolean {
  return SETTLED.has(status);
}

function matches<T extends LogisticsQueueRow>(request: T, query: LogisticsQueueQuery, q: string) {
  if (
    query.status === "open"
      ? SETTLED.has(request.status)
      : query.status !== "all" && request.status !== query.status
  ) {
    return false;
  }
  if (query.kind && request.kind !== query.kind) {
    return false;
  }
  return (
    !q ||
    [request.member_name, ...(request.schools ?? []).map((school) => school.school ?? "")].some(
      (value) => value.toLocaleLowerCase().includes(q),
    )
  );
}

/**
 * The queue, filtered and ordered.
 *
 * Open requests always lead, whichever column it is sorted by: with finished requests included, an
 * admin still has to see what is waiting on the lab before what is done. Ties fall back to the
 * newest submission and then the id, so a page boundary never lands between two rows the order
 * cannot tell apart -- an unstable tie is how a row appears on two pages or on none.
 */
export function selectLogisticsQueue<T extends LogisticsQueueRow>(
  requests: readonly T[],
  query: LogisticsQueueQuery,
): T[] {
  const q = (query.q ?? "").trim().toLocaleLowerCase();
  const direction = query.dir === "asc" ? 1 : -1;
  return requests
    .filter((request) => matches(request, query, q))
    .map((request) => ({ request, deadline: requestDeadlineDetails(request)?.at }))
    .toSorted((left, right) => {
      const settled =
        Number(SETTLED.has(left.request.status)) - Number(SETTLED.has(right.request.status));
      if (settled) {
        return settled;
      }
      let comparison = 0;
      if (query.sort === "deadline") {
        if (!left.deadline || !right.deadline) {
          // Undated last in either direction: "no deadline" is not the latest deadline.
          if (left.deadline !== right.deadline) {
            return left.deadline ? -1 : 1;
          }
        } else {
          comparison = Date.parse(left.deadline) - Date.parse(right.deadline);
        }
      } else if (query.sort === "submitted") {
        comparison = Date.parse(left.request.submitted_at) - Date.parse(right.request.submitted_at);
      } else if (query.sort === "user") {
        comparison = left.request.member_name.localeCompare(right.request.member_name, undefined, {
          sensitivity: "base",
        });
      } else if (query.sort === "status") {
        comparison =
          STATUS_ORDER.indexOf(left.request.status) - STATUS_ORDER.indexOf(right.request.status);
      } else {
        const touched = (row: T) => row.updated_at || row.submitted_at;
        comparison = touched(left.request).localeCompare(touched(right.request));
      }
      return (
        comparison * direction ||
        right.request.submitted_at.localeCompare(left.request.submitted_at) ||
        left.request.id.localeCompare(right.request.id)
      );
    })
    .map(({ request }) => request);
}

const KINDS = new Set<string>(adminBotLogisticsRequestKinds);
const STATUSES = new Set<string>(["all", "open", ...adminBotLogisticsRequestStatuses]);
const SORTS = new Set<string>(LOGISTICS_QUEUE_SORTS);

/** The query string's half of the question. Anything it does not recognise is "invalid", not ignored. */
export function readLogisticsQueueQuery(params: URLSearchParams): LogisticsQueueQuery | "invalid" {
  const status = params.get("status") ?? DEFAULT_LOGISTICS_QUEUE_QUERY.status;
  const kind = params.get("kind");
  const q = params.get("q")?.trim() ?? "";
  const sort = params.get("sort") ?? DEFAULT_LOGISTICS_QUEUE_QUERY.sort;
  const dir = params.get("dir") ?? DEFAULT_LOGISTICS_QUEUE_QUERY.dir;
  if (
    !STATUSES.has(status) ||
    (kind !== null && !KINDS.has(kind)) ||
    q.length > 120 ||
    !SORTS.has(sort) ||
    (dir !== "asc" && dir !== "desc")
  ) {
    return "invalid";
  }
  return {
    status: status as LogisticsQueueQuery["status"],
    ...(kind ? { kind: kind as AdminBotLogisticsRequestKind } : {}),
    ...(q ? { q } : {}),
    sort: sort as LogisticsQueueSort,
    dir,
  };
}

/** The other half: what the browser puts on the URL. Defaults are left off so the URL stays short. */
export function logisticsQueueParams(query: LogisticsQueueQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.status !== DEFAULT_LOGISTICS_QUEUE_QUERY.status) {
    params.set("status", query.status);
  }
  if (query.kind) {
    params.set("kind", query.kind);
  }
  if (query.q?.trim()) {
    params.set("q", query.q.trim());
  }
  if (query.sort !== DEFAULT_LOGISTICS_QUEUE_QUERY.sort) {
    params.set("sort", query.sort);
  }
  if (query.dir !== DEFAULT_LOGISTICS_QUEUE_QUERY.dir) {
    params.set("dir", query.dir);
  }
  return params;
}
