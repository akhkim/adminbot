import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetSlackChannelNames,
  readSlackChannelNames,
  SLACK_CHANNEL_CACHE_MS,
  SLACK_CHANNEL_STALE_MS,
} from "./directory.js";

describe("readSlackChannelNames", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    forgetSlackChannelNames();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks Slack once for requests that arrive together, and not again for five minutes", async () => {
    let answer: (names: string[]) => void = () => {};
    const fetchNames = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          answer = resolve;
        }),
    );
    const together = [readSlackChannelNames(fetchNames), readSlackChannelNames(fetchNames)];
    answer(["proj-causal"]);
    expect(await Promise.all(together)).toEqual([["proj-causal"], ["proj-causal"]]);

    vi.advanceTimersByTime(SLACK_CHANNEL_CACHE_MS - 1);
    expect(await readSlackChannelNames(fetchNames)).toEqual(["proj-causal"]);
    expect(fetchNames).toHaveBeenCalledTimes(1);
  });

  it("hands back the older list while it fetches a new one, and the new one after", async () => {
    const lists = [["proj-old"], ["proj-old", "proj-new"]];
    const fetchNames = vi.fn(async () => lists.shift() ?? []);
    await readSlackChannelNames(fetchNames);

    vi.advanceTimersByTime(SLACK_CHANNEL_CACHE_MS + 1);
    expect(await readSlackChannelNames(fetchNames)).toEqual(["proj-old"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(await readSlackChannelNames(fetchNames)).toEqual(["proj-old", "proj-new"]);
    expect(fetchNames).toHaveBeenCalledTimes(2);
  });

  it("waits for Slack once the list is too old to answer with", async () => {
    const lists = [["proj-old"], ["proj-new"]];
    const fetchNames = vi.fn(async () => lists.shift() ?? []);
    await readSlackChannelNames(fetchNames);

    vi.advanceTimersByTime(SLACK_CHANNEL_CACHE_MS + SLACK_CHANNEL_STALE_MS);
    expect(await readSlackChannelNames(fetchNames)).toEqual(["proj-new"]);
  });

  it("does not keep a failure", async () => {
    const fetchNames = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error("missing_scope"))
      .mockResolvedValueOnce(["proj-causal"]);
    await expect(readSlackChannelNames(fetchNames)).rejects.toThrow("missing_scope");
    expect(await readSlackChannelNames(fetchNames)).toEqual(["proj-causal"]);
  });

  it("asks again after the names are forgotten", async () => {
    const fetchNames = vi.fn(async () => ["proj-causal"]);
    await readSlackChannelNames(fetchNames);
    forgetSlackChannelNames();
    await readSlackChannelNames(fetchNames);
    expect(fetchNames).toHaveBeenCalledTimes(2);
  });
});
