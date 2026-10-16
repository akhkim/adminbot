import { describe, expect, it, vi } from "vitest";
import {
  createSlackUserDirectoryReader,
  normalizeSlackUser,
  slackPlaceholderUserIds,
  type SlackUsersFetch,
} from "./slack-users.js";

// Synthetic workspace only. Every call goes to this mock; nothing here reaches slack.com.
const ENV = { SLACK_BOT_TOKEN: "xoxb-test-token" } as NodeJS.ProcessEnv;

type Reply = { status?: number; body?: unknown; retryAfter?: string };

function mockSlack(replies: Reply[]) {
  const calls: string[] = [];
  const fetchImpl = vi.fn<SlackUsersFetch>(async (input, init) => {
    calls.push(input);
    expect(init.headers.Authorization).toBe("Bearer xoxb-test-token");
    const reply = replies.shift();
    if (!reply) {
      throw new Error("unexpected extra Slack call");
    }
    const status = reply.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => (name === "retry-after" ? (reply.retryAfter ?? null) : null) },
      text: async () => JSON.stringify(reply.body ?? {}),
    };
  });
  return { fetchImpl, calls };
}

const user = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  tz: "America/Toronto",
  profile: { real_name: `Person ${id}`, email: `${id.toLowerCase()}@lab.test` },
  ...extra,
});

describe("Slack users.list reader", () => {
  it("follows the cursor across pages and normalizes profile fields", async () => {
    const { fetchImpl, calls } = mockSlack([
      {
        body: {
          ok: true,
          members: [user("U1"), user("U2", { is_restricted: true })],
          response_metadata: { next_cursor: "page2" },
        },
      },
      {
        body: {
          ok: true,
          members: [
            user("U3", {
              deleted: true,
              profile: {
                real_name: "Third Person",
                display_name: "third",
                email: "Third@Lab.Test",
                title: "Postdoc",
                image_512: "https://avatars.test/u3-512.png",
                image_192: "https://avatars.test/u3-192.png",
              },
            }),
          ],
          response_metadata: { next_cursor: "" },
        },
      },
    ]);
    const users = await createSlackUserDirectoryReader(ENV, { fetchImpl })();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("users.list?limit=200");
    expect(calls[1]).toContain("cursor=page2");
    expect(users.map((u) => u.id)).toEqual(["U1", "U2", "U3"]);
    expect(users[1]?.is_restricted).toBe(true);
    expect(users[2]).toEqual({
      id: "U3",
      deleted: true,
      is_bot: false,
      is_app_user: false,
      is_restricted: false,
      is_ultra_restricted: false,
      real_name: "Third Person",
      display_name: "third",
      email: "third@lab.test",
      title: "Postdoc",
      tz: "America/Toronto",
      image: "https://avatars.test/u3-512.png",
    });
  });

  it("waits Retry-After on HTTP 429 and retries the same page", async () => {
    const sleep = vi.fn(async () => {});
    const { fetchImpl, calls } = mockSlack([
      { body: { ok: true, members: [user("U1")], response_metadata: { next_cursor: "c2" } } },
      { status: 429, retryAfter: "7", body: { ok: false, error: "ratelimited" } },
      { body: { ok: true, members: [user("U2")] } },
    ]);
    const users = await createSlackUserDirectoryReader(ENV, { fetchImpl, sleep })();
    expect(sleep).toHaveBeenCalledWith(7000);
    expect(calls[1]).toBe(calls[2]);
    expect(users.map((u) => u.id)).toEqual(["U1", "U2"]);
  });

  it("treats a 200 with error ratelimited the same way and caps a huge Retry-After", async () => {
    const sleep = vi.fn(async () => {});
    const { fetchImpl } = mockSlack([
      { status: 200, retryAfter: "99999", body: { ok: false, error: "ratelimited" } },
      { body: { ok: true, members: [user("U1")] } },
    ]);
    await createSlackUserDirectoryReader(ENV, { fetchImpl, sleep })();
    expect(sleep).toHaveBeenCalledWith(120_000);
  });

  it("gives up after the retry budget instead of looping forever", async () => {
    const sleep = vi.fn(async () => {});
    const { fetchImpl } = mockSlack(
      Array.from({ length: 3 }, () => ({ status: 429, retryAfter: "1" })),
    );
    await expect(
      createSlackUserDirectoryReader(ENV, { fetchImpl, sleep, maxRetries: 2 })(),
    ).rejects.toThrow("still rate limited after 2 retries");
  });

  it("throws on a Slack error rather than returning a partial workspace", async () => {
    const { fetchImpl } = mockSlack([
      { body: { ok: true, members: [user("U1")], response_metadata: { next_cursor: "c2" } } },
      { body: { ok: false, error: "missing_scope" } },
    ]);
    await expect(createSlackUserDirectoryReader(ENV, { fetchImpl })()).rejects.toThrow(
      "Slack users.list failed: missing_scope",
    );
  });

  it("throws on an HTTP failure and on a repeated cursor", async () => {
    const failing = mockSlack([{ status: 500, body: { ok: true, members: [] } }]);
    await expect(
      createSlackUserDirectoryReader(ENV, { fetchImpl: failing.fetchImpl })(),
    ).rejects.toThrow("Slack users.list failed: 500");
    const looping = mockSlack([
      { body: { ok: true, members: [user("U1")], response_metadata: { next_cursor: "same" } } },
      { body: { ok: true, members: [user("U2")], response_metadata: { next_cursor: "same" } } },
    ]);
    await expect(
      createSlackUserDirectoryReader(ENV, { fetchImpl: looping.fetchImpl })(),
    ).rejects.toThrow("repeated a pagination cursor");
  });

  it("requires a bot token before calling Slack", async () => {
    const { fetchImpl } = mockSlack([]);
    await expect(createSlackUserDirectoryReader({}, { fetchImpl })()).rejects.toThrow(
      "SLACK_BOT_TOKEN",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a member without an id", () => {
    expect(() => normalizeSlackUser({ profile: {} })).toThrow("without an ID");
  });

  it("parses the explicit placeholder flag list", () => {
    expect([
      ...slackPlaceholderUserIds({ ADMINBOT_SLACK_PLACEHOLDER_USER_IDS: " U1, ,U2 " }),
    ]).toEqual(["U1", "U2"]);
    expect(slackPlaceholderUserIds({}).size).toBe(0);
  });
});
