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
 * `alumni` and `part_time` lead because they describe the member's standing rather than their
 * relationship to the lab, and they lower expectations: a part-time full member is chased as
 * part-time, and an alumnus who still carries `full` is chased (gently) as an alumnus. Among the
 * member types, the more engaged relationship wins, so `full,mailing-list` is chased as full rather
 * than switched off by its weakest token.
 */
export const adminBotEngagementAudiences = [
  "alumni",
  "part_time",
  "full",
  "coauthor-major",
  "coauthor-minor",
  "acquaintance",
  "mailing-list",
  "external-prof",
] as const;
export type AdminBotEngagementAudience = (typeof adminBotEngagementAudiences)[number];

export type AdminBotEngagementPolicyEntry = {
  /** Whether this group is chased at all. */
  enabled: boolean;
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

/** What settings may override: any field of any group, nothing else. */
export type AdminBotEngagementPolicyOverrides = Partial<
  Record<AdminBotEngagementAudience, Partial<AdminBotEngagementPolicyEntry>>
>;

const OFF: Omit<AdminBotEngagementPolicyEntry, "subject" | "template"> = {
  enabled: false,
  channel: "email",
  inactive_after_days: 90,
  interval_days: 30,
  max_reminders: 1,
  escalate: false,
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
 */
export const adminBotDefaultEngagementPolicy: AdminBotEngagementPolicy = {
  full: {
    enabled: true,
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
  "coauthor-major": {
    enabled: true,
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
    channel: "email",
    inactive_after_days: 45,
    interval_days: 14,
    max_reminders: 2,
    escalate: false,
    subject: "Your AdminBot account",
    template: [
      "Hi {first_name}, {last_seen}.",
      "",
      "The papers you are on with the lab are tracked in AdminBot. When you have a moment, sign in and check that your details are right.",
    ].join("\n"),
  },
  part_time: {
    enabled: true,
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
  // An explicit choice, not a gap: alumni keep their portal access, and the one thing worth saying
  // to them is that the door is still open. Long gaps, one ask per quiet spell, never escalated.
  alumni: {
    enabled: true,
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
  acquaintance: {
    ...OFF,
    subject: "Your AdminBot account",
    template: "Hi {first_name}.",
  },
  "mailing-list": {
    ...OFF,
    subject: "Your AdminBot account",
    template: "Hi {first_name}.",
  },
  "external-prof": {
    ...OFF,
    subject: "Your AdminBot account",
    template: "Hi {first_name}.",
  },
};

/** Defaults with the stored overrides laid over them, field by field. */
export function resolveEngagementPolicy(
  overrides: AdminBotEngagementPolicyOverrides | undefined,
): AdminBotEngagementPolicy {
  const resolved = { ...adminBotDefaultEngagementPolicy };
  for (const audience of adminBotEngagementAudiences) {
    const override = overrides?.[audience];
    if (override) {
      resolved[audience] = { ...resolved[audience], ...override };
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
