/**
 * The Slack workspace's member list against the lab's roster: who is new, whose Slack-derived
 * fields moved, whose account was deactivated, and which records are placeholders or test accounts.
 *
 * This replaces the one-off Slack member export (scripts/adminbot-create-members-from-export.ts),
 * which wrote rows straight into SQLite. Here the plan is pure and the service applies it through
 * the normal member write funnel, so provenance, audits and the after-write hooks all run.
 *
 * Pure: nothing here reads Slack, touches the store, or sends anything.
 *
 * Deliberately narrow about what it writes. Slack is the source of truth for exactly four things:
 * that an account exists, its user ID, its avatar and its time zone. Everything else on a profile
 * is the member's or an admin's, and a field either of them wrote is never overwritten here.
 */
import type { AdminBotLabMember, AdminBotLabMemberInput } from "../../contracts/actions.js";
import { isDoNotContactName } from "./do-not-contact.js";

/** One Slack account, normalized from a `users.list` member by the connector. */
export type SlackDirectoryUser = {
  id: string;
  deleted: boolean;
  is_bot: boolean;
  is_invited_user?: boolean;
  is_app_user: boolean;
  /** Multi-channel guest. */
  is_restricted: boolean;
  /** Single-channel guest. */
  is_ultra_restricted: boolean;
  real_name?: string;
  display_name?: string;
  email?: string;
  title?: string;
  tz?: string;
  /** The largest square avatar Slack offered. */
  image?: string;
};

export type SlackDirectoryReader = () => Promise<SlackDirectoryUser[]>;

/** Why one Slack account was left out of the roster entirely. */
export type SlackAccountKind =
  | "member"
  | "bot"
  | "slackbot"
  | "deleted"
  | "multi_channel_guest"
  | "single_channel_guest"
  | "opted_out"
  | "placeholder";

/** The roster fields this sync may write. A field outside this list is never touched. */
export const SLACK_ROSTER_SYNC_FIELDS = [
  "name",
  "slack_user_id",
  "avatar_url",
  "timezone",
] as const;
export type SlackRosterSyncField = (typeof SLACK_ROSTER_SYNC_FIELDS)[number];

export type SlackRosterFieldChange = {
  field: SlackRosterSyncField;
  from: string;
  to: string;
};

export type SlackRosterUpdate = {
  member_id: string;
  slack_user_id: string;
  matched_by: "slack_user_id" | "email";
  changes: SlackRosterFieldChange[];
};

export type SlackRosterCreate = {
  slack_user_id: string;
  member: AdminBotLabMemberInput;
};

export type SlackRosterRemoval = {
  member_id: string;
  member_name: string;
  slack_user_id: string;
  reason: string;
};

export type SlackRosterSkip = {
  slack_user_id: string;
  kind: Exclude<SlackAccountKind, "member">;
  /** Present when the account matched a roster record anyway, so an admin can see the pairing. */
  member_id?: string;
};

/**
 * A record whose name says not to contact the person ("Null,do not contact", "DNC"). That is an
 * opt-out by a real person, not a test row: the sync writes nothing to it, so no after-write hook
 * can invite, nudge or notify them, and it is listed for an admin to look at rather than proposed
 * for deletion.
 */
export type SlackRosterOptOut = {
  member_id?: string;
  member_name?: string;
  slack_user_id: string;
  reason: string;
  action: "opted out; admin review";
};

export type SlackRosterConflict = {
  slack_user_id: string;
  member_id?: string;
  reason: string;
};

export type SlackRosterSyncPlan = {
  creates: SlackRosterCreate[];
  updates: SlackRosterUpdate[];
  /** Matched roster members whose Slack account is now deactivated. Flagged, never removed. */
  deactivations: { member_id: string; slack_user_id: string }[];
  /** Matched roster members whose Slack account came back. The flag is cleared. */
  reactivations: { member_id: string; slack_user_id: string }[];
  /** Test or placeholder records that are in the roster. Each becomes an approval, not a delete. */
  removals: SlackRosterRemoval[];
  /** Do-not-contact records. Left untouched and surfaced for an admin; never proposed for removal. */
  opted_out: SlackRosterOptOut[];
  /** Slack accounts deliberately not imported: bots, guests, deactivated, placeholders. */
  skipped: SlackRosterSkip[];
  /** Pairings this sync will not guess at. Reported, never applied. */
  conflicts: SlackRosterConflict[];
  /** Roster members that matched and needed nothing. The idempotency number: a re-run is all this. */
  unchanged: number;
};

