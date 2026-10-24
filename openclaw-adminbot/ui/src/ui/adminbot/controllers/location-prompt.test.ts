/* @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAdminBotLocationPrompt, prepareProfileLocationPrompt } from "./location-prompt.ts";

it("defers blocked reads and retries an earlier rejected read after unlocking", () => {
  const host: Parameters<typeof prepareProfileLocationPrompt>[0] = { adminBotLocationDrift: null };
  expect(prepareProfileLocationPrompt(host, true)).toBe(false);
  expect(host.adminBotLocationDrift).toBeUndefined();
  expect(prepareProfileLocationPrompt(host, true)).toBe(false);
  expect(prepareProfileLocationPrompt(host, false)).toBe(true);
  host.adminBotLocationDrift = null;
  expect(prepareProfileLocationPrompt(host, false)).toBe(false);
});

const api = vi.hoisted(() => ({ fetchLocationPrompt: vi.fn() }));

vi.mock("../api/profile.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/profile.ts")>()),
  fetchLocationPrompt: api.fetchLocationPrompt,
}));
vi.mock("../auth/session.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/session.ts")>()),
  loadStoredMemberSession: () => ({ sessionToken: "synthetic-token", expiresAt: "2099-01-01" }),
  resolveAdminBotBaseUrl: () => "http://adminbot.test",
}));

type Host = Parameters<typeof loadAdminBotLocationPrompt>[0];

describe("location prompt controller", () => {
  beforeEach(() => {
    api.fetchLocationPrompt.mockReset();
  });

  it("reads only the drift question; nothing asks where a member is", async () => {
    const drift = {
      member_id: "m_synthetic",
      observed_country: "Germany",
      since: "2026-10-01T00:00:00.000Z",
      observation_count: 3,
    };
    api.fetchLocationPrompt.mockResolvedValue({ ok: true, value: { drift } });
    const host = { memberId: "m_synthetic", settings: {} } as unknown as Host;
    await loadAdminBotLocationPrompt(host);
    expect(host.adminBotLocationDrift).toEqual(drift);
    expect(Object.keys(host)).not.toContain("adminBotLocationCheckin");
  });

  it("stays silent when the read fails", async () => {
    api.fetchLocationPrompt.mockResolvedValue({ ok: false, kind: "unreachable" });
    const host = { memberId: "m_synthetic", settings: {} } as unknown as Host;
    await loadAdminBotLocationPrompt(host);
    expect(host.adminBotLocationDrift).toBeNull();
    expect(host.adminBotLocationError ?? null).toBeNull();
  });
});
