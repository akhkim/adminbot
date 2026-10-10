import type { ActiveChannelReader } from "../kernel/service.active-channels.js";
import { ADMINBOT_ACTIVE_CHANNELS } from "../workflows/members/access-audit.js";
import { adminBotSlackBotToken, resolveChannelId, type SlackAdminFetch } from "./slack-admin.js";

export function createActiveChannelReader(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: SlackAdminFetch = (input, init) =>
    globalThis.fetch(input, { ...init, signal: AbortSignal.timeout(30_000) }),
): ActiveChannelReader {
  return async () => {
    const token = adminBotSlackBotToken(env);
    async function pages(method: string, field: string, extra: Record<string, string> = {}) {
      const items: unknown[] = [];
      const seen = new Set<string>();
      let cursor = "";
      do {
        const params = new URLSearchParams({
          limit: "200",
          ...extra,
          ...(cursor ? { cursor } : {}),
        });
        const response = await fetchImpl(`https://slack.com/api/${method}?${params}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });
        const body = JSON.parse(await response.text());
        if (!response.ok || body.ok !== true || !Array.isArray(body[field])) {
          throw new Error(`Slack ${method} failed: ${body.error ?? response.status}`);
        }
        items.push(...body[field]);
        cursor = body.response_metadata?.next_cursor?.trim() ?? "";
        if (cursor && seen.has(cursor)) {
          throw new Error("Slack repeated a pagination cursor");
        }
        seen.add(cursor);
      } while (cursor);
      return items;
    }
    const users = new Map<string, boolean>();
    for (const value of await pages("users.list", "members")) {
      const user = value as { id?: string; is_bot?: boolean; is_app_user?: boolean };
      if (!user.id) {
        throw new Error("Slack returned a user without an ID");
      }
      users.set(
        user.id,
        user.is_bot === true || user.is_app_user === true || user.id === "USLACKBOT",
      );
    }
    const snapshot = [];
    for (const channel of ADMINBOT_ACTIVE_CHANNELS) {
      const channelId = await resolveChannelId(token, channel, fetchImpl);
      const ids = await pages("conversations.members", "members", { channel: channelId });
      const userIds: string[] = [];
      for (const id of ids) {
        if (typeof id !== "string" || !users.has(id)) {
          throw new Error("Slack channel member missing from directory");
        }
        if (!users.get(id)) {
          userIds.push(id);
        }
      }
      snapshot.push({ channel, userIds });
    }
    return snapshot;
  };
}
