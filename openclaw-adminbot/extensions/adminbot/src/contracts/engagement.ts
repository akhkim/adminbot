// Is this person around, and if not, what does the lab do about it?
//
// Two halves that every "who has gone quiet" reader has to agree on, kept together in contracts/
// because the sweep, the profile overview, adoption and the settings page all read them:
//
// 1. Engagement: one derived `last_active_at` over every channel a member can show up on (a web
//    sign-in, a day the web app saw them, the CLI, an edit they made themselves, Slack). Before
//    this, each reader picked its own subset, and a member who lives in the terminal read as
//    "never signed in" to the dormant sweep forever.
// 2. The reminder policy: per member type, whether the lab chases them at all, on which channel,
//    after how long, how often, and how many times before an admin is told. It used to be a
//    hardcoded `["full"]`.
//
// Pure: no clock, no store. The service supplies the inputs and does the sending.

import {
  adminBotDormantChaseIntervalDays,
  adminBotIsAlumniMember,
  adminBotSlackActivityOf,
  type AdminBotLabMember,
  type AdminBotMemberType,
} from "./actions.js";

export const adminBotEngagementChannels = [
  "web_login",
  "web_seen",
  "cli",
  "self_edit",
  "slack",
] as const;
export type AdminBotEngagementChannel = (typeof adminBotEngagementChannels)[number];

export type AdminBotMemberEngagement = {
  /** The latest of `channels`. Absent when the member has never shown up anywhere we measure. */
  last_active_at?: string;
  /** Which channel `last_active_at` came from. */
  last_channel?: AdminBotEngagementChannel;
  /** The latest sighting per channel. A channel with no sighting is absent rather than empty. */
  channels: Partial<Record<AdminBotEngagementChannel, string>>;
};

export type AdminBotEngagementMember = Pick<
  AdminBotLabMember,
  | "last_login_at"
  | "last_seen_at"
  | "last_cli_at"
  | "slack_user_id"
  | "slack_messages_7d"
  | "slack_activity_checked_at"
>;

/**
 * Every place this member has shown up, and the latest of them.
 *
 * `lastLoginAt` and `lastSelfEditAt` are passed in rather than read off the record because the
 * service knows better: the login falls back to the login-event table when the record's stamp was
 * overwritten by a bulk write, and a self-edit comes from provenance rather than from any field.
 *
 * Slack counts only when the sweep measured the member as active, and then at the time it measured
 * them. "Unknown" and "inactive" are not sightings: an unlinked account is missing data, not silence,
 * and a member who said nothing all week has not shown up just because somebody looked.
 */
export function adminBotMemberEngagement(
  member: AdminBotEngagementMember,
  params: {
    lastLoginAt?: string | undefined;
    lastSelfEditAt?: string | undefined;
  } = {},
): AdminBotMemberEngagement {
  const candidates: Array<[AdminBotEngagementChannel, string | undefined]> = [
    ["web_login", params.lastLoginAt ?? member.last_login_at],
    ["web_seen", member.last_seen_at],
    ["cli", member.last_cli_at],
    ["self_edit", params.lastSelfEditAt],
    [
      "slack",
      adminBotSlackActivityOf(member) === "active" ? member.slack_activity_checked_at : undefined,
    ],
  ];
  const channels: Partial<Record<AdminBotEngagementChannel, string>> = {};
  let latest: { channel: AdminBotEngagementChannel; at: number; iso: string } | undefined;
  for (const [channel, stamp] of candidates) {
    const iso = stamp?.trim();
    // An unparseable stamp is dropped rather than kept: it cannot be compared, and keeping it would
    // let a garbage value read as "active" to anybody who only checks presence.
    const at = iso ? Date.parse(iso) : Number.NaN;
    if (!iso || !Number.isFinite(at)) {
      continue;
    }
    channels[channel] = iso;
    if (!latest || at > latest.at) {
      latest = { channel, at, iso };
    }
  }
  return latest
    ? { last_active_at: latest.iso, last_channel: latest.channel, channels }
    : { channels };
}