/**
 * Names that only a test or placeholder record ever has. Compared whole and case-insensitively,
 * never by substring. "null" is deliberately absent: in this lab's data a bare "Null" is how a real
 * member opted out (see do-not-contact.ts), so it must never read as a test row.
 */
const PLACEHOLDER_NAMES = new Set([
  "undefined",
  "none",
  "n/a",
  "test",
  "test user",
  "test account",
  "placeholder",
  "dummy",
]);

/** Reserved by RFC 2606 for documentation; no real person has a mailbox there. */
const PLACEHOLDER_EMAIL = /@(?:[a-z0-9-]+\.)*example\.(?:com|org|net|edu)$/iu;
function doNotContactReason(fields: Array<[label: string, value: string | undefined]>) {
  const hit = fields.find(([, value]) => isDoNotContactName(value));
  return hit ? `${hit[0]} "${hit[1]?.trim()}" asks not to be contacted` : undefined;
}

/**
 * The name with any bracketed aside removed, so "Null (do not contact)" is judged on "Null". The
 * aside itself is checked separately for the do-not-contact marker.
 */
function bareName(value: string): string {
  return value
    .replace(/[([{][^)\]}]*[)\]}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/**
 * Why a name, email or flag marks a test or placeholder record, or undefined when it does not.
 * Conservative on purpose: a whole-name match, a reserved example domain, or an admin's flag.
 */
export function placeholderReason(fields: {
  names: Array<string | undefined>;
  email?: string;
  flagged?: boolean;
}): string | undefined {
  if (fields.flagged) {
    return "flagged as a placeholder in ADMINBOT_SLACK_PLACEHOLDER_USER_IDS";
  }
  for (const name of fields.names) {
    const value = name?.trim();
    if (!value) {
      continue;
    }
    if (PLACEHOLDER_NAMES.has(bareName(value))) {
      return `name "${value}" is a placeholder`;
    }
  }
  if (fields.email && PLACEHOLDER_EMAIL.test(fields.email.trim())) {
    return `email ${fields.email.trim()} is a reserved example address`;
  }
  return undefined;
}

/** What one Slack account is, from this sync's point of view. Order matters: first match wins. */
export function classifySlackUser(
  user: SlackDirectoryUser,
  placeholderIds: ReadonlySet<string> = new Set(),
): SlackAccountKind {
  if (user.id === "USLACKBOT") {
    return "slackbot";
  }
  if (user.is_bot || user.is_app_user) {
    return "bot";
  }
  // Opt-out first: a do-not-contact account is never treated as a test row, whatever else it looks
  // like. Then placeholders, ahead of `deleted` so a deactivated test account still gets its roster
  // record proposed for removal rather than merely flagged as deactivated.
  if (slackOptOutReason(user)) {
    return "opted_out";
  }
  if (slackPlaceholderReason(user, placeholderIds)) {
    return "placeholder";
  }
  if (user.deleted) {
    return "deleted";
  }
  if (user.is_ultra_restricted) {
    return "single_channel_guest";
  }
  if (user.is_restricted) {
    return "multi_channel_guest";
  }
  return "member";
}

function slackPlaceholderReason(
  user: SlackDirectoryUser,
  placeholderIds: ReadonlySet<string>,
): string | undefined {
  return placeholderReason({
    names: [user.real_name, user.display_name],
    ...(user.email ? { email: user.email } : {}),
    flagged: placeholderIds.has(user.id),
  });
}

function slackOptOutReason(user: SlackDirectoryUser): string | undefined {
  return doNotContactReason([
    ["Slack name", user.real_name],
    ["Slack display name", user.display_name],
    ["Slack title", user.title],
  ]);
}

