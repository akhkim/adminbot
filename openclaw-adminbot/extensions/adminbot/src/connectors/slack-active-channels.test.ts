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

describe("Slack Connect members, whom users.list omits", () => {
  function connect(info: Record<string, object>) {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      let body: object;
      if (url.pathname.endsWith("users.list")) {
        body = { ok: true, members: [{ id: "UHUMAN" }] };
      } else if (url.pathname.endsWith("users.info")) {
        body = info[url.searchParams.get("user") ?? ""] ?? { ok: false, error: "user_not_found" };
      } else if (url.pathname.endsWith("conversations.list")) {
        body = {
          ok: true,
          channels: [
            { id: "C1", name: "jinesis-active" },
            { id: "C2", name: "random-active" },
          ],
        };
      } else {
        body = { ok: true, members: ["UHUMAN", "WEXTERNAL", "WEXTBOT"] };
      }
      return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(body) };
    });
    return { read: createActiveChannelReader({ SLACK_BOT_TOKEN: "test" }, fetchImpl), fetchImpl };
  }

  it("looks them up instead of abandoning the read, and still excludes their bots", async () => {
    const { read, fetchImpl } = connect({
      WEXTERNAL: { ok: true, user: { id: "WEXTERNAL", team_id: "TOTHER" } },
      WEXTBOT: { ok: true, user: { id: "WEXTBOT", team_id: "TOTHER", is_bot: true } },
    });
    expect(await read()).toEqual([
      { channel: "jinesis-active", userIds: ["UHUMAN", "WEXTERNAL"] },
      { channel: "random-active", userIds: ["UHUMAN", "WEXTERNAL"] },
    ]);
    // Once per account, not once per channel.
    const lookups = fetchImpl.mock.calls.filter(([input]) =>
      new URL(input).pathname.endsWith("users.info"),
    );
    expect(lookups).toHaveLength(2);
  });

  it("fails the whole read when one of them cannot be looked up", async () => {
    const { read } = connect({
      WEXTERNAL: { ok: true, user: { id: "WEXTERNAL", team_id: "TOTHER" } },
    });
    await expect(read()).rejects.toThrow("users.info failed: user_not_found");
  });
});
