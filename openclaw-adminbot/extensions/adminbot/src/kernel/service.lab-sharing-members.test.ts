import { expect, it } from "vitest";
import { createAdminBotMockService } from "../api/server.js";

it("searches only whitelisted member fields and explicit open project titles", () => {
  const mock = createAdminBotMockService();
  try {
    mock.service.upsertLabMember({
      id: "viewer",
      name: "Viewer",
      email: "viewer@lab.test",
      privilege_level: "member",
    });
    mock.service.upsertLabMember({
      id: "author",
      name: "Mina Member",
      email: "private-address@lab.test",
      research_branch: "Language",
      research_topics: ["Causality"],
    });
    for (const [id, title] of [
      ["open", "Open Synthetic Agents"],
      ["closed", "Closed Secret Project"],
      ["private", "Hidden Paper"],
    ]) {
      mock.service.upsertPaper({
        id,
        title,
        authors: ["Mina Member"],
        first_author_member_id: "author",
        current_step: "brainstorming",
      });
    }
    const service = mock.service.labSharing();
    const request = { description: "Tasks", tags: [], members_needed: 1, hours_per_week: 2 };
    service.save("author", "open", request);
    service.save("author", "closed", request);
    service.save("author", "closed", {}, true);
    const search = (query: string) => {
      const result = service.searchMembers("viewer", query);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.payload.members;
    };
    expect(service.searchMembers("absent", "mina").status).toBe(403);
    expect(service.searchMembers("viewer", "x".repeat(101)).status).toBe(400);
    expect(search(" ")).toEqual([]);
    expect(search("m")).toEqual([]);
    for (const query of [" MINA ", "causality", "language", "synthetic"]) {
      expect(search(query)).toHaveLength(1);
    }
    expect(search("secret")).toEqual([]);
    expect(search("hidden")).toEqual([]);
    expect(search("private-address")).toEqual([]);
    expect(Object.keys(search("mina")[0]).sort()).toEqual([
      "id",
      "matched_fields",
      "name",
      "projects",
      "research_branch",
      "research_topics",
    ]);
    expect(search("synthetic")[0].projects).toEqual([
      { id: "open", title: "Open Synthetic Agents" },
    ]);
    expect(JSON.stringify(search("mina"))).not.toContain("private-address");
    for (let i = 0; i < 22; i++) {
      mock.service.upsertLabMember({ id: `m${i}`, name: `Match ${String(i).padStart(2, "0")}` });
    }
    const limited = service.searchMembers("viewer", "match");
    expect(limited.ok && limited.payload.truncated).toBe(true);
    expect(limited.ok && limited.payload.members).toHaveLength(20);
    expect(limited.ok && limited.payload.members[0].name).toBe("Match 00");
  } finally {
    mock.close();
  }
});
