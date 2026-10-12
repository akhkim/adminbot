import { describe, expect, it, vi } from "vitest";
import { createActiveChannelReader } from "./slack-active-channels.js";

function setup(failSecondPage = false) {
  const fetchImpl = vi.fn(async (input: string | URL) => {
    const url = new URL(input);
    let body: object;
    if (url.pathname.endsWith("users.list")) {
      body = { ok: true, members: [{ id: "UHUMAN" }, { id: "UBOT", is_bot: true }] };
    } else if (url.pathname.endsWith("conversations.list")) {
      body = {
        ok: true,
        channels: [
          { id: "C1", name: "jinesis-active" },
          { id: "C2", name: "random-active" },
        ],
      };
    } else if (url.searchParams.has("cursor")) {
      body = failSecondPage ? { ok: false, error: "ratelimited" } : { ok: true, members: ["UBOT"] };
    } else {
      body = { ok: true, members: ["UHUMAN"], response_metadata: { next_cursor: "page2" } };
    }
    return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(body) };
  });
  return { read: createActiveChannelReader({ SLACK_BOT_TOKEN: "test" }, fetchImpl), fetchImpl };
}
describe("active-channel Slack reader", () => {
  it("reads every page and excludes bot accounts", async () => {
    expect(await setup().read()).toEqual([
      { channel: "jinesis-active", userIds: ["UHUMAN"] },
      { channel: "random-active", userIds: ["UHUMAN"] },
    ]);
  });
  it("fails instead of returning partial membership", async () => {
    await expect(setup(true).read()).rejects.toThrow("ratelimited");
  });
  it("fails closed without Slack credentials", async () => {
    await expect(createActiveChannelReader({})()).rejects.toThrow();
  });
});
