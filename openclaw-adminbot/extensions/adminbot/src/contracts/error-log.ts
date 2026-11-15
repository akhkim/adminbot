// What went wrong for the people using AdminBot, as the service keeps it.
//
// Until this existed a browser error was visible to exactly one person: whoever hit it, and only if
// they had the console open. A failed request showed a banner to that member and left no trace an
// operator could find later. This is the record behind "is anybody stuck right now".
//
// One row per *problem*, not one per occurrence. A render loop can raise the same TypeError two
// hundred times a minute, and a table that grew a row each time would bury the second problem under
// the first and grow without bound. Repeats bump a count instead; see `adminBotErrorFingerprint`.
//
// What is deliberately absent: request and response bodies, query strings, tokens and form
// contents. The browser never sends them, and `scrubErrorText` runs again here because a member's
// browser is not a trusted author of what an admin later reads.
import { createHash } from "node:crypto";

/**
 * Where the report came from.
 *
 *   error                an uncaught exception in the Control UI
 *   unhandled_rejection  a promise nobody caught
 *   api                  the browser saw an AdminBot request fail (5xx, or no answer at all)
 *   server               a route handler threw; recorded by the service itself, not sent by anyone
 */
export const adminBotBrowserErrorKinds = ["error", "unhandled_rejection", "api"] as const;
export type AdminBotErrorKind = (typeof adminBotBrowserErrorKinds)[number] | "server";

/** One occurrence, validated and cut to size. */
export type AdminBotErrorReport = {
  kind: AdminBotErrorKind;
  message: string;
  name?: string;
  stack?: string;
  /** The Control UI path the member was on. Path only. */
  page?: string;
  /** The Control UI build that raised it, when the bundle carries one. */
  build?: string;
  user_agent?: string;
  api_method?: string;
  /** The route that failed. Path only. */
  api_path?: string;
  /** The HTTP status, or 0 when the request never got an answer. */
  api_status?: number;
};

/** Every occurrence of one problem. */
export type AdminBotErrorGroup = {
  /** The fingerprint. Stable across restarts, so a resolved problem that returns reopens its row. */
  id: string;
  kind: AdminBotErrorKind;
  message: string;
  name?: string;
  page?: string;
  api_method?: string;
  api_path?: string;
  api_status?: number;
  count: number;
  /**
   * Who hit it, as member ids, capped at `adminBotErrorMemberCap`. Past the cap the list stops
   * growing and `members_capped` says so: "at least this many" is all an admin needs to know to
   * tell one person's bad cache from a lab-wide outage.
   */
  member_ids: string[];
  members_capped?: boolean;
  first_seen_at: string;
  last_seen_at: string;
  /** From the most recent occurrence that carried one. */
  sample_stack?: string;
  build?: string;
  user_agent?: string;
  resolved_at?: string;
  resolved_by?: string;
};

export const adminBotErrorMessageMax = 500;
export const adminBotErrorStackMax = 4000;
export const adminBotErrorMemberCap = 25;
/** How many distinct problems are kept. The least recently seen are dropped past this. */
export const adminBotErrorGroupCap = 500;
/** A problem nobody has hit for this long is dropped. */
export const adminBotErrorRetentionDays = 90;
/** Reports one member may file per minute; the browser's own cap is far below this. */
export const adminBotErrorReportsPerMinute = 60;

/**
 * Removes what an error string should never carry into a log somebody else reads.
 *
 * Query strings and fragments go because that is where invite codes, search text and OAuth state
 * live; bearer tokens and long opaque runs because a thrown fetch error can quote its own headers;
 * email addresses because an error message built from a form value would otherwise name a person.
 * It over-redacts on purpose: a mangled hash in a stack frame costs nothing, a leaked token does.
 */
