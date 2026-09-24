import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import type { UiSettings } from "../../storage.ts";
import { saveStoredMemberSession } from "../auth/session.ts";
import type { AdminBotHost } from "./admin.ts";
import { loadAdminBotLocationDrifts, loadAdminBotLocationPrompt } from "./location-prompt.ts";
import { loadAdminBotMeetings } from "./meetings.ts";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

function host(): AdminBotHost {
  return {
    settings: { adminBotUrl: "https://admin.safe.eu" } as UiSettings,
    adminBotLocationDrift: undefined,
    adminBotLocationDrifts: undefined,
    adminBotMeetings: undefined,
    adminBotMeetingsLoading: false,
    adminBotMeetingsError: null,
  } as AdminBotHost;
}

describe("member-owned location and meeting caches", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    saveStoredMemberSession({ sessionToken: "token-a", expiresAt: "later" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("drops late location prompt and drift responses from A after B signs in", async () => {
    const finish: Record<string, (response: Response) => void> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      const key = url.includes("location-drifts") ? "drifts" : "prompt";
      return new Promise<Response>((resolve) => {
        finish[key] = resolve;
      });
    });
    const app = host();
    const prompt = loadAdminBotLocationPrompt(app);
    const drifts = loadAdminBotLocationDrifts(app);
    saveStoredMemberSession({ sessionToken: "token-b", expiresAt: "later" });
    finish.prompt?.(json({ drift: { current_city: "A's city" } }));
    finish.drifts?.(json({ drifts: [{ current_city: "A's city" }] }));
    await Promise.all([prompt, drifts]);
    expect(app.adminBotLocationDrift).toBeUndefined();
    expect(app.adminBotLocationDrifts).toBeUndefined();
  });

  it("does not show A's meetings or clear B's loading state after a late response", async () => {
    let finish: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const app = host();
    const loading = loadAdminBotMeetings(app);
    saveStoredMemberSession({ sessionToken: "token-b", expiresAt: "later" });
    app.adminBotMeetingsLoading = true;
    finish?.(json({ meetings: [{ id: "a-private-meeting" }] }));
    await loading;
    expect(app.adminBotMeetings).toBeUndefined();
    expect(app.adminBotMeetingsLoading).toBe(true);
  });
});
