import { expect, it } from "vitest";
import { createAdminBotMockService } from "../api/server.js";

it("projects private offers by caller and restricts lifecycle mutations to the respondent", () => {
  const mock = createAdminBotMockService();
  try {
    for (const id of ["owner", "reader", "other", "admin"]) {
      mock.service.upsertLabMember({
        id,
        name: id,
        email: `${id}@lab.test`,
        privilege_level: id === "admin" ? "admin" : "member",
      });
    }
    mock.service.upsertPaper({
      id: "p1",
      title: "Synthetic project",
      authors: ["owner"],
      first_author_member_id: "owner",
      current_step: "brainstorming",
    });
    const service = mock.service.labSharing();
    const draft = {
      description: "Synthetic tasks",
      tags: [],
      members_needed: 2,
      hours_per_week: 3,
    };
    expect(service.save("owner", "p1", draft).ok).toBe(true);
    expect(service.interest("missing", "p1", {}).status).toBe(403);
    expect(service.interest("reader", "absent", {}).status).toBe(404);
    expect(service.interest("owner", "p1", { hours_per_week: 2 }).status).toBe(403);
    expect(service.interest("reader", "p1", { hours_per_week: 0 }).status).toBe(400);
    expect(
      service.interest("reader", "p1", {
        hours_per_week: 2,
        note: "Private synthetic note",
        member_id: "other",
      }).ok,
    ).toBe(true);
    const offers = (id: string) => {
      const result = service.list(id);
      if (!result.ok) {
        throw new Error("unexpected failure");
      }
      return result.payload.interests;
    };
    expect(offers("other")).toEqual([]);
    expect(offers("owner")).toHaveLength(1);
    expect(offers("admin")).toHaveLength(1);
    expect(offers("reader")[0]).toMatchObject({
      member_id: "reader",
      note: "Private synthetic note",
    });
    expect(service.interest("other", "p1", { member_id: "reader" }, true).status).toBe(404);
    service.interest("reader", "p1", { hours_per_week: 4 });
    expect(mock.store.listHelpInterests()).toHaveLength(1);
    service.save("owner", "p1", {}, true);
    expect(service.interest("reader", "p1", { hours_per_week: 3 }).status).toBe(409);
    expect(service.interest("reader", "p1", {}, true).ok).toBe(true);
    expect(offers("owner")).toEqual([]);
    expect(offers("reader")[0].status).toBe("withdrawn");
    service.save("owner", "p1", draft);
    expect(service.interest("reader", "p1", { hours_per_week: 1 }).ok).toBe(true);
    expect(offers("owner")[0].status).toBe("active");
  } finally {
    mock.close();
  }
});
