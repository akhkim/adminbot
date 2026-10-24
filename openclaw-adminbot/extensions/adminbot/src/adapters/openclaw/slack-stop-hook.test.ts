import { describe, expect, it, vi } from "vitest";
import { handleSlackStopDispatch } from "./slack-stop-hook.js";

const dm = { content: "STOP", channel: "slack", senderId: "U-MEI", isGroup: false };

describe("handleSlackStopDispatch", () => {
  it("answers a bare stop in a Slack DM with the service's reply", async () => {
    const apply = vi.fn(async () => ({ matched: true, changed: true, reply: "Done." }));
    await expect(handleSlackStopDispatch(dm, {}, apply)).resolves.toEqual({
      handled: true,
      text: "Done.",
    });
    expect(apply).toHaveBeenCalledWith({ slackUserId: "U-MEI", command: "stop" });
  });

  it.each([
    ["a channel message", { ...dm, isGroup: true }],
    ["an unknown chat type", { ...dm, isGroup: undefined }],
    ["another channel", { ...dm, channel: "telegram" }],
    ["a sentence", { ...dm, content: "stop the EMNLP reminders" }],
    ["no sender", { ...dm, senderId: undefined }],
  ])("leaves %s to the agent", async (_label, event) => {
    const apply = vi.fn();
    await expect(handleSlackStopDispatch(event, {}, apply)).resolves.toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
  });

  it("falls through for a sender AdminBot does not know, and on a service failure", async () => {
    await expect(
      handleSlackStopDispatch(dm, {}, async () => ({ matched: false, changed: false })),
    ).resolves.toBeUndefined();
    await expect(
      handleSlackStopDispatch(dm, {}, async () => {
        throw new Error("service down");
      }),
    ).resolves.toBeUndefined();
  });
});
