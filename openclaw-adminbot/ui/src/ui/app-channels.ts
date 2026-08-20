// The two channel-config actions the settings page needs: save, and reload-discarding-edits.
//
// This module used to carry the WhatsApp pairing flow and the Nostr profile editor as well. Both
// went with their channel cards: the deep clean removed every channel plugin except Slack, so
// there was nothing behind either surface to configure.
import { loadChannels, type ChannelsState } from "./controllers/channels.ts";
import { loadConfig, saveConfig, type ConfigState } from "./controllers/config.ts";
type ChannelsActionHost = ChannelsState &
  ConfigState & {
    hello?: { auth?: { deviceToken?: string | null } | null } | null;
    password?: string;
    settings: { token?: string };
  };

export async function handleChannelConfigSave(host: ChannelsActionHost) {
  const saved = await saveConfig(host as ConfigState);
  const saveError = host.lastError;
  if (!saved) {
    await loadConfig(host as ConfigState);
    if (saveError && !host.lastError) {
      host.lastError = saveError;
    }
    return;
  }
  await loadChannels(host as ChannelsState, true);
}

export async function handleChannelConfigReload(host: ChannelsActionHost) {
  await loadConfig(host as ConfigState, { discardPendingChanges: true });
  await loadChannels(host as ChannelsState, true);
}
