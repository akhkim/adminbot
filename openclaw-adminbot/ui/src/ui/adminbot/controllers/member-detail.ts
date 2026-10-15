// Whole member records, read when a view opens one.
//
// The shared roster (GET /lab/members?view=summary) carries only what list cells and pickers show;
// see extensions/adminbot/src/api/routes/member-summary-row.ts. The two admin views that need more
// than that read it here instead: Time Availability reads the one schedule it is showing, and the
// Lab Members duplicate check reads its pairs whole, because "Only here: ..." compares every field.
//
// Same shape as the meetings roster (controllers/meetings.ts): read on intent and on open, once per
// member per roster load (loadAdminBot drops them with the rows), and dropped when the session that
// asked is gone. Without a session (gateway
// mode) the roster rows are already whole, so both reads are no-ops and the rows stand.
import type { MemberDuplicatePair } from "../../../../../extensions/adminbot/src/contracts/member-duplicates.js";
import {
  fetchMemberResource,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
} from "../auth/session.ts";
import type { AdminBotHost, AdminBotLabMember } from "./admin.ts";

export type AdminBotMemberDetails = Record<
  string,
  {
    session: string;
    member?: AdminBotLabMember;
    loading?: boolean;
    report?: boolean;
    /** The last read failed; only a pick or a refresh asks again, never a re-render. */
    failed?: boolean;
  }
>;

export type AdminBotDuplicatePairs = {
  /** The roster read these pairs belong to; a reload of the roster asks again. */
  rosterLoadedAt: number;
  pairs?: MemberDuplicatePair<AdminBotLabMember>[];
};

function sessionToken(): string | undefined {
  return loadStoredMemberSession()?.sessionToken;
}

function setDetail(host: AdminBotHost, memberId: string, entry: AdminBotMemberDetails[string]) {
  host.adminBotMemberDetails = { ...host.adminBotMemberDetails, [memberId]: entry };
  host.requestUpdate?.();
}

/**
 * Read one member's whole record. `report` is false for a hover or a highlighted row: a failed
 * prefetch of somebody nobody picked is not worth a banner. Picking them, or opening the page on
 * them, reports. `retry` is for a pick: a render that finds a failed read leaves it failed, so a
 * service that is down is not asked again on every paint.
 */
export async function loadAdminBotMemberDetail(
  host: AdminBotHost,
  memberId: string,
  options: { report: boolean; retry?: boolean },
): Promise<void> {
  const token = sessionToken();
  if (!token || !memberId) {
    return;
  }
  const held = host.adminBotMemberDetails?.[memberId];
  if (held?.session === token && (held.member || held.loading || (held.failed && !options.retry))) {
    if (held.loading && options.report) {
      held.report = true;
    }
    return;
  }
  const pending = { session: token, loading: true, report: options.report };
  setDetail(host, memberId, pending);
  const result = await fetchMemberResource(
    `/lab/members/${encodeURIComponent(memberId)}/detail`,
    token,
    resolveAdminBotBaseUrl(host.settings),
  );
  if (sessionToken() !== token || host.adminBotMemberDetails?.[memberId] !== pending) {
    return;
  }
  const member = result.ok ? (result.value as { member?: AdminBotLabMember }).member : undefined;
  setDetail(host, memberId, member ? { session: token, member } : { session: token, failed: true });
  if (!member && pending.report) {
    host.adminBotError = "Could not load this member's schedule. Please try again.";
  }
}

/** The roster with any whole records this session has read laid over their rows. */
export function withMemberDetails(
  host: AdminBotHost,
  members: AdminBotLabMember[],
): AdminBotLabMember[] {
  const token = sessionToken();
  const details = host.adminBotMemberDetails ?? {};
  return members.map((row) => {
    const entry = details[row.id];
    return entry?.member && entry.session === token ? { ...row, ...entry.member } : row;
  });
}

/**
 * The duplicate pairs for the roster this session has loaded, read whole from the service.
 *
 * Undefined without a session: the gateway's roster rows are whole, so the view pairs them itself.
 * Null while the read is out or failed, so the view shows nothing rather than pairs built from
 * summary rows, whose "Only here" would list fields the row simply did not carry.
 */
export function adminBotDuplicatePairs(
  host: AdminBotHost,
  onLoaded: () => void,
): MemberDuplicatePair<AdminBotLabMember>[] | null | undefined {
  const token = sessionToken();
  const rosterLoadedAt = host.adminBotRosterLoadedAt;
  if (!token || !rosterLoadedAt) {
    return undefined;
  }
  const held = host.adminBotDuplicatePairs;
  if (held?.rosterLoadedAt === rosterLoadedAt) {
    return held.pairs ?? null;
  }
  const pending: AdminBotDuplicatePairs = { rosterLoadedAt };
  host.adminBotDuplicatePairs = pending;
  void fetchMemberResource("/lab/members/duplicates", token, resolveAdminBotBaseUrl(host.settings))
    .then((result) => {
      if (sessionToken() !== token || host.adminBotDuplicatePairs !== pending) {
        return;
      }
      if (!result.ok) {
        host.adminBotError = "Could not check the roster for duplicate records. Please try again.";
        return;
      }
      host.adminBotDuplicatePairs = {
        rosterLoadedAt,
        pairs: (result.value as { pairs?: MemberDuplicatePair<AdminBotLabMember>[] }).pairs ?? [],
      };
    })
    .finally(onLoaded);
  return null;
}
