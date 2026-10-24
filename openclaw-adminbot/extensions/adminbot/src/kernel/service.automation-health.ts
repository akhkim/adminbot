/**
 * Is the automation actually running, and is it actually working?
 *
 * Two questions the cron run list cannot answer on its own. A job that stops being scheduled is
 * silent -- nothing runs, so nothing fails -- and a job that runs green while every action it
 * proposes fails (an invite into a channel that does not exist, 1,281 times in a week) looks
 * healthy from the scheduler's side. Both are read here from the audit trail: the cron wrapper
 * records one heartbeat per run, and every failed execution is already audited.
 *
 * Pure: the events and a proposal lookup in, the issues out. The service decides who hears about
 * them, and the ledger decides how often.
 */
import { classifySlackInviteFailure } from "../connectors/slack-admin.js";
import type { AdminBotAuditEvent, AdminBotStoredProposal } from "../contracts/actions.js";

const HOUR_MS = 60 * 60 * 1000;

/** A broken channel blocks invites into it for a day, then one invite tries again. */
export const SLACK_CHANNEL_BLOCK_MS = 24 * HOUR_MS;
/** A person the bot cannot add is a manual job; re-proposing them within a month only re-fails. */
export const SLACK_MEMBER_BLOCK_MS = 30 * 24 * HOUR_MS;
/** Action failures inside this window, at least this often with the same error, are an issue. */
const REPEAT_WINDOW_MS = 24 * HOUR_MS;
const REPEAT_THRESHOLD = 3;

export type AutomationHealthIssue = {
  /** Stable while the problem is the same problem; the alert ledger dedupes on it. */
  key: string;
  kind: "stale" | "failing" | "repeating_failure" | "channel_blocked" | "needs_manual_invite";
  label: string;
  detail: string;
  count: number;
  last_seen?: string;
};

export type SlackInviteBlock = {
  scope: "channel" | "member";
  reason: string;
  channel: string;
  user_id?: string;
  since: string;
  error: string;
};

type ProposalLookup = (id: string) => AdminBotStoredProposal | undefined;

const channelKey = (channel: string) => channel.trim().replace(/^#/u, "").toLowerCase();

function invitePayload(
  proposal: AdminBotStoredProposal | undefined,
): { channel: string; user_id: string } | undefined {
  const payload = proposal?.proposed_payload as Record<string, unknown> | undefined;
  return typeof payload?.channel === "string" && typeof payload.user_id === "string"
    ? { channel: payload.channel, user_id: payload.user_id }
    : undefined;
}

/**
 * Every invite the bot should stop retrying, newest failure per channel or per person.
 *
 * Read from `execution.failed` rather than kept in a table of its own: the failure is already
 * recorded with its reason, and a second record of the same fact is a second thing to fall out of
 * step. A later success clears nothing explicitly -- a channel block simply ages out, and the next
 * invite after that is the probe.
 */
export function slackInviteBlocks(
  events: readonly AdminBotAuditEvent[],
  proposalOf: ProposalLookup,
  now = new Date(),
): SlackInviteBlock[] {
  const blocks = new Map<string, SlackInviteBlock>();
  for (const event of events) {
    if (event.type !== "execution.failed" || !event.action_id) {
      continue;
    }
    const details = (event.details ?? {}) as Record<string, unknown>;
    if (details.action_type !== "slack.invite_to_channel" || typeof details.error !== "string") {
      continue;
    }
    const failure = classifySlackInviteFailure(details.error);
    const age = now.getTime() - Date.parse(event.timestamp);
    if (
      !failure ||
      !(age >= 0) ||
      age > (failure.scope === "channel" ? SLACK_CHANNEL_BLOCK_MS : SLACK_MEMBER_BLOCK_MS)
    ) {
      continue;
    }
    const payload = invitePayload(proposalOf(event.action_id));
    if (!payload) {
      continue;
    }
    const channel = channelKey(payload.channel);
    const key =
      failure.scope === "channel" ? `channel|${channel}` : `member|${channel}|${payload.user_id}`;
    const previous = blocks.get(key);
    if (!previous || previous.since < event.timestamp) {
      blocks.set(key, {
        scope: failure.scope,
        reason: failure.reason,
        channel,
        ...(failure.scope === "member" ? { user_id: payload.user_id } : {}),
        since: event.timestamp,
        error: details.error,
      });
    }
  }
  return [...blocks.values()];
}

/** The block, if any, that a new invite of `userId` into `channel` would run into. */
export function slackInviteBlockFor(
  blocks: readonly SlackInviteBlock[],
  channel: string,
  userId: string,
): SlackInviteBlock | undefined {
  const wanted = channelKey(channel);
  return blocks.find(
    (block) =>
      block.channel === wanted && (block.scope === "channel" || block.user_id === userId),
  );
}

// ---------------------------------------------------------------------------------------------
// Schedules: how long a job may be quiet before quiet means stopped
// ---------------------------------------------------------------------------------------------

function cronField(field: string, min: number, max: number): Set<number> | undefined {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/u.exec(part.trim());
    if (!match) {
      return undefined;
    }
    const [from, to] =
      match[1] === "*"
        ? [min, max]
        : match[1].includes("-")
          ? match[1].split("-").map(Number)
          : [Number(match[1]), match[2] ? max : Number(match[1])];
    const step = match[2] ? Number(match[2]) : 1;
    if (!(step > 0) || from < min || to > max || from > to) {
      return undefined;
    }
    for (let value = from; value <= to; value += step) {
      values.add(value);
    }
  }
  return values;
}