// ---------------------------------------------------------------------------------------------
// The reminder policy.

/**
 * The groups the policy is written for. A member matches the first that applies, in this order.
 *
 * Every member type the roster offers is here, plus `part_time` (a standing, not a type). That is
 * the coverage rule: each group has an explicit row below, "off" included, so no member falls
 * through to whatever a sweep happens to do by default. `AdminBotMemberType` is checked against
 * this list at compile time just after it, so adding a type to the roster without deciding its
 * reminders is a type error rather than a silent gap.
 *
 * `alumni` and `part_time` lead because they describe the member's standing rather than their
 * relationship to the lab, and they lower expectations: a part-time full member is chased as
 * part-time, and an alumnus who still carries `full` is chased (gently) as an alumnus. Among the
 * member types, the more engaged relationship wins, so `full,mailing-list` is chased as full rather
 * than switched off by its weakest token -- which is also why the operational tags
 * (`adminbot-admin`, `adminbot-developer`) and `mailing-list` come last.
 */
export const adminBotEngagementAudiences = [
  "alumni",
  "part_time",
  "full",
  "own-pace-advisee",
  "coauthor-major",
  "coauthor-minor",
  "disappearing-coauthor",
  "coauthor-discussant-or-designer",
  "slightly-better-than-emails",
  "interviewee",
  "external-prof",
  "benefit-partner",
  "benefit-direct-relative",
  "acquaintance",
  "adminbot-admin",
  "adminbot-developer",
  "mailing-list",
] as const;
export type AdminBotEngagementAudience = (typeof adminBotEngagementAudiences)[number];

// Compile-time coverage: a roster type with no policy row fails the build here.
type UncoveredMemberType = Exclude<AdminBotMemberType, AdminBotEngagementAudience>;
const everyMemberTypeHasAPolicy: [UncoveredMemberType] extends [never] ? true : never = true;
void everyMemberTypeHasAPolicy;

/**
 * The long-term reminders, each run by its own sweep, that share one per-member cycle.
 *
 * - `dormant_login`: the standing "AdminBot has not seen you" reminder (chaseDisengagedMembers).
 * - `onboarding_chase`: the onboarding follow-up ladder and the open-checklist chase.
 * - `profile_fields`: missing mandatory profile fields and the term timeline.
 * - `weekly_notes`: the Monday ask for a line on each active paper.
 * - `alumni_checkin`: the alumni's standing reminder. Same planner as `dormant_login`, under its
 *   own name so "alumni get a periodic check-in and nothing else" is a row you can read.
 *
 * Operational sweeps (a paper slot, a reimbursement, a rec letter) are deliberately not here: they
 * are about a specific deadline, and holding one back because a profile reminder went out
 * yesterday would make the lab miss the deadline.
 */
export const adminBotLongTermReminderKinds = [
  "dormant_login",
  "onboarding_chase",
  "profile_fields",
  "weekly_notes",
  "alumni_checkin",
] as const;
export type AdminBotLongTermReminderKind = (typeof adminBotLongTermReminderKinds)[number];

export type AdminBotEngagementPolicyEntry = {
  /** Whether this group gets any long-term reminder at all. Off overrides every `reminders` flag. */
  enabled: boolean;
  /** Which of the long-term reminders this group gets. */
  reminders: Record<AdminBotLongTermReminderKind, boolean>;
  /**
   * At most one long-term reminder per this many calendar days, whichever sweep sends it.
   *
   * The ledger behind it is one row per member (`long_term_reminder`), stamped by every sweep in
   * `reminders`, so a member is not told about their profile at 09:20 and their papers at 10:00.
   */
  cycle_days: number;
  /** The dormant reminder's channel. The other kinds keep the channel their sweep has always used. */
  channel: "slack" | "email";
  /** How long without any sighting (see `adminBotMemberEngagement`) before the first reminder. */
  inactive_after_days: number;
  /** Days between reminders once they have started. */
  interval_days: number;
  /** Reminders sent in one quiet spell before the sweep stops asking. */
  max_reminders: number;
  /**
   * Whether running out of reminders puts the member on the professor's desk. Off for groups the
   * lab only offers a door to (alumni): escalating them would be the lab chasing somebody who left.
   */
  escalate: boolean;
  /** The email subject, and the portal notification's title on either channel. */
  subject: string;
  /** The body. `{first_name}` and `{last_seen}` are filled in; see `renderEngagementReminder`. */
  template: string;
};

