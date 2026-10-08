// AdminBot client: Member nudges and escalations.
//
// Mirrors the service's api/routes/nudges.ts. Cut from auth/session.ts, which keeps the session
// lifecycle and the request plumbing every zone shares.
import {
  authedJson,
  type AuthResult,
  calendarFailure,
  mapErrorResponse,
  type MemberNudgeChannel,
  type MemberNudgeResult,
} from "../auth/session.ts";

export type MemberNudgeRequest = {
  channel: MemberNudgeChannel;
  recipient_member_ids: string[];
  message: string;
  // Required when channel is "email"; ignored for "slack".
  subject?: string;
};

// Admin-only bulk nudge/announcement send (POST /nudges/send): fans out into one
// member_nudge.send proposal per recipient, same admin-Bearer-session write path as
// upsertLabMemberAsAdmin — never routed through the shared service principal, which
// the server would reject (403) precisely because this fans real messages out to members.
export async function sendMemberNudge(
  request: MemberNudgeRequest,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<MemberNudgeResult>> {
  const result = await authedJson(baseUrl, "/nudges/send", "POST", sessionToken, request);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body as MemberNudgeResult };
}

/** One person the head professor is being asked to chase, and everything they are sitting on. */
export type EscalatedNudgeRow = {
  memberId: string;
  name: string;
  slackUserId?: string;
  /** When the oldest of these was raised. What the queue is ordered by. */
  escalatedAt: string;
  items: Array<{ id: string; title: string; body: string; createdAt: string; tab?: string }>;
};

/**
 * The escalation queue (GET /nudges/escalated).
 *
 * A 404 is read as an empty queue rather than an error. This route is newer than the page that
 * calls it, and the UI ships from Vercel on merge while the service waits for a run on the host --
 * so a service that predates the route is the ordinary case for a while, and it should render as
 * "nothing outstanding", not as a broken panel.
 */
export async function fetchEscalatedNudges(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<EscalatedNudgeRow[]>> {
  const result = await authedJson(baseUrl, "/nudges/escalated", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (result.response.status === 404) {
    return { ok: true, value: [] };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as {
    total?: unknown;
    members?: Array<{
      member_id?: unknown;
      name?: unknown;
      slack_user_id?: unknown;
      escalated_at?: unknown;
      notifications?: Array<Record<string, unknown>>;
    }>;
  } | null;
  const rows = (body?.members ?? []).flatMap((row) => {
    const memberId = typeof row.member_id === "string" ? row.member_id : "";
    if (!memberId) {
      return [];
    }
    return [
      {
        memberId,
        name: typeof row.name === "string" && row.name ? row.name : memberId,
        ...(typeof row.slack_user_id === "string" ? { slackUserId: row.slack_user_id } : {}),
        escalatedAt: typeof row.escalated_at === "string" ? row.escalated_at : "",
        items: (row.notifications ?? []).map((entry) => ({
          id: typeof entry.id === "string" ? entry.id : "",
          title: typeof entry.title === "string" ? entry.title : "",
          // Not sent any more: the queue draws only titles. Kept so a stored row still type-checks.
          body: typeof entry.body === "string" ? entry.body : "",
          createdAt: typeof entry.created_at === "string" ? entry.created_at : "",
          ...(typeof entry.tab === "string" ? { tab: entry.tab } : {}),
        })),
      },
    ];
  });
  // The service sends the oldest page of people and the size of the whole queue beside it.
  if (typeof body?.total === "number" && Number.isFinite(body.total)) {
    escalatedTotals.set(rows, Math.max(body.total, rows.length));
  }
  return { ok: true, value: rows };
}

// Keyed by the list the read returned, which reaches the professor view untouched, so the count
// rides with the rows without another field on the app state. A list from anywhere else -- an
// older service, a test -- counts as its own length.
const escalatedTotals = new WeakMap<EscalatedNudgeRow[], number>();

/** How many people are waiting in the whole escalation queue, not only the page that was read. */
export function escalatedNudgeTotal(rows: EscalatedNudgeRow[]): number {
  return escalatedTotals.get(rows) ?? rows.length;
}
