import { describe, expect, it } from "vitest";
import { adminBotPaperSlots } from "../contracts/paper-slots.js";
import { AdminBotMemoryStore } from "../persistence/memory.js";
import { AdminBotService } from "./service.js";

describe("active collaborator schedules", () => {
  it("shares only canonical active coauthors and excludes private fields", () => {
    const service = new AdminBotService();
    for (const id of ["viewer", "coauthor", "stranger"]) {
      expect(
        service.upsertLabMember({
          id,
          name: id,
          hours_per_week: 40,
          availability_notes: "private circumstances",
          email: `${id}@example.org`,
          availability: [
            {
              start: "2026-10-01",
              end: "2026-10-12",
              project: "Project",
              hours_per_week: 20,
              note: "private note",
              link: "https://example.org/private",
            },
          ],
          time_off: [
            {
              start: "2026-10-13",
              end: "2026-10-14",
              kind: "vacation",
              availability: "none",
              note: "private reason",
            },
          ],
        }).ok,
      ).toBe(true);
    }
    expect(
      service.upsertPaper({
        id: "active",
        title: "Active",
        authors: [],
        current_step: "brainstorming_docs",
        author_links: [
          { name: "viewer", member_id: "viewer" },
          { name: "coauthor", member_id: "coauthor" },
          { name: "Unlinked external author" },
        ],
      }).ok,
    ).toBe(true);
    const result = service.listActiveCollaboratorSchedules("viewer");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.payload.members.map((m) => m.id)).toEqual(["coauthor"]);
    expect(result.payload.members[0].availability?.[0]).toEqual({
      start: "2026-10-01",
      end: "2026-10-12",
      project: "Project",
      hours_per_week: 20,
    });
    expect(JSON.stringify(result.payload)).not.toMatch(/private|example.org/);
    expect(service.listActiveCollaboratorSchedules("stranger")).toMatchObject({
      ok: true,
      payload: { members: [] },
    });
    expect(service.listActiveCollaboratorSchedules("missing")).toMatchObject({
      ok: false,
      status: 404,
    });
  });
  it("deduplicates coauthors and stops sharing when all required slots settle", () => {
    const store = new AdminBotMemoryStore();
    const service = new AdminBotService(store);
    for (const id of ["viewer", "peer"]) service.upsertLabMember({ id, name: id });
    for (const id of ["one", "two"])
      service.upsertPaper({
        id,
        title: id,
        authors: [],
        current_step: "brainstorming_docs",
        author_links: [
          { name: "viewer", member_id: "viewer" },
          { name: "peer", member_id: "peer" },
        ],
      });
    expect(service.listActiveCollaboratorSchedules("viewer")).toMatchObject({
      ok: true,
      payload: { members: [{ id: "peer" }] },
    });
    for (const paper_id of ["one", "two"])
      for (const slot of adminBotPaperSlots)
        store.savePaperSlot({ paper_id, slot, status: "waived" });
    expect(service.listActiveCollaboratorSchedules("viewer")).toMatchObject({
      ok: true,
      payload: { members: [] },
    });
  });
  it("does not truncate collaborators beyond the first page of own papers", () => {
    const service = new AdminBotService();
    for (const id of ["viewer", "late-peer"]) {
      expect(service.upsertLabMember({ id, name: id }).ok).toBe(true);
    }
    for (let i = 0; i < 201; i++) {
      expect(
        service.upsertPaper({
          id: `paper-${i}`,
          title: `Paper ${String(i).padStart(3, "0")}`,
          authors: [],
          current_step: "brainstorming_docs",
          author_links: [
            { name: "viewer", member_id: "viewer" },
            ...(i === 200 ? [{ name: "late-peer", member_id: "late-peer" }] : []),
          ],
        }).ok,
      ).toBe(true);
    }
    expect(service.listActiveCollaboratorSchedules("viewer")).toMatchObject({
      ok: true,
      payload: { members: [{ id: "late-peer" }] },
    });
  });
});