export type AdminBotEngagementPolicy = Record<
  AdminBotEngagementAudience,
  AdminBotEngagementPolicyEntry
>;

/** What settings may override: any field of any group, and any single reminder flag. */
export type AdminBotEngagementPolicyOverrides = Partial<
  Record<
    AdminBotEngagementAudience,
    Partial<Omit<AdminBotEngagementPolicyEntry, "reminders">> & {
      reminders?: Partial<Record<AdminBotLongTermReminderKind, boolean>>;
    }
  >
>;

const NO_REMINDERS: Record<AdminBotLongTermReminderKind, boolean> = {
  dormant_login: false,
  onboarding_chase: false,
  profile_fields: false,
  weekly_notes: false,
  alumni_checkin: false,
};

function only(
  ...kinds: AdminBotLongTermReminderKind[]
): Record<AdminBotLongTermReminderKind, boolean> {
  return { ...NO_REMINDERS, ...Object.fromEntries(kinds.map((kind) => [kind, true])) };
}

const GENERIC_SUBJECT = "Your AdminBot account";
const GENERIC_TEMPLATE = [
  "Hi {first_name}, {last_seen}.",
  "",
  "When you have a moment, sign in and check that your details are right.",
].join("\n");

/** A group the lab does not chase: every reminder off, still with a full, valid row. */
const OFF: AdminBotEngagementPolicyEntry = {
  enabled: false,
  reminders: NO_REMINDERS,
  cycle_days: 30,
  channel: "email",
  inactive_after_days: 90,
  interval_days: 30,
  max_reminders: 1,
  escalate: false,
  subject: GENERIC_SUBJECT,
  template: GENERIC_TEMPLATE,
};

/**
 * The shipped policy. Settings may override any of it (`engagement_policy`), so these are defaults
 * rather than rules -- the rules are in the planner and in `sendMemberNudge`, which no setting
 * reaches: the nudge list, do-not-contact, the head professor, and the onboarding ladder's
 * precedence.
 *
 * `full` keeps the three-day interval the dormant sweep has always used, so nobody's cadence
 * changes on the day this ships; what is new is that it now ends (five asks, then the professor)
 * and that "quiet" means two weeks without a sighting rather than "has never signed in".
 *
 * The shape of the table, coarsely: the people who work in the lab get everything; coauthors get
 * the reminders about their papers; people onboarded for one reason (an interview) get only the
 * onboarding chase; alumni get one periodic check-in; welcome-only and operational rows get
 * nothing.
 */
