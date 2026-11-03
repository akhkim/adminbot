import { describe, expect, it, vi } from "vitest";
import { createSlackConnectOnboardingInviter } from "./guide-sender.js";

describe("createSlackConnectOnboardingInviter", () => {
  it("invites into the channel it is given, and the configured one otherwise", async () => {
    const inviteToSlackConnect = vi.fn(async () => ({ url: "https://join.slack.example/x" }));
    const invite = createSlackConnectOnboardingInviter(
      { inviteToSlackConnect, defaultSlackChannelId: "C-FRIENDS" },
      {},
    );
    expect(await invite("ext@other.example", "random-active")).toMatchObject({
      ok: true,
      channel_id: "random-active",
    });
    expect(await invite("ext@other.example")).toMatchObject({ ok: true, channel_id: "C-FRIENDS" });
    expect(inviteToSlackConnect.mock.calls).toEqual([
      [{ email: "ext@other.example", channelId: "random-active" }],
      [{ email: "ext@other.example", channelId: "C-FRIENDS" }],
    ]);
  });
});
