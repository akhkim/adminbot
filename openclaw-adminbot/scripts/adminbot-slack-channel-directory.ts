// Builds a member directory from the lab's Slack channels.
//
//   node --import tsx scripts/adminbot-slack-channel-directory.ts [--json] [--csv <in> <out>]
//
// For every human member of ADMINBOT_SLACK_DIRECTORY_CHANNELS (comma-separated ids, defaulting to
// the three lab channels below) this collects the Slack user id, display and real name, timezone,
// profile picture and -- when the token carries users:read.email -- the profile email.
//
// It calls the Slack Web API directly through getSlackWriteClient rather than shelling out to
// `openclaw.mjs directory peers list`, which throws UnresolvedSecretInputError: that CLI path
// cannot resolve the bot token's SecretRef outside a gateway runtime snapshot, which is why
// refreshMemberDirectoryFromSlack has never linked anyone. resolveEmailAutomationSlackAccount is
// the resolver the hourly automation already uses successfully, so this reuses it.
//
// Read-only. It never writes to the roster: --json prints the directory, --csv fills blank Name and
// Slack ID cells in a MemberList export. Feeding it into the roster is
// scripts/adminbot-import-member-sheet.ts's job, which has the never-overwrite/never-create rules.
import fs from "node:fs";

const DEFAULT_CHANNELS = ["C09MANEUPPZ", "C0A06H6K6DV", "C09N53S79BK"];

export type SlackDirectoryEntry = {
  slack_user_id: string;
  name: string;
  real_name: string;
  timezone: string;
  image: string;
  email: string;
  channels: string[];
};

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
    })) as unknown as {
      members?: string[];
      response_metadata?: { next_cursor?: string };
    };
    ids.push(...(page.members ?? []));
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return ids;
}

export async function fetchSlackChannelDirectory(
  channels: readonly string[],
): Promise<SlackDirectoryEntry[]> {
  const { getSlackWriteClient } = await import("../extensions/slack/api.js");
  const { resolveEmailAutomationSlackAccount } = await import("./adminbot-email-automation.ts");
  const account = await resolveEmailAutomationSlackAccount();
  if (!account.botToken) {
    throw new Error("Slack bot token is not configured");
  }
  const client = getSlackWriteClient(account.botToken);
  const api: SlackApi = (method, params) => client.apiCall(method, params) as never;

  // Channel membership first, so one person in several channels is fetched once and carries the
  // full list of where they were found.
  const channelsByUser = new Map<string, string[]>();
  for (const channel of channels) {
    for (const id of await channelMemberIds(api, channel)) {
      channelsByUser.set(id, [...(channelsByUser.get(id) ?? []), channel]);
    }
  }

  // The seed list is ids, but the fallback below has to emit *names* -- a raw "C09MANEUPPZ" is not
  // a channel name, and downstream roster validation rejects it. Resolved once here rather than
  // per member, since the same handful of seeds serves everyone.
  const seedNames = new Map<string, string>();
  for (const channel of channels) {
    const name = await channelName(api, channel);
    if (name) {
      seedNames.set(channel, name);
    }
  }

  const entries: SlackDirectoryEntry[] = [];
  for (const [id, found] of channelsByUser) {
    const info = (await api("users.info", { user: id })) as unknown as {
      user?: {
        name?: string;
        real_name?: string;
        tz?: string;
        deleted?: boolean;
        is_bot?: boolean;
        profile?: {
          real_name?: string;
          display_name?: string;
          email?: string;
          image_512?: string;
          image_192?: string;
        };
      };
    };
    const user = info.user;
    // Bots, apps and deactivated accounts are not lab members and would only ever be noise in a
    // roster join.
    if (!user || user.is_bot || user.deleted) {
      continue;
    }
    const profile = user.profile ?? {};
    entries.push({
      slack_user_id: id,
      name: profile.display_name?.trim() || user.name?.trim() || "",
      real_name: profile.real_name?.trim() || user.real_name?.trim() || "",
      timezone: user.tz?.trim() ?? "",
      image: profile.image_512 ?? profile.image_192 ?? "",
      // Absent unless the app holds users:read.email; Slack omits it rather than erroring.
      email: profile.email?.trim() ?? "",
      // Every channel this person is in, by name -- not just the seed channels they were
      // discovered through. `found` only ever holds the handful of ids this run scanned, which is
      // a statement about the scan rather than about the member.
      channels: await memberChannelNames(
        api,
        id,
        found.flatMap((channel) => {
          const name = seedNames.get(channel);
          return name ? [name] : [];
        }),
      ),
    });
  }
  return entries.toSorted((a, b) => a.real_name.localeCompare(b.real_name));
}

