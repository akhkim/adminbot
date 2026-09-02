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
      if (proposal.type === "slack.create_channel") {
        const payload = readCreatePayload(proposal);
        const token = resolveSlackBotToken(env);
        await createSlackChannel(token, payload.name, fetchImpl);
        return { handled: true };
      }
      if (proposal.type === "slack.remove_from_channel") {
        const payload = readInvitePayload(proposal, "slack.remove_from_channel");
        const token = resolveSlackBotToken(env);
        await removeFromSlackChannel(token, payload.channel, payload.user_id, fetchImpl);
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
function readInvitePayload(
  proposal: AdminBotStoredProposal,
  // Shared by the invite and the removal, which carry the same two fields. Named so the refusal
  // says which one was malformed rather than always blaming the invite.
  typeName = "slack.invite_to_channel",
): {
  channel: string;
  user_id: string;
} {
  const payload = proposal.proposed_payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${typeName} requires an object proposed_payload`);
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
/**
 * The id behind a channel name, which is what every conversations.* call actually takes.
 *
 * Extracted so the invite and the removal resolve names the same way. They have to: a sweep that
 * added somebody to the channel it found and removed them from a different one -- because the two
 * lookups disagreed about archived channels, say -- is worse than either failing outright.
 */
/**
 * A Slack conversation id, as opposed to a channel name.
 *
 * C is a public channel, G a private one, D a DM. Names cannot take this shape -- Slack channel
 * names are lowercase -- so there is no value that could be read as either.
 */
const SLACK_CONVERSATION_ID = /^[CGD][A-Z0-9]{7,}$/u;

/**
 * Every open public channel in the workspace, by name.
 *
 * Exported because two callers need the same walk: `resolveChannelId` looks one up, and the
 * project form asks for the whole set so it can tell somebody their alias does not match any
 * channel *before* they file a project under a name nobody will find.
 *
 * Public and unarchived only, which is the same slice `resolveChannelId` has always searched. A
 * private channel the bot cannot see is not a name the lab can be asked to match: the answer
 * "there is no such channel" would be wrong, and wrong in the direction that blocks a legitimate
 * project.
 *
 * Paginated to exhaustion rather than capped. A cap would silently answer "no such channel" for
 * every channel past the limit, which is the one failure this must not have.
 */
export async function listSlackChannelNames(
  token: string,
  fetchImpl: SlackAdminFetch,
): Promise<string[]> {
  const names: string[] = [];
  for await (const channel of walkPublicChannels(token, fetchImpl)) {
    if (channel.name) {
      names.push(channel.name);
    }
  }
  return names;
}

/** The shared pagination walk. One loop, so a lookup and a listing cannot disagree about scope. */
async function* walkPublicChannels(
  token: string,
  fetchImpl: SlackAdminFetch,
): AsyncGenerator<{ id?: string; name?: string }> {
  let cursor: string | undefined;
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
    for (const channel of payload.channels ?? []) {
      yield channel;
    }
    cursor = payload.response_metadata?.next_cursor?.trim() || undefined;
  } while (cursor);
}

/** The env read, exported so a caller outside the executor can fail the same way it does. */
export function adminBotSlackBotToken(env: NodeJS.ProcessEnv): string {
  return resolveSlackBotToken(env);
}

async function resolveChannelId(
  token: string,
  channelName: string,
  fetchImpl: SlackAdminFetch,
): Promise<string> {
  const wanted = channelName.replace(/^#/u, "");
  // Already an id: hand it back rather than searching the directory for a channel *named*
  // "C0A06H6K6DV", which is what a configured id used to do -- and since these invites run before
  // the mail, that lookup failing refused the whole send. Both forms are legitimate config: the
  // city sweep names its channels, and a fixed channel is more safely pinned by id, which survives
  // a rename.
  if (SLACK_CONVERSATION_ID.test(wanted)) {
    return wanted;
  }
  let channelId: string | undefined;
  for await (const channel of walkPublicChannels(token, fetchImpl)) {
    if (channel.name === wanted) {
      channelId = channel.id;
      break;
    }
  }
  if (!channelId) {
    // Refused rather than created. Opening a channel is a decision about the workspace's shape, and
    // a sweep that quietly makes rooms is how a directory fills with them.
    throw new Error(`Slack has no open channel named #${wanted}`);
  }
  return channelId;
}

