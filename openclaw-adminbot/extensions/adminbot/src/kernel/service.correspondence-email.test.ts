import { describe, expect, it } from "vitest";
import { AdminBotService, AdminBotMemoryStore } from "./service.js";

describe("correspondence email validation", () => {
  it("refuses malformed correspondence addresses without creating a member", () => {
    const service = new AdminBotService();
    const result = service.upsertLabMember({
      id: "ada",
      name: "Ada Example",
      correspondence_email: "not an address",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "correspondence email must be a valid email address" },
    });
    expect(service.listLabMembers()).toMatchObject({ ok: true, payload: { members: [] } });
  });

  it("detects personal-provider addresses without restricting the login address", () => {
    const service = new AdminBotService();
    for (const address of ["ada@gmail.com", " Ada@OUTLOOK.COM ", "ada@proton.me"]) {
      expect(
        service.upsertLabMember({ id: "ada", name: "Ada Example", correspondence_email: address }),
      ).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("institutional or company") },
      });
    }
    expect(
      service.upsertLabMember({
        id: "ada",
        name: "Ada Example",
        email: "ada@gmail.com",
        correspondence_email: "ada@company.example",
      }).ok,
    ).toBe(true);
  });

  it("preserves legacy personal addresses until explicitly changed, including self-profile saves", () => {
    const store = new AdminBotMemoryStore();
    const service = new AdminBotService(store);
    const created = service.upsertLabMember({
      id: "ada",
      name: "Ada Example",
      privilege_level: "member",
    });
    if (!created.ok) throw new Error(created.error.message);
    store.saveLabMember({ ...created.payload, correspondence_email: "ada@gmail.com" });
    expect(
      service.updateOwnProfile("ada", {
        location: "Toronto",
        correspondence_email: "ada@gmail.com",
      }).ok,
    ).toBe(true);
    expect(
      service.updateOwnProfile("ada", { correspondence_email: "ada@hotmail.com" }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(store.getLabMember("ada")?.correspondence_email).toBe("ada@gmail.com");
    expect(
      service.updateOwnProfile("ada", { correspondence_email: "ada@institute.example" }).ok,
    ).toBe(true);
  });

  it("accepts institutional and company addresses, patches and explicit clearing", () => {
    const service = new AdminBotService();
    expect(
      service.upsertLabMember({
        id: "ada",
        name: "Ada Example",
        correspondence_email: "ada@university.example",
      }).ok,
    ).toBe(true);
    expect(
      service.upsertLabMember({ id: "ada", correspondence_email: "ada@company.example" }).ok,
    ).toBe(true);
    expect(service.upsertLabMember({ id: "ada", location: "Toronto" }).ok).toBe(true);
    expect(service.upsertLabMember({ id: "ada", correspondence_email: "" }).ok).toBe(true);
  });
});
