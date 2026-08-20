// Control UI controller manages channels gateway state.
import type { ChannelsStatusSnapshot } from "../types.ts";
import type { ChannelsState } from "./channels.types.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

export type { ChannelsState };

type LoadChannelsOptions = {
  softTimeoutMs?: number;
};

function delay(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => {
    setTimeout(() => resolve("timeout"), ms);
  });
}

export async function loadChannels(
  state: ChannelsState,
  probe: boolean,
  options: LoadChannelsOptions = {},
) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.channelsLoading && (!state.channelsLoadingProbe || probe)) {
    return;
  }
  const refreshSeq = (state.channelsRefreshSeq ?? 0) + 1;
  state.channelsRefreshSeq = refreshSeq;
  state.channelsLoading = true;
  state.channelsLoadingProbe = probe;
  state.channelsError = null;
  const refresh = (async () => {
    try {
      const res = await state.client!.request<ChannelsStatusSnapshot | null>("channels.status", {
        probe,
        timeoutMs: 8000,
      });
      if (state.channelsRefreshSeq !== refreshSeq) {
        return;
      }
      state.channelsSnapshot = res;
      state.channelsLastSuccess = Date.now();
    } catch (err) {
      if (state.channelsRefreshSeq !== refreshSeq) {
        return;
      }
      if (isMissingOperatorReadScopeError(err)) {
        state.channelsSnapshot = null;
        state.channelsError = formatMissingOperatorReadScopeMessage("channel status");
      } else {
        state.channelsError = String(err);
      }
    } finally {
      if (state.channelsRefreshSeq === refreshSeq) {
        state.channelsLoading = false;
        state.channelsLoadingProbe = null;
      }
    }
  })();

  const softTimeoutMs = options.softTimeoutMs;
  if (typeof softTimeoutMs === "number" && softTimeoutMs > 0) {
    const outcome = await Promise.race([refresh.then(() => "done" as const), delay(softTimeoutMs)]);
    if (outcome === "timeout") {
      return;
    }
    return;
  }
  await refresh;
}
