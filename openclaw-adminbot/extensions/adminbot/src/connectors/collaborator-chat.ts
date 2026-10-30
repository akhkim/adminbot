import type { AdminBotStoredProposal } from "../contracts/actions.js";
import { readCollaboratorChatPayload } from "../contracts/collaborator-chat.js";
import type { AdminBotExecutorOutcome } from "../kernel/service.js";
import type { SlackAdminFetch } from "./slack-admin.js";

export async function executeCollaboratorChat(
  proposal: AdminBotStoredProposal,
  token: string,
  fetchImpl: SlackAdminFetch,
): Promise<AdminBotExecutorOutcome> {
  const payload = readCollaboratorChatPayload(proposal.proposed_payload);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let knownChannel: string | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Slack collaborator-chat deadline exceeded; reconcile before retrying."));
    }, 25_000);
  });
  const run = async (): Promise<AdminBotExecutorOutcome> => {
    const call = async (method: string, body: Record<string, unknown>) => {
      controller.signal.throwIfAborted();
      const response = await fetchImpl(`https://slack.com/api/${method}`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      });
      controller.signal.throwIfAborted();
      const text = await response.text();
      controller.signal.throwIfAborted();
      const result = JSON.parse(text) as {
        ok?: boolean;
        error?: string;
        user?: {
          id?: string;
          deleted?: boolean;
          is_bot?: boolean;
          is_app_user?: boolean;
          is_invited_user?: boolean;
        };
        channel?: { id?: string };
        ts?: string;
      };
      if (!response.ok || !result.ok) {
        throw new Error(`Slack ${method} failed: ${result.error ?? response.status}`);
      }
      return result;
    };
    // A linked ID or accepted workspace invitation is not current workspace membership.
    for (const participant of payload.participants) {
      const { user } = await call("users.info", { user: participant.slack_user_id });
      if (
        !user ||
        user.id !== participant.slack_user_id ||
        user.deleted ||
        user.is_bot ||
        user.is_app_user ||
        user.is_invited_user
      ) {
        throw new Error("A participant is not a verified active Slack user.");
      }
    }
    const opened = await call("conversations.open", {
      users: payload.participants.map((p) => p.slack_user_id).join(","),
      return_im: true,
    });
    const channel = opened.channel?.id;
    if (typeof channel !== "string" || !channel) {
      throw new Error("Slack returned no conversation receipt; reconcile before retrying.");
    }
    knownChannel = channel;
    try {
      const sent = await call("chat.postMessage", {
        channel,
        text: payload.message,
        client_msg_id: proposal.id.replace(/^act_/u, ""),
        mrkdwn: false,
        parse: "none",
        unfurl_links: false,
        unfurl_media: false,
      });
      if (typeof sent.ts !== "string" || !sent.ts) {
        throw new Error("Slack returned no message receipt.");
      }
      return {
        handled: true,
        artifacts: { outcome: "message_accepted", slack_channel: channel, slack_ts: sent.ts },
      };
    } catch {
      return {
        handled: true,
        delivered: false,
        reason: "Group opened, but message outcome is unknown. Reconcile before retrying.",
        artifacts: { outcome: "message_unknown", slack_channel: channel },
      };
    }
  };
  try {
    return await Promise.race([run(), deadline]);
  } catch (error) {
    if (knownChannel) {
      return {
        handled: true,
        delivered: false,
        reason:
          "Slack deadline or response failure; reconcile the retained conversation before retrying.",
        artifacts: { outcome: "message_unknown", slack_channel: knownChannel },
      };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