async function inviteToSlackChannel(
  token: string,
  channelName: string,
  userId: string,
  fetchImpl: SlackAdminFetch,
): Promise<void> {
  const channelId = await resolveChannelId(token, channelName, fetchImpl);
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

/**
 * The channel a create proposal may open.
 *
 * Only `proj-<alias>`. This is the whole safety story for auto-approving creation: the action
 * cannot open a `lab-`, `group-` or arbitrarily named room however it is called, so the worst a bug
 * upstream can do is create a project channel for a project. The shape matches the alias rule in
 * contracts/actions.ts, which is what generated the name.
 */
const PROJECT_CHANNEL_NAME = /^proj-[a-z0-9][a-z0-9-]*$/u;

function readCreatePayload(proposal: AdminBotStoredProposal): { name: string } {
  const payload = proposal.proposed_payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("slack.create_channel requires an object proposed_payload");
  }
  const name = requireString(payload as Record<string, unknown>, "name").replace(/^#/u, "");
  if (!PROJECT_CHANNEL_NAME.test(name)) {
    throw new Error(
      `slack.create_channel refuses ${name}: only proj-<alias> channels may be opened this way`,
    );
  }
  return { name };
}

/**
 * Opens one project channel, or accepts that it is already open.
 *
 * `name_taken` is success, not failure, and that is what lets this run without first asking Slack
 * what exists: the sweep says "there should be a channel called this" every time it runs, and Slack
 * decides whether that means creating one. It is the same idempotence `already_in_channel` gives
 * the invite, and it is why no channel directory is needed to make project channels work.
 */
async function createSlackChannel(
  token: string,
  name: string,
  fetchImpl: SlackAdminFetch,
): Promise<void> {
  const response = await fetchImpl("https://slack.com/api/conversations.create", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ name, is_private: false }),
  });
  const payload = parseSlackJson<SlackRenameResponse>(await response.text());
  if (payload?.error === "name_taken") {
    return;
  }
  if (!response.ok || !payload?.ok) {
    const detail = payload?.error?.trim() || response.statusText || "unknown error";
    throw new Error(`Slack channel create failed ${response.status}: ${detail}`);
  }
}

/**
 * Takes one member back out of one public channel.
 *
 * `not_in_channel` is not an error, for the same reason `already_in_channel` is not one above: the
 * sweep is idempotent by design, and somebody who left of their own accord has already reached the
 * state this is asking for. Treating it as a failure would make every later run of the sweep
 * report a problem that no longer exists.
 *
 * `cant_kick_self` is left as an error deliberately. It means the bot was asked to remove itself,
 * which is never something a roster sweep should be doing and is worth surfacing rather than
 * swallowing alongside the benign cases.
 */
async function removeFromSlackChannel(
  token: string,
  channelName: string,
  userId: string,
  fetchImpl: SlackAdminFetch,
): Promise<void> {
  const channelId = await resolveChannelId(token, channelName, fetchImpl);
  const removal = await fetchImpl("https://slack.com/api/conversations.kick", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: channelId, user: userId }),
  });
  const removalPayload = parseSlackJson<SlackRenameResponse>(await removal.text());
  if (removalPayload?.error === "not_in_channel") {
    return;
  }
  if (!removal.ok || !removalPayload?.ok) {
    const detail = removalPayload?.error?.trim() || removal.statusText || "unknown error";
    throw new Error(`Slack channel removal failed ${removal.status}: ${detail}`);
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
  // One is now legitimate. This used to demand two, guarding against the escalation quietly
  // becoming a private message *to the professor* with the member not in the room. That failure is
  // gone by construction: the professor is no longer a recipient at all -- their copy is the
  // escalation queue on their own page -- so the only person this can reach is the member it is
  // about, which is the direction the old rule was protecting.
  if (userIds.length < 1) {
    throw new Error("member_nudge.escalate requires at least one Slack user id");
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
