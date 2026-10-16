// Nudge campaigns: one Slack DM to each member a rule picks, with the safety rails every such send
// needs, written once.
//
// A campaign supplies only what is particular to it: which members it is about and the message
// each one gets. This module does the rest, in the same order every time:
//
//   1. Filter. Alumni are never candidates. Then the campaign's own rule, then the rules every
//      nudge shares: never the head professor, never someone off the nudge list, never someone
//      Slack cannot reach (unless the campaign keeps the old notify-in-portal-anyway behaviour),
//      never someone the ledger says was already asked inside the cooldown.
//   2. Dry run. The default. Returns the count, the skips by reason and three sample messages, and
//      sends nothing.
//   3. Confirm guard. A real send needs `confirm` equal to the dry run's count, so what an admin
//      saw is what goes out; a roster that moved in between refuses rather than surprises.
//      Scheduled runs (a cron with the service token) bypass this one guard and nothing else.
//   4. Send, one member at a time, paced (Slack rate-limits DMs), collecting failures instead of
//      stopping at the first.
//   5. Ledger and audit, per delivered member: the ledger stamp is what step 1 reads next time, and
//      the audit row is the record of who was told what by whom.
//
// Pure apart from the injected `send`, `stamp`, `audit` and `sleep`, so it is testable without a
// service, a store or Slack.
import type { AdminBotLabMember, AdminBotMemberNotificationKind } from "../../contracts/actions.js";
import type {
  AdminBotNudgeDomain,
  AdminBotNudgeLedgerRecord,
} from "../../contracts/paper-cycle.js";

const DAY_MS = 86_400_000;

/** Slack allows about one DM a second per app; a little under that keeps a long run clear of 429s. */
export const ADMINBOT_NUDGE_CAMPAIGN_PACE_MS = 1100;

/** How many rendered messages a dry run shows. */
export const ADMINBOT_NUDGE_CAMPAIGN_SAMPLES = 3;

/** What every campaign declares about itself; also what the campaigns listing shows. */
export type AdminBotNudgeCampaignInfo = {
  /** The ledger domain, and the campaign's id in routes and audit rows. */
  key: AdminBotNudgeDomain;
  label: string;
  description: string;
  /** The route that previews and sends it. */
  route: string;
  /**
   * How long after a send the same member may be asked again. `null`: once, ever. `0`: no
   * cooldown at all (the profile photo nudge's original behaviour).
   */
  cooldown_days: number | null;
  /** A cron runs it with the service token (and so without the confirm guard). */
  scheduled: boolean;
};

/** A campaign's verdict on one member: why not, or the message they get. */
export type AdminBotNudgeCampaignDecision = { skip: string } | { message: string };

export type AdminBotNudgeCampaign = AdminBotNudgeCampaignInfo & {
  /** The notification filed in the portal next to the DM. */
  notification: {
    kind: AdminBotMemberNotificationKind;
    title: string;
    tab?: string;
    important?: boolean;
  };
  /**
   * Skip members with no Slack ID before sending (default). `false` keeps the older behaviour of
   * passing them to the send, which files the portal notification and reports the Slack skip.
   */
  requireSlack?: boolean;
  /** Whether the send appends the portal address. `false` when the message carries its own link. */
  appendPortalLink?: boolean;
  decide(member: AdminBotLabMember): AdminBotNudgeCampaignDecision;
};

export type AdminBotNudgeCampaignMode = {
  dry_run: boolean;
  /** Required for a real send: the number of recipients the admin confirmed. */
  confirm?: number;
  /** A scheduled run: skips the confirm guard, nothing else. */
  scheduled?: boolean;
};

export type AdminBotNudgeCampaignSample = { member_id: string; name: string; message: string };

export type AdminBotNudgeCampaignResult = {
  campaign: AdminBotNudgeDomain;
  dry_run: boolean;
  /** Members who would get (dry run) or were sent (real run) the message. */
  count: number;
  /** Members passed over, by reason. */
  skipped: Record<string, number>;
  samples: AdminBotNudgeCampaignSample[];
  /** Real run only: delivered to Slack. */
  sent?: number;
  /** Real run only: attempted and not delivered, with the reason. */
  failed?: Array<{ member_id: string; reason: string }>;
};

export type AdminBotNudgeCampaignRefusal = {
  refused: "confirm_required" | "confirm_mismatch";
  message: string;
  count: number;
};

