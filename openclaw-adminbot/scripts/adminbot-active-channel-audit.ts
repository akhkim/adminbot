// Who is in #jinesis-active and #random-active who should not be.
//
//   node --import tsx scripts/adminbot-active-channel-audit.ts [--json] [--sheet <xlsx>] [--propose]
//
// Reads both channels, matches every member against the roster, and reports each one as entitled,
// not entitled, unknown or unmatched. Read-only by default: it prints the audit and files nothing.
//
// `--propose` files one `slack.remove_from_channel` proposal per not-entitled person per channel.
// That action is T3, so nothing leaves the building until an admin approves it in Pending Actions
// -- deliberately, and unlike `slack.invite_to_channel`, which is T1. Adding somebody to a channel
// by mistake is an apology; removing them is a person watching a room disappear, losing the
// history, and needing somebody to work out what happened before they can be put back.
//
// Only `not_entitled` is ever proposed. `unknown` (Member Type blank) and `unmatched` (no roster
// row carries that Slack id) are printed for a human and left alone. Treating "the roster cannot
// say" as "no" is how this kicks the PI out of the lab channel.
//
// `--sheet` cross-checks the roster's Member Type against the spreadsheet's Full Slack Member List
// tab. Where the two disagree the person is downgraded to `unknown` and reported: a removal decided
// from a value the two sources contradict each other about is the one most likely to be wrong.
import process from "node:process";
import {
  adminBotMemberTypeTokens,
  type AdminBotLabMember,
} from "../extensions/adminbot/src/contracts/actions.js";
import { ADMINBOT_ACTIVE_CHANNELS } from "../extensions/adminbot/src/workflows/members/access-audit.js";
import {
  auditActiveChannels,
  classifyChannelMember,
  findMemberTypeDivergence,
  type ActiveChannelRow,
} from "../extensions/adminbot/src/workflows/members/active-channel-audit.js";

type SlackApi = (method: string, params: Record<string, unknown>) => Promise<Record<string, never>>;

/** Every member id in a channel, following Slack's cursor pagination to the end. */
async function channelMemberIds(api: SlackApi, channel: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = (await api("conversations.members", {
      channel,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    })) as unknown as { members?: string[]; response_metadata?: { next_cursor?: string } };
    ids.push(...(page.members ?? []));
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return ids;
}

