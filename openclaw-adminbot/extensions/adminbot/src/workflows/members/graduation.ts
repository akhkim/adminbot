// Leaving: the date the member keeps, the status only an admin can set, and the ceremony somebody
// has to book a room for.
//
// `graduated_month` is `yyyy-mm` and member-editable -- it is their plan, and they are the one who
// knows when it moves. `status` is not: it sits in SELF_PROFILE_PRIVILEGED_FIELDS, so nobody can
// declare themselves alumni. That split is the whole shape of this file. AdminBot asks the member
// to keep the date honest, and asks an admin to make the transition, because the transition is a
// governance act with access consequences and a sweep should not be the thing that performs it.
//
// Pure: this decides what would be said, and the service says it.

/**
 * How far ahead a member is asked to confirm they are still leaving when they said.
 *
 * Two months, and months rather than days because the field is month-granular -- a day count off a
 * `yyyy-mm` is a precision the data does not have. Two is enough to arrange an offboarding and
 * short enough that the answer is still one somebody knows.
 */
export const adminBotGraduationConfirmLeadMonths = 2;

/**
 * The month the ceremony happens, and how far ahead somebody is reminded to arrange it.
 *
 * June and three months, which is a guess at a convocation calendar rather than a fact about this
 * lab -- both are one-line changes, which is why they are named constants and not arithmetic
 * buried in the sweep.
 */
export const adminBotGraduationCeremonyMonth = 6;
export const adminBotGraduationCeremonyLeadMonths = 3;

/** The guidebook section about leaving. Named here so changing it is a one-line edit. */
export const adminBotGraduationGuidebookSection = "Wrapping up and moving on";

export type GraduationMember = {
  id: string;
  name: string;
  status?: string;
  /** `yyyy-mm`. The member's own plan, which is why they are the one asked to keep it current. */
  graduated_month?: string;
};

export type GraduationAction =
  /** Their date is close: ask them to confirm it, or move it. */
  | { kind: "confirm"; member_id: string; member_name: string; month: string; months_until: number }
  /** Their date has passed and they are still on the roster as current: ask an admin. */
  | {
      kind: "transition";
      member_id: string;
      member_name: string;
      month: string;
      months_since: number;
    };

export type GraduationCeremony = {
  /** The calendar year the ceremony is for. */
  year: number;
  month: string;
  graduates: Array<{ member_id: string; member_name: string; month: string }>;
};

/** `yyyy-mm` as a comparable month number, or undefined when it is not a month. */
function monthIndex(value: string | undefined): number | undefined {
  if (!value || !/^\d{4}-(0[1-9]|1[0-2])$/u.test(value)) {
    return undefined;
  }
  const [year, month] = value.split("-").map(Number) as [number, number];
  return year * 12 + (month - 1);
}

function nowMonthIndex(now: Date): number {
  return now.getUTCFullYear() * 12 + now.getUTCMonth();
}

/**
 * What is due to be said about people leaving.
 *
 * Alumni are already gone, so nothing is said about them -- the transition prompt exists precisely
 * to close the gap between the date passing and somebody's status catching up, and it stops the
 * moment it has.
 */
export function graduationActions(
  members: readonly GraduationMember[],
  now: Date,
): GraduationAction[] {
  const current = nowMonthIndex(now);
  const actions: GraduationAction[] = [];
  for (const member of members) {
    if (member.status === "alumni") {
      continue;
    }
    const month = monthIndex(member.graduated_month);
    if (month === undefined) {
      continue;
    }
    const delta = month - current;
    if (delta >= 0 && delta <= adminBotGraduationConfirmLeadMonths) {
      actions.push({
        kind: "confirm",
        member_id: member.id,
        member_name: member.name,
        month: member.graduated_month as string,
        months_until: delta,
      });
      continue;
    }
    if (delta < 0) {
      actions.push({
        kind: "transition",
        member_id: member.id,
        member_name: member.name,
        month: member.graduated_month as string,
        months_since: -delta,
      });
    }
  }
  return actions.toSorted(
    (left, right) =>
      left.month.localeCompare(right.month) || left.member_id.localeCompare(right.member_id),
  );
}

/**
 * The ceremony to arrange, if one is coming.
 *
 * Everyone whose `graduated_month` falls in the ceremony's calendar year, including the ones who
 * have already left: a graduation ceremony is for the year's graduates, and somebody who finished
 * in March and is now alumni is exactly who it is for.
 */
export function graduationCeremony(
  members: readonly GraduationMember[],
  now: Date,
): GraduationCeremony | undefined {
  const current = nowMonthIndex(now);
  // The ceremony in whichever year is next: this year's if it has not happened, otherwise next.
  const thisYear = now.getUTCFullYear();
  const year =
    current <= thisYear * 12 + (adminBotGraduationCeremonyMonth - 1) ? thisYear : thisYear + 1;
  const ceremonyMonth = year * 12 + (adminBotGraduationCeremonyMonth - 1);
  if (ceremonyMonth - current > adminBotGraduationCeremonyLeadMonths) {
    return undefined;
  }
  const graduates = members
    .filter((member) => member.graduated_month?.startsWith(`${year}-`))
    .map((member) => ({
      member_id: member.id,
      member_name: member.name,
      month: member.graduated_month as string,
    }))
    .toSorted((left, right) => left.month.localeCompare(right.month));
  if (!graduates.length) {
    return undefined;
  }
  return {
    year,
    month: `${year}-${String(adminBotGraduationCeremonyMonth).padStart(2, "0")}`,
    graduates,
  };
}

/** Asks the member to confirm the date they gave, or move it. */
export function buildGraduationConfirmMessage(action: {
  month: string;
  months_until: number;
}): string {
  const when =
    action.months_until === 0
      ? "this month"
      : action.months_until === 1
        ? "next month"
        : `in ${action.months_until} months`;
  return [
    `Your record says you are finishing ${when} (${action.month}).`,
    "",
    `If that is still right, there is nothing to do — the guidebook's "${adminBotGraduationGuidebookSection}" section covers what to hand over.`,
    "",
    "If it has moved, update the month on My Profile and I will follow it. An admin marks you as alumni when the time comes; you do not have to.",
  ].join("\n");
}

/**
 * Asks the admins to make the transition.
 *
 * One message listing everyone due, because this is a queue somebody works through rather than a
 * conversation, and three separate DMs about three people is how a queue gets ignored.
 */
export function buildGraduationTransitionMessage(
  actions: ReadonlyArray<{ member_name: string; month: string; months_since: number }>,
): string {
  return [
    actions.length === 1
      ? "This member's finishing month has passed and they are still on the roster as current:"
      : "These members' finishing months have passed and they are still on the roster as current:",
    "",
    ...actions.map(
      (action) => `• ${action.member_name} — ${action.month} (${action.months_since} month(s) ago)`,
    ),
    "",
    "Set them to alumni on Lab Members if they have gone, or clear the month if they have not.",
  ].join("\n");
}

/** Asks somebody to arrange the ceremony, and says who it is for. */
export function buildGraduationCeremonyMessage(ceremony: GraduationCeremony): string {
  return [
    `The ${ceremony.year} graduation ceremony is coming up (${ceremony.month}). This year's graduates:`,
    "",
    ...ceremony.graduates.map((graduate) => `• ${graduate.member_name} — ${graduate.month}`),
    "",
    "Worth booking a room and a date now while everyone is still reachable.",
  ].join("\n");
}
