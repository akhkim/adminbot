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
