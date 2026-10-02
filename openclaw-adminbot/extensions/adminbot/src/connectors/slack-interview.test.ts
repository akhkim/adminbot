import { describe, expect, it, vi } from "vitest";
import { createInterviewChannelProvisioner } from "./slack-interview.js";

describe("private interview channels", () => {
  const interview = { project: "Example", task: "Example task", interviewer_ids: ["UONE", "UTWO"] };
  function mock(extra = false) {
    return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const method = (typeof url === "string" ? url : url instanceof URL ? url.href : url.url)
        .split("/")
        .at(-1);
      let result: unknown;
      switch (method) {
        case "conversations.list":
          result = { ok: true, channels: [] };
          break;
        case "conversations.create":
          result = { ok: true, channel: { id: "CPRIVATE", is_private: true } };
          break;
        case "auth.test":
          result = { ok: true, user_id: "UBOT" };
          break;
        case "users.lookupByEmail":
          result = { ok: false, error: "users_not_found" };
          break;
        case "conversations.members":
          result = { ok: true, members: extra ? ["UBOT", "USTRANGER"] : ["UBOT"] };
          break;
        default:
          result = { ok: true };
      }
      return new Response(JSON.stringify(result), { status: 200 });
    });
  }
  it("creates a private room and invites only the approved interviewers", async () => {
    const fetcher = mock();
    expect(
      await createInterviewChannelProvisioner({ SLACK_BOT_TOKEN: "synthetic" }, fetcher)(
        "candidate@example.com",
        interview,
      ),
    ).toBe("CPRIVATE");
    const create = fetcher.mock.calls.find(([url]) =>
      (typeof url === "string" ? url : url instanceof URL ? url.href : url.url).endsWith(
        "conversations.create",
      ),
    );
    expect(JSON.parse(create?.[1]?.body as string)).toMatchObject({ is_private: true });
    const invites = fetcher.mock.calls.filter(([url]) =>
      (typeof url === "string" ? url : url instanceof URL ? url.href : url.url).endsWith(
        "conversations.invite",
      ),
    );
    expect(invites.map(([, init]) => JSON.parse(init?.body as string).users)).toEqual([
      "UONE",
      "UTWO",
    ]);
  });
  it("refuses a channel containing extra people before inviting anyone", async () => {
    const fetcher = mock(true);
    await expect(
      createInterviewChannelProvisioner({ SLACK_BOT_TOKEN: "synthetic" }, fetcher)(
        "candidate@example.com",
        interview,
      ),
    ).rejects.toThrow("other people");
    expect(
      fetcher.mock.calls.some(([url]) =>
        (typeof url === "string" ? url : url instanceof URL ? url.href : url.url).endsWith(
          "conversations.invite",
        ),
      ),
    ).toBe(false);
  });
  it("fails closed with no token", async () => {
    const fetcher = mock();
    await expect(
      createInterviewChannelProvisioner({}, fetcher)("candidate@example.com", interview),
    ).rejects.toThrow("token");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
