// Whether a member currently meets the lab's bar for a recommendation letter.
//
// The policy has three clauses, and each one maps to a section below:
//
//   1. Freeze. A desk rejection caused by a hallucinated citation freezes the member for one year
//      from the latest such incident. A new incident restarts the clock. Frozen beats everything.
//   2a. Hours. At least five calendar months -- not necessarily consecutive -- in which the member
//      committed 20 or more hours a week.
//   2b. Attendance. Some window of three consecutive calendar months in which the member was at 80%
//      of the Monday group meetings, and at a Wednesday meeting in 80% of the weeks that had one.
//
// Advisory only. Nothing here refuses a request: the result is shown to the admin deciding, and to
// the member asking, and the decision stays with the lab.
//
// Two of the inputs are weaker than their names suggest, and the result is worded around that.
// Hours are *committed* hours -- what the member planned on the availability page -- not time
// anybody logged, and a month no row covers is unknown rather than zero: the page is newer than
// most members' time in the lab. Members can backfill past months as dated rows, and an admin can
// confirm a criterion outright (an attestation), which counts it as met and labels it as such.
//
// Attendance is not counted yet (`adminBotRecLetterAttendanceEnabled`): it is still worked out and
// shown to admins, but it never moves the headline until rosters are reliable. Attendance is only as complete as the Zoom participant CSVs somebody exported,
// so a meeting with no roster says nothing about anybody: it is left out of the rate, and a window
// in which too few meetings have a roster is not judged at all rather than judged as a miss.
//
// Pure: the member, the incidents, the meetings and the instant all arrive as arguments. The
// service does the reads, which is what lets every edge below be tested without a store or a clock.
import {
  adminBotIsAlumniMember,
  type AdminBotAvailabilityRow,
  type AdminBotLabMember,
  type AdminBotMeetingRecord,
} from "../../contracts/actions.js";
import {
  adminBotRecLetterAttestationCriteria,
  type AdminBotRecLetterAttestation,
  type AdminBotRecLetterAttestationCriterion,
  type AdminBotRecLetterAttestationInput,
} from "../../contracts/rec-letter-attestations.js";
import {
  adminBotRecLetterFreezeIncidentKinds,
  type AdminBotRecLetterFreezeIncident,
  type AdminBotRecLetterFreezeIncidentInput,
} from "../../contracts/rec-letter-freezes.js";
import { couldHaveAttended, hasKnownAttendance, wasPresent } from "../meetings/attendance-nudge.js";

/** The lab runs on Toronto time; a meeting's weekday and month are read there. */
export const adminBotRecLetterEligibilityTimeZone = "America/Toronto";

/** How long a freeze lasts after the incident that started it. */
export const adminBotRecLetterFreezeYears = 1;

/** Committed hours per week a month must average to count. */
export const adminBotRecLetterMinWeeklyHours = 20;

/** How many such months the policy asks for. They need not be consecutive. */
export const adminBotRecLetterRequiredHourMonths = 5;

/** Consecutive calendar months an attendance window spans. */
export const adminBotRecLetterAttendanceWindowMonths = 3;

/** The share of Monday meetings, and of Wednesday weeks, the member must have attended. */
export const adminBotRecLetterMinAttendanceRate = 0.8;

/**
 * The share of a window's meetings that must have a known roster before the window is judged.
 *
 * Below this the rate is a guess from a handful of exported CSVs: a member at every meeting could
 * look absent, or one present at the two that were exported could look perfect. Such a window is
 * "not enough data", never a fail.
 */
export const adminBotRecLetterMinRosterCoverage = 0.7;

/**
 * Whether attendance counts toward the verdict.
 *
 * Off until meeting attendance is tracked reliably. While off, attendance is still worked out for
 * the admin's reading, but it adds nothing to `missing` and never makes the headline "not yet" or
 * "not enough data". Turning it on is this one line.
 */
export const adminBotRecLetterAttendanceEnabled = false;