/**
 * Every conversation a member belongs to, by name.
 *
 * `users.conversations` answers this in one call per person and returns names, so the seed
 * channels are only ever how someone is *discovered*; where they actually are comes from here.
 * Limited to what the bot itself can see -- private channels it is not in are invisible to it, so
 * this is "every channel we can observe them in", not a claim about the whole workspace.
 *
 * A failure falls back to the seed channels this person was discovered in (by name, never by
 * raw id) rather than throwing: a directory run that loses one person's channel list should
 * still record everything else about them.
 */
/** A channel's name from its id, or "" when the bot cannot see it. */
async function channelName(api: SlackApi, channel: string): Promise<string> {
  try {
    const info = (await api("conversations.info", { channel })) as unknown as {
      ok?: boolean;
      channel?: { name?: string };
    };
    return info.ok ? (info.channel?.name?.trim() ?? "") : "";
  } catch {
    return "";
  }
}

async function memberChannelNames(
  api: SlackApi,
  user: string,
  fallback: readonly string[],
): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  try {
    do {
      const page = (await api("users.conversations", {
        user,
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      })) as unknown as {
        ok?: boolean;
        channels?: Array<{ name?: string }>;
        response_metadata?: { next_cursor?: string };
      };
      if (!page.ok) {
        return [...fallback];
      }
      for (const channel of page.channels ?? []) {
        const name = channel.name?.trim();
        if (name) {
          names.push(name);
        }
      }
      cursor = page.response_metadata?.next_cursor?.trim() || undefined;
    } while (cursor);
  } catch {
    return [...fallback];
  }
  return names.sort((a, b) => a.localeCompare(b));
}

const normalize = (value: string) => value.trim().replaceAll(/\s+/gu, " ").toLowerCase();

/** Minimal RFC4180 reader; the sheet quotes any cell containing a comma. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const csvCell = (value: string) =>
  /[",\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

/**
 * Fills blank Slack ID cells in a MemberList export, and appends anyone Slack knows that the sheet
 * does not. Never overwrites a filled cell.
 *
 * Matching prefers the correspondence email over the name: the sheet's names are hand-typed and
 * drift from Slack display names, while an address either matches or does not. Names remain the
 * fallback for rows whose email column is blank.
 *
 * Parses and re-serialises properly rather than splitting on commas: the sheet quotes any cell
 * containing one (research interests and notes routinely do), and a naive split shifts every later
 * column, which silently writes the id into the wrong field.
 */