export const adminBotDefaultEngagementPolicy: AdminBotEngagementPolicy = {
  full: {
    enabled: true,
    reminders: only("dormant_login", "onboarding_chase", "profile_fields", "weekly_notes"),
    // Two days, not one: the profile and the dormant reminders each repeat every three days, so a
    // one-day cycle would let a member hear something on most weekdays.
    cycle_days: 2,
    channel: "slack",
    inactive_after_days: 14,
    interval_days: adminBotDormantChaseIntervalDays,
    max_reminders: 5,
    escalate: true,
    subject: "AdminBot has not seen you in a while",
    template: [
      "Hi {first_name}, {last_seen}.",
      "",
      "Your profile, papers and deadlines are waiting there, and a quick sign-in is what keeps them current. If something is in the way, reply here.",
    ].join("\n"),
  },
  part_time: {
    enabled: true,
    reminders: only("dormant_login", "onboarding_chase", "profile_fields", "weekly_notes"),
    cycle_days: 5,
    channel: "slack",
    inactive_after_days: 30,
    interval_days: 7,
    max_reminders: 2,
    escalate: false,
    subject: "AdminBot has not seen you in a while",
    template: [
      "Hi {first_name}, {last_seen}.",
      "",
      "No rush -- when you next have time, a quick sign-in keeps your profile and papers current.",
    ].join("\n"),
  },
  // Advised at their own pace: the account and profile are worth keeping current, but a weekly
  // "what did you do on this paper" is the opposite of their own pace.
  "own-pace-advisee": {
    enabled: true,
    reminders: only("dormant_login", "onboarding_chase", "profile_fields"),
    cycle_days: 7,
    channel: "slack",
    inactive_after_days: 30,
    interval_days: 14,
    max_reminders: 2,
    escalate: false,
    subject: "AdminBot has not seen you in a while",
    template: [
      "Hi {first_name}, {last_seen}.",
      "",
      "Whenever suits you, a quick sign-in keeps your profile and papers current.",
    ].join("\n"),
  },
  "coauthor-major": {
    enabled: true,
    reminders: only("dormant_login", "onboarding_chase", "profile_fields", "weekly_notes"),
    cycle_days: 5,
    channel: "slack",
    inactive_after_days: 21,
    interval_days: 7,
    max_reminders: 3,
    escalate: true,
    subject: "Your papers in AdminBot",
    template: [
      "Hi {first_name}, {last_seen}.",
      "",
      "The papers you are on are tracked there. A sign-in to check their status keeps the lab's view of them right. If you cannot get in, reply here.",
    ].join("\n"),
  },
  "coauthor-minor": {
    enabled: true,
    reminders: only("dormant_login", "onboarding_chase", "profile_fields", "weekly_notes"),
    cycle_days: 10,
    channel: "email",
    inactive_after_days: 45,
    interval_days: 14,
    max_reminders: 2,
    escalate: false,
    subject: GENERIC_SUBJECT,
    template: [
      "Hi {first_name}, {last_seen}.",
      "",
      "The papers you are on with the lab are tracked in AdminBot. When you have a moment, sign in and check that your details are right.",
    ].join("\n"),
  },
  // A coauthor who has gone quiet on a paper. The paper is the reason to write, so weekly notes and
  // a sign-in reminder are on; the profile is not worth chasing somebody about who has drifted off.
  "disappearing-coauthor": {
    enabled: true,
    reminders: only("dormant_login", "onboarding_chase", "weekly_notes"),
    cycle_days: 10,
    channel: "email",
    inactive_after_days: 30,
    interval_days: 14,
    max_reminders: 2,
    escalate: false,
    subject: "Your papers in AdminBot",
    template: [
      "Hi {first_name}, {last_seen}.",
      "",
      "The papers you are on with the lab are tracked in AdminBot. A quick look at where they stand would help the group a lot.",
    ].join("\n"),
  },
  // Discussants, designers and the barely-more-than-email collaborators: onboarded, and asked about
  // the papers they are on, but never chased for a sign-in or a profile they have no use for.
  "coauthor-discussant-or-designer": {
    ...OFF,
    enabled: true,
    reminders: only("onboarding_chase", "weekly_notes"),
    cycle_days: 14,
  },
  "slightly-better-than-emails": {
    ...OFF,
    enabled: true,
    reminders: only("onboarding_chase", "weekly_notes"),
    cycle_days: 14,
  },
  // Onboarded for an interview and nothing else: finishing onboarding is the only thing to chase.
  interviewee: {
    ...OFF,
    enabled: true,
    reminders: only("onboarding_chase"),
    cycle_days: 7,
  },
  // An explicit choice, not a gap: alumni keep their portal access, and the one thing worth saying
  // to them is that the door is still open. One check-in per half-year of quiet, never escalated,
  // and nothing else -- no profile reminder, no weekly notes, no onboarding chase.
  alumni: {
    enabled: true,
    reminders: only("alumni_checkin"),
    cycle_days: 90,
    channel: "email",
    inactive_after_days: 180,
    interval_days: 180,
    max_reminders: 1,
    escalate: false,
    subject: "Your alumni access to AdminBot",
    template: [
      "Hi {first_name}, {last_seen}.",
      "",
      "Your alumni access is still active. If you sign in, you can update where you are now and what you are working on, so the lab can keep in touch. No reply needed.",
    ].join("\n"),
  },
  // Welcome-only relationships (the basic welcome in member-type-template.ts): they get their
  // access and one message, and nothing on a timer.
  "external-prof": OFF,
  "benefit-partner": OFF,
  "benefit-direct-relative": OFF,
  acquaintance: OFF,
  // Operational tags. The people carrying them run AdminBot; a member who is only a tag is a test
  // or service row, and one who is also `full` is chased as full (see the audience order).
  "adminbot-admin": OFF,
  "adminbot-developer": OFF,
  "mailing-list": OFF,
};