/** How many members one badge read may ask about: a page of the queue, with room to spare. */
export const adminBotRecLetterSummaryLimit = 100;

export type RecLetterCriterionStatus = "met" | "not_met" | "insufficient_data";

export type RecLetterEligibilityStatus = "eligible" | "frozen" | "not_yet" | "insufficient_data";

export type RecLetterFreezeResult = {
  frozen: boolean;
  /** YYYY-MM-DD, the first day the member is no longer frozen. Absent with no incidents on file. */
  frozen_until?: string;
  /** The incident the clock runs from. Admin detail; the member's view drops it. */
  latest_incident_id?: string;
  /** How many incidents are on file. Admin detail; the member's view drops it. */
  incident_count?: number;
};

/** An admin's confirmation that a criterion is met, as the result carries it. */
export type RecLetterAttested = {
  attestation_id: string;
  /** When it was recorded. */
  at: string;
  /** Who recorded it. Admin detail; the member's view drops it. */
  by?: string;
  /** Why. Admin detail; the member's view drops it. */
  note?: string;
};

export type RecLetterHoursMonth = {
  /** YYYY-MM. */
  month: string;
  /** False when no availability row covers any day of the month: unknown, not zero hours. */
  has_data: boolean;
  /** Average committed hours per week across the month, one decimal. Null without data. */
  average_weekly_hours: number | null;
  qualifies: boolean;
};

export type RecLetterHoursResult = {
  /** "met" when attested, whatever the rows say. */
  status: RecLetterCriterionStatus;
  qualifying_months: number;
  required_months: number;
  min_weekly_hours: number;
  /** Months in the range that some row covers, and the YYYY-MM of those none does. */
  months_with_data: number;
  months_without_data: string[];
  /** Every completed month in the member's range, oldest first. */
  months: RecLetterHoursMonth[];
  attested?: RecLetterAttested;
};

export type RecLetterAttendanceWindow = {
  /** YYYY-MM of the window's first and last month. */
  start_month: string;
  end_month: string;
  /** Distinct Mondays with a recorded meeting the member could have attended. */
  mondays_held: number;
  mondays_with_roster: number;
  mondays_present: number;
  /** Distinct weeks with a recorded Wednesday meeting the member could have attended. */
  wednesday_weeks_held: number;
  wednesday_weeks_with_roster: number;
  wednesday_weeks_present: number;
  /** Rates are over the rostered meetings only, 0..1. Null when nothing was rostered. */
  monday_rate: number | null;
  wednesday_rate: number | null;
  monday_coverage: number | null;
  wednesday_coverage: number | null;
  /** Enough rosters to judge, by `adminBotRecLetterMinRosterCoverage`. */
  assessable: boolean;
  passes: boolean;
};

export type RecLetterAttendanceResult = {
  /** "met" when attested, whatever the rosters say. */
  status: RecLetterCriterionStatus;
  /** Whether this criterion counts toward the verdict: `adminBotRecLetterAttendanceEnabled`. */
  counted: boolean;
  attested?: RecLetterAttested;
  min_rate: number;
  min_roster_coverage: number;
  window_months: number;
  /** The passing window with the best weaker rate; else the best judged one; else none. */
  best_window: RecLetterAttendanceWindow | null;
  windows_assessed: number;
  windows_considered: number;
};

/** What stands between the member and "eligible", one entry per gap. Codes are for the UI. */
export type RecLetterEligibilityGap =
  | { code: "frozen"; frozen_until: string }
  | {
      code: "hours_not_enough_history";
      qualifying_months: number;
      required_months: number;
      /** YYYY-MM months that no availability row covers; backfilling them may settle it. */
      months_without_data: string[];
    }
  | { code: "hours_short"; qualifying_months: number; required_months: number }
  | { code: "attendance_no_window" }
  | { code: "attendance_below_threshold" };

