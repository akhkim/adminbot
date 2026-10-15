// Refresh starts a new workshop pass, then reads it back through the same loader the tab opens
// with. Fetch is stubbed: what is under test is that the read actually happens and the spinner the
// refresh put up comes down again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import type { UiSettings } from "../../storage.ts";
import { saveStoredMemberSession } from "../auth/session.ts";
import { type AdminBotHost, createEmptyWorkshopNudgeReviewState } from "./admin.ts";
import { refreshWorkshopNudgePreview } from "./conference-papers.ts";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

describe("workshop refresh", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    saveStoredMemberSession({ sessionToken: "tok", expiresAt: "later" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reads the new pass back and clears its spinner", async () => {
    const paths: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      return path.endsWith("/refresh")
        ? json({ ok: true })
        : json({ status: "succeeded", preview: null });
    });
    const host = {
      settings: { adminBotUrl: "https://admin.safe.eu" } as UiSettings,
      adminBotWorkshopNudges: createEmptyWorkshopNudgeReviewState(),
    } as AdminBotHost;
    await refreshWorkshopNudgePreview(host);
    expect(paths.map((path) => path.split("/").pop())).toEqual(["refresh", "preview"]);
    expect(host.adminBotWorkshopNudges.loading).toBe(false);
    expect(host.adminBotWorkshopNudges.run?.status).toBe("succeeded");
  });
});
