import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withCompleteProfile } from "../contracts/profile-completion.test-helpers.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";
const PASSWORD = "correcthorse";

const running: {
  mock: ReturnType<typeof createAdminBotMockService>;
  cleanup: string;
}[] = [];

afterEach(async () => {
  while (running.length > 0) {
    const entry = running.pop();
    if (!entry) {
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      entry.mock.server.close((error) => (error ? reject(error) : resolve()));
    });
    entry.mock.close();
    await rm(entry.cleanup, { force: true });
  }
});

type Lab = {
  baseUrl: string;
  /** Session tokens, by member id. */
  tokens: Record<string, string>;
};

// `readers: false` builds a deployment with neither the calendar nor the Slack reader wired, which
// is what a host without those credentials looks like.
async function startLab({ readers = true }: { readers?: boolean } = {}): Promise<Lab> {
  const sensitiveInfoPath = path.join(
    os.tmpdir(),
    `adminbot-active-channels-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
  );
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    ...(readers
      ? {
          readCalendarAccess: async () => [],
          readCalendarMembership: async () => [],
          readActiveChannels: async () => [
            { channel: "jinesis-active", userIds: [] },
            { channel: "random-active", userIds: [] },
          ],
          // A synthetic one-account workspace; the real Slack API is never called.
          readSlackDirectory: async () => [
            {
              id: "USYNTH",
              deleted: false,
              is_bot: false,
              is_app_user: false,
              is_restricted: false,
              is_ultra_restricted: false,
              real_name: "Synthetic Person",
              email: "synthetic@lab.test",
            },
          ],
        }
      : {}),
    sensitiveInfoPath,
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
    dcsRosterRecorder: async () => ({
      username: "stub@cs.toronto.edu",
      password: "stub",
      candidates: ["stub@cs.toronto.edu"],
    }),
  });
  await new Promise<void>((resolve, reject) => {
    mock.server.once("error", reject);
    mock.server.listen(0, "127.0.0.1", () => {
      mock.server.off("error", reject);
      resolve();
    });
  });
  const address = mock.server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing mock service address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  running.push({ mock, cleanup: sensitiveInfoPath });

  const tokens: Record<string, string> = {};
  for (const [id, privilege] of [
    ["ada", "member"],
    ["grace", "member"],
    ["zhijing", "admin"],
  ] as const) {
    // Complete profiles keep the profile gate out of the way, so a member 403 proves the
    // route's own admin check rather than profile_incomplete.
    const seeded = mock.service.upsertLabMember(
      withCompleteProfile({
        id,
        name: id,
        email: `${id}@cs.toronto.edu`,
        privilege_level: privilege,
      }),
    );
    if (!seeded.ok) {
      throw new Error(seeded.error.message);
    }
    await fetch(`${baseUrl}/auth/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        member_id: id,
        email: `${id}@cs.toronto.edu`,
        password: PASSWORD,
      }),
    });
    const pending = await fetch(`${baseUrl}/auth/registrations?status=pending`, {
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    const registrations = (
      (await pending.json()) as {
        registrations: { id: string; member_id?: string }[];
      }
    ).registrations;
    const claim = registrations.find((entry) => entry.member_id === id);
    if (!claim) {
      throw new Error(`no pending claim for ${id}`);
    }
    const approved = await mock.auth.approveRegistration(claim.id, "test-admin");
    if (!approved.ok) {
      throw new Error(approved.error.message);
    }
    const login = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `${id}@cs.toronto.edu`,
        password: PASSWORD,
      }),
    });
    tokens[id] = ((await login.json()) as { session_token: string }).session_token;
  }
  return { baseUrl, tokens };
}

describe("active-channel cleanup authorization", () => {
  it.each(["active-channels", "calendar-membership", "slack-roster"])(
    "allows service/admin and denies members/anonymous for %s",
    async (endpoint) => {
      const { baseUrl, tokens } = await startLab();
      for (const [token, expected] of [
        [undefined, 401],
        [tokens.ada, 403],
        [tokens.zhijing, 200],
        [SERVICE_TOKEN, 200],
      ] as const) {
        const response = await fetch(`${baseUrl}/members/${endpoint}/sync`, {
          method: "POST",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        expect(response.status).toBe(expected);
        if (expected === 403) {
          expect(await response.json()).toEqual({ error: { message: "insufficient privileges" } });
        }
      }
    },
  );

  // The Sunday cron (scripts/adminbot-active-channels-cron.sh) calls both with the service token.
  // A route that went missing would answer 404 there and the sweep would silently stop; one whose
  // reader is unwired must say so with a 503 rather than report an empty, "successful" sweep.
  it.each([
    ["active-channels", "Slack active-channel reader is unavailable"],
    ["calendar-membership", "Calendar membership reader is unavailable"],
    ["slack-roster", "Slack user directory reader is unavailable"],
  ])("fails closed with 503 when the %s reader is not wired", async (endpoint, message) => {
    const { baseUrl, tokens } = await startLab({ readers: false });
    for (const token of [SERVICE_TOKEN, tokens.zhijing]) {
      const response = await fetch(`${baseUrl}/members/${endpoint}/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(503);
      expect(((await response.json()) as { error: { message: string } }).error.message).toBe(
        message,
      );
    }
  });

  it.each(["active-channels", "calendar-membership", "slack-roster"])(
    "refuses a member session for %s before reading anything",
    async (endpoint) => {
      const { baseUrl, tokens } = await startLab({ readers: false });
      const response = await fetch(`${baseUrl}/members/${endpoint}/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokens.ada}` },
      });
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: { message: string } }).error.message).toBe(
        "insufficient privileges",
      );
    },
  );

  // The cron may run the guarded pass but not override the guard: force is an admin decision.
  it("refuses force from the service token and accepts it from an admin session", async () => {
    const { baseUrl, tokens } = await startLab();
    for (const [token, expected] of [
      [SERVICE_TOKEN, 403],
      [tokens.zhijing, 200],
    ] as const) {
      const response = await fetch(`${baseUrl}/members/slack-roster/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ force: true, dry_run: true }),
      });
      expect(response.status).toBe(expected);
    }
  });
});