/** Channel name -> id. The two channels are named in the codebase, not by id. */
async function resolveChannelIds(
  api: SlackApi,
  names: readonly string[],
): Promise<Map<string, string>> {
  const wanted = new Set(names.map((name) => name.replace(/^#/u, "").toLowerCase()));
  const found = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const page = (await api("conversations.list", {
      limit: 200,
      exclude_archived: true,
      types: "public_channel,private_channel",
      ...(cursor ? { cursor } : {}),
    })) as unknown as {
      channels?: Array<{ id: string; name: string }>;
      response_metadata?: { next_cursor?: string };
    };
    for (const channel of page.channels ?? []) {
      if (wanted.has(channel.name.toLowerCase())) {
        found.set(channel.name.toLowerCase(), channel.id);
      }
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor && found.size < wanted.size);
  return found;
}

async function slackDisplayNames(
  api: SlackApi,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const id of ids) {
    try {
      const info = (await api("users.info", { user: id })) as unknown as {
        user?: { real_name?: string; name?: string; is_bot?: boolean };
      };
      const user = info.user;
      names.set(id, `${user?.real_name || user?.name || id}${user?.is_bot ? " (bot)" : ""}`);
    } catch {
      // A lookup that fails leaves the id as the label. Not a reason to abandon the audit, and the
      // id is still enough for a person to find them in Slack.
      names.set(id, id);
    }
  }
  return names;
}

/** Member Type by Slack id, off the spreadsheet's Full Slack Member List tab.
 *
 * Read through python/openpyxl, which the repo already depends on for the reimbursement forms,
 * rather than adding a JavaScript xlsx library for one optional cross-check.
 */
async function readSheetTypes(pathname: string): Promise<Map<string, string>> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const program = [
    "import json,sys",
    "from openpyxl import load_workbook",
    "wb=load_workbook(sys.argv[1], read_only=True, data_only=True)",
    "ws=wb['Full Slack Member List']",
    "rows=ws.iter_rows(values_only=True)",
    "header=[str(c).strip() if c else '' for c in next(rows)]",
    "slack=header.index('Slack ID'); mtype=header.index('Member Type')",
    "out={}",
    "for r in rows:",
    "    if not r or len(r)<=max(slack,mtype): continue",
    "    sid=str(r[slack]).strip() if r[slack] else ''",
    "    if sid: out[sid]=str(r[mtype]).strip() if r[mtype] else ''",
    "print(json.dumps(out))",
  ].join("\n");
  const result = await run("python3", ["-c", program, pathname], { maxBuffer: 8 * 1024 * 1024 });
  return new Map(Object.entries(JSON.parse(result.stdout) as Record<string, string>));
}

function render(audit: ReturnType<typeof auditActiveChannels>, divergence: unknown[]): void {
  const { counts } = audit;
  process.stdout.write(
    `#jinesis-active / #random-active audit\n` +
      `  ${counts.entitled} entitled · ${counts.not_entitled} not entitled · ` +
      `${counts.unknown} unknown · ${counts.unmatched} unmatched\n\n`,
  );
  if (audit.removable.length) {
    process.stdout.write(`Would remove (${audit.removable.length}):\n`);
    for (const row of audit.removable) {
      process.stdout.write(
        `  ${row.member_name ?? row.display_name} [${row.slack_user_id}] — ${row.reason}\n` +
          `      channels: ${row.channels.join(", ")}\n`,
      );
    }
    process.stdout.write("\n");
  }
  if (audit.needs_review.length) {
    process.stdout.write(
      `Left alone, needs a person (${audit.needs_review.length}) — never removed by this script:\n`,
    );
    for (const row of audit.needs_review) {
      process.stdout.write(
        `  ${row.member_name ?? row.display_name} [${row.slack_user_id}] — ${row.reason}\n`,
      );
    }
    process.stdout.write("\n");
  }
  if (divergence.length) {
    process.stdout.write(
      `Roster and spreadsheet disagree (${divergence.length}) — treated as unknown:\n`,
    );
    for (const entry of divergence as Array<{
      member_name: string;
      database: string;
      spreadsheet: string;
    }>) {
      process.stdout.write(
        `  ${entry.member_name}: database "${entry.database}" vs sheet "${entry.spreadsheet}"\n`,
      );
    }
    process.stdout.write("\n");
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const propose = argv.includes("--propose");
  const sheetAt = argv.indexOf("--sheet");
  const sheetPath = sheetAt >= 0 ? argv[sheetAt + 1] : undefined;

  const { getSlackWriteClient } = await import("../extensions/slack/api.js");
  const { resolveEmailAutomationSlackAccount } = await import("./adminbot-email-automation.ts");
  const account = await resolveEmailAutomationSlackAccount();
  if (!account.botToken) {
    throw new Error("Slack bot token is not configured");
  }
  const api = (await getSlackWriteClient({ botToken: account.botToken })) as unknown as SlackApi;

  const channelIds = await resolveChannelIds(api, ADMINBOT_ACTIVE_CHANNELS);
  const missing = ADMINBOT_ACTIVE_CHANNELS.filter((name) => !channelIds.has(name.toLowerCase()));
  if (missing.length) {
    throw new Error(`could not resolve channel(s): ${missing.join(", ")}`);
  }

  // Slack id -> the channels they are in, so one person with both memberships is one row.
  const membership = new Map<string, string[]>();
  for (const name of ADMINBOT_ACTIVE_CHANNELS) {
    const id = channelIds.get(name.toLowerCase()) as string;
    for (const user of await channelMemberIds(api, id)) {
      membership.set(user, [...(membership.get(user) ?? []), name]);
    }
  }

  // Same convention as adminbot-import-member-sheet.ts and the cron scripts: the running service
  // over HTTP with the service token, rather than opening its database from a second process.
  const token = process.env.ADMINBOT_SERVICE_TOKEN;
  if (!token) {
    throw new Error("ADMINBOT_SERVICE_TOKEN is not set");
  }
  const baseUrl = process.env.ADMINBOT_BASE_URL?.trim() || "http://127.0.0.1:8765";
  const rosterResponse = await fetch(`${baseUrl}/lab/members`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!rosterResponse.ok) {
    throw new Error(`could not read the roster: ${rosterResponse.status}`);
  }
  const members =
    ((await rosterResponse.json()) as { members?: AdminBotLabMember[] }).members ?? [];
  const bySlackId = new Map(
    members.flatMap((member) =>
      member.slack_user_id?.trim() ? [[member.slack_user_id.trim(), member] as const] : [],
    ),
  );

  const divergence = sheetPath
    ? findMemberTypeDivergence({ members, sheetTypesBySlackId: await readSheetTypes(sheetPath) })
    : [];
  const contested = new Set(divergence.map((entry) => entry.member_id));

  const names = await slackDisplayNames(api, [...membership.keys()]);
  const rows: ActiveChannelRow[] = [...membership.entries()].map(([slackUserId, channels]) => {
    const member = bySlackId.get(slackUserId);
    const row = classifyChannelMember({
      slackUserId,
      displayName: names.get(slackUserId) ?? slackUserId,
      ...(member ? { member } : {}),
      channels,
    });
    // A person the two sources disagree about is not a person to remove on the strength of one of
    // them. Downgraded rather than dropped, so they still appear in the report.
    return member && contested.has(member.id)
      ? {
          ...row,
          verdict: "unknown" as const,
          reason: "The roster and the spreadsheet disagree about this Member Type.",
        }
      : row;
  });

  const audit = auditActiveChannels(rows);
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...audit, divergence }, null, 2)}\n`);
  } else {
    render(audit, divergence);
  }

  if (!propose) {
    process.stdout.write(
      audit.removable.length
        ? "Nothing was filed. Re-run with --propose to raise removal proposals for review.\n"
        : "Nothing to remove.\n",
    );
    return;
  }

  let filed = 0;
  for (const row of audit.removable) {
    for (const channel of row.channels) {
      const response = await fetch(`${baseUrl}/proposals`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "slack.remove_from_channel",
          summary: `Remove ${row.member_name ?? row.display_name} from #${channel} (${row.member_type ?? "no member type"})`,
          proposed_payload: { channel, user_id: row.slack_user_id, reason: row.reason },
          // One proposal per person per channel, so approving is per removal rather than
          // all-or-nothing, and a re-run does not stack duplicates.
          idempotency_key: `active-channel-removal:${channel}:${row.slack_user_id}`,
        }),
      });
      if (response.ok) {
        filed += 1;
      } else {
        process.stderr.write(
          `  could not file removal for ${row.slack_user_id} in #${channel}: ${response.status}\n`,
        );
      }
    }
  }
  process.stdout.write(
    `Filed ${filed} removal proposal(s). They are T3: nothing happens until an admin approves them in Pending Actions.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
