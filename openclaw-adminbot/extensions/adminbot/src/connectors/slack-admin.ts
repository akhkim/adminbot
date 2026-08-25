import type { AdminBotStoredProposal } from "../contracts/actions.js";
import type { AdminBotActionExecutor } from "../kernel/service.js";

export type SlackAdminFetch = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; statusText: string; text(): Promise<string> }>;

export type AdminBotSlackAdminExecutorOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: SlackAdminFetch;
};

type SlackRenameResponse = {
  ok?: boolean;
  error?: string;
};

type SlackConversationsListResponse = SlackRenameResponse & {
  channels?: Array<{ id?: string; name?: string }>;
  response_metadata?: { next_cursor?: string };
};

type SlackConversationsOpenResponse = SlackRenameResponse & {
  channel?: { id?: string };
};

export function createAdminBotSlackAdminExecutor(
  options: AdminBotSlackAdminExecutorOptions = {},
): AdminBotActionExecutor {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as SlackAdminFetch);
  return {
    async execute(proposal) {
      if (proposal.type === "slack.rename_channel") {
        const payload = readRenamePayload(proposal);
        const token = resolveSlackBotToken(env);
        await renameSlackChannel(token, payload.channel_id, payload.new_name, fetchImpl);
        return { handled: true };
      }
      if (proposal.type === "slack.channel_naming_notify_owner") {
        const payload = readOwnerNoticePayload(proposal);
        const token = resolveSlackBotToken(env);
        await notifySlackOwner(token, payload.owner_user_id, payload.message, fetchImpl);
        return { handled: true };
      }
      // The escalation DM runs here rather than through the OpenClaw message CLI because it is a
      // group conversation: `conversations.open` takes a list of users and hands back one channel
      // for all of them, and there is no "send to these two people at once" in a per-target send.
      if (proposal.type === "slack.invite_to_channel") {
        const payload = readInvitePayload(proposal);
        const token = resolveSlackBotToken(env);
        await inviteToSlackChannel(token, payload.channel, payload.user_id, fetchImpl);
        return { handled: true };
      }
      if (proposal.type === "member_nudge.escalate") {
        const payload = readGroupDmPayload(proposal);
        const token = resolveSlackBotToken(env);
        await notifySlackOwner(token, payload.user_ids.join(","), payload.message, fetchImpl);
        return { handled: true };
      }
      return { handled: false };
    },
  };
}

/**
 * The two people the escalation opens a conversation with.
 *
 * Two, not one: a group DM with a single other user is an ordinary DM, and an escalation that
 * quietly became a private message to the professor is the failure mode this whole shape exists to
 * avoid -- the member has to be in the room.
 */
function readInvitePayload(proposal: AdminBotStoredProposal): {
  channel: string;
  user_id: string;
} {
  const payload = proposal.proposed_payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("slack.invite_to_channel requires an object proposed_payload");
  }
  const record = payload as Record<string, unknown>;
  return {
    channel: requireString(record, "channel"),
    user_id: requireString(record, "user_id"),
  };
}

/**
 * Adds one person to one public channel, by channel name.
 *
 * The name is resolved here rather than stored on the proposal because a channel id means nothing
 * to the administrator reading the audit log, and "#group-toronto" is the thing that was actually
 * decided. `exclude_archived` keeps a renamed-and-archived channel from swallowing the invite.
 *
 * Already-in-channel is not an error. The sweep is idempotent by design and a member who joined on
 * their own before AdminBot got to them is the success case, not a failure to report.
 */
async function inviteToSlackChannel(
  token: string,
  channelName: string,
  userId: string,
  fetchImpl: SlackAdminFetch,
): Promise<void> {
  const wanted = channelName.replace(/^#/u, "");
  let cursor: string | undefined;
  let channelId: string | undefined;
  do {
    const params = new URLSearchParams({
      types: "public_channel",
      exclude_archived: "true",
      limit: "1000",
      ...(cursor ? { cursor } : {}),
    });
    const response = await fetchImpl(`https://slack.com/api/conversations.list?${params}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const payload = parseSlackJson<SlackConversationsListResponse>(await response.text());
    if (!response.ok || !payload?.ok) {
      const detail = payload?.error?.trim() || response.statusText || "unknown error";
      throw new Error(`Slack channel lookup failed ${response.status}: ${detail}`);
    }
    channelId = payload.channels?.find((channel) => channel.name === wanted)?.id;
    cursor = payload.response_metadata?.next_cursor?.trim() || undefined;
  } while (!channelId && cursor);
  if (!channelId) {
    // Refused rather than created. Opening a channel is a decision about the workspace's shape, and
    // a sweep that quietly makes rooms is how a directory fills with them.
    throw new Error(`Slack has no open channel named #${wanted}`);
  }
  const invite = await fetchImpl("https://slack.com/api/conversations.invite", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: channelId, users: userId }),
  });
  const invitePayload = parseSlackJson<SlackRenameResponse>(await invite.text());
  if (invitePayload?.error === "already_in_channel") {
    return;
  }
  if (!invite.ok || !invitePayload?.ok) {
    const detail = invitePayload?.error?.trim() || invite.statusText || "unknown error";
    throw new Error(`Slack channel invite failed ${invite.status}: ${detail}`);
  }
}