const gapCache = new Map<string, number | undefined>();

/**
 * The longest a five-field cron expression ever goes between two runs, in minutes.
 *
 * Walked rather than reasoned about: "10 9 * * 1-5" is a day apart on a Tuesday and three days
 * apart over a weekend, and the weekend is the gap a staleness check must allow for. Sixty-two
 * days covers a monthly job twice. Cached, since the expressions are a fixed set of ~50.
 */
export function cronMaxGapMinutes(expression: string): number | undefined {
  if (gapCache.has(expression)) {
    return gapCache.get(expression);
  }
  const fields = expression.trim().split(/\s+/u);
  const parsed =
    fields.length === 5
      ? [
          cronField(fields[0], 0, 59),
          cronField(fields[1], 0, 23),
          cronField(fields[2], 1, 31),
          cronField(fields[3], 1, 12),
          cronField(fields[4], 0, 7),
        ]
      : [];
  let result: number | undefined;
  if (parsed.length === 5 && parsed.every(Boolean)) {
    const [minutes, hours, days, months, weekdays] = parsed as Set<number>[];
    if (weekdays.has(7)) {
      weekdays.add(0);
    }
    // Classic cron: when both day fields are restricted, either one matching is a run.
    const domStar = fields[2] === "*";
    const dowStar = fields[4] === "*";
    const start = Date.UTC(2026, 0, 5);
    let previous: number | undefined;
    let longest = 0;
    for (let minute = 0; minute < 62 * 24 * 60; minute += 1) {
      const at = new Date(start + minute * 60_000);
      if (!minutes.has(at.getUTCMinutes()) || !hours.has(at.getUTCHours())) {
        continue;
      }
      const dom = days.has(at.getUTCDate());
      const dow = weekdays.has(at.getUTCDay());
      const dayMatches = domStar || dowStar ? dom && dow : dom || dow;
      if (!dayMatches || !months.has(at.getUTCMonth() + 1)) {
        continue;
      }
      if (previous !== undefined) {
        longest = Math.max(longest, minute - previous);
      }
      previous = minute;
    }
    result = longest > 0 ? longest : undefined;
  }
  gapCache.set(expression, result);
  return result;
}

/** Quiet for longer than this means the job has stopped. The grace absorbs a slow or late run. */
export function staleAfterMinutes(expression: string): number | undefined {
  const gap = cronMaxGapMinutes(expression);
  return gap === undefined ? undefined : gap + Math.max(90, Math.round(gap / 4));
}

// ---------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------

type Heartbeat = { job: string; ok: boolean; at: string; cron?: string; detail?: string };

function heartbeatOf(event: AdminBotAuditEvent): Heartbeat | undefined {
  if (event.type !== "automation_health.heartbeat") {
    return undefined;
  }
  const details = (event.details ?? {}) as Record<string, unknown>;
  return typeof details.job === "string"
    ? {
        job: details.job,
        ok: details.ok === true,
        at: event.timestamp,
        ...(typeof details.cron === "string" ? { cron: details.cron } : {}),
        ...(typeof details.detail === "string" ? { detail: details.detail } : {}),
      }
    : undefined;
}

/** Ids and long numbers out, so the same failure on two members groups as one failure. */
function normalizeError(message: string): string {
  return message
    .replace(/\b[UWCGD][A-Z0-9]{8,}\b/gu, "<id>")
    .replace(/\b(?:act|aud|notif)_[0-9a-f-]+\b/gu, "<id>")
    .replace(/\d{4,}/gu, "<n>")
    .trim()
    .slice(0, 200);
}

function runs(count: number): string {
  return count === 1 ? "1 run" : `${count} runs`;
}

