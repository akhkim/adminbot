import { describe, expect, it } from "vitest";
import { AdminBotMemoryStore, AdminBotService } from "./service.js";

describe("merged member retirement", () => {
  it("refuses a stale import without creating a member or running onboarding hooks", () => {
    const store = new AdminBotMemoryStore();
    const service = new AdminBotService(store);
    expect(service.upsertLabMember({ id: "canonical", name: "Synthetic Person" }).ok).toBe(true);
    expect(service.upsertLabMember({ id: "old-import", name: "Synthetic Person" }).ok).toBe(true);
    expect(
      service.mergeLabMembers({
        survivorId: "canonical",
        duplicateId: "old-import",
        actorId: "admin",
      }).ok,
    ).toBe(true);
    const before = store.listAuditEvents().length;
    expect(
      service.upsertLabMember(
        { id: "old-import", name: "Synthetic Person", member_type: "full" },
        { source: "import" },
      ),
    ).toMatchObject({ ok: false, status: 409 });
    expect(store.getLabMember("old-import")).toBeUndefined();
    expect(store.getLabMember("canonical")?.member_type).toBeUndefined();
    expect(store.listAuditEvents()).toHaveLength(before);
    expect(
      service.renameLabMember({ memberId: "canonical", newId: "old-import", actorId: "admin" }),
    ).toMatchObject({ ok: false, status: 409 });
    expect(service.upsertLabMember({ id: "canonical", name: "Updated Person" }).ok).toBe(true);
    expect(service.upsertLabMember({ id: "unrelated", name: "Unrelated Person" }).ok).toBe(true);
  });
});