/** Defaults with the stored overrides laid over them, field by field (and flag by flag). */
export function resolveEngagementPolicy(
  overrides: AdminBotEngagementPolicyOverrides | undefined,
): AdminBotEngagementPolicy {
  const resolved = { ...adminBotDefaultEngagementPolicy };
  for (const audience of adminBotEngagementAudiences) {
    const override = overrides?.[audience];
    if (override) {
      const base = resolved[audience];
      resolved[audience] = {
        ...base,
        ...override,
        reminders: { ...base.reminders, ...override.reminders },
      };
    }
  }
  return resolved;
}

const POLICY_DAY_LIMIT = 3650;
const POLICY_REMINDER_LIMIT = 20;
const POLICY_TEXT_LIMIT = 2000;

/**
 * Why these overrides cannot be stored, or undefined when they can.
 *
 * Strict on purpose. A setting that silently dropped a bad field would leave the admin believing
 * they had switched a group off when the default was still chasing it -- the one failure a knob
 * like this must not have.
 */
export function validateEngagementPolicyOverrides(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "engagement_policy must be an object keyed by member group";
  }
  for (const [audience, entry] of Object.entries(value)) {
    if (!(adminBotEngagementAudiences as readonly string[]).includes(audience)) {
      return `engagement_policy: unknown group "${audience}"`;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return `engagement_policy.${audience} must be an object`;
    }
    for (const [field, fieldValue] of Object.entries(entry as Record<string, unknown>)) {
      const where = `engagement_policy.${audience}.${field}`;
      switch (field) {
        case "enabled":
        case "escalate":
          if (typeof fieldValue !== "boolean") return `${where} must be true or false`;
          break;
        case "channel":
          if (fieldValue !== "slack" && fieldValue !== "email") {
            return `${where} must be "slack" or "email"`;
          }
          break;
        case "inactive_after_days":
        case "interval_days":
        case "cycle_days":
          if (
            typeof fieldValue !== "number" ||
            !Number.isInteger(fieldValue) ||
            fieldValue < 1 ||
            fieldValue > POLICY_DAY_LIMIT
          ) {
            return `${where} must be a whole number of days from 1 to ${POLICY_DAY_LIMIT}`;
          }
          break;
        case "max_reminders":
          if (
            typeof fieldValue !== "number" ||
            !Number.isInteger(fieldValue) ||
            fieldValue < 1 ||
            fieldValue > POLICY_REMINDER_LIMIT
          ) {
            return `${where} must be a whole number from 1 to ${POLICY_REMINDER_LIMIT}`;
          }
          break;
        case "reminders": {
          if (!fieldValue || typeof fieldValue !== "object" || Array.isArray(fieldValue)) {
            return `${where} must be an object of reminder flags`;
          }
          for (const [kind, flag] of Object.entries(fieldValue as Record<string, unknown>)) {
            if (!(adminBotLongTermReminderKinds as readonly string[]).includes(kind)) {
              return `${where}.${kind} is not a reminder kind`;
            }
            if (typeof flag !== "boolean") {
              return `${where}.${kind} must be true or false`;
            }
          }
          break;
        }
        case "subject":
        case "template":
          if (
            typeof fieldValue !== "string" ||
            !fieldValue.trim() ||
            fieldValue.length > POLICY_TEXT_LIMIT
          ) {
            return `${where} must be non-empty text of at most ${POLICY_TEXT_LIMIT} characters`;
          }
          break;
        default:
          return `${where} is not a policy field`;
      }
    }
  }
  return undefined;
}

