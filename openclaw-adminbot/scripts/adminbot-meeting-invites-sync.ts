#!/usr/bin/env tsx
// Puts the people in a meeting's Slack channel onto that meeting's calendar invite.
//
// Two families, one pass: #meeting-xxx belongs to a "Theme: xxx" event and #proj-xxx to a
// "Proj: xxx" one. The channel is the lab's own statement of who is on a piece of work -- somebody
// was added to it by a person who knew why -- so it is the better roster for the invite than
// anything derived, and it is the one an admin already keeps up to date.
//
// Split where the capability is, like adminbot-topic-channels-sync.ts: this knows how to ask Slack
// what channels exist and who is in them, and the service decides which event that maps to and
// which address to use. The calendar read happens service-side, because the host has a Google
// client and a cron wrapper does not -- so this sends channels and members, and nothing else.
//
// Nothing here invites anyone. Every match becomes a `calendar.add_attendees` proposal an admin
// approves, because putting a person on a recurring invite is not a thing a nightly pass gets to
// do quietly.
import { isMainModule } from "./lib/is-main-module.mjs";

/** The two channel families that own a meeting. Kept in step with ADMINBOT_MEETING_FAMILIES. */
const CHANNEL_PREFIXES = ["meeting-", "proj-"];
const SLACK_PAGE_LIMIT = 1000;

type SlackApi = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export type MeetingChannel = { channel: string; slack_user_ids: string[] };

/** Every open public channel in one of the two meeting families, by name and id. */
export async function fetchMeetingChannels(
  api: SlackApi,
): Promise<Array<{ id: string; name: string }>> {
  const found: Array<{ id: string; name: string }> = [];
  let cursor: string | undefined;
  do {
    const page = (await api("conversations.list", {
      types: "public_channel",
      exclude_archived: true,
      limit: SLACK_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    })) as {
      channels?: Array<{ id?: string; name?: string }>;
      response_metadata?: { next_cursor?: string };
    };
    for (const channel of page.channels ?? []) {
      const name = channel.name?.trim().toLowerCase();
      const id = channel.id?.trim();
      if (name && id && CHANNEL_PREFIXES.some((prefix) => name.startsWith(prefix))) {
        found.push({ id, name });
      }
    }
    cursor = page.response_metadata?.next_cursor?.trim() || undefined;
  } while (cursor);
  return found.toSorted((left, right) => left.name.localeCompare(right.name));
}

/**
 * Who is in one channel, paged out in full.
 *
 * A partial member list is worse than none: the sweep would read it as "these are the people on
 * this work" and proposals would quietly omit whoever fell past the first page. So a failure here
 * drops the channel rather than sending a short list -- see the catch in `collectChannels`.
 */
export async function fetchChannelMembers(api: SlackApi, channelId: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = (await api("conversations.members", {
      channel: channelId,
      limit: SLACK_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    })) as { members?: string[]; response_metadata?: { next_cursor?: string } };
    ids.push(...(page.members ?? []));
    cursor = page.response_metadata?.next_cursor?.trim() || undefined;
  } while (cursor);
  return [...new Set(ids)];
}

export async function collectChannels(
  api: SlackApi,
  channels: ReadonlyArray<{ id: string; name: string }>,
  onSkip: (channel: string, reason: string) => void,
): Promise<MeetingChannel[]> {
  const collected: MeetingChannel[] = [];
  for (const channel of channels) {
    try {
      const members = await fetchChannelMembers(api, channel.id);
      if (members.length === 0) {
        continue;
      }
      collected.push({ channel: channel.name, slack_user_ids: members });
    } catch (error) {
      // One unreadable channel -- a private one the bot was removed from is the usual cause -- must
      // not fail the other forty.
      onSkip(channel.name, error instanceof Error ? error.message : String(error));
    }
  }
  return collected;
}

async function slackApi(): Promise<SlackApi> {
  // Same resolver adminbot-topic-channels-sync.ts uses; see the note there about why this goes to
  // the Web API directly rather than through the gateway's directory.
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
  const api = await slackApi();
  const skipped: Array<{ channel: string; reason: string }> = [];
  const channels = await collectChannels(api, await fetchMeetingChannels(api), (channel, reason) =>
    skipped.push({ channel, reason }),
  );
  if (channels.length === 0) {
    // Not an error, for the same reason the topic-channel sweep says so: a workspace with no
    // meeting channels has nobody to invite anywhere, and a nightly red for that would be noise.
    console.log(JSON.stringify({ channels: 0, invited: 0, skipped: skipped.length }, null, 2));
    return;
  }
  if (process.argv.includes("--dry-run")) {
    console.log(
      JSON.stringify(
        {
          dry_run: true,
          channels: channels.map((entry) => ({
            channel: entry.channel,
            members: entry.slack_user_ids.length,
          })),
          unreadable: skipped,
        },
        null,
        2,
      ),
    );
    return;
  }
  const port = process.env.ADMINBOT_PORT || "8765";
  // No `meetings` in the body: the service reads the calendar itself. See the route.
  const response = await fetch(`http://127.0.0.1:${port}/calendar/themed-meeting-invites/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ channels }),
  }).catch((error: unknown) => {
    throw new Error(`cannot reach the AdminBot service on 127.0.0.1:${port} — is it running?`, {
      cause: error,
    });
  });
  if (!response.ok) {
    throw new Error(
      `POST /calendar/themed-meeting-invites/run failed: ${response.status} ${await response.text()}`,
    );
  }
  const payload = (await response.json()) as {
    invited?: Array<{ event_id: string; channel: string; attendees: string[] }>;
    skipped?: unknown[];
  };
  console.log(
    JSON.stringify(
      {
        channels: channels.length,
        proposed: payload.invited?.length ?? 0,
        attendees: payload.invited?.reduce((sum, row) => sum + row.attendees.length, 0) ?? 0,
        skipped: payload.skipped?.length ?? 0,
        unreadable: skipped.length,
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
