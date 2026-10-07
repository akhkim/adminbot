import { describe, expect, it } from "vitest";
import { AdminBotService } from "./service.js";

const URL = "https://drive.google.com/file/d/1PdF9xAbCdEfGhIjKlMnOpQrStUv/view";

describe("Drive access", () => {
  it("checks the bot account's actual access without changing sharing", async () => {
    const ids: string[] = [];
    const service = new AdminBotService(undefined, {
      driveProbe: async (id) => {
        ids.push(id);
        return { status: "found", canEdit: true };
      },
    });
    const result = await service.checkDriveAccess(URL);
    expect(ids).toEqual(["1PdF9xAbCdEfGhIjKlMnOpQrStUv"]);
    expect(result).toMatchObject({ ok: true, payload: { status: "accessible" } });
  });

  it("accepts view-only and link-shared files, which Google reports as found but not editable", async () => {
    for (const probed of [{ canEdit: false }, {}]) {
      const service = new AdminBotService(undefined, {
        driveProbe: async () => ({ status: "found", ...probed }),
      });
      expect(await service.checkDriveAccess(URL)).toMatchObject({
        ok: true,
        payload: { status: "accessible" },
      });
    }
  });

  it("refuses a trashed file even when AdminBot can still see it", async () => {
    const service = new AdminBotService(undefined, {
      driveProbe: async () => ({ status: "found", trashed: true, canEdit: true }),
    });
    expect(await service.checkDriveAccess(URL)).toMatchObject({
      ok: true,
      payload: { status: "inaccessible", message: expect.stringContaining("trash") },
    });
  });

  it("does not claim access when the probe cannot establish it", async () => {
    const service = new AdminBotService(undefined, {
      driveProbe: async () => ({ status: "unreadable", reason: "permission denied" }),
    });
    expect(await service.checkDriveAccess(URL)).toMatchObject({
      ok: true,
      payload: { status: "unverified" },
    });
    expect(await service.checkDriveAccess("https://example.com/file")).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("treats Google's ambiguous 404 as inaccessible, not as proof of deletion", async () => {
    const service = new AdminBotService(undefined, {
      driveProbe: async () => ({ status: "missing" }),
    });
    const result = await service.checkDriveAccess(URL);
    expect(result).toMatchObject({
      ok: true,
      payload: { status: "inaccessible", message: expect.stringContaining("cannot open") },
    });
    expect(result.ok && result.payload.message).not.toContain("as Editor");
  });
});