export type RecLetterEligibility = {
  member_id: string;
  status: RecLetterEligibilityStatus;
  /** YYYY-MM-DD in Toronto: the day this was worked out for. */
  as_of: string;
  advisory: true;
  is_alumni: boolean;
  freeze: RecLetterFreezeResult;
  hours: RecLetterHoursResult;
  attendance: RecLetterAttendanceResult;
  missing: RecLetterEligibilityGap[];
};

export type RecLetterEligibilityInput = {
  member: AdminBotLabMember;
  /** May hold other members' incidents; only this member's are read. */
  incidents: readonly AdminBotRecLetterFreezeIncident[];
  meetings: readonly AdminBotMeetingRecord[];
  /** May hold other members' attestations; only this member's are read. */
  attestations?: readonly AdminBotRecLetterAttestation[];
  now: Date;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

function validDate(value: string | undefined): value is string {
  if (!value || !DATE_RE.test(value)) {
    return false;
  }
  const [y, m, d] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}

function validMonth(value: string | undefined): value is string {
  if (!value || !MONTH_RE.test(value)) {
    return false;
  }
  const month = Number(value.slice(5, 7));
  return month >= 1 && month <= 12;
}

type ZonedDay = { date: string; month: string; weekday: string };

const zonedFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: adminBotRecLetterEligibilityTimeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
});

/**
 * The Toronto calendar day an instant falls on. Null for anything that does not parse.
 *
 * Exported for the tests that pin the daylight-saving edges: a Monday-evening meeting is Tuesday
 * in UTC, and the weekday has to be read where the meeting happened.
 */
export function recLetterMeetingDay(instant: Date): ZonedDay | null {
  if (Number.isNaN(instant.getTime())) {
    return null;
  }
  const parts = Object.fromEntries(
    zonedFormatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, month: date.slice(0, 7), weekday: parts.weekday };
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1 + delta, 1));
  return shifted.toISOString().slice(0, 7);
}

function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function monthsBetween(first: string, last: string): string[] {
  const months: string[] = [];
  for (let month = first; month <= last; month = shiftMonth(month, 1)) {
    months.push(month);
  }
  return months;
}

/**
 * The same calendar day a year on.
 *
 * A 29 February incident ends on 1 March: a frozen-until date that does not exist would leave the
 * member frozen by a string comparison nobody can read off a calendar.
 */
function addYears(date: string, years: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y + years, m - 1, d)).toISOString().slice(0, 10);
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// 1. Freeze
// ---------------------------------------------------------------------------

/**
 * Frozen from the latest incident until the same day a year later, exclusive.
 *
 * "Latest" rather than "first plus one year per incident": the policy says a new incident restarts
 * the clock, which is a reset, not a sentence added on top.
 */
export function recLetterFreeze(
  memberId: string,
  incidents: readonly AdminBotRecLetterFreezeIncident[],
  today: string,
): RecLetterFreezeResult {
  const own = incidents.filter(
    (incident) => incident.member_id === memberId && validDate(incident.occurred_on),
  );
  if (!own.length) {
    return { frozen: false, incident_count: 0 };
  }
  const latest = own.reduce((best, incident) =>
    incident.occurred_on > best.occurred_on ? incident : best,
  );
  const frozenUntil = addYears(latest.occurred_on, adminBotRecLetterFreezeYears);
  return {
    frozen: today < frozenUntil,
    frozen_until: frozenUntil,
    latest_incident_id: latest.id,
    incident_count: own.length,
  };
}

// ---------------------------------------------------------------------------
// 2a. Committed hours
// ---------------------------------------------------------------------------

function usableRows(
  rows: readonly AdminBotAvailabilityRow[] | undefined,
): AdminBotAvailabilityRow[] {
  return (rows ?? []).filter(
    (row) =>
      validDate(row.start) &&
      validDate(row.end) &&
      row.start <= row.end &&
      Number.isFinite(row.hours_per_week) &&
      row.hours_per_week >= 0 &&
      row.hours_per_week <= 168,
  );
}

