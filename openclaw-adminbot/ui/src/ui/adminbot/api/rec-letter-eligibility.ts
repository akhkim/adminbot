// AdminBot client: recommendation-letter eligibility, the freeze incidents and the admin
// attestations behind it.
//
// Mirrors the eligibility, freeze-incident and attestation routes in the service's
// api/routes/logistics.ts. Advisory reads only, apart from the admin's records and deletes:
// nothing here can hold up a letter request, and the service, not this file, decides who may read
// what. A member's own read comes back already stripped of incident ids and admin notes.
import { authedJson, type AuthResult, calendarFailure } from "../auth/session.ts";

export type RecLetterEligibilityStatus = "eligible" | "frozen" | "not_yet" | "insufficient_data";
export type RecLetterCriterionStatus = "met" | "not_met" | "insufficient_data";

export type RecLetterHoursMonth = {
  month: string;
  /** False when no availability row covers the month: unknown, not zero hours. */
  has_data?: boolean;
  average_weekly_hours: number | null;
  qualifies: boolean;
};

/** An admin's confirmation of a criterion. A member's read carries only the id and the time. */
export type RecLetterAttested = {
  attestation_id: string;
  at: string;
  by?: string;
  note?: string;
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
  | {
      code: "hours_not_enough_history";
      qualifying_months: number;
      required_months: number;
      months_without_data: string[];
    }
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
    months_with_data?: number;
    /** YYYY-MM months no availability row covers. */
    months_without_data?: string[];
    months: RecLetterHoursMonth[];
    attested?: RecLetterAttested;
  };
  attendance: {
    status: RecLetterCriterionStatus;
    /** Whether attendance counts toward the verdict. Off until attendance is tracked. */
    counted?: boolean;
    attested?: RecLetterAttested;
    min_rate: number;
    min_roster_coverage: number;
    window_months: number;
    best_window: RecLetterAttendanceWindow | null;
    windows_assessed: number;
    windows_considered: number;
  };
  missing: RecLetterEligibilityGap[];
};

const STATUSES: ReadonlySet<string> = new Set([
  "eligible",
  "frozen",
  "not_yet",
  "insufficient_data",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a body is a whole eligibility result, every part the views read present.
 *
 * A 200 is not proof of shape: a service older than these routes, a proxy's catch-all, or a body
 * written before a field existed can all answer one. Anything short of the whole result is treated
 * as no result, so the views draw "unavailable" rather than read a field that is not there.
 */
export function isRecLetterEligibility(value: unknown): value is RecLetterEligibility {
  if (!isRecord(value) || typeof value.status !== "string" || !STATUSES.has(value.status)) {
    return false;
  }
  const { freeze, hours, attendance, missing } = value;
  return (
    typeof value.as_of === "string" &&
    isRecord(freeze) &&
    typeof freeze.frozen === "boolean" &&
    isRecord(hours) &&
    typeof hours.status === "string" &&
    typeof hours.required_months === "number" &&
    typeof hours.min_weekly_hours === "number" &&
    Array.isArray(hours.months) &&
    isRecord(attendance) &&
    typeof attendance.status === "string" &&
    typeof attendance.window_months === "number" &&
    typeof attendance.min_rate === "number" &&
    typeof attendance.min_roster_coverage === "number" &&
    (attendance.best_window === null || isRecord(attendance.best_window)) &&
    Array.isArray(missing)
  );
}

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

export type RecLetterAttestationCriterion = "hours" | "attendance";

export type RecLetterAttestation = {
  id: string;
  member_id: string;
  criterion: RecLetterAttestationCriterion;
  note?: string;
  created_by: string;
  created_at: string;
};

export type RecLetterAdminEligibility = {
  member: { id: string; name: string };
  eligibility: RecLetterEligibility;
  incidents: RecLetterFreezeIncident[];
  attestations: RecLetterAttestation[];
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
export async function fetchOwnRecLetterEligibility(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<RecLetterEligibility | null>> {
  const result = await call<unknown>(baseUrl, "/logistics/eligibility/me", "GET", sessionToken);
  return result.ok
    ? { ok: true, value: isRecLetterEligibility(result.value) ? result.value : null }
    : result;
}

/** Admin-only: the full result for one member, found by member or by one of their requests. */
export async function fetchRecLetterEligibility(
  target: { memberId: string } | { requestId: string },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<RecLetterAdminEligibility | null>> {
  const query =
    "memberId" in target
      ? `member_id=${encodeURIComponent(target.memberId)}`
      : `request_id=${encodeURIComponent(target.requestId)}`;
  const result = await call<unknown>(
    baseUrl,
    `/logistics/eligibility?${query}`,
    "GET",
    sessionToken,
  );
  if (!result.ok) {
    return result;
  }
  const body = result.value;
  return {
    ok: true,
    value:
      isRecord(body) && isRecord(body.member) && isRecLetterEligibility(body.eligibility)
        ? {
            member: body.member as RecLetterAdminEligibility["member"],
            eligibility: body.eligibility,
            incidents: Array.isArray(body.incidents)
              ? (body.incidents as RecLetterFreezeIncident[])
              : [],
            attestations: Array.isArray(body.attestations)
              ? (body.attestations as RecLetterAttestation[])
              : [],
          }
        : null,
  };
}

/** Admin-only: one status per member, for the queue's badges. The service caps the batch. */
export async function fetchRecLetterEligibilitySummaries(
  memberIds: readonly string[],
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<RecLetterEligibilitySummary[]>> {
  const result = await call<unknown>(
    baseUrl,
    `/logistics/eligibility/summary?member_ids=${memberIds.map(encodeURIComponent).join(",")}`,
    "GET",
    sessionToken,
  );
  if (!result.ok) {
    return result;
  }
  const summaries = isRecord(result.value) ? result.value.summaries : undefined;
  return {
    ok: true,
    value: Array.isArray(summaries)
      ? summaries.filter(
          (entry): entry is RecLetterEligibilitySummary =>
            isRecord(entry) &&
            typeof entry.member_id === "string" &&
            typeof entry.status === "string" &&
            STATUSES.has(entry.status),
        )
      : [],
  };
}

export async function fetchRecLetterFreezeIncidents(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<RecLetterFreezeIncident[]>> {
  const result = await call<unknown>(baseUrl, "/logistics/freeze-incidents", "GET", sessionToken);
  return result.ok
    ? {
        ok: true,
        value:
          isRecord(result.value) && Array.isArray(result.value.incidents)
            ? (result.value.incidents as RecLetterFreezeIncident[])
            : [],
      }
    : result;
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

/** Admin-only: confirm that a member meets a criterion the records cannot show. */
export function createRecLetterAttestation(
  input: { member_id: string; criterion: RecLetterAttestationCriterion; note?: string },
  sessionToken: string,
  baseUrl: string,
) {
  return call<RecLetterAttestation>(
    baseUrl,
    "/logistics/eligibility-attestations",
    "POST",
    sessionToken,
    input,
  );
}

export function deleteRecLetterAttestation(id: string, sessionToken: string, baseUrl: string) {
  return call<{ deleted: boolean; id: string }>(
    baseUrl,
    `/logistics/eligibility-attestations/${encodeURIComponent(id)}`,
    "DELETE",
    sessionToken,
  );
}