export function fillSheet(
  csv: string,
  entries: readonly SlackDirectoryEntry[],
  options: { append?: boolean } = {},
): { out: string; filled: number; matched: number; appended: number } {
  const table = parseCsv(csv);
  const header = (table[0] ?? []).map((cell) => cell.replace(/^\ufeff/u, ""));
  // Columns this script owns. Appended in a fixed order so a re-run finds them again rather than
  // adding a second copy, and filled for every matched row -- an existing member's Slack address
  // is as much a fact worth recording as a new one's.
  const derived: Array<[string, (entry: SlackDirectoryEntry) => string]> = [
    ["Slack ID", (entry) => entry.slack_user_id],
    ["Slack email", (entry) => entry.email],
    ["Profile photo", (entry) => entry.image],
    ["Channels", (entry) => entry.channels.join(", ")],
  ];
  const columnFor = new Map<string, number>();
  for (const [label] of derived) {
    let index = header.findIndex((cell) => normalize(cell) === normalize(label));
    if (index === -1) {
      index = header.length;
      header.push(label);
    }
    columnFor.set(label, index);
  }
  const emailColumn = header.findIndex((cell) => normalize(cell).startsWith("email for"));
  const nameColumn = 0;
  const byName = new Map<string, SlackDirectoryEntry>();
  const byEmail = new Map<string, SlackDirectoryEntry>();
  for (const entry of entries) {
    for (const key of [entry.real_name, entry.name].filter(Boolean)) {
      byName.set(normalize(key), entry);
    }
    if (entry.email) {
      byEmail.set(normalize(entry.email), entry);
    }
  }
  let filled = 0;
  let matched = 0;
  const seen = new Set<string>();
  const body = table.slice(1).map((cells) => {
    const row = cells.slice();
    if (!row.some((cell) => cell.trim())) {
      return row;
    }
    // Address first: it either matches or it does not, where a hand-typed name can drift.
    const entry =
      (emailColumn !== -1 ? byEmail.get(normalize(row[emailColumn] ?? "")) : undefined) ??
      byName.get(normalize(row[nameColumn] ?? ""));
    if (!entry) {
      return row;
    }
    seen.add(entry.slack_user_id);
    matched += 1;
    for (const [label, read] of derived) {
      const index = columnFor.get(label) ?? 0;
      while (row.length <= index) {
        row.push("");
      }
      const value = read(entry);
      if (value && !row[index]?.trim()) {
        row[index] = value;
        filled += 1;
      }
    }
    return row;
  });
  // Anyone in the channels the sheet has never listed. Added with only what Slack actually knows
  // -- name, correspondence email, timezone, Slack id -- so the blanks read as "not collected yet"
  // rather than as invented values.
  let appended = 0;
  if (options.append) {
    // Two lab members have a second Slack account on the same address. Appending both would put
    // one person on two rows, so an address is only ever added once -- the first account wins and
    // the duplicate is skipped rather than silently overwriting it.
    // Seeded with the addresses already on the sheet, not just the ones appended in this pass:
    // a member whose row exists and who has a second Slack account would otherwise be appended
    // alongside their own row.
    const appendedEmails = new Set<string>(
      emailColumn === -1
        ? []
        : body.map((row) => normalize(row[emailColumn] ?? "")).filter(Boolean),
    );
    for (const entry of entries) {
      if (seen.has(entry.slack_user_id)) {
        continue;
      }
      const key = normalize(entry.email);
      if (key && appendedEmails.has(key)) {
        continue;
      }
      if (key) {
        appendedEmails.add(key);
      }
      const row = Array.from({ length: header.length }, () => "");
      row[nameColumn] = entry.real_name || entry.name;
      if (emailColumn !== -1) {
        row[emailColumn] = entry.email;
      }
      const locationColumn = header.findIndex((cell) => normalize(cell) === "location");
      if (locationColumn !== -1) {
        row[locationColumn] = entry.timezone;
      }
      for (const [label, read] of derived) {
        row[columnFor.get(label) ?? 0] = read(entry);
      }
      body.push(row);
      appended += 1;
    }
  }

  const width = Math.max(header.length, ...body.map((row) => row.length));
  const pad = (row: string[]) => {
    const padded = row.slice();
    while (padded.length < width) {
      padded.push("");
    }
    return padded.map(csvCell).join(",");
  };
  return { out: [pad(header), ...body.map(pad)].join("\n"), filled, matched, appended };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const channels = (process.env.ADMINBOT_SLACK_DIRECTORY_CHANNELS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const entries = await fetchSlackChannelDirectory(channels.length ? channels : DEFAULT_CHANNELS);

  const csvIndex = args.indexOf("--csv");
  if (csvIndex !== -1) {
    const input = args[csvIndex + 1];
    const output = args[csvIndex + 2];
    if (!input || !output) {
      throw new Error("--csv needs an input and an output path");
    }
    const result = fillSheet(fs.readFileSync(input, "utf8"), entries, {
      append: !args.includes("--no-append"),
    });
    fs.writeFileSync(output, result.out);
    console.error(
      `slack directory: ${entries.length} people; matched ${result.matched} rows; filled ${result.filled} Slack IDs; appended ${result.appended} new -> ${output}`,
    );
    return;
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  console.error(
    `slack directory: ${entries.length} people across ${channels.length || 3} channels`,
  );
  for (const entry of entries) {
    console.log(
      [entry.slack_user_id, entry.real_name || entry.name, entry.timezone, entry.email].join("\t"),
    );
  }
}

try {
  await main();
} catch (error) {
  console.error(
    `slack channel directory failed: ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
}