/** Whether a roster record says not to contact its person. */
export function rosterOptOutReason(member: AdminBotLabMember): string | undefined {
  return doNotContactReason([
    ["roster name", member.name],
    ["roster preferred name", member.preferred_name],
  ]);
}

/** Whether a roster record itself looks like a test or placeholder, independent of Slack. */
export function rosterPlaceholderReason(member: AdminBotLabMember): string | undefined {
  return placeholderReason({
    names: [member.name, member.preferred_name],
    ...(member.email ? { email: member.email } : {}),
  });
}

/**
 * Whether this sync may write `field` on `member`. A field the member or an admin wrote is theirs:
 * provenance "member" is the precedence rule the adoption metrics already rely on (isSelfFilled),
 * and "admin" is somebody deciding on purpose. Only fields nobody stamped, or an import stamped,
 * are Slack's to refresh.
 */
function writable(member: AdminBotLabMember, field: SlackRosterSyncField): boolean {
  const source = member.field_provenance?.[field]?.source;
  return source !== "member" && source !== "admin";
}

const normalizeEmail = (value: string | undefined) => value?.trim().toLowerCase() || undefined;

/** A stable, readable id for a newly created member, unique against the roster and this plan. */
function newMemberId(name: string, slackUserId: string, taken: Set<string>): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || slackUserId.toLowerCase();
  let id = base;
  for (let suffix = 2; taken.has(id); suffix += 1) {
    id = `${base}-${suffix}`;
  }
  taken.add(id);
  return id;
}