function memberTypeTokens(memberType: string | undefined): Set<string> {
  return new Set(
    (memberType ?? "")
      .split(",")
      // The roster spells these both ways ("coauthor_major" from one import, "coauthor-major" from
      // another); the policy is keyed by the hyphenated form.
      .map((token) => token.trim().toLowerCase().replace(/_/gu, "-"))
      .filter(Boolean),
  );
}

/**
 * Which policy group this member falls under, or undefined when none does.
 *
 * Undefined is the safe answer: a member type the table does not name is not chased, so a new type
 * added to the roster is off until somebody decides otherwise.
 */
export function adminBotEngagementAudienceOf(
  member: Pick<AdminBotLabMember, "status" | "member_type">,
): AdminBotEngagementAudience | undefined {
  if (adminBotIsAlumniMember(member)) {
    return "alumni";
  }
  if (member.status === "part_time") {
    return "part_time";
  }
  const tokens = memberTypeTokens(member.member_type);
  return adminBotEngagementAudiences.find(
    (audience) => audience !== "alumni" && audience !== "part_time" && tokens.has(audience),
  );
}

/**
 * Why an address the roster resolved cannot be mailed, or undefined when it looks deliverable.
 *
 * `adminBotOutreachEmail` is deliberately not a validator (a hand-maintained roster carries odd but
 * working values), so the sweep asks this separately before it mails anybody on a timer. A trailing
 * dot is the common one -- "name@utoronto.ca." pasted from the end of a sentence -- and it bounces.
 * Flagged, not fixed: rewriting a member's address is a roster edit, and that is an admin's call.
 */
export function adminBotEmailAddressProblem(
  address: string,
): "trailing_dot" | "malformed" | undefined {
  const trimmed = address.trim();
  if (trimmed.endsWith(".")) {
    return "trailing_dot";
  }
  return /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u.test(trimmed) ? undefined : "malformed";
}

/**
 * The reminder's body with its placeholders filled.
 *
 * `{last_seen}` is a phrase, not a number of days, because "you have not been here in 212 days"
 * reads as an accusation (the old never-signed-in reminder avoided day counts for the same
 * reason). A date says the same thing as a fact.
 */
export function renderEngagementReminder(
  template: string,
  params: { firstName: string; lastActiveAt?: string | undefined },
): string {
  const at = params.lastActiveAt ? new Date(params.lastActiveAt) : undefined;
  const lastSeen =
    at && Number.isFinite(at.getTime())
      ? `AdminBot last saw you on ${at.toLocaleDateString("en-US", {
          day: "numeric",
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        })}`
      : "you have not signed in to AdminBot yet";
  return template
    .replace(/\{first_name\}/gu, params.firstName)
    .replace(/\{last_seen\}/gu, lastSeen);
}

