// AdminBot client: Settings, feedback, notifications, and tab usage.
//
// Mirrors the service's api/routes/workspace.ts. Cut from auth/session.ts, which keeps the session
// lifecycle and the request plumbing every zone shares.
import { authedJson, type AuthResult, calendarFailure, mapErrorResponse } from "../auth/session.ts";

/**
 * Writes lab-wide settings over the signed-in admin's own member session (PUT /settings).
 *
 * Not through the adminbot_update_settings gateway tool: every gateway-tool call authenticates as
 * the shared service principal, and the service's requireMemberPrivileged denies that principal
 * for settings outright -- governance has to be driven by a real member session, or any signed-in
 * member could change lab policy by asking the agent to. Same reasoning as
 * upsertLabMemberAsAdmin below.
 */
export async function updateSettingsAsAdmin(
  settings: Record<string, unknown>,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(baseUrl, "/settings", "PUT", sessionToken, settings);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    // A 400 carries the service's own explanation of what it refused.
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body };
}

/**
 * Send one member's verdict on one surface.
 *
 * Fire-and-forget from the caller's point of view: the widget has already stored the vote locally
 * and dismissed itself, so a failed write must not put a dialog in front of somebody who has
 * finished. The result is returned anyway, because a caller that wants to log it should be able
 * to -- what it must not do is block the page on it.
 */
export async function submitFeedback(
  input: { featureId: string; rating: number; comment?: string; githubFile?: string },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(baseUrl, "/feedback", "POST", sessionToken, {
    feature_id: input.featureId,
    rating: input.rating,
    ...(input.comment ? { comment: input.comment } : {}),
    ...(input.githubFile ? { github_file: input.githubFile } : {}),
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body };
}

export type MemberNotification = {
  id: string;
  member_id: string;
  /** Open, not a closed union: a service newer than this page can name a sender it does not know. */
  kind: string;
  title: string;
  body: string;
  /** A Control UI tab id. Validated against the Tab union where it is used, never trusted as one here. */
  tab?: string;
  created_at: string;
  read_at?: string;
  /** One of the things the lab actually chases. Absent from a service older than the flag. */
  important?: boolean;
  /** When the head professor was brought in. Absent means they have not been. */
  escalated_at?: string;
};

export async function fetchNotifications(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<MemberNotification[]>> {
  const result = await authedJson(baseUrl, "/notifications", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as { notifications?: MemberNotification[] } | null;
  return { ok: true, value: body?.notifications ?? [] };
}

/** No ids marks every unread one read, which is what "dismiss all" on the popup stack means. */
export async function markNotificationsRead(
  sessionToken: string,
  baseUrl: string,
  notificationIds?: readonly string[],
): Promise<AuthResult<{ read: number }>> {
  const result = await authedJson(
    baseUrl,
    "/notifications/read",
    "POST",
    sessionToken,
    notificationIds?.length ? { notification_ids: [...notificationIds] } : {},
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as { read: number } };
}

/** One tab's share of a usage window, as the page reads it. */
export type TabVisitRate = {
  tab: string;
  visits: number;
  members: number;
  visitsPerDay: number;
  dwellSecondsMedian: number;
  dwellSecondsTotal: number;
  dwellSamples: number;
  firstAt: string;
  lastAt: string;
};

export type TabVisitReport = {
  from: string;
  to: string;
  days: number;
  visits: number;
  members: number;
  impersonatedVisits: number;
  tabs: TabVisitRate[];
};

/** One row of the log, as the CSV writes it. Deliberately the service's own field names. */
export type TabVisitRow = {
  id: string;
  member_id: string;
  tab: string;
  at: string;
  impersonated?: boolean;
};

/**
 * Tell the service a tab was opened.
 *
 * Returns nothing and throws nothing: navigation must not wait on this and must not break when it
 * fails. A dropped visit is a gap in a usage log; a navigation that stalls or a page that errors
 * because analytics was unreachable is a broken tool, and the second is much worse than the first.
 */
export async function recordTabVisit(
  sessionToken: string,
  baseUrl: string,
  tab: string,
): Promise<void> {
  try {
    await authedJson(baseUrl, "/ui/tab-visits", "POST", sessionToken, { tab });
  } catch {
    // Same reasoning as the unreachable branch: a usage log is never worth a visible failure.
  }
}

export async function fetchTabVisitReport(
  sessionToken: string,
  baseUrl: string,
  days: number,
): Promise<AuthResult<TabVisitReport>> {
  const result = await authedJson(
    baseUrl,
    `/ui/tab-visits?days=${encodeURIComponent(String(days))}`,
    "GET",
    sessionToken,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as {
    from?: string;
    to?: string;
    days?: number;
    visits?: number;
    members?: number;
    impersonated_visits?: number;
    tabs?: Array<Record<string, unknown>>;
  } | null;
  return {
    ok: true,
    value: {
      from: body?.from ?? "",
      to: body?.to ?? "",
      days: body?.days ?? days,
      visits: body?.visits ?? 0,
      members: body?.members ?? 0,
      impersonatedVisits: body?.impersonated_visits ?? 0,
      tabs: (body?.tabs ?? []).map((row) => ({
        tab: typeof row.tab === "string" ? row.tab : "",
        visits: numberOr(row.visits),
        members: numberOr(row.members),
        visitsPerDay: numberOr(row.visits_per_day),
        dwellSecondsMedian: numberOr(row.dwell_seconds_median),
        dwellSecondsTotal: numberOr(row.dwell_seconds_total),
        dwellSamples: numberOr(row.dwell_samples),
        firstAt: typeof row.first_at === "string" ? row.first_at : "",
        lastAt: typeof row.last_at === "string" ? row.last_at : "",
      })),
    },
  };
}

/** The raw rows behind the report, for the analysis that happens outside this tool. */
export async function fetchTabVisitRows(
  sessionToken: string,
  baseUrl: string,
  days: number,
): Promise<AuthResult<TabVisitRow[]>> {
  const result = await authedJson(
    baseUrl,
    `/ui/tab-visits/rows?days=${encodeURIComponent(String(days))}`,
    "GET",
    sessionToken,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as { visits?: TabVisitRow[] } | null;
  return { ok: true, value: body?.visits ?? [] };
}

function numberOr(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
