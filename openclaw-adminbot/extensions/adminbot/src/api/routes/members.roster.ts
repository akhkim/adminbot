// Paged table read, separated from members.ts so the unpaged agent/summary APIs stay unchanged.
import { redactConfidentialMemberFields } from "../../contracts/actions.js";
import { memberRosterFilterKeys, type MemberRosterFilters } from "../../contracts/member-roster.js";
import { memberAttends } from "../../workflows/calendar/standing-meetings.js";
import { sendJson } from "../server.http.js";
import { readStandingMeetings } from "./meetings.js";
import { readListPage } from "./query-params.js";
import { get } from "./router.js";

export const memberRosterRoute = get(
  "/lab/members/roster",
  async ({ res, url, ctx, principal }) => {
    const page = readListPage(url) ?? { limit: 50, offset: 0 };
    const filters: MemberRosterFilters = {};
    for (const key of memberRosterFilterKeys) {
      const value = url.searchParams.get(key)?.trim();
      if (value) {
        filters[key] = value;
      }
    }
    if (page === "invalid" || Object.values(filters).some((value) => value.length > 500)) {
      sendJson(res, 400, { error: { message: "invalid roster filters or pagination" } });
      return;
    }
    let meetingMembers: Set<string> | undefined;
    if (filters.meeting) {
      if (principal.kind !== "member" || principal.member.privilege_level !== "admin") {
        sendJson(res, 403, { error: { message: "the meeting filter needs an admin session" } });
        return;
      }
      const standing = await readStandingMeetings(ctx);
      if ("error" in standing) {
        sendJson(res, standing.error.status, { error: { message: standing.error.message } });
        return;
      }
      const meeting = standing.meetings.find((entry) => entry.id === filters.meeting);
      if (meeting) {
        meetingMembers = new Set(
          ctx.store
            .listLabMembers()
            .filter((member) => memberAttends(meeting, member))
            .map((member) => member.id),
        );
      } else {
        delete filters.meeting;
      }
    }
    const result = ctx.service.listMemberRoster({ ...page, filters }, meetingMembers);
    sendJson(res, 200, {
      ...result,
      members: result.members.map((member) =>
        redactConfidentialMemberFields(member, {
          ...(principal.kind === "member" ? { memberId: principal.member.id } : {}),
          isAdmin: principal.kind === "member" && principal.member.privilege_level === "admin",
          isMemberSession: principal.kind === "member",
        }),
      ),
    });
  },
);
