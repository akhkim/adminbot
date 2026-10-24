// The before_dispatch hook that answers "stop" and "start" in a Slack DM without the agent.
//
// A bare command is recorded by the AdminBot service and answered with one fixed reply; anything
// else, a channel message, or a sender the service does not know falls through to the agent as
// usual. A service failure also falls through: the member then gets an ordinary agent answer
// rather than a false "Done".
import { parseSlackStopCommand } from "../../workflows/members/slack-stop.js";

export type SlackStopDispatchEvent = {
  content: string;
  body?: string;
  channel?: string;
  senderId?: string;
  isGroup?: boolean;
};

export type SlackStopDispatchContext = { channelId?: string; senderId?: string };

export type ApplySlackStop = (params: {
  slackUserId: string;
  command: "stop" | "start";
}) => Promise<unknown>;

export async function handleSlackStopDispatch(
  event: SlackStopDispatchEvent,
  ctx: SlackStopDispatchContext,
  applySlackStop: ApplySlackStop,
): Promise<{ handled: true; text: string } | undefined> {
  if (event.isGroup !== false || (event.channel ?? ctx.channelId) !== "slack") {
    return undefined;
  }
  const command = parseSlackStopCommand(event.content || event.body);
  const slackUserId = (event.senderId ?? ctx.senderId ?? "").trim();
  if (!command || !slackUserId) {
    return undefined;
  }
  try {
    const result = (await applySlackStop({ slackUserId, command })) as {
      matched?: boolean;
      reply?: string;
    };
    return result?.matched && result.reply ? { handled: true, text: result.reply } : undefined;
  } catch {
    return undefined;
  }
}
