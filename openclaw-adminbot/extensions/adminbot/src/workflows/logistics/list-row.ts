import type { AdminBotLogisticsRequest } from "../../contracts/actions.js";

/**
 * A logistics request as GET /logistics/requests sends it: one row of a queue.
 *
 * The queue, the member's own list and the professor's letter card draw who asked, what kind, the
 * soonest deadline, the status and whether the signed copy went out; the search reads school names.
 * Everything else -- the description, the facts, the links, the file names, the lab's answer --
 * is drawn only once a request is opened, and opening one is already its own read
 * (GET /logistics/requests/:id) because that is the read that carries the files. So the list keeps
 * the queue's columns and, on each school and meeting, only what the deadline is computed from.
 */
export type AdminBotLogisticsListRow = Pick<
  AdminBotLogisticsRequest,
  | "id"
  | "kind"
  | "member_id"
  | "member_name"
  | "status"
  | "submitted_at"
  | "updated_at"
  | "deadline_at"
  | "signed_sent_at"
  | "signed_sent_to"
> & {
  schools?: Array<
    Pick<
      NonNullable<AdminBotLogisticsRequest["schools"]>[number],
      "school" | "letter_deadline" | "letter_deadline_time" | "deadline_timezone"
    >
  >;
  meetings?: Array<
    Pick<
      NonNullable<AdminBotLogisticsRequest["meetings"]>[number],
      "purpose" | "preferred_time" | "timezone"
    >
  >;
};

function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

export function logisticsListRow(request: AdminBotLogisticsRequest): AdminBotLogisticsListRow {
  return defined({
    id: request.id,
    kind: request.kind,
    member_id: request.member_id,
    member_name: request.member_name,
    status: request.status,
    submitted_at: request.submitted_at,
    updated_at: request.updated_at,
    deadline_at: request.deadline_at,
    signed_sent_at: request.signed_sent_at,
    signed_sent_to: request.signed_sent_to,
    schools: request.schools?.map((school) =>
      defined({
        school: school.school,
        letter_deadline: school.letter_deadline,
        letter_deadline_time: school.letter_deadline_time,
        deadline_timezone: school.deadline_timezone,
      }),
    ),
    meetings: request.meetings?.map((meeting) =>
      defined({
        purpose: meeting.purpose,
        preferred_time: meeting.preferred_time,
        timezone: meeting.timezone,
      }),
    ),
  });
}
