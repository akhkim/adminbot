import { createHash } from "node:crypto";
import type { InterviewInvitation } from "../workflows/onboarding/interview.js";

/** Called only by the approved onboarding executor; never from preview or proposal creation. */
export function createInterviewChannelProvisioner(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl = fetch,
) {
  return async (email: string, interview: InterviewInvitation): Promise<string> => {
    const token = env.SLACK_BOT_TOKEN || env.ADMINBOT_SLACK_BOT_TOKEN;
    if (!token) {
      throw new Error("Private interview channels require a configured Slack bot token.");
    }
    const call = async (method: string, body: Record<string, unknown>) => {
      const response = await fetchImpl(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as {
        ok?: boolean;
        error?: string;
        channel?: { id?: string; is_private?: boolean };
        channels?: { id: string; name: string; is_private?: boolean }[];
        members?: string[];
        user_id?: string;
        user?: { id?: string };
        response_metadata?: { next_cursor?: string };
      };
      if (!response.ok || !result.ok) {
        throw new Error(`Private interview channel: ${result.error || response.status}`);
      }
      return result;
    };
    const name = `interview-${createHash("sha256")
      .update(JSON.stringify([email.toLowerCase(), [...interview.interviewer_ids].toSorted()]))
      .digest("hex")
      .slice(0, 20)}`;
    let channel: string | undefined;
    let cursor = "";
    for (let page = 0; page < 20; page++) {
      const list = await call("conversations.list", {
        types: "private_channel",
        limit: 200,
        cursor,
      });
      channel = list.channels?.find((item) => item.name === name && item.is_private)?.id;
      cursor = list.response_metadata?.next_cursor || "";
      if (channel || !cursor) {
        break;
      }
      if (page === 19) {
        throw new Error("Could not safely finish checking existing interview channels.");
      }
    }
    if (!channel) {
      const created = await call("conversations.create", { name, is_private: true });
      if (!created.channel?.is_private || !created.channel.id) {
        throw new Error("Slack did not return a private interview channel.");
      }
      channel = created.channel.id;
    }
    const bot = await call("auth.test", {});
    if (!bot.user_id) {
      throw new Error("Could not identify the invitation bot.");
    }
    const allowed = new Set([...interview.interviewer_ids, bot.user_id]);
    try {
      const candidate = await call("users.lookupByEmail", { email });
      if (candidate.user?.id) {
        allowed.add(candidate.user.id);
      }
    } catch (error) {
      if (!(error instanceof Error) || !error.message.endsWith("users_not_found")) {
        throw error;
      }
    }
    const occupants = await call("conversations.members", { channel, limit: 1000 });
    if (
      occupants.response_metadata?.next_cursor ||
      !occupants.members ||
      occupants.members.some((id) => !allowed.has(id))
    ) {
      throw new Error(
        "The interview channel contains other people; refusing to invite the candidate.",
      );
    }
    // Invite only the two explicitly approved interviewers; no default lab/friends channel.
    for (const id of interview.interviewer_ids) {
      try {
        await call("conversations.invite", { channel, users: id });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.endsWith("already_in_channel")) {
          throw error;
        }
      }
    }
    return channel;
  };
}
