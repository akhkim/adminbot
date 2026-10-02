import { describe, expect, it } from "vitest";
import { AdminBotService } from "./service.js";

const URL = "https://drive.google.com/file/d/1PdF9xAbCdEfGhIjKlMnOpQrStUv/view";

describe("Drive edit access", () => {
  it("checks the bot account's actual capability without changing sharing", async () => {
    const ids: string[] = [];
    const service = new AdminBotService(undefined, {
      driveProbe: async (id) => {
        ids.push(id);
        return { status: "found", canEdit: false };
      },
    });
    const result = await service.checkDriveEditAccess(URL);
    expect(ids).toEqual(["1PdF9xAbCdEfGhIjKlMnOpQrStUv"]);
    expect(result).toMatchObject({ ok: true, payload: { status: "not_editable" } });
  });

  it("does not claim access when the probe cannot establish it", async () => {
    const service = new AdminBotService(undefined, {
      driveProbe: async () => ({ status: "unreadable", reason: "permission denied" }),
    });
    expect(await service.checkDriveEditAccess(URL)).toMatchObject({
      ok: true,
      payload: { status: "unverified" },
    });
    expect(await service.checkDriveEditAccess("https://example.com/file")).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("treats Google's ambiguous 404 as inaccessible, not as proof of deletion", async () => {
    const service = new AdminBotService(undefined, {
      driveProbe: async () => ({ status: "missing" }),
    });
    expect(await service.checkDriveEditAccess(URL)).toMatchObject({
      ok: true,
      payload: { status: "not_editable", message: expect.stringContaining("cannot open") },
    });
  });
});