/**
 * The reminders that stand on evidence about the member rather than on what their group is
 * expected to do: an open checklist, a mandatory field left empty, a paper they are an author on.
 *
 * These reach a member the roster has not typed yet, on `adminBotUnclassifiedReminderCycleDays`.
 * Most of the imported roster carries no type, and holding these back until somebody types
 * everyone would quietly stop the lab's routine asks for most of the lab. The other two kinds,
 * the dormant-login reminder and the alumni check-in, are about expectations only a type sets,
 * so an untyped member gets neither.
 */
export const adminBotEvidenceReminderKinds: ReadonlySet<AdminBotLongTermReminderKind> = new Set([
  "onboarding_chase",
  "profile_fields",
  "weekly_notes",
]);

/**
 * The cycle for a member with no type. Three days, the profile sweep's own re-remind interval, so
 * the untyped majority of the roster keeps the cadence it had before the cycle existed, and the
 * only change for them is that two sweeps can no longer land on the same day.
 */
export const adminBotUnclassifiedReminderCycleDays = 3;

export type AdminBotLongTermReminderGate =
  | {
      allowed: true;
      /** Absent for an untyped member sent an evidence reminder on the fallback cycle. */
      audience?: AdminBotEngagementAudience;
    }
  | {
      allowed: false;
      /**
       * - `unclassified`: no group matches the member's type and the reminder needs one. Reported
       *   by the sweeps rather than left silent, because it is the roster that needs fixing.
       * - `off`: the member's group does not get this reminder.
       * - `cycle`: another long-term reminder reached them within the cycle.
       */
      reason: "unclassified" | "off" | "cycle";
      audience?: AdminBotEngagementAudience;
    };

/**
 * May this member be sent this long-term reminder now? The one gate every long-term sweep asks.
 *
 * Fails closed where a type is what decides: an untyped member gets no engagement reminder, and a
 * reminder the row does not name is off. The cycle is counted in UTC calendar days, not hours, so
 * that the crons' different times of day do not decide it: a reminder at 10:50 on Monday and a
 * two-day cycle allow the next one at 09:20 on Wednesday, which an hours count would refuse by
 * ninety minutes.
 *
 * `lastLongTermReminderAt` is the member's `long_term_reminder` ledger stamp -- one row per member,
 * whatever kind went last -- and `now` is the sweep's own clock, the same one it stamps with.
 */
export function adminBotLongTermReminderGate(params: {
  member: Pick<AdminBotLabMember, "status" | "member_type">;
  kind: AdminBotLongTermReminderKind;
  policy: AdminBotEngagementPolicy;
  lastLongTermReminderAt?: string | undefined;
  now: Date;
}): AdminBotLongTermReminderGate {
  const audience = adminBotEngagementAudienceOf(params.member);
  let cycleDays: number;
  if (!audience) {
    if (!adminBotEvidenceReminderKinds.has(params.kind)) {
      return { allowed: false, reason: "unclassified" };
    }
    cycleDays = adminBotUnclassifiedReminderCycleDays;
  } else {
    const entry = params.policy[audience];
    if (!entry.enabled || !entry.reminders[params.kind]) {
      return { allowed: false, reason: "off", audience };
    }
    cycleDays = entry.cycle_days;
  }
  const last = params.lastLongTermReminderAt ? Date.parse(params.lastLongTermReminderAt) : NaN;
  if (
    Number.isFinite(last) &&
    utcDayNumber(params.now.getTime()) - utcDayNumber(last) < cycleDays
  ) {
    return audience
      ? { allowed: false, reason: "cycle", audience }
      : { allowed: false, reason: "cycle" };
  }
  return audience ? { allowed: true, audience } : { allowed: true };
}

/** The standing reminder's kind for this group: alumni get the check-in, everyone else the login. */
export function adminBotStandingReminderKind(
  audience: AdminBotEngagementAudience,
): Extract<AdminBotLongTermReminderKind, "dormant_login" | "alumni_checkin"> {
  return audience === "alumni" ? "alumni_checkin" : "dormant_login";
}

function utcDayNumber(ms: number): number {
  return Math.floor(ms / 86_400_000);
}
