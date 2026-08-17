// Slack plugin module implements events behavior.
import type { ResolvedSlackAccount } from "../accounts.js";
import type { SlackMonitorContext } from "./context.js";
import { registerSlackAssistantEvents } from "./events/assistant.js";
import { registerSlackChannelEvents } from "./events/channels.js";
import { registerSlackHomeEvents } from "./events/home.js";
import { registerSlackInteractionEvents } from "./events/interactions.js";
import { registerSlackMemberEvents } from "./events/members.js";
import { registerSlackMessageEvents } from "./events/messages.js";
import { registerSlackPinEvents } from "./events/pins.js";
import { registerSlackReactionEvents } from "./events/reactions.js";
import type { SlackMessageHandler } from "./message-handler.js";

export function registerSlackMonitorEvents(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  handleSlackMessage: SlackMessageHandler;
  /** Called on each inbound event to update liveness tracking. */
  trackEvent?: () => void;
  onChannelNamingEvent?: (event: {
    eventType: "channel_created" | "channel_rename";
    channelId?: string;
    channelName?: string;
    ownerUserId?: string;
    purpose?: string;
    topic?: string;
  }) => Promise<void>;
}) {
  registerSlackMessageEvents({
    ctx: params.ctx,
    handleSlackMessage: params.handleSlackMessage,
  });
  registerSlackReactionEvents({ ctx: params.ctx, trackEvent: params.trackEvent });
  registerSlackMemberEvents({ ctx: params.ctx, trackEvent: params.trackEvent });
  registerSlackChannelEvents({
    ctx: params.ctx,
    trackEvent: params.trackEvent,
    onChannelNamingEvent: params.onChannelNamingEvent,
  });
  registerSlackPinEvents({ ctx: params.ctx, trackEvent: params.trackEvent });
  registerSlackHomeEvents({ ctx: params.ctx, trackEvent: params.trackEvent });
  registerSlackInteractionEvents({ ctx: params.ctx, trackEvent: params.trackEvent });
  registerSlackAssistantEvents({ ctx: params.ctx, trackEvent: params.trackEvent });
}