export function scrubErrorText(value: string): string {
  return (
    value
      // The lookahead leaves a stack frame's trailing :line:column in place.
      .replace(
        /([a-z][a-z0-9+.-]*:\/\/[^\s?#)'"]+)[?#][^\s)'"]*?(?=(?::\d+){0,2}(?:[\s)'"]|$))/giu,
        "$1",
      )
      .replace(/(?<=[\w/.-])\?[\w%.~+-]+=[^\s)'"]*?(?=(?::\d+){0,2}(?:[\s)'"]|$))/gu, "")
      .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/gu, "[email]")
      .replace(/[A-Za-z0-9_-]{32,}/gu, "[redacted]")
  );
}

/** A path with no query, no fragment and no origin, or undefined when it is not a path. */
export function errorPathOnly(value: unknown, max = 200): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const path = value.trim().split(/[?#]/u)[0] ?? "";
  if (!path.startsWith("/")) {
    return undefined;
  }
  return scrubErrorText(path).slice(0, max);
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = scrubErrorText(value.trim()).slice(0, max);
  return trimmed || undefined;
}

/**
 * Turns whatever the browser sent into a report, or says why not.
 *
 * Unknown fields are dropped rather than stored, so a later browser cannot use this route to park
 * arbitrary data in the service. `server` is refused as a kind: only the service files those.
 */
export function parseAdminBotErrorReport(
  body: Record<string, unknown>,
): { ok: true; report: AdminBotErrorReport } | { ok: false; message: string } {
  const kind = adminBotBrowserErrorKinds.find((candidate) => candidate === body.kind);
  if (!kind) {
    return { ok: false, message: "kind must be error, unhandled_rejection or api" };
  }
  const message = text(body.message, adminBotErrorMessageMax);
  if (!message) {
    return { ok: false, message: "message is required" };
  }
  const name = text(body.name, 80);
  const stack = text(body.stack, adminBotErrorStackMax);
  const page = errorPathOnly(body.page);
  const build = text(body.build, 80);
  const userAgent = text(body.user_agent, 300);
  const method = text(body.api_method, 10)?.toUpperCase();
  const apiPath = errorPathOnly(body.api_path);
  const status = Number(body.api_status);
  return {
    ok: true,
    report: {
      kind,
      message,
      ...(name ? { name } : {}),
      ...(stack ? { stack } : {}),
      ...(page ? { page } : {}),
      ...(build ? { build } : {}),
      ...(userAgent ? { user_agent: userAgent } : {}),
      ...(kind === "api" && method ? { api_method: method } : {}),
      ...(kind === "api" && apiPath ? { api_path: apiPath } : {}),
      ...(kind === "api" && Number.isInteger(status) && status >= 0 && status <= 599
        ? { api_status: status }
        : {}),
    },
  };
}

/**
 * A route path with its record ids folded out, so one broken route is one problem.
 *
 * Only segments that are unmistakably ids go: all digits, a UUID, or a long opaque run. A member
 * slug such as `/lab/members/ada` stays, because nothing tells it apart from a route name; those
 * split into one group per record and the group cap bounds them.
 */
function routeShape(path: string): string {
  return path
    .split("/")
    .map((segment) =>
      /^\d+$/u.test(segment) || /^[0-9a-f-]{16,}$/iu.test(segment) || segment.length >= 24
        ? ":id"
        : segment,
    )
    .join("/");
}

/**
 * What makes two occurrences the same problem.
 *
 * The kind, the error's name, its message with the numbers folded out (so "row 14" and "row 15"
 * group), the first stack frame, and for a request its method, route shape and status. The page is
 * left out on purpose: a shared component that throws on six tabs is one bug, not six.
 */
export function adminBotErrorFingerprint(report: AdminBotErrorReport): string {
  const firstFrame =
    report.stack
      ?.split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("at ") || line.includes("@")) ?? "";
  const parts = [
    report.kind,
    report.name ?? "",
    report.message.replace(/\d+/gu, "#"),
    // Line and column numbers move with every build; the file and function do not.
    firstFrame.replace(/:\d+/gu, ""),
    report.api_method ?? "",
    report.api_path ? routeShape(report.api_path) : "",
    report.api_status === undefined ? "" : String(report.api_status),
  ];
  return `err_${createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 24)}`;
}

/** Folds one occurrence into its group, or starts the group. Pure: the stores share it. */
export function mergeAdminBotErrorReport(
  existing: AdminBotErrorGroup | undefined,
  report: AdminBotErrorReport,
  options: { id: string; memberId?: string; now: string },
): AdminBotErrorGroup {
  const known = existing?.member_ids ?? [];
  const isNewMember = options.memberId !== undefined && !known.includes(options.memberId);
  const hasRoom = known.length < adminBotErrorMemberCap;
  const memberIds = isNewMember && hasRoom ? [...known, options.memberId!] : known;
  const capped = existing?.members_capped || (isNewMember && !hasRoom);
  const stack = report.stack ?? existing?.sample_stack;
  const build = report.build ?? existing?.build;
  const userAgent = report.user_agent ?? existing?.user_agent;
  // A problem that comes back after being marked resolved is not resolved: the resolution is
  // dropped rather than kept, so it returns to the open list where somebody will see it.
  return {
    id: options.id,
    kind: report.kind,
    message: report.message,
    ...(report.name ? { name: report.name } : {}),
    ...((report.page ?? existing?.page) ? { page: report.page ?? existing?.page } : {}),
    ...(report.api_method ? { api_method: report.api_method } : {}),
    ...(report.api_path ? { api_path: report.api_path } : {}),
    ...(report.api_status === undefined ? {} : { api_status: report.api_status }),
    count: (existing?.count ?? 0) + 1,
    member_ids: memberIds,
    ...(capped ? { members_capped: true } : {}),
    first_seen_at: existing?.first_seen_at ?? options.now,
    last_seen_at: options.now,
    ...(stack ? { sample_stack: stack } : {}),
    ...(build ? { build } : {}),
    ...(userAgent ? { user_agent: userAgent } : {}),
  };
}
