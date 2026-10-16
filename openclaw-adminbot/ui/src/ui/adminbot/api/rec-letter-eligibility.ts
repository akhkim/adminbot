// AdminBot client: recommendation-letter eligibility and the freeze incidents behind it.
//
// Mirrors the eligibility and freeze-incident routes in the service's api/routes/logistics.ts.
// Advisory reads only, apart from the admin's record and delete: nothing here can hold up a
// letter request, and the service, not this file, decides who may read what. A member's own read
// comes back already stripped of incident ids and notes.
import { authedJson, type AuthResult, calendarFailure } from "../auth/session.ts";

export type RecLetterEligibilityStatus = "eligible" | "frozen" | "not_yet" | "insufficient_data";
export type RecLetterCriterionStatus = "met" | "not_met" | "insufficient_data";

export type RecLetterHoursMonth = {
  month: string;
  average_weekly_hours: number;
  qualifies: boolean;
};

export type RecLetterAttendanceWindow = {
  start_month: string;
  end_month: string;
  mondays_held: number;
  mondays_with_roster: number;
  mondays_present: number;
  wednesday_weeks_held: number;
  wednesday_weeks_with_roster: number;
  wednesday_weeks_present: number;
  monday_rate: number | null;
  wednesday_rate: number | null;
  monday_coverage: number | null;
  wednesday_coverage: number | null;
  assessable: boolean;
  passes: boolean;
};

export type RecLetterEligibilityGap =
  | { code: "frozen"; frozen_until: string }
  | { code: "hours_no_data" }
  | { code: "hours_short"; qualifying_months: number; required_months: number }
  | { code: "attendance_no_window" }
  | { code: "attendance_below_threshold" };

export type RecLetterEligibility = {
  member_id: string;
  status: RecLetterEligibilityStatus;
  as_of: string;
  advisory: true;
  is_alumni: boolean;
  /** An admin read also carries the latest incident's id and the count; a member's never does. */
  freeze: {
    frozen: boolean;
    frozen_until?: string;
    latest_incident_id?: string;
    incident_count?: number;
  };
  hours: {
    status: RecLetterCriterionStatus;
    qualifying_months: number;
    required_months: number;
    min_weekly_hours: number;
    months: RecLetterHoursMonth[];
  };
  attendance: {
    status: RecLetterCriterionStatus;
    min_rate: number;
    min_roster_coverage: number;
    window_months: number;
    best_window: RecLetterAttendanceWindow | null;
    windows_assessed: number;
    windows_considered: number;
  };
  missing: RecLetterEligibilityGap[];
};

export type RecLetterFreezeIncident = {
  id: string;
  member_id: string;
  kind: "hallucinated_citation_desk_rejection";
  occurred_on: string;
  paper_id?: string;
  note?: string;
  created_by: string;
  created_at: string;
};

export type RecLetterFreezeIncidentInput = {
  member_id: string;
  occurred_on: string;
  paper_id?: string;
  note?: string;
};

export type RecLetterAdminEligibility = {
  member: { id: string; name: string };
  eligibility: RecLetterEligibility;
  incidents: RecLetterFreezeIncident[];
};

export type RecLetterEligibilitySummary = {
  member_id: string;
  status: RecLetterEligibilityStatus;
  frozen_until?: string;
};

async function call<T>(
  baseUrl: string,
  path: string,
  method: "GET" | "POST" | "DELETE",
  sessionToken: string,
  body?: unknown,
): Promise<AuthResult<T>> {
  const result = await authedJson(baseUrl, path, method, sessionToken, body);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as T };
}

/** The caller's own result. The session decides whose; there is no parameter to get it wrong. */
export function fetchOwnRecLetterEligibility(sessionToken: string, baseUrl: string) {
  return call<RecLetterEligibility>(baseUrl, "/logistics/eligibility/me", "GET", sessionToken);
}

/** Admin-only: the full result for one member, found by member or by one of their requests. */
export function fetchRecLetterEligibility(
  target: { memberId: string } | { requestId: string },
  sessionToken: string,
  baseUrl: string,
) {
  const query =
    "memberId" in target
      ? `member_id=${encodeURIComponent(target.memberId)}`
      : `request_id=${encodeURIComponent(target.requestId)}`;
  return call<RecLetterAdminEligibility>(
    baseUrl,
    `/logistics/eligibility?${query}`,
    "GET",
    sessionToken,
  );
}

/** Admin-only: one status per member, for the queue's badges. The service caps the batch. */
export async function fetchRecLetterEligibilitySummaries(
  memberIds: readonly string[],
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<RecLetterEligibilitySummary[]>> {
  const result = await call<{ summaries?: RecLetterEligibilitySummary[] }>(
    baseUrl,
    `/logistics/eligibility/summary?member_ids=${memberIds.map(encodeURIComponent).join(",")}`,
    "GET",
    sessionToken,
  );
  return result.ok ? { ok: true, value: result.value.summaries ?? [] } : result;
}

export async function fetchRecLetterFreezeIncidents(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<RecLetterFreezeIncident[]>> {
  const result = await call<{ incidents?: RecLetterFreezeIncident[] }>(
    baseUrl,
    "/logistics/freeze-incidents",
    "GET",
    sessionToken,
  );
  return result.ok ? { ok: true, value: result.value.incidents ?? [] } : result;
}

export function createRecLetterFreezeIncident(
  input: RecLetterFreezeIncidentInput,
  sessionToken: string,
  baseUrl: string,
) {
  return call<RecLetterFreezeIncident>(
    baseUrl,
    "/logistics/freeze-incidents",
    "POST",
    sessionToken,
    {
      ...input,
      kind: "hallucinated_citation_desk_rejection",
    },
  );
}

export function deleteRecLetterFreezeIncident(id: string, sessionToken: string, baseUrl: string) {
  return call<{ deleted: boolean; id: string }>(
    baseUrl,
    `/logistics/freeze-incidents/${encodeURIComponent(id)}`,
    "DELETE",
    sessionToken,
  );
}
