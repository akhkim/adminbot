#!/usr/bin/env tsx
// Invites collaborators into the #discussion-xxx and #meeting-xxx channels their work matches.
//
// Two halves, split where the capability is. This script knows how to ask Slack what channels
// exist; the service knows who belongs in them. It sends the list and the service does the
// matching, so who-goes-where stays server-computed and testable and this stays a Slack read.
//
// The channel list is the lab's own answer to "what are our topics": the lab decides by opening a
// channel, and a topic with no channel is one nobody has committed to yet.
import { isMainModule } from "./lib/is-main-module.mjs";

const CHANNEL_PREFIXES = ["discussion-", "meeting-"];
const SLACK_PAGE_LIMIT = 1000;

type SlackApi = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** Every open public channel in one of our topic families, by name. */
export async function fetchTopicChannels(api: SlackApi): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = (await api("conversations.list", {
      types: "public_channel",
      exclude_archived: true,
      limit: SLACK_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    })) as {
      channels?: Array<{ name?: string }>;
      response_metadata?: { next_cursor?: string };
    };
    for (const channel of page.channels ?? []) {
      const name = channel.name?.trim().toLowerCase();
      if (name && CHANNEL_PREFIXES.some((prefix) => name.startsWith(prefix))) {
        names.push(name);
      }
    }
    cursor = page.response_metadata?.next_cursor?.trim() || undefined;
  } while (cursor);
  return [...new Set(names)].sort();
}

async function slackApi(): Promise<SlackApi> {
  // Same resolver the hourly email automation uses. The `directory peers` CLI path cannot resolve
  // the bot token's SecretRef outside a gateway runtime snapshot, which is why this goes to the Web
  // API directly -- see the note in adminbot-slack-channel-directory.ts.
  const { getSlackWriteClient } = await import("../extensions/slack/api.js");
  const { resolveEmailAutomationSlackAccount } = await import("./adminbot-email-automation.ts");
  const account = await resolveEmailAutomationSlackAccount();
  if (!account.botToken) {
    throw new Error("Slack bot token is not configured");
  }
  const client = getSlackWriteClient(account.botToken);
  return (method, params) => client.apiCall(method, params) as never;
}

async function main(): Promise<void> {
  const token = process.env.ADMINBOT_SERVICE_TOKEN;
  if (!token) {
    throw new Error("ADMINBOT_SERVICE_TOKEN is not set");
  }
  const channels = await fetchTopicChannels(await slackApi());
  if (channels.length === 0) {
    // Not an error: a workspace with no topic channels yet has nobody to invite anywhere, and
    // failing the cron run for it would be a nightly red for a state the lab chose.
    console.log(JSON.stringify({ channels: 0, invited: 0, skipped: 0 }, null, 2));
    return;
  }
  if (process.argv.includes("--dry-run")) {
    console.log(JSON.stringify({ dry_run: true, channels }, null, 2));
    return;
  }
  const port = process.env.ADMINBOT_PORT || "8765";
  const response = await fetch(`http://127.0.0.1:${port}/members/topic-channels/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ channels }),
  }).catch((error: unknown) => {
    throw new Error(`cannot reach the AdminBot service on 127.0.0.1:${port} — is it running?`, {
      cause: error,
    });
  });
  if (!response.ok) {
    throw new Error(`POST /members/topic-channels/run failed: ${response.status}`);
  }
  const payload = (await response.json()) as {
    invited?: unknown[];
    skipped?: unknown[];
  };
  console.log(
    JSON.stringify(
      {
        channels: channels.length,
        invited: payload.invited?.length ?? 0,
        skipped: payload.skipped?.length ?? 0,
      },
      null,
      2,
    ),
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    const cause = error instanceof Error && error.cause ? ` (${String(error.cause)})` : "";
    console.error(`${error instanceof Error ? error.message : String(error)}${cause}`);
    process.exit(1);
  });
}