export function automationHealthIssues(
  events: readonly AdminBotAuditEvent[],
  proposalOf: ProposalLookup,
  now = new Date(),
): AutomationHealthIssue[] {
  const issues: AutomationHealthIssue[] = [];
  const nowMs = now.getTime();

  // Jobs: stopped, or failing run after run. Newest heartbeat last, per job.
  const byJob = new Map<string, Heartbeat[]>();
  for (const event of events) {
    const beat = heartbeatOf(event);
    if (beat) {
      byJob.set(beat.job, [...(byJob.get(beat.job) ?? []), beat]);
    }
  }
  for (const [job, beats] of byJob) {
    beats.sort((left, right) => left.at.localeCompare(right.at));
    const latest = beats[beats.length - 1];
    const cron = [...beats].reverse().find((beat) => beat.cron)?.cron;
    const staleAfter = cron ? staleAfterMinutes(cron) : undefined;
    const quietMinutes = (nowMs - Date.parse(latest.at)) / 60_000;
    if (staleAfter !== undefined && quietMinutes > staleAfter) {
      issues.push({
        key: `stale:${job}`,
        kind: "stale",
        label: `${job} has stopped running`,
        detail: `Scheduled "${cron}", but the last run was ${Math.round(quietMinutes / 60)}h ago. Check the gateway cron store and the job's last error.`,
        count: 1,
        last_seen: latest.at,
      });
    }
    let failing = 0;
    for (let index = beats.length - 1; index >= 0 && !beats[index].ok; index -= 1) {
      failing += 1;
    }
    // A daily job that failed once has already lost a day; an hourly one gets a second chance
    // before anyone hears about a blip.
    const gap = cron ? cronMaxGapMinutes(cron) : undefined;
    if (failing >= (gap !== undefined && gap >= 24 * 60 ? 1 : 2)) {
      issues.push({
        key: `failing:${job}`,
        kind: "failing",
        label: `${job} is failing`,
        detail: `${runs(failing)} in a row failed. Last error: ${latest.detail ?? "none recorded"}`,
        count: failing,
        last_seen: latest.at,
      });
    }
  }

  // Actions: the same execution failing over and over. Classified invite failures are reported
  // once as blocks below, not here as a count, since the guard has already stopped them repeating.
  const repeats = new Map<string, { type: string; error: string; count: number; last: string }>();
  for (const event of events) {
    if (event.type !== "execution.failed") {
      continue;
    }
    const age = nowMs - Date.parse(event.timestamp);
    const details = (event.details ?? {}) as Record<string, unknown>;
    const type = typeof details.action_type === "string" ? details.action_type : "unknown";
    const error = typeof details.error === "string" ? details.error : "unknown error";
    if (!(age >= 0 && age <= REPEAT_WINDOW_MS)) {
      continue;
    }
    if (type === "slack.invite_to_channel" && classifySlackInviteFailure(error)) {
      continue;
    }
    const normalized = normalizeError(error);
    const key = `${type}|${normalized}`;
    const entry = repeats.get(key) ?? { type, error: normalized, count: 0, last: event.timestamp };
    entry.count += 1;
    entry.last = entry.last < event.timestamp ? event.timestamp : entry.last;
    repeats.set(key, entry);
  }
  for (const [key, entry] of repeats) {
    if (entry.count >= REPEAT_THRESHOLD) {
      issues.push({
        key: `repeat:${key}`,
        kind: "repeating_failure",
        label: `${entry.type} keeps failing`,
        detail: `${entry.count} failures in 24h: ${entry.error}`,
        count: entry.count,
        last_seen: entry.last,
      });
    }
  }

  // Invites: a broken channel is one issue; the people the bot cannot add are one per channel.
  const blocks = slackInviteBlocks(events, proposalOf, now);
  for (const block of blocks.filter((entry) => entry.scope === "channel")) {
    issues.push({
      key: `slack-channel:${block.channel}:${block.reason}`,
      kind: "channel_blocked",
      label: `Invites into #${block.channel} are paused`,
      detail:
        block.reason === "channel_missing"
          ? `There is no public channel named #${block.channel}. Create it (or make it public), or pin its channel id in config; invites resume within a day.`
          : block.reason === "not_in_channel"
            ? `The bot is not a member of #${block.channel} and could not join it. Add the bot to the channel; invites resume within a day.`
            : `Slack refused invites into #${block.channel} (${block.reason}). Invites resume within a day.`,
      count: 1,
      last_seen: block.since,
    });
  }
  const manual = new Map<string, SlackInviteBlock[]>();
  for (const block of blocks.filter((entry) => entry.scope === "member")) {
    manual.set(block.channel, [...(manual.get(block.channel) ?? []), block]);
  }
  for (const [channel, people] of manual) {
    const users = people.map((entry) => entry.user_id ?? "").toSorted();
    issues.push({
      key: `slack-manual-invite:${channel}:${users.join(",")}`,
      kind: "needs_manual_invite",
      label: `${users.length} ${users.length === 1 ? "person needs" : "people need"} a manual invite to #${channel}`,
      detail: `The bot cannot add them (${[...new Set(people.map((entry) => entry.reason))].join(", ")}): guests and members of another workspace or org have to be invited by a workspace admin. Slack ids: ${users.join(", ")}.`,
      count: users.length,
      last_seen: people.map((entry) => entry.since).toSorted().at(-1),
    });
  }
  return issues;
}