/**
 * Average committed hours per week across one calendar month.
 *
 * Worked out per day and averaged over the month's days, which is the same number as averaging over
 * its weeks -- a month is 4 3/7 weeks, not four, and a row that covers half of it should count for
 * half. Rows that overlap add up: a term baseline and a project row for the same week are two
 * commitments, which is how the availability page draws them too.
 */
export function averageWeeklyCommittedHours(
  rows: readonly AdminBotAvailabilityRow[],
  month: string,
): number {
  const days = daysInMonth(month);
  const first = `${month}-01`;
  const last = `${month}-${String(days).padStart(2, "0")}`;
  let total = 0;
  for (const row of rows) {
    const from = row.start > first ? row.start : first;
    const to = row.end < last ? row.end : last;
    if (from > to) {
      continue;
    }
    const covered = Number(to.slice(8, 10)) - Number(from.slice(8, 10)) + 1;
    total += row.hours_per_week * covered;
  }
  return total / days;
}

/**
 * The months a member's hours are counted over: joined to graduated, or to last month.
 *
 * Only finished months count. A month still under way could pass on what was planned for its first
 * week and then not happen; it counts once it is over.
 */
function hourMonths(
  member: AdminBotLabMember,
  rows: readonly AdminBotAvailabilityRow[],
  currentMonth: string,
): string[] {
  const earliestRow = rows.reduce<string | undefined>(
    (min, row) => (!min || row.start < min ? row.start : min),
    undefined,
  );
  const joined = member.joined_month?.trim();
  const first = joined && validMonth(joined) ? joined : earliestRow?.slice(0, 7);
  if (!first) {
    return [];
  }
  const lastFinished = shiftMonth(currentMonth, -1);
  const graduated = member.graduated_month?.trim();
  const last = validMonth(graduated) && graduated < lastFinished ? graduated : lastFinished;
  return first <= last ? monthsBetween(first, last) : [];
}

/**
 * True when some row covers at least one day of the month. A month nobody wrote anything for is
 * unknown, not a month at zero hours: the availability page is newer than most members' time in
 * the lab, and counting the months before it as zero is what made long-standing members look short.
 */
