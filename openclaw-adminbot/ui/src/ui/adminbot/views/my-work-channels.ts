// Matching a typed project alias against the Slack workspace's channels, for the create form's
// "this channel already exists" check. Cut from my-work.ts so it stays under its file-size ratchet.
import { adminBotProjectChannelName } from "../../../../../extensions/adminbot/src/contracts/actions.js";

/** Slack channel names are lowercase, so the comparison is too. */
export function channelExists(channels: readonly string[], alias: string): boolean {
  const wanted = adminBotProjectChannelName(alias).toLowerCase();
  return channels.some((channel) => channel.replace(/^#/u, "").toLowerCase() === wanted);
}

/**
 * Channels that look like near-misses for what was typed, so a mismatch is actionable.
 *
 * A bare "no channel matches" leaves the member guessing at a name they cannot see from here.
 * Matching on the shared prefix is enough to surface the usual mistake -- `cais2` against
 * `#proj-cais`, `causal-ai` against `#proj-cais` -- without listing a workspace at them.
 */
export function nearbyChannels(channels: readonly string[], alias: string): string[] {
  const wanted = alias.toLowerCase();
  if (wanted.length < 2) {
    return [];
  }
  return channels
    .map((channel) => channel.replace(/^#/u, ""))
    .filter((channel) => channel.startsWith("proj-"))
    .filter((channel) => {
      const suffix = channel.slice("proj-".length).toLowerCase();
      return suffix.startsWith(wanted.slice(0, 3)) || wanted.startsWith(suffix.slice(0, 3));
    })
    .slice(0, 5);
}