export function planSlackRosterSync(params: {
  users: readonly SlackDirectoryUser[];
  members: readonly AdminBotLabMember[];
  /** Slack user IDs an admin has explicitly marked as placeholders. */
  placeholderIds?: ReadonlySet<string>;
  now: string;
}): SlackRosterSyncPlan {
  const placeholderIds = params.placeholderIds ?? new Set<string>();
  const plan: SlackRosterSyncPlan = {
    creates: [],
    updates: [],
    deactivations: [],
    reactivations: [],
    removals: [],
    opted_out: [],
    skipped: [],
    conflicts: [],
    unchanged: 0,
  };
  const bySlackId = new Map<string, AdminBotLabMember>();
  const byEmail = new Map<string, AdminBotLabMember[]>();
  for (const member of params.members) {
    const slackId = member.slack_user_id?.trim();
    if (slackId) {
      bySlackId.set(slackId, member);
    }
    const email = normalizeEmail(member.email);
    if (email) {
      byEmail.set(email, [...(byEmail.get(email) ?? []), member]);
    }
  }
  // What members absorbed in admin merges, consulted only when the live indexes miss.
  const byAlternateSlackId = new Map<string, AdminBotLabMember>();
  const byAlternateEmail = new Map<string, AdminBotLabMember>();
  for (const member of params.members) {
    for (const slackId of member.alternate_slack_user_ids ?? []) {
      const key = slackId.trim();
      if (key && !bySlackId.has(key) && !byAlternateSlackId.has(key)) {
        byAlternateSlackId.set(key, member);
      }
    }
    for (const address of member.alternate_emails ?? []) {
      const key = normalizeEmail(address);
      if (key && !byEmail.has(key) && !byAlternateEmail.has(key)) {
        byAlternateEmail.set(key, member);
      }
    }
  }
  // Retired ids stay taken, so a re-created duplicate could not reclaim one even if it got this far.
  const takenIds = new Set(
    params.members.flatMap((member) => [member.id, ...(member.former_member_ids ?? [])]),
  );
  const matchedMembers = new Set<string>();
  const removalIds = new Set<string>();
  const optedOutIds = new Set<string>();
  const optOut = (member: AdminBotLabMember | undefined, slackUserId: string, reason: string) => {
    if (member && optedOutIds.has(member.id)) {
      return;
    }
    if (member) {
      optedOutIds.add(member.id);
    }
    plan.opted_out.push({
      ...(member ? { member_id: member.id, member_name: member.name } : {}),
      slack_user_id: slackUserId,
      reason,
      action: "opted out; admin review",
    });
  };

  const propose = (member: AdminBotLabMember, slackUserId: string, reason: string) => {
    if (removalIds.has(member.id)) {
      return;
    }
    removalIds.add(member.id);
    plan.removals.push({
      member_id: member.id,
      member_name: member.name,
      slack_user_id: slackUserId,
      reason,
    });
  };

  for (const user of params.users) {
    const kind = classifySlackUser(user, placeholderIds);
    const email = normalizeEmail(user.email);
    let member = bySlackId.get(user.id);
    let matchedBy: SlackRosterUpdate["matched_by"] = "slack_user_id";
    if (!member && email) {
      const candidates = (byEmail.get(email) ?? []).filter(
        // An email hit on a record already linked to a different Slack account is two people
        // sharing an address (or a re-created account), not a match.
        (candidate) => !candidate.slack_user_id?.trim() || candidate.slack_user_id === user.id,
      );
      if (candidates.length > 1) {
        plan.conflicts.push({
          slack_user_id: user.id,
          reason: `email ${email} matches ${candidates.length} roster records`,
        });
        continue;
      }
      member = candidates[0];
      matchedBy = "email";
    }
    if (!member) {
      const absorbedBy =
        byAlternateSlackId.get(user.id) ?? (email ? byAlternateEmail.get(email) : undefined);
      if (absorbedBy) {
        // A second account of somebody an admin merged: the duplicate record was retired on
        // purpose, so this account is not a joiner. Nothing is written from it either -- its avatar,
        // zone and deactivation describe the other account, not the one the record keeps.
        matchedMembers.add(absorbedBy.id);
        plan.unchanged += 1;
        continue;
      }
    }
    if (member) {
      matchedMembers.add(member.id);
    }

    // A do-not-contact record or account is reported and left exactly as it is. No write means no
    // after-write hook, so the sync cannot be what invites, nudges or messages somebody who opted
    // out -- and the roster's own name (often the member's own edit) is never "fixed" back.
    const optOutReason = member ? rosterOptOutReason(member) : undefined;
    if (kind === "opted_out" || optOutReason) {
      optOut(
        member,
        user.id,
        optOutReason ?? slackOptOutReason(user) ?? "asks not to be contacted",
      );
      continue;
    }
    if (kind === "bot" || kind === "slackbot") {
      plan.skipped.push({
        slack_user_id: user.id,
        kind,
        ...(member ? { member_id: member.id } : {}),
      });
      continue;
    }
    if (kind === "placeholder") {
      if (member) {
        propose(member, user.id, slackPlaceholderReason(user, placeholderIds) ?? "placeholder");
      } else {
        plan.skipped.push({ slack_user_id: user.id, kind });
      }
      continue;
    }
    if (!member) {
      // Not on the roster. Only a full workspace member is imported; a guest is somebody invited
      // into one or two channels, and a deactivated account is somebody who has already left.
      if (kind !== "member") {
        plan.skipped.push({ slack_user_id: user.id, kind });
        continue;
      }
      const name = user.real_name?.trim() || user.display_name?.trim();
      if (!name) {
        plan.conflicts.push({ slack_user_id: user.id, reason: "Slack account has no name" });
        continue;
      }
      if (!email) {
        // Without an address the record cannot be matched again, so the next run would create it
        // a second time. Report instead.
        plan.conflicts.push({ slack_user_id: user.id, reason: "Slack account has no email" });
        continue;
      }
      plan.creates.push({
        slack_user_id: user.id,
        member: {
          id: newMemberId(name, user.id, takenIds),
          name,
          email,
          slack_user_id: user.id,
          // Least privilege. Joining the Slack workspace is not an authorization; an admin
          // promotes from here exactly as for any other unattended join.
          privilege_level: "external_collaborator",
          ...(user.image ? { avatar_url: user.image } : {}),
          ...(user.tz ? { timezone: user.tz } : {}),
          notes: "Created from the Slack roster sync.",
        },
      });
      continue;
    }

    // Matched to a real account. A roster record with a test-placeholder name ("Test User") backed
    // by a real person is repaired from Slack below rather than removed.
    if (kind === "deleted") {
      if (!member.slack_deactivated_at?.trim()) {
        plan.deactivations.push({ member_id: member.id, slack_user_id: user.id });
      } else {
        plan.unchanged += 1;
      }
      continue;
    }

    const changes: SlackRosterFieldChange[] = [];
    const offer = (field: SlackRosterSyncField, next: string | undefined, onlyIfEmpty: boolean) => {
      const value = next?.trim();
      if (!value || !writable(member, field)) {
        return;
      }
      const current = (member[field] ?? "").trim();
      if (current === value || (onlyIfEmpty && current)) {
        return;
      }
      changes.push({ field, from: current, to: value });
    };
    if (!member.slack_user_id?.trim()) {
      offer("slack_user_id", user.id, true);
    }
    offer("avatar_url", user.image, false);
    // Only when empty: the directory refresh owns the live zone and records the movement timeline;
    // writing it here too would race that and skip the timeline.
    offer("timezone", user.tz, true);
    if (rosterPlaceholderReason(member)) {
      // A placeholder name such as "Test User" backed by a real Slack account: the record is a real
      // person with a stand-in name, so take the name Slack has. Admin provenance does not protect
      // a stand-in name -- nobody types "placeholder" as a decision -- but a member's own entry does.
      const name = user.real_name?.trim() || user.display_name?.trim();
      if (name && member.field_provenance?.name?.source !== "member") {
        changes.push({ field: "name", from: member.name, to: name });
      }
    }

    const reactivated = Boolean(member.slack_deactivated_at?.trim());
    if (reactivated) {
      plan.reactivations.push({ member_id: member.id, slack_user_id: user.id });
    }
    if (changes.length) {
      plan.updates.push({
        member_id: member.id,
        slack_user_id: user.id,
        matched_by: matchedBy,
        changes,
      });
    } else if (!reactivated) {
      plan.unchanged += 1;
    }
    if (kind !== "member") {
      // Still updated -- a guest on the roster is usually an external collaborator -- but noted so
      // the report says why this account would not have been imported had it been new.
      plan.skipped.push({ slack_user_id: user.id, kind, member_id: member.id });
    }
  }

  // Roster records no Slack account matched. A do-not-contact one is reported, never removed; a
  // test placeholder is proposed for removal.
  for (const member of params.members) {
    if (matchedMembers.has(member.id) || removalIds.has(member.id) || optedOutIds.has(member.id)) {
      continue;
    }
    const optOutReason = rosterOptOutReason(member);
    if (optOutReason) {
      optOut(member, member.slack_user_id?.trim() ?? "", optOutReason);
      continue;
    }
    const reason = rosterPlaceholderReason(member);
    if (reason) {
      propose(member, member.slack_user_id?.trim() ?? "", `roster record ${reason}`);
    }
  }
  return plan;
}

/** Refuse a pass that would create or flag more of the roster than a real day ever does. */
export const ADMINBOT_SLACK_ROSTER_SYNC_MIN_CHANGES = 10;
export const ADMINBOT_SLACK_ROSTER_SYNC_MAX_CHANGE_FRACTION = 0.25;

export function slackRosterSyncRefusal(
  plan: SlackRosterSyncPlan,
  rosterSize: number,
): string | undefined {
  const sweeping = plan.creates.length + plan.deactivations.length + plan.removals.length;
  const ceiling = Math.max(
    ADMINBOT_SLACK_ROSTER_SYNC_MIN_CHANGES,
    Math.ceil(rosterSize * ADMINBOT_SLACK_ROSTER_SYNC_MAX_CHANGE_FRACTION),
  );
  if (sweeping > ceiling) {
    return `refusing to apply ${sweeping} creations, deactivations and removals in one pass (ceiling ${ceiling} for a roster of ${rosterSize}) -- check the Slack read, then re-run with force`;
  }
  return undefined;
}