export type AdminBotNudgeCampaignDeps = {
  members: readonly AdminBotLabMember[];
  /** The ledger rows for this campaign's domain. */
  ledger: readonly AdminBotNudgeLedgerRecord[];
  headProfessorMemberId?: string;
  now: Date;
  /** Delivers one message. Resolves `delivered: false` with a reason rather than throwing. */
  send(params: {
    member: AdminBotLabMember;
    message: string;
  }): Promise<{ delivered: boolean; reason?: string }>;
  /** Records the ask in the ledger. Called once per delivered member. */
  stamp(memberId: string, nowIso: string): void;
  /** One audit row per delivered member. */
  audit(memberId: string): void;
  paceMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const DEPARTED = new Set(["alumni"]);

/** The ledger subject a campaign stamps; one per member per campaign. */
export function campaignSubjectId(campaign: AdminBotNudgeDomain): string {
  return campaign;
}

/** Whether the ledger says this member was asked inside the campaign's cooldown. */
export function askedRecently(
  entry: AdminBotNudgeLedgerRecord | undefined,
  cooldownDays: number | null,
  now: Date,
): boolean {
  if (!entry?.last_nudged_at || cooldownDays === 0) {
    return false;
  }
  if (cooldownDays === null) {
    return true;
  }
  const at = Date.parse(entry.last_nudged_at);
  return Number.isFinite(at) && now.getTime() - at < cooldownDays * DAY_MS;
}

/** The first word of a name, for "Hi Sam". Falls back to the whole name, then "there". */
export function firstName(name: string | undefined): string {
  const trimmed = name?.trim() ?? "";
  return trimmed.split(/\s+/u)[0] || "there";
}

/** Step 1: who gets it, and why everyone else does not. */
export function selectCampaignRecipients(
  campaign: AdminBotNudgeCampaign,
  deps: Pick<AdminBotNudgeCampaignDeps, "members" | "ledger" | "headProfessorMemberId" | "now">,
): {
  recipients: Array<{ member: AdminBotLabMember; message: string }>;
  skipped: Record<string, number>;
} {
  const subject = campaignSubjectId(campaign.key);
  const ledger = new Map(
    deps.ledger
      .filter((entry) => entry.domain === campaign.key && entry.subject_id === subject)
      .map((entry) => [entry.member_id, entry] as const),
  );
  const headProfessor = deps.headProfessorMemberId?.trim();
  const recipients: Array<{ member: AdminBotLabMember; message: string }> = [];
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  for (const member of deps.members) {
    if (DEPARTED.has(member.status ?? "")) {
      continue;
    }
    const decision = campaign.decide(member);
    if ("skip" in decision) {
      skip(decision.skip);
      continue;
    }
    if (headProfessor && member.id === headProfessor) {
      skip("head_professor");
      continue;
    }
    if (member.receives_nudges !== true) {
      skip("nudges_off");
      continue;
    }
    if (campaign.requireSlack !== false && !member.slack_user_id?.trim()) {
      skip("no_slack_id");
      continue;
    }
    if (askedRecently(ledger.get(member.id), campaign.cooldown_days, deps.now)) {
      skip("already_sent");
      continue;
    }
    recipients.push({ member, message: decision.message });
  }
  return { recipients, skipped };
}

/** Steps 2 to 5. A refusal is returned, not thrown, so the route can answer 409 with the count. */
export async function runNudgeCampaign(
  campaign: AdminBotNudgeCampaign,
  mode: AdminBotNudgeCampaignMode,
  deps: AdminBotNudgeCampaignDeps,
): Promise<AdminBotNudgeCampaignResult | AdminBotNudgeCampaignRefusal> {
  const { recipients, skipped } = selectCampaignRecipients(campaign, deps);
  const count = recipients.length;
  const samples = recipients
    .slice(0, ADMINBOT_NUDGE_CAMPAIGN_SAMPLES)
    .map(({ member, message }) => ({ member_id: member.id, name: member.name, message }));
  if (mode.dry_run) {
    return { campaign: campaign.key, dry_run: true, count, skipped, samples };
  }
  if (!mode.scheduled) {
    if (mode.confirm === undefined) {
      return {
        refused: "confirm_required",
        message: `Sending needs confirm: ${count} (run a dry run first).`,
        count,
      };
    }
    if (mode.confirm !== count) {
      return {
        refused: "confirm_mismatch",
        message: `confirm was ${mode.confirm} but ${count} members would be messaged now; preview again.`,
        count,
      };
    }
  }
  const paceMs = deps.paceMs ?? ADMINBOT_NUDGE_CAMPAIGN_PACE_MS;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nowIso = deps.now.toISOString();
  const failed: Array<{ member_id: string; reason: string }> = [];
  let sent = 0;
  for (const [index, { member, message }] of recipients.entries()) {
    if (index > 0 && paceMs > 0) {
      await sleep(paceMs);
    }
    let outcome: { delivered: boolean; reason?: string };
    try {
      outcome = await deps.send({ member, message });
    } catch (error) {
      outcome = {
        delivered: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (!outcome.delivered) {
      failed.push({ member_id: member.id, reason: outcome.reason ?? "not delivered" });
      continue;
    }
    sent += 1;
    deps.stamp(member.id, nowIso);
    deps.audit(member.id);
  }
  return { campaign: campaign.key, dry_run: false, count, skipped, samples, sent, failed };
}

export function isCampaignRefusal(
  value: AdminBotNudgeCampaignResult | AdminBotNudgeCampaignRefusal,
): value is AdminBotNudgeCampaignRefusal {
  return "refused" in value;
}

/** Reads `{dry_run, confirm}` from a request body. Anything but an explicit `false` is a dry run. */
export function campaignModeFromBody(body: Record<string, unknown>): AdminBotNudgeCampaignMode {
  const confirm = body.confirm;
  return {
    dry_run: body.dry_run !== false,
    ...(typeof confirm === "number" && Number.isInteger(confirm) && confirm >= 0
      ? { confirm }
      : {}),
  };
}