function monthHasData(rows: readonly AdminBotAvailabilityRow[], month: string): boolean {
  const first = `${month}-01`;
  const last = `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
  return rows.some((row) => row.start <= last && row.end >= first);
}

/**
 * The hours criterion.
 *
 * "Met" with enough qualifying months. "Not met" only when the record could not get there: at
 * least the required number of months have data, and even counting every unknown month as a
 * qualifying one the member would still fall short. Anything else is "not enough data" -- too
 * little history to say no, or gaps that backfilling could fill.
 */
export function recLetterHours(member: AdminBotLabMember, today: string): RecLetterHoursResult {
  const rows = usableRows(member.availability);
  const base = {
    required_months: adminBotRecLetterRequiredHourMonths,
    min_weekly_hours: adminBotRecLetterMinWeeklyHours,
  };
  const months: RecLetterHoursMonth[] = hourMonths(member, rows, today.slice(0, 7)).map((month) => {
    if (!monthHasData(rows, month)) {
      return { month, has_data: false, average_weekly_hours: null, qualifies: false };
    }
    const average = averageWeeklyCommittedHours(rows, month);
    return {
      month,
      has_data: true,
      average_weekly_hours: round(average, 1),
      // Judged on the unrounded figure, so 19.96 does not round its way over the line.
      qualifies: average >= adminBotRecLetterMinWeeklyHours,
    };
  });
  const qualifying = months.filter((month) => month.qualifies).length;
  const withData = months.filter((month) => month.has_data).length;
  const withoutData = months.filter((month) => !month.has_data).map((month) => month.month);
  const required = adminBotRecLetterRequiredHourMonths;
  const status: RecLetterCriterionStatus =
    qualifying >= required
      ? "met"
      : withData >= required && qualifying + withoutData.length < required
        ? "not_met"
        : "insufficient_data";
  return {
    ...base,
    status,
    qualifying_months: qualifying,
    months_with_data: withData,
    months_without_data: withoutData,
    months,
  };
}

// ---------------------------------------------------------------------------
// 2b. Attendance
// ---------------------------------------------------------------------------

/**
 * One Monday, or one week's Wednesday, as the member's attendance sees it.
 *
 * Meetings are grouped by Toronto date before they are counted: a meeting that was recorded in two
 * parts, or two Wednesday theme meetings on the same day, is still one occasion to attend.
 */
type Occasion = { month: string; rostered: boolean; present: boolean };

function occasions(
  meetings: readonly { day: ZonedDay; meeting: AdminBotMeetingRecord }[],
  member: AdminBotLabMember,
): Occasion[] {
  const byDate = new Map<string, AdminBotMeetingRecord[]>();
  const monthOf = new Map<string, string>();
  for (const { day, meeting } of meetings) {
    byDate.set(day.date, [...(byDate.get(day.date) ?? []), meeting]);
    monthOf.set(day.date, day.month);
  }
  return [...byDate.entries()].map(([date, group]) => {
    const present = group.some(
      (meeting) => hasKnownAttendance(meeting) && wasPresent(meeting, member),
    );
    // Present at any rostered meeting settles the day. Otherwise the day is only known if every
    // meeting on it has a roster: the member may have been at the one nobody exported.
    const rostered = present || group.every(hasKnownAttendance);
    return { month: monthOf.get(date)!, rostered, present };
  });
}

function windowStats(
  start: string,
  end: string,
  mondays: readonly Occasion[],
  wednesdays: readonly Occasion[],
): RecLetterAttendanceWindow {
  const inside = (occasion: Occasion) => occasion.month >= start && occasion.month <= end;
  const count = (list: readonly Occasion[]) => {
    const held = list.filter(inside);
    const rostered = held.filter((occasion) => occasion.rostered);
    return {
      held: held.length,
      rostered: rostered.length,
      present: rostered.filter((occasion) => occasion.present).length,
    };
  };
  const mon = count(mondays);
  const wed = count(wednesdays);
  const ratio = (part: number, whole: number) => (whole ? part / whole : null);
  const mondayCoverage = ratio(mon.rostered, mon.held);
  const wednesdayCoverage = ratio(wed.rostered, wed.held);
  const mondayRate = ratio(mon.present, mon.rostered);
  const wednesdayRate = ratio(wed.present, wed.rostered);
  // Every month of the window needs a Monday on record. A month with none is a gap in what was
  // filed, not a month off, and a "three-month" window resting on two of them is not one.
  const monthsWithMonday = new Set(mondays.filter(inside).map((occasion) => occasion.month));
  const assessable =
    monthsWithMonday.size === adminBotRecLetterAttendanceWindowMonths &&
    mondayCoverage !== null &&
    wednesdayCoverage !== null &&
    mondayCoverage >= adminBotRecLetterMinRosterCoverage &&
    wednesdayCoverage >= adminBotRecLetterMinRosterCoverage &&
    mon.rostered > 0 &&
    wed.rostered > 0;
  const passes =
    assessable &&
    (mondayRate ?? 0) >= adminBotRecLetterMinAttendanceRate &&
    (wednesdayRate ?? 0) >= adminBotRecLetterMinAttendanceRate;
  return {
    start_month: start,
    end_month: end,
    mondays_held: mon.held,
    mondays_with_roster: mon.rostered,
    mondays_present: mon.present,
    wednesday_weeks_held: wed.held,
    wednesday_weeks_with_roster: wed.rostered,
    wednesday_weeks_present: wed.present,
    monday_rate: mondayRate === null ? null : round(mondayRate, 3),
    wednesday_rate: wednesdayRate === null ? null : round(wednesdayRate, 3),
    monday_coverage: mondayCoverage === null ? null : round(mondayCoverage, 3),
    wednesday_coverage: wednesdayCoverage === null ? null : round(wednesdayCoverage, 3),
    assessable,
    passes,
  };
}

function weakerRate(window: RecLetterAttendanceWindow): number {
  return Math.min(window.monday_rate ?? 0, window.wednesday_rate ?? 0);
}

export function recLetterAttendance(
  member: AdminBotLabMember,
  meetings: readonly AdminBotMeetingRecord[],
  today: string,
): RecLetterAttendanceResult {
  const graduated = member.graduated_month?.trim();
  const lastMonth =
    validMonth(graduated) && graduated < today.slice(0, 7) ? graduated : today.slice(0, 7);
  const relevant = meetings.flatMap((meeting) => {
    const day = recLetterMeetingDay(new Date(meeting.started_at));
    if (!day || day.date > today || day.month > lastMonth) {
      return [];
    }
    // Same test the absence nudge uses for "could they have been there", widened by actual
    // presence: somebody seen at a meeting in the month they joined plainly could attend it.
    if (
      !couldHaveAttended(meeting, member) &&
      !(hasKnownAttendance(meeting) && wasPresent(meeting, member))
    ) {
      return [];
    }
    return [{ day, meeting }];
  });
  const mondays = occasions(
    relevant.filter(({ day }) => day.weekday === "Mon"),
    member,
  );
  const wednesdays = occasions(
    relevant.filter(({ day }) => day.weekday === "Wed"),
    member,
  );

  const joined = member.joined_month?.trim();
  const earliestMeeting = relevant.reduce<string | undefined>(
    (min, { day }) => (!min || day.month < min ? day.month : min),
    undefined,
  );
  const firstMonth = validMonth(joined) ? joined : earliestMeeting;
  const windows: RecLetterAttendanceWindow[] = [];
  if (firstMonth) {
    const span = adminBotRecLetterAttendanceWindowMonths - 1;
    for (
      let start = firstMonth;
      shiftMonth(start, span) <= lastMonth;
      start = shiftMonth(start, 1)
    ) {
      windows.push(windowStats(start, shiftMonth(start, span), mondays, wednesdays));
    }
  }
  const assessed = windows.filter((window) => window.assessable);
  const passing = assessed.filter((window) => window.passes);
  // Best weaker rate first; on a tie, the window resting on more rosters, then the most recent.
  const evidence = (window: RecLetterAttendanceWindow) =>
    window.mondays_with_roster + window.wednesday_weeks_with_roster;
  const better = (window: RecLetterAttendanceWindow, best: RecLetterAttendanceWindow) =>
    weakerRate(window) !== weakerRate(best)
      ? weakerRate(window) > weakerRate(best)
      : evidence(window) >= evidence(best);
  const pick = (list: RecLetterAttendanceWindow[]) =>
    list.reduce<RecLetterAttendanceWindow | null>(
      (best, window) => (!best || better(window, best) ? window : best),
      null,
    );
  return {
    status: passing.length ? "met" : assessed.length ? "not_met" : "insufficient_data",
    counted: adminBotRecLetterAttendanceEnabled,
    min_rate: adminBotRecLetterMinAttendanceRate,
    min_roster_coverage: adminBotRecLetterMinRosterCoverage,
    window_months: adminBotRecLetterAttendanceWindowMonths,
    best_window: pick(passing) ?? pick(assessed),
    windows_assessed: assessed.length,
    windows_considered: windows.length,
  };
}

// ---------------------------------------------------------------------------
// 3. Overall
// ---------------------------------------------------------------------------

/** The member's latest attestation for a criterion, as the result carries it. */
function attestedFor(
  memberId: string,
  criterion: AdminBotRecLetterAttestationCriterion,
  attestations: readonly AdminBotRecLetterAttestation[],
): RecLetterAttested | undefined {
  const latest = attestations
    .filter((entry) => entry.member_id === memberId && entry.criterion === criterion)
    .reduce<AdminBotRecLetterAttestation | undefined>(
      (best, entry) => (!best || entry.created_at > best.created_at ? entry : best),
      undefined,
    );
  if (!latest) {
    return undefined;
  }
  return {
    attestation_id: latest.id,
    at: latest.created_at,
    by: latest.created_by,
    ...(latest.note ? { note: latest.note } : {}),
  };
}

/** An attested criterion is met, whatever the data says; the data stays for the admin to read. */
function withAttestation<T extends { status: RecLetterCriterionStatus }>(
  result: T,
  attested: RecLetterAttested | undefined,
): T & { attested?: RecLetterAttested } {
  return attested ? { ...result, status: "met", attested } : result;
}

/**
 * The headline, from the criteria that count: the freeze and hours, and attendance only once
 * `adminBotRecLetterAttendanceEnabled` is on.
 *
 * Precedence: frozen, then eligible when every counted criterion is met, then "not yet" when one
 * is known to fall short, and only then "not enough data". Unknown never reads as "not yet".
 */
export function recLetterHeadline(
  freeze: RecLetterFreezeResult,
  counted: readonly RecLetterCriterionStatus[],
): RecLetterEligibilityStatus {
  if (freeze.frozen) {
    return "frozen";
  }
  if (counted.every((status) => status === "met")) {
    return "eligible";
  }
  if (counted.includes("not_met")) {
    return "not_yet";
  }
  return "insufficient_data";
}

/** The advisory result for one member. */
export function recLetterEligibility(input: RecLetterEligibilityInput): RecLetterEligibility {
  const { member, now } = input;
  const attestations = input.attestations ?? [];
  const today = recLetterMeetingDay(now)?.date ?? now.toISOString().slice(0, 10);
  const freeze = recLetterFreeze(member.id, input.incidents, today);
  const hours = withAttestation(
    recLetterHours(member, today),
    attestedFor(member.id, "hours", attestations),
  );
  const attendance = withAttestation(
    recLetterAttendance(member, input.meetings, today),
    attestedFor(member.id, "attendance", attestations),
  );

  const missing: RecLetterEligibilityGap[] = [];
  if (freeze.frozen && freeze.frozen_until) {
    missing.push({ code: "frozen", frozen_until: freeze.frozen_until });
  }
  if (hours.status === "insufficient_data") {
    missing.push({
      code: "hours_not_enough_history",
      qualifying_months: hours.qualifying_months,
      required_months: hours.required_months,
      months_without_data: hours.months_without_data,
    });
  } else if (hours.status === "not_met") {
    missing.push({
      code: "hours_short",
      qualifying_months: hours.qualifying_months,
      required_months: hours.required_months,
    });
  }
  if (attendance.counted) {
    if (attendance.status === "insufficient_data") {
      missing.push({ code: "attendance_no_window" });
    } else if (attendance.status === "not_met") {
      missing.push({ code: "attendance_below_threshold" });
    }
  }

  const counted = attendance.counted ? [hours.status, attendance.status] : [hours.status];
  return {
    member_id: member.id,
    status: recLetterHeadline(freeze, counted),
    as_of: today,
    advisory: true,
    is_alumni: adminBotIsAlumniMember(member),
    freeze,
    hours,
    attendance,
    missing,
  };
}

/** Who confirmed it and why are the lab's notes; the member keeps that, and when, it was. */
function redactAttested(attested: RecLetterAttested | undefined) {
  return attested ? { attested: { attestation_id: attested.attestation_id, at: attested.at } } : {};
}

/**
 * The member's own copy: the same verdict without the admin's bookkeeping.
 *
 * Which incident, how many, and an expired freeze's end date are the lab's records, not the
 * member's reading. What the member keeps is whether they are frozen and until when, and whether a
 * criterion was confirmed by an admin -- not by whom or with what note.
 */
export function redactRecLetterEligibilityForMember(
  result: RecLetterEligibility,
): RecLetterEligibility {
  const freeze: RecLetterFreezeResult = result.freeze.frozen
    ? { frozen: true, frozen_until: result.freeze.frozen_until }
    : { frozen: false };
  const { attested: hoursAttested, ...hours } = result.hours;
  const { attested: attendanceAttested, ...attendance } = result.attendance;
  return {
    ...result,
    freeze,
    hours: { ...hours, ...redactAttested(hoursAttested) },
    attendance: { ...attendance, ...redactAttested(attendanceAttested) },
  };
}

// ---------------------------------------------------------------------------
// Incident input
// ---------------------------------------------------------------------------

const PAPER_ID_MAX = 200;
const NOTE_MAX = 2000;

/** Checks an admin's freeze entry. The service adds the id, the author and the stamp. */
export function parseRecLetterFreezeIncidentInput(
  input: unknown,
): { ok: true; value: AdminBotRecLetterFreezeIncidentInput } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "expected a JSON object" };
  }
  const body = input as Record<string, unknown>;
  const memberId = typeof body.member_id === "string" ? body.member_id.trim() : "";
  if (!memberId) {
    return { ok: false, error: "member_id is required" };
  }
  const kind = body.kind ?? "hallucinated_citation_desk_rejection";
  if (
    typeof kind !== "string" ||
    !(adminBotRecLetterFreezeIncidentKinds as readonly string[]).includes(kind)
  ) {
    return {
      ok: false,
      error: `kind must be one of ${adminBotRecLetterFreezeIncidentKinds.join(", ")}`,
    };
  }
  const occurredOn = typeof body.occurred_on === "string" ? body.occurred_on.trim() : "";
  if (!validDate(occurredOn)) {
    return { ok: false, error: "occurred_on must be a YYYY-MM-DD date" };
  }
  const optional = (field: "paper_id" | "note", max: number) => {
    const value = body[field];
    if (value === undefined || value === null) {
      return { ok: true as const, value: undefined };
    }
    if (typeof value !== "string" || value.length > max) {
      return { ok: false as const, error: `${field} must be text of at most ${max} characters` };
    }
    return { ok: true as const, value: value.trim() || undefined };
  };
  const paperId = optional("paper_id", PAPER_ID_MAX);
  if (!paperId.ok) {
    return paperId;
  }
  const note = optional("note", NOTE_MAX);
  if (!note.ok) {
    return note;
  }
  return {
    ok: true,
    value: {
      member_id: memberId,
      kind: kind as AdminBotRecLetterFreezeIncidentInput["kind"],
      occurred_on: occurredOn,
      ...(paperId.value ? { paper_id: paperId.value } : {}),
      ...(note.value ? { note: note.value } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Attestation input
// ---------------------------------------------------------------------------

/** Checks an admin's attestation. The service adds the id, the author and the stamp. */
export function parseRecLetterAttestationInput(
  input: unknown,
): { ok: true; value: AdminBotRecLetterAttestationInput } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "expected a JSON object" };
  }
  const body = input as Record<string, unknown>;
  const memberId = typeof body.member_id === "string" ? body.member_id.trim() : "";
  if (!memberId) {
    return { ok: false, error: "member_id is required" };
  }
  const criterion = body.criterion;
  if (
    typeof criterion !== "string" ||
    !(adminBotRecLetterAttestationCriteria as readonly string[]).includes(criterion)
  ) {
    return {
      ok: false,
      error: `criterion must be one of ${adminBotRecLetterAttestationCriteria.join(", ")}`,
    };
  }
  const note = body.note;
  if (note !== undefined && note !== null && (typeof note !== "string" || note.length > NOTE_MAX)) {
    return { ok: false, error: `note must be text of at most ${NOTE_MAX} characters` };
  }
  const trimmed = typeof note === "string" ? note.trim() : "";
  return {
    ok: true,
    value: {
      member_id: memberId,
      criterion: criterion as AdminBotRecLetterAttestationCriterion,
      ...(trimmed ? { note: trimmed } : {}),
    },
  };
}