function readGroupDmPayload(proposal: AdminBotStoredProposal): {
  user_ids: string[];
  message: string;
} {
  const payload = proposal.proposed_payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("member_nudge.escalate requires an object proposed_payload");
  }
  const raw = (payload as Record<string, unknown>).user_ids;
  const userIds = Array.isArray(raw)
    ? [...new Set(raw.filter((id): id is string => typeof id === "string" && Boolean(id.trim())))]
    : [];
  if (userIds.length < 2) {
    throw new Error("member_nudge.escalate requires at least two Slack user ids");
  }
  return {
    user_ids: userIds,
    message: requireString(payload as Record<string, unknown>, "message"),
  };
}

function readOwnerNoticePayload(proposal: AdminBotStoredProposal): {
  owner_user_id: string;
  message: string;
} {
  const payload = proposal.proposed_payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("slack.channel_naming_notify_owner requires an object proposed_payload");
  }
  const ownerUserId = requireString(payload as Record<string, unknown>, "owner_user_id");
  const message = requireString(payload as Record<string, unknown>, "message");
  return { owner_user_id: ownerUserId, message };
}

function resolveSlackBotToken(env: NodeJS.ProcessEnv): string {
  const token = env.SLACK_BOT_TOKEN?.trim();
  if (!token) {
    throw new Error("SLACK_BOT_TOKEN is required for Slack admin actions");
  }
  return token;
}

function readRenamePayload(proposal: AdminBotStoredProposal): {
  channel_id: string;
  new_name: string;
} {
  const payload = proposal.proposed_payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("slack.rename_channel requires an object proposed_payload");
  }
  const channelId = requireString(payload as Record<string, unknown>, "channel_id");
  const newName = requireString(payload as Record<string, unknown>, "new_name");
  return { channel_id: channelId, new_name: newName };
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`proposed_payload.${key} must be a non-empty string`);
  }
  return value.trim();
}

async function notifySlackOwner(
  token: string,
  ownerUserId: string,
  message: string,
  fetchImpl: SlackAdminFetch,
): Promise<void> {
  const openResponse = await fetchImpl("https://slack.com/api/conversations.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ users: ownerUserId }),
  });
  const openPayload = parseSlackJson<SlackConversationsOpenResponse>(await openResponse.text());
  if (!openResponse.ok || !openPayload?.ok || !openPayload.channel?.id) {
    const detail = openPayload?.error?.trim() || openResponse.statusText || "unknown error";
    throw new Error(`Slack DM open failed ${openResponse.status}: ${detail}`);
  }
  const postResponse = await fetchImpl("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: openPayload.channel.id, text: message }),
  });
  const postPayload = parseSlackJson<SlackRenameResponse>(await postResponse.text());
  if (!postResponse.ok || !postPayload?.ok) {
    const detail = postPayload?.error?.trim() || postResponse.statusText || "unknown error";
    throw new Error(`Slack DM send failed ${postResponse.status}: ${detail}`);
  }
}

async function renameSlackChannel(
  token: string,
  channelId: string,
  newName: string,
  fetchImpl: SlackAdminFetch,
): Promise<void> {
  const response = await fetchImpl("https://slack.com/api/conversations.rename", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: channelId, name: newName }),
  });
  const parsed = parseSlackJson<SlackRenameResponse>(await response.text());
  if (!response.ok || !parsed?.ok) {
    const detail = parsed?.error?.trim() || response.statusText || "unknown error";
    throw new Error(`Slack channel rename failed ${response.status}: ${detail}`);
  }
}

function parseSlackJson<T>(raw: string): T | undefined {
  if (!raw.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
