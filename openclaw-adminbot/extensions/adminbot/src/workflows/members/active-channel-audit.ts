// Who belongs in #jinesis-active and #random-active, and who is in them without belonging.
//
// The entitlement rule is not invented here. `collaborator-subgroups.ts` already grants
// `active_channels` to exactly `own_pace_advisee` and `coauthor_major`, and a full member holds
// every lab surface by definition -- so this asks those predicates rather than restating them. A
// second copy of "who belongs in the active channels" would drift from the one that decides who
// gets invited, and the drift would be invisible: both would keep answering, just differently.
//
// The important half of this module is what it refuses to decide.
//
// A channel member falls into one of four buckets, and only one of them is a removal. `entitled`
// stays. `not_entitled` is a person the roster positively says should not be there. `unknown` is
// a roster row whose Member Type is blank -- twelve of them in the current sheet -- and `unmatched`
// is a Slack account no roster row claims at all: a bot, a guest, somebody who joined before the
// roster existed, or a row whose Slack id was never filled in (56 of 178 rows have none).
//
// Unknown and unmatched are reported and never removed. Treating "the roster cannot say" as "no"
// is how a sweep kicks the PI out of the lab channel, and there is no undo for that -- the person
// sees it, loses the history, and has to be re-invited by somebody who understands what happened.

import {
  adminBotIsFullMemberType,
  adminBotMemberTypeTokens,
  type AdminBotLabMember,
} from "../../contracts/actions.js";

/**
 * The Member Type tokens that hold the active channels.
 *
 * `full` covers the lab's own people. The other two are the only external subgroups the access
 * matrix grants `active_channels` to -- see the `cells` on that row, which this list mirrors and
 * `activeChannelEntitlementMatchesMatrix` asserts against.
 */
export const ACTIVE_CHANNEL_TOKENS = ["full", "own-pace-advisee", "coauthor-major"] as const;

export type ActiveChannelVerdict = "entitled" | "not_entitled" | "unknown" | "unmatched";

export type ActiveChannelRow = {
  slack_user_id: string;
  /** Whatever Slack calls them, for a report a human reads. */
  display_name: string;
  /** The roster row this Slack account resolved to, when one did. */
  member_id?: string;
  member_name?: string;
  member_type?: string;
  verdict: ActiveChannelVerdict;
  /** Why, in one line. Shown per row so a removal is never unexplained. */
  reason: string;
  /** Which of the two channels they are in. */
  channels: string[];
};

export type ActiveChannelAudit = {
  rows: ActiveChannelRow[];
  /** The only rows a removal may be proposed for. */
  removable: ActiveChannelRow[];
  /** Reported for a person to resolve, never acted on. */
  needs_review: ActiveChannelRow[];
  counts: Record<ActiveChannelVerdict, number>;
};

/**
 * Whether a Member Type string holds the active channels.
 *
 * Token-based, because the column is multi-valued: "alumni, coauthor-major" is three rows in the
 * current sheet and is entitled through its second token. Exact string matching would drop all
 * three, and they are exactly the people whose entitlement is least obvious.
 */
export function holdsActiveChannels(memberType: string | undefined): boolean {
  const tokens = adminBotMemberTypeTokens(memberType);
  return ACTIVE_CHANNEL_TOKENS.some((token) => tokens.includes(token));
}

/**
 * A blank Member Type is a question, not a no.
 *
 * The shared tokenizer splits on commas without dropping empties, so a blank column comes back as
 * `[""]` -- length 1, and truthy if you only count. Harmless for the `includes()` callers it was
 * written for, wrong here, where the whole decision turns on whether the roster said anything.
 */
function hasMemberType(memberType: string | undefined): boolean {
  return adminBotMemberTypeTokens(memberType).some((token) => token.length > 0);
}

/**
 * Classify one channel member.
 *
 * `member` absent means no roster row claimed this Slack account. That is `unmatched` and stays
 * put: the roster not knowing somebody is a gap in the roster, not evidence about the person.
 */
export function classifyChannelMember(params: {
  slackUserId: string;
  displayName: string;
  member?: AdminBotLabMember;
  channels: string[];
}): ActiveChannelRow {
  const base = {
    slack_user_id: params.slackUserId,
    display_name: params.displayName,
    channels: params.channels,
  };
  if (!params.member) {
    return {
      ...base,
      verdict: "unmatched",
      reason:
        "No roster row carries this Slack id. Left alone: the roster not knowing somebody is a gap in the roster.",
    };
  }
  const member = params.member;
  const shared = {
    ...base,
    member_id: member.id,
    member_name: member.name,
    ...(member.member_type ? { member_type: member.member_type } : {}),
  };
  if (!hasMemberType(member.member_type)) {
    return {
      ...shared,
      verdict: "unknown",
      reason:
        "Member Type is blank, so the roster cannot say. Left alone until somebody fills it in.",
    };
  }
  if (holdsActiveChannels(member.member_type) || adminBotIsFullMemberType(member.member_type)) {
    return {
      ...shared,
      verdict: "entitled",
      reason: `Member Type "${member.member_type}" holds the active channels.`,
    };
  }
  return {
    ...shared,
    verdict: "not_entitled",
    reason: `Member Type "${member.member_type}" does not hold #jinesis-active or #random-active.`,
  };
}

export function auditActiveChannels(rows: readonly ActiveChannelRow[]): ActiveChannelAudit {
  const counts: Record<ActiveChannelVerdict, number> = {
    entitled: 0,
    not_entitled: 0,
    unknown: 0,
    unmatched: 0,
  };
  for (const row of rows) {
    counts[row.verdict] += 1;
  }
  return {
    rows: [...rows],
    // Only the positively not-entitled. This is the list the removal path is allowed to see.
    removable: rows.filter((row) => row.verdict === "not_entitled"),
    needs_review: rows.filter((row) => row.verdict === "unknown" || row.verdict === "unmatched"),
    counts,
  };
}

/**
 * One roster row disagreeing with the spreadsheet about somebody's Member Type.
 *
 * The database is the authority and the sheet is supposed to match it. Where they do not, the
 * honest answer is neither: this reports the pair and the row is treated as `unknown` for the
 * purposes of removal, because a removal decided from a value the two sources disagree about is
 * the one most likely to be wrong.
 */
export type MemberTypeDivergence = {
  member_id: string;
  member_name: string;
  database: string;
  spreadsheet: string;
};

export function findMemberTypeDivergence(params: {
  members: readonly AdminBotLabMember[];
  /** Member Type by Slack id, read off the spreadsheet's Full Slack Member List tab. */
  sheetTypesBySlackId: ReadonlyMap<string, string>;
}): MemberTypeDivergence[] {
  const divergent: MemberTypeDivergence[] = [];
  for (const member of params.members) {
    const slackId = member.slack_user_id?.trim();
    if (!slackId) {
      continue;
    }
    const sheet = params.sheetTypesBySlackId.get(slackId)?.trim();
    if (sheet === undefined) {
      continue;
    }
    const database = member.member_type?.trim() ?? "";
    // Compared as token sets: the two sources order and space the list differently, and
    // "full, coauthor-minor" against "coauthor-minor, full" is agreement, not divergence.
    const left = [...adminBotMemberTypeTokens(database)].toSorted().join(",");
    const right = [...adminBotMemberTypeTokens(sheet)].toSorted().join(",");
    if (left !== right) {
      divergent.push({
        member_id: member.id,
        member_name: member.name,
        database,
        spreadsheet: sheet,
      });
    }
  }
  return divergent;
}
